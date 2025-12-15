/**
 * Email Service
 * Handles sending emails using Mailgun API or SMTP (nodemailer)
 */

const nodemailer = require('nodemailer');
const FormData = require('form-data');
const Mailgun = require('mailgun.js');
const path = require('path');
const axios = require('axios');

class EmailService {
    constructor() {
        this.transporter = null;
        this.mailgunClient = null;
        this.mailgunDomain = null;
        this.provider = null; // 'mailgun' or 'smtp'
        this.from = process.env.EMAIL_FROM || 'noreply@s3protection.com';
        this.initialize();
    }

    /**
     * Initialize the email service (Mailgun or SMTP)
     */
    initialize() {
        try {
            // Try Mailgun first (preferred)
            if (process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN) {
                const mailgun = new Mailgun(FormData);
                this.mailgunClient = mailgun.client({
                    username: 'api',
                    key: process.env.MAILGUN_API_KEY,
                    url: process.env.MAILGUN_API_URL || 'https://api.mailgun.net' // Use EU endpoint if needed
                });
                this.mailgunDomain = process.env.MAILGUN_DOMAIN;
                this.provider = 'mailgun';
                console.log(`[EmailService] ✓ Initialized with Mailgun (domain: ${this.mailgunDomain})`);
                return;
            }

            // Fallback to SMTP
            const emailConfig = {
                host: process.env.SMTP_HOST || 'smtp.gmail.com',
                port: parseInt(process.env.SMTP_PORT || '587'),
                secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
                auth: {
                    user: process.env.SMTP_USER,
                    pass: process.env.SMTP_PASSWORD
                }
            };

            // Only create transporter if SMTP credentials are configured
            if (emailConfig.auth.user && emailConfig.auth.pass) {
                this.transporter = nodemailer.createTransporter(emailConfig);
                this.provider = 'smtp';
                console.log(`[EmailService] ✓ Initialized with SMTP (host: ${emailConfig.host}:${emailConfig.port})`);
                return;
            }

            // No email service configured
            console.log('[EmailService] ⚠️  Email not configured - sending disabled');
            console.log('[EmailService] To enable, add one of these to .env:');
            console.log('[EmailService]   - Mailgun: MAILGUN_API_KEY + MAILGUN_DOMAIN');
            console.log('[EmailService]   - SMTP: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD');

        } catch (error) {
            console.error('[EmailService] ✗ Initialization failed:', error.message);
            this.transporter = null;
            this.mailgunClient = null;
            this.provider = null;
        }
    }

    /**
     * Check if email service is configured and ready
     */
    isConfigured() {
        return this.provider !== null;
    }

    /**
     * Send an email
     * @param {Object} options - Email options
     * @param {string} options.to - Recipient email address
     * @param {string} options.subject - Email subject
     * @param {string} options.html - HTML content
     * @param {string} options.text - Plain text content (optional, will be generated from HTML if not provided)
     * @returns {Promise<Object>} Send result
     */
    async sendMail({ to, subject, html, text, headers }) {
        if (!this.isConfigured()) {
            throw new Error('Email service not configured. Please configure email settings in .env');
        }

        try {
            if (this.provider === 'mailgun') {
                return await this.sendViaMailgun({ to, subject, html, text, headers });
            } else if (this.provider === 'smtp') {
                return await this.sendViaSMTP({ to, subject, html, text, headers });
            }
        } catch (error) {
            console.error(`[EmailService] Failed to send email to ${to}:`, error);
            throw error;
        }
    }

    /**
     * Send email via Mailgun API
     */
    async sendViaMailgun({ to, subject, html, text, headers }) {
        const messageData = {
            from: this.from,
            to: [to],
            subject: subject,
            html: html,
            text: text || this.stripHtml(html)
        };

        // Add custom headers for email threading if provided
        if (headers) {
            messageData['h:In-Reply-To'] = headers['In-Reply-To'];
            messageData['h:References'] = headers['References'];
        }

        const response = await this.mailgunClient.messages.create(this.mailgunDomain, messageData);
        console.log(`[EmailService] Email sent via Mailgun to ${to}: ${response.id}`);
        return { success: true, messageId: response.id, provider: 'mailgun' };
    }

    /**
     * Send email via SMTP (nodemailer)
     */
    async sendViaSMTP({ to, subject, html, text, headers }) {
        const mailOptions = {
            from: this.from,
            to,
            subject,
            html,
            text: text || this.stripHtml(html)
        };

        // Add custom headers for email threading if provided
        if (headers) {
            mailOptions.headers = headers;
        }

        const info = await this.transporter.sendMail(mailOptions);
        console.log(`[EmailService] Email sent via SMTP to ${to}: ${info.messageId}`);
        return { success: true, messageId: info.messageId, provider: 'smtp' };
    }

    /**
     * Send an email using the logged-in user's Microsoft Graph access token
     * This allows sending email on behalf of the authenticated user
     * @param {Object} options - Email options
     * @param {string} options.accessToken - User's Microsoft Graph access token
     * @param {string} options.to - Recipient email address
     * @param {string} options.subject - Email subject
     * @param {string} options.html - HTML content
     * @param {Object} options.headers - Optional email headers for threading
     * @returns {Promise<Object>} Send result
     */
    async sendMailAsUser({ accessToken, to, subject, html, headers }) {
        if (!accessToken) {
            throw new Error('User access token is required to send email');
        }

        try {
            // Prepare the email message in Microsoft Graph format
            const message = {
                message: {
                    subject: subject,
                    body: {
                        contentType: 'HTML',
                        content: html
                    },
                    toRecipients: [
                        {
                            emailAddress: {
                                address: to
                            }
                        }
                    ]
                },
                saveToSentItems: true
            };

            // Add threading headers if provided (In-Reply-To, References)
            if (headers) {
                message.message.internetMessageHeaders = [];
                if (headers['In-Reply-To']) {
                    message.message.internetMessageHeaders.push({
                        name: 'In-Reply-To',
                        value: headers['In-Reply-To']
                    });
                }
                if (headers['References']) {
                    message.message.internetMessageHeaders.push({
                        name: 'References',
                        value: headers['References']
                    });
                }
            }

            // Send email via Microsoft Graph API
            const response = await axios.post(
                'https://graph.microsoft.com/v1.0/me/sendMail',
                message,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            console.log(`[EmailService] Email sent via Microsoft Graph to ${to}`);
            return { success: true, provider: 'microsoft-graph' };

        } catch (error) {
            console.error(`[EmailService] Failed to send email via Microsoft Graph to ${to}:`, error.response?.data || error.message);
            throw new Error(`Failed to send email: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /**
     * Send interview reminder email
     * @param {Object} reminder - Reminder data
     * @returns {Promise<Object>} Send result
     */
    async sendInterviewReminder(reminder) {
        const { candidate_email, meeting_subject, meeting_start, meeting_end, meeting_location, meeting_web_link, organizer_name, reminder_token } = reminder;

        const startDate = new Date(meeting_start);
        const endDate = new Date(meeting_end);

        // Format date and time
        const dateStr = startDate.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const timeStr = startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const endTimeStr = endDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const duration = Math.round((endDate - startDate) / 60000); // minutes

        // Base URL for action links (use environment variable or default)
        const baseUrl = process.env.API_BASE_URL || 'https://ats.s3protection.com';
        const confirmUrl = `${baseUrl}/api/interview-reminders/confirm/${reminder_token}`;
        const cancelUrl = `${baseUrl}/api/interview-reminders/cancel/${reminder_token}`;
        const rescheduleUrl = `${baseUrl}/api/interview-reminders/reschedule/${reminder_token}`;

        const subject = `Reminder: Interview Tomorrow - ${meeting_subject}`;

        const html = this.generateReminderHtml({
            meeting_subject,
            dateStr,
            timeStr,
            endTimeStr,
            duration,
            meeting_location,
            meeting_web_link,
            organizer_name,
            confirmUrl,
            cancelUrl,
            rescheduleUrl
        });

        return this.sendMail({
            to: candidate_email,
            subject,
            html
        });
    }

    /**
     * Generate HTML for interview reminder email
     */
    generateReminderHtml({ meeting_subject, dateStr, timeStr, endTimeStr, duration, meeting_location, meeting_web_link, organizer_name, confirmUrl, cancelUrl, rescheduleUrl }) {
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Interview Reminder</title>
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
            padding: 30px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .header {
            text-align: center;
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 2px solid #2d5a27;
        }
        .header h1 {
            color: #2d5a27;
            margin: 0;
            font-size: 24px;
        }
        .meeting-details {
            background-color: #f9f9f9;
            border-left: 4px solid #2d5a27;
            padding: 20px;
            margin: 20px 0;
            border-radius: 4px;
        }
        .meeting-details h2 {
            margin: 0 0 15px 0;
            color: #2d5a27;
            font-size: 20px;
        }
        .detail-row {
            margin: 10px 0;
            display: flex;
            align-items: flex-start;
        }
        .detail-label {
            font-weight: 600;
            min-width: 100px;
            color: #555;
        }
        .detail-value {
            flex: 1;
            color: #333;
        }
        .action-buttons {
            margin: 30px 0;
            text-align: center;
        }
        .btn {
            display: inline-block;
            padding: 12px 24px;
            margin: 8px;
            text-decoration: none;
            border-radius: 6px;
            font-weight: 600;
            font-size: 14px;
            transition: background-color 0.2s;
        }
        .btn-confirm {
            background-color: #2d5a27;
            color: #ffffff;
        }
        .btn-confirm:hover {
            background-color: #1f3e1b;
        }
        .btn-cancel {
            background-color: #d32f2f;
            color: #ffffff;
        }
        .btn-cancel:hover {
            background-color: #b71c1c;
        }
        .btn-reschedule {
            background-color: #1976d2;
            color: #ffffff;
        }
        .btn-reschedule:hover {
            background-color: #1565c0;
        }
        .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #ddd;
            text-align: center;
            font-size: 12px;
            color: #666;
        }
        .join-link {
            background-color: #e3f2fd;
            padding: 15px;
            border-radius: 6px;
            margin: 15px 0;
            text-align: center;
        }
        .join-link a {
            color: #1976d2;
            text-decoration: none;
            font-weight: 600;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📅 Interview Reminder</h1>
            <p style="margin: 10px 0 0 0; color: #666;">Your interview is scheduled for tomorrow</p>
        </div>

        <div class="meeting-details">
            <h2>${meeting_subject}</h2>

            <div class="detail-row">
                <span class="detail-label">📅 Date:</span>
                <span class="detail-value">${dateStr}</span>
            </div>

            <div class="detail-row">
                <span class="detail-label">⏰ Time:</span>
                <span class="detail-value">${timeStr} - ${endTimeStr} (${duration} minutes)</span>
            </div>

            ${organizer_name ? `
            <div class="detail-row">
                <span class="detail-label">👤 Organizer:</span>
                <span class="detail-value">${organizer_name}</span>
            </div>
            ` : ''}

            ${meeting_location ? `
            <div class="detail-row">
                <span class="detail-label">📍 Location:</span>
                <span class="detail-value">${meeting_location}</span>
            </div>
            ` : ''}

            ${meeting_web_link ? `
            <div class="join-link">
                <a href="${meeting_web_link}" target="_blank">🔗 Join Meeting (Outlook)</a>
            </div>
            ` : ''}
        </div>

        <p style="margin: 20px 0; text-align: center; color: #555;">
            Please confirm your attendance or let us know if you need to reschedule:
        </p>

        <div class="action-buttons">
            <a href="${confirmUrl}" class="btn btn-confirm">✓ Confirm Attendance</a>
            <a href="${rescheduleUrl}" class="btn btn-reschedule">🔄 Request Reschedule</a>
            <a href="${cancelUrl}" class="btn btn-cancel">✗ Cancel Interview</a>
        </div>

        <div class="footer">
            <p>If you have any questions, please contact the organizer directly.</p>
            <p style="margin-top: 10px; color: #999;">
                This is an automated reminder. Please do not reply to this email.
            </p>
        </div>
    </div>
</body>
</html>
        `.trim();
    }

    /**
     * Send organizer notification when candidate responds to reminder
     * @param {Object} data - Notification data
     * @returns {Promise<Object>} Send result
     */
    async sendOrganizerNotification({ organizerEmail, candidateEmail, meetingSubject, meetingStart, responseStatus, responseNotes }) {
        if (!organizerEmail) {
            console.log('[EmailService] No organizer email provided, skipping notification');
            return { success: false, error: 'No organizer email' };
        }

        const startDate = new Date(meetingStart);
        const dateStr = startDate.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const timeStr = startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

        const statusText = {
            confirmed: 'confirmed their attendance',
            cancelled: 'cancelled',
            rescheduled: 'requested to reschedule'
        }[responseStatus] || responseStatus;

        const statusIcon = {
            confirmed: '✓',
            cancelled: '✗',
            rescheduled: '🔄'
        }[responseStatus] || '📧';

        const statusColor = {
            confirmed: '#28a745',
            cancelled: '#dc3545',
            rescheduled: '#17a2b8'
        }[responseStatus] || '#666';

        const subject = `${statusIcon} Candidate Response: ${meetingSubject}`;

        const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Candidate Response Notification</title>
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
            padding: 30px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .header {
            text-align: center;
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 2px solid ${statusColor};
        }
        .header h1 {
            color: ${statusColor};
            margin: 0;
            font-size: 24px;
        }
        .status-badge {
            display: inline-block;
            background-color: ${statusColor};
            color: #ffffff;
            padding: 8px 16px;
            border-radius: 20px;
            font-weight: 600;
            font-size: 14px;
            margin: 10px 0;
        }
        .details {
            background-color: #f9f9f9;
            border-left: 4px solid ${statusColor};
            padding: 20px;
            margin: 20px 0;
            border-radius: 4px;
        }
        .detail-row {
            margin: 10px 0;
        }
        .detail-label {
            font-weight: 600;
            color: #555;
        }
        .detail-value {
            color: #333;
            margin-left: 5px;
        }
        .notes-box {
            background-color: #fff3cd;
            border: 1px solid #ffc107;
            border-radius: 6px;
            padding: 15px;
            margin: 20px 0;
        }
        .notes-box h3 {
            margin: 0 0 10px 0;
            color: #856404;
            font-size: 16px;
        }
        .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #ddd;
            text-align: center;
            font-size: 12px;
            color: #666;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>${statusIcon} Candidate Response</h1>
            <div class="status-badge">${statusText.toUpperCase()}</div>
        </div>

        <div class="details">
            <div class="detail-row">
                <span class="detail-label">Candidate:</span>
                <span class="detail-value">${candidateEmail}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Meeting:</span>
                <span class="detail-value">${meetingSubject}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Date/Time:</span>
                <span class="detail-value">${dateStr} at ${timeStr}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Response:</span>
                <span class="detail-value" style="color: ${statusColor}; font-weight: 600;">${statusText}</span>
            </div>
        </div>

        ${responseNotes ? `
        <div class="notes-box">
            <h3>Candidate's Notes:</h3>
            <p style="margin: 0; color: #333;">${responseNotes}</p>
        </div>
        ` : ''}

        ${responseStatus === 'confirmed' ? `
        <p style="text-align: center; color: #28a745; font-size: 16px; margin: 20px 0;">
            <strong>Great news!</strong> The candidate has confirmed their attendance.
        </p>
        ` : ''}

        ${responseStatus === 'cancelled' ? `
        <p style="text-align: center; color: #dc3545; font-size: 16px; margin: 20px 0;">
            The candidate has cancelled this interview. ${responseNotes ? 'Please see their reason above.' : ''}
        </p>
        ` : ''}

        ${responseStatus === 'rescheduled' ? `
        <p style="text-align: center; color: #17a2b8; font-size: 16px; margin: 20px 0;">
            The candidate has requested to reschedule. ${responseNotes ? 'Please review their availability notes above and reach out to arrange a new time.' : 'Please reach out to arrange a new time.'}
        </p>
        ` : ''}

        <div class="footer">
            <p>This is an automated notification from the Application Management Dashboard.</p>
        </div>
    </div>
</body>
</html>
        `.trim();

        return this.sendMail({
            to: organizerEmail,
            subject,
            html
        });
    }

    /**
     * Send candidate rejection email
     * @param {Object} options - Rejection email options
     * @param {string} options.candidateEmail - Candidate's email
     * @param {string} options.candidateName - Candidate's name
     * @param {string} options.jobTitle - Job title they applied for
     * @param {string} options.rejectionReason - Reason for rejection
     * @param {boolean} options.shouldArchive - Whether candidate will be archived
     * @param {string} options.feedbackToken - Unique token for feedback requests
     * @returns {Promise<Object>} Send result
     */
    async sendRejectionEmail({ candidateEmail, candidateName, jobTitle, rejectionReason, shouldArchive, feedbackToken }) {
        const baseUrl = process.env.API_BASE_URL || 'https://ats.s3protection.com';
        const feedbackUrl = `${baseUrl}/ats/api/ats/rejection-feedback/request/${feedbackToken}`;

        // Customize message based on rejection reason
        const messageTemplates = {
            'unqualified': {
                message: 'After careful review of your application and qualifications, we have decided to move forward with candidates whose experience more closely aligns with the specific requirements of this role.',
                keepInTouch: false
            },
            'more-qualified': {
                message: 'We were impressed with your qualifications and experience. However, we have decided to move forward with a candidate whose background more closely matches the specific needs of this particular role. We would love to keep your information on file for future opportunities that may be a better fit.',
                keepInTouch: true
            },
            'failed-background': {
                message: 'After completing our background verification process, we are unable to move forward with your application at this time.',
                keepInTouch: false
            },
            'accepted-other': {
                message: 'We understand that you have accepted another opportunity. We appreciate your interest in our organization and would love to stay in touch for potential future opportunities.',
                keepInTouch: true
            },
            'culture-fit': {
                message: 'After careful consideration, we have determined that this particular role may not be the best fit. We appreciate the time you invested in the interview process.',
                keepInTouch: false
            },
            'overqualified': {
                message: 'Your impressive qualifications and experience level exceed the requirements for this particular role. We would like to keep your information on file and will reach out if a more senior position becomes available that better matches your expertise.',
                keepInTouch: true
            },
            'compensation': {
                message: 'While we were impressed with your qualifications, we are unable to meet your compensation expectations for this role at this time. We would like to keep your information on file for future opportunities where we may be able to better align with your requirements.',
                keepInTouch: true
            },
            'other': {
                message: 'After careful review, we have decided to move forward with other candidates for this position.',
                keepInTouch: false
            }
        };

        const template = messageTemplates[rejectionReason] || messageTemplates['other'];
        const subject = `Update on Your Application - ${jobTitle}`;

        const html = this.generateRejectionHtml({
            candidateName,
            jobTitle,
            message: template.message,
            keepInTouch: template.keepInTouch,
            shouldArchive,
            feedbackUrl
        });

        return this.sendMail({
            to: candidateEmail,
            subject,
            html
        });
    }

    /**
     * Generate HTML for rejection email
     */
    generateRejectionHtml({ candidateName, jobTitle, message, keepInTouch, shouldArchive, feedbackUrl }) {
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Application Update</title>
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
            padding: 30px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .header {
            text-align: center;
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 2px solid #666;
        }
        .header h1 {
            color: #333;
            margin: 0;
            font-size: 24px;
        }
        .content {
            margin: 20px 0;
            line-height: 1.8;
        }
        .job-title {
            background-color: #f0f0f0;
            padding: 12px;
            border-radius: 6px;
            text-align: center;
            font-weight: 600;
            margin: 20px 0;
            color: #555;
        }
        .message-box {
            background-color: #f9f9f9;
            border-left: 4px solid #666;
            padding: 20px;
            margin: 20px 0;
            border-radius: 4px;
        }
        .keep-in-touch {
            background-color: #e8f5e9;
            border-left: 4px solid #4caf50;
            padding: 20px;
            margin: 20px 0;
            border-radius: 4px;
        }
        .keep-in-touch h3 {
            margin: 0 0 10px 0;
            color: #2e7d32;
            font-size: 16px;
        }
        .feedback-section {
            background-color: #e3f2fd;
            border: 2px solid #2196f3;
            border-radius: 8px;
            padding: 20px;
            margin: 30px 0;
            text-align: center;
        }
        .feedback-section h3 {
            margin: 0 0 15px 0;
            color: #1565c0;
            font-size: 18px;
        }
        .feedback-section p {
            margin: 0 0 20px 0;
            color: #555;
            font-size: 14px;
        }
        .btn {
            display: inline-block;
            padding: 12px 30px;
            background-color: #2196f3;
            color: #ffffff;
            text-decoration: none;
            border-radius: 6px;
            font-weight: 600;
            font-size: 15px;
            transition: background-color 0.2s;
        }
        .btn:hover {
            background-color: #1976d2;
        }
        .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #ddd;
            text-align: center;
            font-size: 12px;
            color: #666;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Application Status Update</h1>
        </div>

        <div class="content">
            <p>Dear ${candidateName},</p>

            <p>Thank you for your interest in the following position with our organization:</p>

            <div class="job-title">
                ${jobTitle}
            </div>

            <div class="message-box">
                <p style="margin: 0;">${message}</p>
            </div>

            ${keepInTouch ? `
            <div class="keep-in-touch">
                <h3>📋 We'd Like to Stay Connected</h3>
                <p style="margin: 0;">Your profile will remain in our system, and we will reach out if a suitable opportunity arises that matches your qualifications and career goals. We encourage you to check our careers page periodically for new openings.</p>
            </div>
            ` : ''}

            <p>We appreciate the time and effort you put into your application and wish you the very best in your career search.</p>
        </div>

        <div class="feedback-section">
            <h3>💬 We Value Your Feedback</h3>
            <p>We're always looking to improve our hiring process. If you'd like to share your experience or request specific feedback about your application, please click the button below:</p>
            <a href="${feedbackUrl}" class="btn">Request Feedback</a>
            <p style="margin-top: 15px; font-size: 12px; color: #777;">
                This link will allow you to submit a feedback request that our team will review and respond to.
            </p>
        </div>

        <div class="footer">
            <p>Sincerely,<br>The Hiring Team</p>
            <p style="margin-top: 20px; color: #999;">
                This is an automated notification. Please do not reply directly to this email.
            </p>
        </div>
    </div>
</body>
</html>
        `.trim();
    }

    /**
     * Send application confirmation email to candidate
     */
    async sendApplicationConfirmation({ candidateEmail, candidateName, jobTitle }) {
        if (!this.isConfigured()) {
            throw new Error('Email service not configured');
        }

        const subject = `Application Received - ${jobTitle}`;
        const html = this.generateApplicationConfirmationHtml({ candidateName, jobTitle });
        const text = this.stripHtml(html);

        return this.sendMail({
            to: candidateEmail,
            subject: subject,
            html: html,
            text: text
        });
    }

    /**
     * Generate HTML for application confirmation email
     */
    generateApplicationConfirmationHtml({ candidateName, jobTitle }) {
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
        <tr>
            <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" style="background-color: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                    <!-- Header -->
                    <tr>
                        <td style="padding: 40px 40px 30px; text-align: center; border-bottom: 1px solid #e0e0e0;">
                            <h1 style="margin: 0; color: #28a745; font-size: 28px; font-weight: 600;">✓ Application Received</h1>
                        </td>
                    </tr>

                    <!-- Content -->
                    <tr>
                        <td style="padding: 40px;">
                            <p style="margin: 0 0 20px; color: #333; font-size: 16px; line-height: 1.6;">
                                Dear ${candidateName},
                            </p>

                            <p style="margin: 0 0 20px; color: #555; font-size: 16px; line-height: 1.6;">
                                Thank you for your application for the <strong>${jobTitle}</strong> position. We have successfully received your submission.
                            </p>

                            <div style="background-color: #f8f9fa; border-left: 4px solid #28a745; padding: 20px; margin: 30px 0; border-radius: 4px;">
                                <p style="margin: 0; color: #555; font-size: 15px; line-height: 1.6;">
                                    <strong>What happens next?</strong><br>
                                    Your application will be reviewed by someone on our talent team for consideration. We carefully evaluate each application to find the best fit for our team.
                                </p>
                            </div>

                            <p style="margin: 0 0 20px; color: #555; font-size: 16px; line-height: 1.6;">
                                If your qualifications match our current needs, a member of our team will reach out to you to discuss next steps.
                            </p>

                            <p style="margin: 0 0 20px; color: #555; font-size: 16px; line-height: 1.6;">
                                We appreciate your interest in joining our team and the time you invested in your application.
                            </p>

                            <p style="margin: 30px 0 0; color: #555; font-size: 16px; line-height: 1.6;">
                                Best regards,<br>
                                <strong>Talent Acquisition Team</strong>
                            </p>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="padding: 20px 40px; background-color: #f8f8f8; border-top: 1px solid #e0e0e0; border-radius: 0 0 8px 8px;">
                            <p style="margin: 0; color: #999; font-size: 12px; line-height: 1.5; text-align: center;">
                                This is an automated confirmation from our Applicant Tracking System.<br>
                                Please do not reply to this email.
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
        `.trim();
    }

    /**
     * Strip HTML tags for plain text version
     */
    stripHtml(html) {
        return html
            .replace(/<style[^>]*>.*?<\/style>/gis, '')
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Verify the email configuration
     */
    async verify() {
        if (!this.isConfigured()) {
            return { success: false, error: 'Email service not configured' };
        }

        try {
            if (this.provider === 'mailgun') {
                // Verify Mailgun by checking domain
                const domain = await this.mailgunClient.domains.get(this.mailgunDomain);
                console.log('[EmailService] Mailgun connection verified successfully');
                return { success: true, provider: 'mailgun', domain: domain.name };
            } else if (this.provider === 'smtp') {
                await this.transporter.verify();
                console.log('[EmailService] SMTP connection verified successfully');
                return { success: true, provider: 'smtp' };
            }
        } catch (error) {
            console.error('[EmailService] Verification failed:', error);
            return { success: false, error: error.message };
        }
    }
}

// Export singleton instance
module.exports = new EmailService();
