/**
 * Rejection Feedback Routes Module
 * Handles rejection emails and candidate feedback requests
 */

const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const {
  DEFAULT_SCHEMA,
  PEOPLE_TABLE,
  PEOPLE_PK,
  APP_TABLE,
} = require("./helpers");

// Email service will be injected via init
let emailService = null;

function initRejection(deps) {
  if (deps.emailService) {
    emailService = deps.emailService;
  }
}

// ==================== REJECTION EMAILS ====================
// POST /send-rejection-email - Send rejection email to candidate
router.post("/send-rejection-email", async (req, res) => {
  try {
    const { candidateId, rejectionReason, shouldArchive } = req.body;

    if (!candidateId || !rejectionReason) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Get candidate details
    const candidateResult = await req.db.query(
      `SELECT candidate_id, email, first_name, last_name FROM ${PEOPLE_TABLE} WHERE candidate_id = $1`,
      [candidateId]
    );

    if (candidateResult.rows.length === 0) {
      return res.status(404).json({ error: "Candidate not found" });
    }

    const candidate = candidateResult.rows[0];
    const candidateName =
      `${candidate.first_name || ""} ${candidate.last_name || ""}`.trim() ||
      "Candidate";
    const candidateEmail = candidate.email;

    if (!candidateEmail) {
      return res.status(400).json({ error: "Candidate has no email address" });
    }

    // Get job title from the most recent application for this candidate
    let jobTitle = "the position";
    try {
      const applicationResult = await req.db.query(
        `SELECT jl.job_title
         FROM ${APP_TABLE} a
         LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON a.job_requisition_id = jl.job_requisition_id
         WHERE a.candidate_id = $1
         ORDER BY a.application_date DESC
         LIMIT 1`,
        [candidateId]
      );

      if (
        applicationResult.rows.length > 0 &&
        applicationResult.rows[0].job_title
      ) {
        jobTitle = applicationResult.rows[0].job_title;
      }
    } catch (jobError) {
      console.warn(
        "[ATS] Could not fetch job title, using default:",
        jobError.message
      );
    }

    // Generate unique feedback token
    const feedbackToken = crypto.randomBytes(32).toString("hex");

    // Create feedback request record in database
    const ensureFeedbackTableSQL = `
      CREATE TABLE IF NOT EXISTS ${DEFAULT_SCHEMA}.rejection_feedback_requests (
        id SERIAL PRIMARY KEY,
        candidate_id INTEGER NOT NULL,
        candidate_email VARCHAR(255) NOT NULL,
        candidate_name VARCHAR(255),
        job_title VARCHAR(255),
        rejection_reason VARCHAR(100),
        feedback_token VARCHAR(64) UNIQUE NOT NULL,
        status VARCHAR(50) DEFAULT 'awaiting_candidate',
        candidate_message TEXT,
        admin_response TEXT,
        rejection_email_message_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        responded_at TIMESTAMP,
        responded_by VARCHAR(255)
      )
    `;
    await req.db.query(ensureFeedbackTableSQL);

    // Add rejection_email_message_id column if table exists but doesn't have it
    try {
      await req.db.query(`
        ALTER TABLE ${DEFAULT_SCHEMA}.rejection_feedback_requests
        ADD COLUMN IF NOT EXISTS rejection_email_message_id TEXT
      `);
    } catch (alterError) {
      console.log(
        "[ATS] rejection_email_message_id column already exists or error:",
        alterError.message
      );
    }

    // Insert feedback request with 'awaiting_candidate' status
    await req.db.query(
      `INSERT INTO ${DEFAULT_SCHEMA}.rejection_feedback_requests
       (candidate_id, candidate_email, candidate_name, job_title, rejection_reason, feedback_token, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'awaiting_candidate')`,
      [
        candidateId,
        candidateEmail,
        candidateName,
        jobTitle,
        rejectionReason,
        feedbackToken,
      ]
    );

    // Send rejection email
    if (!emailService) {
      return res.status(500).json({ error: "Email service not configured" });
    }

    const emailResult = await emailService.sendRejectionEmail({
      candidateEmail,
      candidateName,
      jobTitle,
      rejectionReason,
      shouldArchive,
      feedbackToken,
    });

    // Store the Message-ID from the sent email for threading
    if (emailResult.messageId) {
      await req.db.query(
        `UPDATE ${DEFAULT_SCHEMA}.rejection_feedback_requests
         SET rejection_email_message_id = $1
         WHERE feedback_token = $2`,
        [emailResult.messageId, feedbackToken]
      );
    }

    return res.json({
      success: true,
      messageId: emailResult.messageId,
      provider: emailResult.provider,
    });
  } catch (error) {
    console.error("[ATS] Error sending rejection email:", error);
    return res
      .status(500)
      .json({ error: "Failed to send rejection email", detail: error.message });
  }
});

// POST /rejection-feedback/create - Create feedback request token
router.post("/rejection-feedback/create", async (req, res) => {
  try {
    const { candidateId, token, rejectionReason } = req.body;

    if (!candidateId || !token) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Create table if it doesn't exist
    await req.db.query(`
      CREATE TABLE IF NOT EXISTS ${DEFAULT_SCHEMA}.rejection_feedback_requests (
        id SERIAL PRIMARY KEY,
        candidate_id INTEGER NOT NULL,
        feedback_token VARCHAR(255) UNIQUE NOT NULL,
        rejection_reason TEXT,
        status VARCHAR(50) DEFAULT 'awaiting_candidate',
        candidate_message TEXT,
        admin_response TEXT,
        rejection_email_message_id TEXT,
        responded_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        responded_at TIMESTAMP
      )
    `);

    // Add missing columns if needed
    try {
      await req.db.query(`
        ALTER TABLE ${DEFAULT_SCHEMA}.rejection_feedback_requests
        ADD COLUMN IF NOT EXISTS rejection_email_message_id TEXT
      `);
      await req.db.query(`
        ALTER TABLE ${DEFAULT_SCHEMA}.rejection_feedback_requests
        ADD COLUMN IF NOT EXISTS candidate_email VARCHAR(255)
      `);
      await req.db.query(`
        ALTER TABLE ${DEFAULT_SCHEMA}.rejection_feedback_requests
        ADD COLUMN IF NOT EXISTS candidate_name VARCHAR(255)
      `);
      await req.db.query(`
        ALTER TABLE ${DEFAULT_SCHEMA}.rejection_feedback_requests
        ADD COLUMN IF NOT EXISTS job_title VARCHAR(255)
      `);
    } catch (alterError) {
      console.log(
        "[ATS] Column alteration completed or columns already exist:",
        alterError.message
      );
    }

    // Fetch candidate data from database
    let candidateEmail = null;
    let candidateName = null;
    let jobTitle = null;

    try {
      const candidateResult = await req.db.query(
        `SELECT email, first_name, last_name FROM ${PEOPLE_TABLE} WHERE ${PEOPLE_PK} = $1`,
        [candidateId]
      );

      const candidate = candidateResult.rows[0];
      if (candidate) {
        candidateName =
          `${candidate.first_name || ""} ${candidate.last_name || ""}`.trim() ||
          null;
        candidateEmail = candidate.email || null;
      }

      // Get job title from the most recent application
      const applicationResult = await req.db.query(
        `SELECT jl.job_title
         FROM ${APP_TABLE} a
         LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON a.job_requisition_id = jl.job_requisition_id
         WHERE a.candidate_id = $1
         ORDER BY a.application_date DESC
         LIMIT 1`,
        [candidateId]
      );

      if (
        applicationResult.rows.length > 0 &&
        applicationResult.rows[0].job_title
      ) {
        jobTitle = applicationResult.rows[0].job_title;
      }
    } catch (candidateError) {
      console.warn(
        "[ATS] Could not fetch candidate details:",
        candidateError.message
      );
    }

    // Insert feedback request
    await req.db.query(
      `INSERT INTO ${DEFAULT_SCHEMA}.rejection_feedback_requests
       (candidate_id, candidate_email, candidate_name, job_title, feedback_token, rejection_reason, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'awaiting_candidate')`,
      [candidateId, candidateEmail, candidateName, jobTitle, token, rejectionReason]
    );

    // Generate the feedback URL
    const baseUrl = process.env.API_BASE_URL || "https://ats.s3protection.com";
    const feedbackUrl = `${baseUrl}/ats/api/ats/public/rejection-feedback/request/${token}`;

    res.json({ success: true, feedbackUrl });
  } catch (error) {
    console.error("[ATS] ERROR creating feedback request:", error);
    res.status(500).json({
      error: "Failed to create feedback request",
      detail: error.message,
    });
  }
});

// GET /rejection-feedback/pending - Get pending feedback requests (admin)
router.get("/rejection-feedback/pending", async (req, res) => {
  try {
    // Ensure table exists
    await req.db.query(`
      CREATE TABLE IF NOT EXISTS ${DEFAULT_SCHEMA}.rejection_feedback_requests (
        id SERIAL PRIMARY KEY,
        candidate_id INTEGER NOT NULL,
        feedback_token VARCHAR(255) UNIQUE NOT NULL,
        rejection_reason TEXT,
        status VARCHAR(50) DEFAULT 'awaiting_candidate',
        candidate_message TEXT,
        admin_response TEXT,
        responded_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        responded_at TIMESTAMP
      )
    `);

    // Only show feedback requests that candidates have actually submitted
    const result = await req.db.query(
      `SELECT * FROM ${DEFAULT_SCHEMA}.rejection_feedback_requests
       WHERE status = 'submitted'
       ORDER BY created_at DESC`
    );

    return res.json(result.rows);
  } catch (error) {
    console.error("[ATS] Error fetching feedback requests:", error);
    return res.status(500).json({ error: "Failed to fetch feedback requests" });
  }
});

// POST /rejection-feedback/respond/:id - Respond to feedback request (admin)
router.post("/rejection-feedback/respond/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { response } = req.body;
    const respondedBy =
      (req.session?.user?.emails && req.session.user.emails[0]) || "admin";

    if (!response) {
      return res.status(400).json({ error: "Response message required" });
    }

    // Update feedback request
    const result = await req.db.query(
      `UPDATE ${DEFAULT_SCHEMA}.rejection_feedback_requests
       SET admin_response = $1, status = 'responded', responded_at = CURRENT_TIMESTAMP, responded_by = $2
       WHERE id = $3
       RETURNING *`,
      [response, respondedBy, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Feedback request not found" });
    }

    const feedbackRequest = result.rows[0];
    const candidateName = feedbackRequest.candidate_name || "Candidate";
    const candidateEmail = feedbackRequest.candidate_email;
    const jobTitle = feedbackRequest.job_title || "the position";

    if (!candidateEmail) {
      return res
        .status(400)
        .json({ error: "Candidate email not found in feedback request" });
    }

    // Send response email to candidate
    const responseHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
    .container { background: #fff; border-radius: 8px; padding: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    h1 { color: #2196f3; margin: 0 0 20px 0; }
    .response-box { background: #f9f9f9; border-left: 4px solid #2196f3; padding: 20px; margin: 20px 0; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Response to Your Feedback Request</h1>
    <p>Dear ${candidateName},</p>
    <p>Thank you for requesting feedback regarding your application for ${jobTitle}.</p>
    <div class="response-box">
      <p style="margin: 0; white-space: pre-wrap;">${response}</p>
    </div>
    <p>We appreciate your interest in our organization and wish you the best in your career search.</p>
    <p style="margin-top: 30px;">Sincerely,<br>The Hiring Team</p>
  </div>
</body>
</html>
    `;

    try {
      const userAccessToken = req.session?.user?.accessToken;
      let emailSent = false;

      // Try to send via user's Microsoft 365 account first
      if (userAccessToken && emailService) {
        try {
          const emailOptions = {
            accessToken: userAccessToken,
            to: candidateEmail,
            subject: `Feedback on Your Application - ${jobTitle}`,
            html: responseHtml,
          };

          if (feedbackRequest.rejection_email_message_id) {
            emailOptions.headers = {
              "In-Reply-To": feedbackRequest.rejection_email_message_id,
              References: feedbackRequest.rejection_email_message_id,
            };
          }

          await emailService.sendMailAsUser(emailOptions);
          emailSent = true;
        } catch (graphError) {
          const isTokenError =
            graphError.message?.includes("expired") ||
            graphError.message?.includes("InvalidAuthenticationToken");
          if (!isTokenError) throw graphError;
        }
      }

      // Fallback to system email service
      if (!emailSent && emailService) {
        if (!emailService.isConfigured()) {
          return res.status(500).json({
            error: "Email service unavailable",
            message: "Please log out and log back in, then try again.",
          });
        }

        await emailService.sendMail({
          to: candidateEmail,
          subject: `Feedback on Your Application - ${jobTitle}`,
          html: responseHtml,
        });
      }
    } catch (emailError) {
      console.error("[ATS] Failed to send feedback response email:", emailError);
      return res.status(500).json({
        error: "Failed to send email",
        message: emailError.message,
      });
    }

    return res.json({ success: true, feedbackRequest: result.rows[0] });
  } catch (error) {
    console.error("[ATS] Error responding to feedback request:", error);
    return res.status(500).json({ error: "Failed to send response" });
  }
});

// ==================== PUBLIC ROUTES ====================
// GET /public/rejection-feedback/request/:token - Display feedback form
router.get("/public/rejection-feedback/request/:token", async (req, res) => {
  try {
    const { token } = req.params;

    const result = await req.db.query(
      `SELECT * FROM ${DEFAULT_SCHEMA}.rejection_feedback_requests WHERE feedback_token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Invalid Link</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
            h1 { color: #dc3545; }
          </style>
        </head>
        <body>
          <h1>Invalid or Expired Link</h1>
          <p>This feedback request link is not valid or may have expired.</p>
        </body>
        </html>
      `);
    }

    const feedbackRequest = result.rows[0];

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Request Feedback</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5; }
          .container { background-color: #ffffff; border-radius: 8px; padding: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          h1 { color: #2196f3; margin: 0 0 20px 0; text-align: center; }
          .info-box { background-color: #e3f2fd; border-left: 4px solid #2196f3; padding: 15px; margin: 20px 0; border-radius: 4px; }
          label { display: block; margin: 15px 0 5px 0; font-weight: 600; color: #555; }
          textarea { width: 100%; min-height: 150px; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-family: inherit; font-size: 14px; box-sizing: border-box; }
          button { background-color: #2196f3; color: white; border: none; padding: 12px 30px; border-radius: 6px; font-size: 16px; cursor: pointer; width: 100%; margin-top: 20px; }
          button:hover { background-color: #1976d2; }
          button:disabled { background-color: #ccc; cursor: not-allowed; }
          .success-message { display: none; background-color: #d4edda; border: 1px solid #c3e6cb; color: #155724; padding: 15px; border-radius: 6px; margin: 20px 0; }
          .error-message { display: none; background-color: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; padding: 15px; border-radius: 6px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Request Feedback on Your Application</h1>
          <div class="info-box">
            <p><strong>Position:</strong> ${feedbackRequest.job_title}</p>
          </div>
          <form id="feedback-form">
            <label for="message">Your Message (Optional):</label>
            <textarea id="message" name="message" placeholder="You can ask specific questions about your application or interview performance, or simply request general feedback."></textarea>
            <button type="submit" id="submit-btn">Submit Feedback Request</button>
          </form>
          <div id="success-message" class="success-message">
            <strong>Request Submitted Successfully!</strong>
            <p>Our team will review it and respond via email within 3-5 business days.</p>
          </div>
          <div id="error-message" class="error-message">
            <strong>Error</strong>
            <p id="error-text"></p>
          </div>
        </div>
        <script>
          document.getElementById('feedback-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const submitBtn = document.getElementById('submit-btn');
            const message = document.getElementById('message').value;
            submitBtn.disabled = true;
            submitBtn.textContent = 'Submitting...';
            try {
              const response = await fetch('/ats/api/ats/public/rejection-feedback/submit/${token}', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message })
              });
              const data = await response.json();
              if (response.ok && data.success) {
                document.getElementById('feedback-form').style.display = 'none';
                document.getElementById('success-message').style.display = 'block';
              } else {
                throw new Error(data.error || 'Failed to submit request');
              }
            } catch (error) {
              document.getElementById('error-message').style.display = 'block';
              document.getElementById('error-text').textContent = error.message;
              submitBtn.disabled = false;
              submitBtn.textContent = 'Submit Feedback Request';
            }
          });
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    console.error("[ATS] Error displaying feedback request form:", error);
    res.status(500).send("An error occurred");
  }
});

// POST /public/rejection-feedback/submit/:token - Submit feedback request
router.post("/public/rejection-feedback/submit/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { message } = req.body;

    const result = await req.db.query(
      `UPDATE ${DEFAULT_SCHEMA}.rejection_feedback_requests
       SET candidate_message = $1, status = 'submitted'
       WHERE feedback_token = $2 AND status = 'awaiting_candidate'
       RETURNING *`,
      [message || "", token]
    );

    if (result.rows.length === 0) {
      return res
        .status(400)
        .json({ error: "Invalid token or request already submitted" });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("[ATS] Error submitting feedback request:", error);
    return res.status(500).json({ error: "Failed to submit feedback request" });
  }
});

module.exports = router;
module.exports.initRejection = initRejection;
