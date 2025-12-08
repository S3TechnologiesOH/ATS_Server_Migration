/**
 * Interview Reminders API Endpoints
 * Handles confirm/cancel/reschedule actions from reminder emails
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const emailService = require('../services/emailService');

/**
 * Initialize routes with database pools
 */
function initializeRoutes(pools) {
    const db = pools['ats'];

    if (!db) {
        console.error('[InterviewReminders] ✗ ATS database pool not found');
        return router;
    }

    console.log('[InterviewReminders] ✓ Initializing routes with ATS database pool');

    /**
     * Send manual reminder for a specific meeting
     * POST /api/interview-reminders/send-manual
     * Body: { candidateEmail, meetingSubject, meetingStart, meetingEnd, meetingLocation, meetingWebLink, organizerName }
     */
    router.post('/send-manual', async (req, res) => {
        try {
            const {
                candidateEmail,
                meetingSubject,
                meetingStart,
                meetingEnd,
                meetingLocation,
                meetingWebLink,
                organizerName,
                organizerEmail
            } = req.body;

            // Validate required fields
            if (!candidateEmail || !meetingSubject || !meetingStart || !meetingEnd) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing required fields: candidateEmail, meetingSubject, meetingStart, meetingEnd'
                });
            }

            // Check if email service is configured
            if (!emailService.isConfigured()) {
                return res.status(503).json({
                    success: false,
                    error: 'Email service not configured. Add MAILGUN_API_KEY and MAILGUN_DOMAIN to .env'
                });
            }

            const startDate = new Date(meetingStart);
            const endDate = new Date(meetingEnd);

            // Check if reminder already sent for this meeting
            const checkQuery = `
                SELECT id, reminder_sent_at, response_status
                FROM interview_reminders
                WHERE candidate_email = $1
                  AND meeting_start = $2
                ORDER BY created_at DESC
                LIMIT 1
            `;
            const existingResult = await db.query(checkQuery, [candidateEmail, startDate]);

            // Generate secure token
            const reminderToken = crypto.randomBytes(32).toString('hex');

            // Create or update reminder record
            let reminderId;
            if (existingResult.rows.length > 0) {
                // Update existing record
                const updateQuery = `
                    UPDATE interview_reminders
                    SET reminder_token = $1,
                        reminder_sent_at = NOW(),
                        response_status = 'pending',
                        response_at = NULL,
                        response_notes = NULL,
                        updated_at = NOW()
                    WHERE id = $2
                    RETURNING id
                `;
                const updateResult = await db.query(updateQuery, [reminderToken, existingResult.rows[0].id]);
                reminderId = updateResult.rows[0].id;
                console.log(`[InterviewReminders] Re-sending reminder (ID: ${reminderId}) to ${candidateEmail}`);
            } else {
                // Create new record
                const insertQuery = `
                    INSERT INTO interview_reminders (
                        candidate_email,
                        meeting_subject,
                        meeting_start,
                        meeting_end,
                        meeting_location,
                        meeting_web_link,
                        organizer_name,
                        organizer_email,
                        reminder_token,
                        reminder_sent_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
                    RETURNING id
                `;
                const insertResult = await db.query(insertQuery, [
                    candidateEmail,
                    meetingSubject,
                    startDate,
                    endDate,
                    meetingLocation || null,
                    meetingWebLink || null,
                    organizerName || null,
                    organizerEmail || null,
                    reminderToken
                ]);
                reminderId = insertResult.rows[0].id;
                console.log(`[InterviewReminders] Created new reminder (ID: ${reminderId}) for ${candidateEmail}`);
            }

            // Send email
            const reminderData = {
                candidate_email: candidateEmail,
                meeting_subject: meetingSubject,
                meeting_start: startDate.toISOString(),
                meeting_end: endDate.toISOString(),
                meeting_location: meetingLocation || null,
                meeting_web_link: meetingWebLink || null,
                organizer_name: organizerName || null,
                reminder_token: reminderToken
            };

            await emailService.sendInterviewReminder(reminderData);

            console.log(`[InterviewReminders] ✓ Manual reminder sent to ${candidateEmail} for "${meetingSubject}"`);

            res.json({
                success: true,
                message: 'Reminder sent successfully',
                reminderId: reminderId
            });

        } catch (error) {
            console.error('[InterviewReminders] Manual send failed:', error);
            res.status(500).json({
                success: false,
                error: error.message || 'Failed to send reminder'
            });
        }
    });

    /**
     * Confirm interview attendance
     * GET /api/interview-reminders/confirm/:token
     */
    router.get('/confirm/:token', async (req, res) => {
        try {
            const { token } = req.params;

            // Find reminder by token
            const findQuery = `
                SELECT *
                FROM interview_reminders
                WHERE reminder_token = $1
            `;
            const findResult = await db.query(findQuery, [token]);

            if (findResult.rows.length === 0) {
                return res.status(404).send(generateResponsePage({
                    status: 'error',
                    title: 'Invalid Link',
                    message: 'This reminder link is invalid or has expired.',
                    icon: '❌'
                }));
            }

            const reminder = findResult.rows[0];

            // Check if already responded
            if (reminder.response_status !== 'pending') {
                return res.send(generateResponsePage({
                    status: 'info',
                    title: 'Already Responded',
                    message: `You have already ${reminder.response_status} this interview on ${new Date(reminder.response_at).toLocaleString()}.`,
                    icon: 'ℹ️',
                    meetingDetails: reminder
                }));
            }

            // Update to confirmed
            const updateQuery = `
                UPDATE interview_reminders
                SET response_status = 'confirmed',
                    response_at = NOW()
                WHERE id = $1
                RETURNING *
            `;
            const updateResult = await db.query(updateQuery, [reminder.id]);
            const updatedReminder = updateResult.rows[0];

            // Send email notification to organizer
            if (updatedReminder.organizer_email) {
                try {
                    await emailService.sendOrganizerNotification({
                        organizerEmail: updatedReminder.organizer_email,
                        candidateEmail: updatedReminder.candidate_email,
                        meetingSubject: updatedReminder.meeting_subject,
                        meetingStart: updatedReminder.meeting_start,
                        responseStatus: 'confirmed',
                        responseNotes: null
                    });
                    console.log(`[InterviewReminders] ✓ Sent organizer notification to ${updatedReminder.organizer_email}`);
                } catch (emailError) {
                    console.error('[InterviewReminders] Failed to send organizer notification:', emailError);
                    // Don't fail the whole operation if email fails
                }
            }

            // Emit Socket.IO event for real-time update
            const io = req.app.get('io');
            if (io) {
                io.emit('reminder-response', {
                    id: updatedReminder.id,
                    candidateEmail: updatedReminder.candidate_email,
                    meetingSubject: updatedReminder.meeting_subject,
                    meetingStart: updatedReminder.meeting_start,
                    responseStatus: 'confirmed',
                    responseAt: updatedReminder.response_at,
                    responseNotes: null
                });
                console.log(`[InterviewReminders] ✓ Emitted Socket.IO event for confirmation`);
            }

            // Send success response
            res.send(generateResponsePage({
                status: 'success',
                title: 'Interview Confirmed',
                message: `Thank you for confirming your attendance for "${reminder.meeting_subject}".`,
                icon: '✓',
                meetingDetails: reminder
            }));

            console.log(`[InterviewReminders] Confirmed: ${reminder.candidate_email} for meeting at ${reminder.meeting_start}`);

        } catch (error) {
            console.error('[InterviewReminders] Confirm error:', error);
            res.status(500).send(generateResponsePage({
                status: 'error',
                title: 'Error',
                message: 'An error occurred while processing your confirmation. Please contact the organizer directly.',
                icon: '❌'
            }));
        }
    });

    /**
     * Cancel interview
     * GET /api/interview-reminders/cancel/:token
     */
    router.get('/cancel/:token', async (req, res) => {
        try {
            const { token } = req.params;
            const { reason } = req.query;

            // Find reminder by token
            const findQuery = `
                SELECT *
                FROM interview_reminders
                WHERE reminder_token = $1
            `;
            const findResult = await db.query(findQuery, [token]);

            if (findResult.rows.length === 0) {
                return res.status(404).send(generateResponsePage({
                    status: 'error',
                    title: 'Invalid Link',
                    message: 'This reminder link is invalid or has expired.',
                    icon: '❌'
                }));
            }

            const reminder = findResult.rows[0];

            // Check if already responded
            if (reminder.response_status !== 'pending') {
                return res.send(generateResponsePage({
                    status: 'info',
                    title: 'Already Responded',
                    message: `You have already ${reminder.response_status} this interview on ${new Date(reminder.response_at).toLocaleString()}.`,
                    icon: 'ℹ️',
                    meetingDetails: reminder
                }));
            }

            // If no reason provided, show form
            if (!reason) {
                return res.send(generateCancellationForm(token, reminder));
            }

            // Update to cancelled
            const updateQuery = `
                UPDATE interview_reminders
                SET response_status = 'cancelled',
                    response_at = NOW(),
                    response_notes = $1
                WHERE id = $2
                RETURNING *
            `;
            const updateResult = await db.query(updateQuery, [reason, reminder.id]);
            const updatedReminder = updateResult.rows[0];

            // Send email notification to organizer with reason
            if (updatedReminder.organizer_email) {
                try {
                    await emailService.sendOrganizerNotification({
                        organizerEmail: updatedReminder.organizer_email,
                        candidateEmail: updatedReminder.candidate_email,
                        meetingSubject: updatedReminder.meeting_subject,
                        meetingStart: updatedReminder.meeting_start,
                        responseStatus: 'cancelled',
                        responseNotes: reason
                    });
                    console.log(`[InterviewReminders] ✓ Sent organizer notification to ${updatedReminder.organizer_email}`);
                } catch (emailError) {
                    console.error('[InterviewReminders] Failed to send organizer notification:', emailError);
                    // Don't fail the whole operation if email fails
                }
            }

            // Emit Socket.IO event for real-time update
            const io = req.app.get('io');
            if (io) {
                io.emit('reminder-response', {
                    id: updatedReminder.id,
                    candidateEmail: updatedReminder.candidate_email,
                    meetingSubject: updatedReminder.meeting_subject,
                    meetingStart: updatedReminder.meeting_start,
                    responseStatus: 'cancelled',
                    responseAt: updatedReminder.response_at,
                    responseNotes: reason
                });
                console.log(`[InterviewReminders] ✓ Emitted Socket.IO event for cancellation`);
            }

            // Send success response
            res.send(generateResponsePage({
                status: 'success',
                title: 'Interview Cancelled',
                message: `Your interview for "${reminder.meeting_subject}" has been cancelled. The organizer will be notified.`,
                icon: '✓',
                meetingDetails: reminder,
                note: reason ? `Reason: ${reason}` : null
            }));

            console.log(`[InterviewReminders] Cancelled: ${reminder.candidate_email} for meeting at ${reminder.meeting_start}. Reason: ${reason}`);

        } catch (error) {
            console.error('[InterviewReminders] Cancel error:', error);
            res.status(500).send(generateResponsePage({
                status: 'error',
                title: 'Error',
                message: 'An error occurred while processing your cancellation. Please contact the organizer directly.',
                icon: '❌'
            }));
        }
    });

    /**
     * Request reschedule
     * GET /api/interview-reminders/reschedule/:token
     */
    router.get('/reschedule/:token', async (req, res) => {
        try {
            const { token } = req.params;
            const { reason } = req.query;

            // Find reminder by token
            const findQuery = `
                SELECT *
                FROM interview_reminders
                WHERE reminder_token = $1
            `;
            const findResult = await db.query(findQuery, [token]);

            if (findResult.rows.length === 0) {
                return res.status(404).send(generateResponsePage({
                    status: 'error',
                    title: 'Invalid Link',
                    message: 'This reminder link is invalid or has expired.',
                    icon: '❌'
                }));
            }

            const reminder = findResult.rows[0];

            // Check if already responded
            if (reminder.response_status !== 'pending') {
                return res.send(generateResponsePage({
                    status: 'info',
                    title: 'Already Responded',
                    message: `You have already ${reminder.response_status} this interview on ${new Date(reminder.response_at).toLocaleString()}.`,
                    icon: 'ℹ️',
                    meetingDetails: reminder
                }));
            }

            // If no reason provided, show form
            if (!reason) {
                return res.send(generateRescheduleForm(token, reminder));
            }

            // Update to rescheduled
            const updateQuery = `
                UPDATE interview_reminders
                SET response_status = 'rescheduled',
                    response_at = NOW(),
                    response_notes = $1
                WHERE id = $2
                RETURNING *
            `;
            const updateResult = await db.query(updateQuery, [reason, reminder.id]);
            const updatedReminder = updateResult.rows[0];

            // Send email notification to organizer with reason
            if (updatedReminder.organizer_email) {
                try {
                    await emailService.sendOrganizerNotification({
                        organizerEmail: updatedReminder.organizer_email,
                        candidateEmail: updatedReminder.candidate_email,
                        meetingSubject: updatedReminder.meeting_subject,
                        meetingStart: updatedReminder.meeting_start,
                        responseStatus: 'rescheduled',
                        responseNotes: reason
                    });
                    console.log(`[InterviewReminders] ✓ Sent organizer notification to ${updatedReminder.organizer_email}`);
                } catch (emailError) {
                    console.error('[InterviewReminders] Failed to send organizer notification:', emailError);
                    // Don't fail the whole operation if email fails
                }
            }

            // Emit Socket.IO event for real-time update
            const io = req.app.get('io');
            if (io) {
                io.emit('reminder-response', {
                    id: updatedReminder.id,
                    candidateEmail: updatedReminder.candidate_email,
                    meetingSubject: updatedReminder.meeting_subject,
                    meetingStart: updatedReminder.meeting_start,
                    responseStatus: 'rescheduled',
                    responseAt: updatedReminder.response_at,
                    responseNotes: reason
                });
                console.log(`[InterviewReminders] ✓ Emitted Socket.IO event for reschedule`);
            }

            // Send success response
            res.send(generateResponsePage({
                status: 'success',
                title: 'Reschedule Requested',
                message: `Your reschedule request for "${reminder.meeting_subject}" has been submitted. The organizer will contact you to arrange a new time.`,
                icon: '✓',
                meetingDetails: reminder,
                note: reason ? `Reason: ${reason}` : null
            }));

            console.log(`[InterviewReminders] Reschedule requested: ${reminder.candidate_email} for meeting at ${reminder.meeting_start}. Reason: ${reason}`);

        } catch (error) {
            console.error('[InterviewReminders] Reschedule error:', error);
            res.status(500).send(generateResponsePage({
                status: 'error',
                title: 'Error',
                message: 'An error occurred while processing your request. Please contact the organizer directly.',
                icon: '❌'
            }));
        }
    });

    /**
     * Get reminder status (for admin/debugging)
     * GET /api/interview-reminders/status/:token
     */
    router.get('/status/:token', async (req, res) => {
        try {
            const { token } = req.params;

            const query = `
                SELECT id, candidate_email, meeting_subject, meeting_start, meeting_end,
                       response_status, response_at, response_notes, reminder_sent_at
                FROM interview_reminders
                WHERE reminder_token = $1
            `;
            const result = await db.query(query, [token]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Reminder not found' });
            }

            res.json(result.rows[0]);

        } catch (error) {
            console.error('[InterviewReminders] Status error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    /**
     * Get reminder statuses for multiple meetings
     * POST /api/interview-reminders/batch-status
     * Body: { meetings: [{ candidateEmail, meetingStart }] }
     */
    router.post('/batch-status', async (req, res) => {
        try {
            const { meetings } = req.body;

            if (!meetings || !Array.isArray(meetings)) {
                return res.status(400).json({ error: 'meetings array required' });
            }

            const results = [];

            for (const meeting of meetings) {
                const { candidateEmail, meetingStart } = meeting;

                if (!candidateEmail || !meetingStart) {
                    results.push({ candidateEmail, meetingStart, status: null });
                    continue;
                }

                const query = `
                    SELECT response_status, response_at, response_notes
                    FROM interview_reminders
                    WHERE candidate_email = $1
                      AND meeting_start = $2
                    ORDER BY created_at DESC
                    LIMIT 1
                `;

                const result = await db.query(query, [candidateEmail, new Date(meetingStart)]);

                if (result.rows.length > 0) {
                    results.push({
                        candidateEmail,
                        meetingStart,
                        status: result.rows[0].response_status,
                        responseAt: result.rows[0].response_at,
                        responseNotes: result.rows[0].response_notes
                    });
                } else {
                    results.push({ candidateEmail, meetingStart, status: null });
                }
            }

            res.json({ results });

        } catch (error) {
            console.error('[InterviewReminders] Batch status error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    return router;
}

/**
 * Generate HTML response page
 */
function generateResponsePage({ status, title, message, icon, meetingDetails, note }) {
    const statusColors = {
        success: '#2d5a27',
        error: '#d32f2f',
        info: '#1976d2'
    };

    const color = statusColors[status] || '#666';

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .container {
            background-color: #ffffff;
            border-radius: 8px;
            padding: 40px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            text-align: center;
        }
        .icon {
            font-size: 64px;
            margin-bottom: 20px;
        }
        h1 {
            color: ${color};
            margin: 0 0 20px 0;
            font-size: 28px;
        }
        .message {
            font-size: 16px;
            color: #666;
            margin-bottom: 20px;
        }
        .meeting-info {
            background-color: #f9f9f9;
            padding: 20px;
            border-radius: 6px;
            margin: 20px 0;
            text-align: left;
        }
        .meeting-info h3 {
            margin: 0 0 10px 0;
            color: #333;
        }
        .note {
            background-color: #fff3e0;
            padding: 15px;
            border-radius: 6px;
            margin: 20px 0;
            color: #e65100;
            font-size: 14px;
        }
        .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #ddd;
            font-size: 12px;
            color: #999;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">${icon}</div>
        <h1>${title}</h1>
        <div class="message">${message}</div>

        ${meetingDetails ? `
        <div class="meeting-info">
            <h3>${meetingDetails.meeting_subject}</h3>
            <p><strong>Date:</strong> ${new Date(meetingDetails.meeting_start).toLocaleString()}</p>
            ${meetingDetails.meeting_location ? `<p><strong>Location:</strong> ${meetingDetails.meeting_location}</p>` : ''}
            ${meetingDetails.organizer_name ? `<p><strong>Organizer:</strong> ${meetingDetails.organizer_name}</p>` : ''}
        </div>
        ` : ''}

        ${note ? `<div class="note">${note}</div>` : ''}

        <div class="footer">
            <p>If you have any questions, please contact the meeting organizer.</p>
        </div>
    </div>
</body>
</html>
    `.trim();
}

/**
 * Generate cancellation form
 */
function generateCancellationForm(token, reminder) {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cancel Interview</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .container {
            background-color: #ffffff;
            border-radius: 8px;
            padding: 40px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        h1 {
            color: #d32f2f;
            margin: 0 0 20px 0;
            font-size: 24px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            color: #555;
        }
        textarea {
            width: 100%;
            padding: 12px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-family: inherit;
            font-size: 14px;
            resize: vertical;
            min-height: 100px;
            box-sizing: border-box;
        }
        .btn {
            display: inline-block;
            padding: 12px 24px;
            margin: 8px 4px;
            border: none;
            border-radius: 6px;
            font-weight: 600;
            font-size: 14px;
            cursor: pointer;
            text-decoration: none;
        }
        .btn-cancel {
            background-color: #d32f2f;
            color: #ffffff;
        }
        .btn-cancel:hover {
            background-color: #b71c1c;
        }
        .btn-secondary {
            background-color: #666;
            color: #ffffff;
        }
        .btn-secondary:hover {
            background-color: #555;
        }
        .meeting-info {
            background-color: #f9f9f9;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 20px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Cancel Interview</h1>

        <div class="meeting-info">
            <h3>${reminder.meeting_subject}</h3>
            <p><strong>Date:</strong> ${new Date(reminder.meeting_start).toLocaleString()}</p>
        </div>

        <form method="GET">
            <div class="form-group">
                <label for="reason">Please let us know why you need to cancel (optional):</label>
                <textarea id="reason" name="reason" placeholder="E.g., Scheduling conflict, no longer interested, etc."></textarea>
            </div>

            <button type="submit" class="btn btn-cancel">Confirm Cancellation</button>
            <a href="javascript:history.back()" class="btn btn-secondary">Go Back</a>
        </form>
    </div>
</body>
</html>
    `.trim();
}

/**
 * Generate reschedule form
 */
function generateRescheduleForm(token, reminder) {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Request Reschedule</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .container {
            background-color: #ffffff;
            border-radius: 8px;
            padding: 40px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        h1 {
            color: #1976d2;
            margin: 0 0 20px 0;
            font-size: 24px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            color: #555;
        }
        textarea {
            width: 100%;
            padding: 12px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-family: inherit;
            font-size: 14px;
            resize: vertical;
            min-height: 100px;
            box-sizing: border-box;
        }
        .btn {
            display: inline-block;
            padding: 12px 24px;
            margin: 8px 4px;
            border: none;
            border-radius: 6px;
            font-weight: 600;
            font-size: 14px;
            cursor: pointer;
            text-decoration: none;
        }
        .btn-reschedule {
            background-color: #1976d2;
            color: #ffffff;
        }
        .btn-reschedule:hover {
            background-color: #1565c0;
        }
        .btn-secondary {
            background-color: #666;
            color: #ffffff;
        }
        .btn-secondary:hover {
            background-color: #555;
        }
        .meeting-info {
            background-color: #f9f9f9;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 20px;
        }
        .note {
            background-color: #e3f2fd;
            padding: 12px;
            border-radius: 6px;
            margin-bottom: 20px;
            color: #1565c0;
            font-size: 14px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Request Reschedule</h1>

        <div class="meeting-info">
            <h3>${reminder.meeting_subject}</h3>
            <p><strong>Current Date:</strong> ${new Date(reminder.meeting_start).toLocaleString()}</p>
        </div>

        <div class="note">
            The organizer will be notified of your reschedule request and will contact you to arrange a new time.
        </div>

        <form method="GET">
            <div class="form-group">
                <label for="reason">Please let us know why you need to reschedule and suggest alternative times (optional):</label>
                <textarea id="reason" name="reason" placeholder="E.g., Scheduling conflict. I'm available Tuesday or Wednesday afternoon."></textarea>
            </div>

            <button type="submit" class="btn btn-reschedule">Submit Request</button>
            <a href="javascript:history.back()" class="btn btn-secondary">Go Back</a>
        </form>
    </div>
</body>
</html>
    `.trim();
}

module.exports = initializeRoutes;
