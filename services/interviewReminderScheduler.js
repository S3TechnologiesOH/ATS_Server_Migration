/**
 * Interview Reminder Scheduler
 * Automatically sends reminder emails 24 hours before scheduled interviews
 */

const cron = require('node-cron');
const crypto = require('crypto');
const emailService = require('./emailService');

class InterviewReminderScheduler {
    constructor(pools, msalClient) {
        this.pools = pools;
        this.msalClient = msalClient;
        this.cronJob = null;
        this.isRunning = false;

        // Configuration
        this.REMINDER_HOURS_BEFORE = parseInt(process.env.REMINDER_HOURS_BEFORE || '24');
        this.CHECK_INTERVAL_CRON = process.env.REMINDER_CHECK_CRON || '0 */1 * * *'; // Every hour by default

        console.log(`[InterviewReminder] Configured to send reminders ${this.REMINDER_HOURS_BEFORE} hours before interviews`);
        console.log(`[InterviewReminder] Check interval: ${this.CHECK_INTERVAL_CRON}`);
    }

    /**
     * Start the reminder scheduler
     */
    start() {
        if (this.cronJob) {
            console.log('[InterviewReminder] Scheduler already running');
            return;
        }

        // Check if email service is configured
        if (!emailService.isConfigured()) {
            console.log('[InterviewReminder] ⚠️  Scheduler started but SMTP not configured');
            console.log('[InterviewReminder] Reminders will not be sent until SMTP is configured');
            console.log('[InterviewReminder] Add SMTP_USER and SMTP_PASSWORD to .env to enable');
        }

        // Validate cron expression
        if (!cron.validate(this.CHECK_INTERVAL_CRON)) {
            console.error(`[InterviewReminder] ✗ Invalid cron expression: ${this.CHECK_INTERVAL_CRON}`);
            return;
        }

        this.cronJob = cron.schedule(this.CHECK_INTERVAL_CRON, async () => {
            await this.checkAndSendReminders();
        });

        console.log('[InterviewReminder] ✓ Scheduler started (checking every hour)');

        // Run initial check after a short delay
        setTimeout(() => {
            this.checkAndSendReminders().catch(err => {
                console.error('[InterviewReminder] Initial check failed:', err.message);
            });
        }, 5000); // 5 seconds delay
    }

    /**
     * Stop the reminder scheduler
     */
    stop() {
        if (this.cronJob) {
            this.cronJob.stop();
            this.cronJob = null;
            console.log('[InterviewReminder] Scheduler stopped');
        }
    }

    /**
     * Main function to check for upcoming interviews and send reminders
     */
    async checkAndSendReminders() {
        if (this.isRunning) {
            console.log('[InterviewReminder] Check already in progress, skipping...');
            return;
        }

        this.isRunning = true;
        console.log('[InterviewReminder] Starting scheduled check for upcoming interviews...');

        try {
            // Check if email service is configured
            if (!emailService.isConfigured()) {
                console.warn('[InterviewReminder] Email service not configured, skipping check');
                return;
            }

            // Get access token for Microsoft Graph API
            const tokenResponse = await this.getAccessToken();
            if (!tokenResponse) {
                console.error('[InterviewReminder] Failed to get access token');
                return;
            }

            const accessToken = tokenResponse.accessToken;

            // Calculate time window for reminders
            const now = new Date();
            const reminderWindowStart = new Date(now.getTime() + (this.REMINDER_HOURS_BEFORE * 60 * 60 * 1000));
            const reminderWindowEnd = new Date(reminderWindowStart.getTime() + (60 * 60 * 1000)); // 1 hour window

            console.log(`[InterviewReminder] Checking for interviews between ${reminderWindowStart.toISOString()} and ${reminderWindowEnd.toISOString()}`);

            // Fetch upcoming meetings from Microsoft Graph
            const meetings = await this.fetchUpcomingMeetings(accessToken, reminderWindowStart, reminderWindowEnd);

            console.log(`[InterviewReminder] Found ${meetings.length} meetings in reminder window`);

            // Filter for candidate interviews and send reminders
            let sentCount = 0;
            let skippedCount = 0;

            for (const meeting of meetings) {
                const candidates = await this.getCandidateAttendeesForMeeting(meeting);

                if (candidates.length === 0) {
                    skippedCount++;
                    continue; // Skip non-candidate meetings
                }

                // Send reminder to each candidate
                for (const candidateEmail of candidates) {
                    const sent = await this.sendReminderIfNotSent(meeting, candidateEmail, accessToken);
                    if (sent) sentCount++;
                }
            }

            console.log(`[InterviewReminder] Check complete. Sent: ${sentCount}, Skipped: ${skippedCount}`);

        } catch (error) {
            console.error('[InterviewReminder] Error during check:', error);
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * Get Microsoft Graph access token
     */
    async getAccessToken() {
        try {
            const tokenRequest = {
                scopes: ['https://graph.microsoft.com/.default']
            };

            const response = await this.msalClient.acquireTokenByClientCredential(tokenRequest);
            return response;
        } catch (error) {
            console.error('[InterviewReminder] Failed to acquire token:', error);
            return null;
        }
    }

    /**
     * Fetch all users in the organization
     */
    async fetchAllUsers(accessToken) {
        try {
            const axios = require('axios');
            const users = [];
            let nextLink = 'https://graph.microsoft.com/v1.0/users?$select=id,userPrincipalName,displayName,mail&$top=999';

            while (nextLink) {
                const response = await axios.get(nextLink, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`
                    }
                });

                users.push(...(response.data.value || []));
                nextLink = response.data['@odata.nextLink'] || null;
            }

            console.log(`[InterviewReminder] Found ${users.length} users in organization`);
            return users;
        } catch (error) {
            console.error('[InterviewReminder] Failed to fetch users:', error.message);
            return [];
        }
    }

    /**
     * Fetch upcoming meetings from Microsoft Graph API for a specific user
     */
    async fetchUpcomingMeetingsForUser(accessToken, userId, startTime, endTime) {
        try {
            const axios = require('axios');

            const startISO = startTime.toISOString();
            const endISO = endTime.toISOString();

            const response = await axios.get(`https://graph.microsoft.com/v1.0/users/${userId}/calendarView`, {
                params: {
                    startDateTime: startISO,
                    endDateTime: endISO,
                    $select: 'id,subject,start,end,location,attendees,organizer,onlineMeeting,webLink',
                    $orderby: 'start/dateTime'
                },
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Prefer': 'outlook.timezone="UTC"'
                }
            });

            return response.data.value || [];
        } catch (error) {
            // Don't log errors for users without calendars or permission issues
            if (error.response && error.response.status === 404) {
                return [];
            }
            if (error.response && error.response.status === 403) {
                return [];
            }
            console.error(`[InterviewReminder] Failed to fetch meetings for user ${userId}:`, error.message);
            return [];
        }
    }

    /**
     * Fetch upcoming meetings from all users in the organization
     */
    async fetchUpcomingMeetings(accessToken, startTime, endTime) {
        try {
            // Fetch all users
            const users = await this.fetchAllUsers(accessToken);

            if (users.length === 0) {
                console.warn('[InterviewReminder] No users found in organization');
                return [];
            }

            // Fetch meetings for each user
            const allMeetings = [];
            const seenMeetingIds = new Set();

            for (const user of users) {
                const meetings = await this.fetchUpcomingMeetingsForUser(accessToken, user.id, startTime, endTime);

                // Deduplicate meetings (same meeting appears in multiple calendars)
                for (const meeting of meetings) {
                    if (!seenMeetingIds.has(meeting.id)) {
                        seenMeetingIds.add(meeting.id);
                        allMeetings.push(meeting);
                    }
                }
            }

            console.log(`[InterviewReminder] Found ${allMeetings.length} unique meetings across ${users.length} users`);
            return allMeetings;
        } catch (error) {
            console.error('[InterviewReminder] Failed to fetch meetings:', error.message);
            return [];
        }
    }

    /**
     * Get candidate attendees from a meeting
     */
    async getCandidateAttendeesForMeeting(meeting) {
        try {
            // Get ATS database pool
            const db = this.pools['ats'];
            if (!db) {
                console.warn('[InterviewReminder] ATS database not configured');
                return [];
            }

            // Get all attendee emails
            const attendees = meeting.attendees || [];
            const attendeeEmails = attendees
                .map(a => a.emailAddress?.address)
                .filter(Boolean)
                .map(email => email.toLowerCase());

            if (attendeeEmails.length === 0) {
                return [];
            }

            // Check which attendees are candidates in our database
            const query = `
                SELECT DISTINCT email
                FROM candidates
                WHERE LOWER(email) = ANY($1)
            `;

            const result = await db.query(query, [attendeeEmails]);
            return result.rows.map(r => r.email);

        } catch (error) {
            console.error('[InterviewReminder] Error checking candidate attendees:', error);
            return [];
        }
    }

    /**
     * Send reminder if not already sent
     */
    async sendReminderIfNotSent(meeting, candidateEmail, accessToken) {
        try {
            const db = this.pools['ats'];
            if (!db) return false;

            const meetingStart = new Date(meeting.start.dateTime);
            const meetingEnd = new Date(meeting.end.dateTime);

            // Check if reminder already sent for this meeting and candidate
            const checkQuery = `
                SELECT id, reminder_sent_at, response_status
                FROM interview_reminders
                WHERE candidate_email = $1
                  AND meeting_start = $2
                  AND reminder_sent_at IS NOT NULL
            `;

            const existingResult = await db.query(checkQuery, [candidateEmail, meetingStart]);

            if (existingResult.rows.length > 0) {
                const existing = existingResult.rows[0];
                console.log(`[InterviewReminder] Reminder already sent to ${candidateEmail} for meeting at ${meetingStart.toISOString()} (status: ${existing.response_status})`);
                return false;
            }

            // Generate secure token for action links
            const reminderToken = crypto.randomBytes(32).toString('hex');

            // Create reminder record
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
                meeting.subject || 'Interview',
                meetingStart,
                meetingEnd,
                meeting.location?.displayName || (meeting.onlineMeeting ? 'Microsoft Teams' : null),
                meeting.webLink || meeting.onlineMeeting?.joinUrl || null,
                meeting.organizer?.emailAddress?.name || null,
                meeting.organizer?.emailAddress?.address || null,
                reminderToken
            ]);

            const reminderId = insertResult.rows[0].id;

            // Send email
            const reminderData = {
                candidate_email: candidateEmail,
                meeting_subject: meeting.subject || 'Interview',
                meeting_start: meetingStart.toISOString(),
                meeting_end: meetingEnd.toISOString(),
                meeting_location: meeting.location?.displayName || (meeting.onlineMeeting ? 'Microsoft Teams' : null),
                meeting_web_link: meeting.webLink || meeting.onlineMeeting?.joinUrl || null,
                organizer_name: meeting.organizer?.emailAddress?.name || null,
                reminder_token: reminderToken
            };

            await emailService.sendInterviewReminder(reminderData);

            console.log(`[InterviewReminder] ✓ Sent reminder to ${candidateEmail} for "${meeting.subject}" at ${meetingStart.toISOString()}`);
            return true;

        } catch (error) {
            console.error(`[InterviewReminder] Failed to send reminder to ${candidateEmail}:`, error);
            return false;
        }
    }

    /**
     * Manual trigger for testing (can be called via API endpoint)
     */
    async triggerManualCheck() {
        console.log('[InterviewReminder] Manual check triggered');
        return this.checkAndSendReminders();
    }
}

module.exports = InterviewReminderScheduler;
