/**
 * Share Routes Module
 * Handles candidate profile sharing via PDF generation and email
 */

const express = require("express");
const router = express.Router();

console.log("[Share] Loading share routes module...");

const {
  DEFAULT_SCHEMA,
  PEOPLE_TABLE,
  PEOPLE_PK,
  APP_TABLE,
  APP_PK,
  getOpenAIClient,
  OPENAI_API_KEY,
} = require("./helpers");

const { generateCandidateProfilePDF } = require("../../../services/pdfService");
const emailService = require("../../../services/emailService");
const config = require("../../../config");

// Dependencies injected via init
let buildCandidateVM = null;
let getLatestCandidateScore = null;
let buildCandidateScoringContext = null;

function initShare(deps) {
  if (deps.buildCandidateVM) buildCandidateVM = deps.buildCandidateVM;
  if (deps.getLatestCandidateScore) getLatestCandidateScore = deps.getLatestCandidateScore;
  if (deps.buildCandidateScoringContext) buildCandidateScoringContext = deps.buildCandidateScoringContext;
}

/**
 * Generate AI professional summary for candidate
 */
async function generateProfessionalSummary(candidateData, combinedText, score) {
  if (!OPENAI_API_KEY) {
    console.warn("[Share] OpenAI not configured, skipping professional summary");
    return null;
  }

  try {
    const client = getOpenAIClient();
    const modelName = config.ai?.openaiModel || "gpt-4o-mini";

    const prompt = `You are an expert recruiter writing a professional summary for a candidate profile that will be shared with hiring managers.

Based on the candidate's resume, cover letter, and application details, write a concise 2-3 paragraph professional summary that:
1. Highlights their key qualifications and experience
2. Summarizes their career trajectory and achievements
3. Notes any standout skills or certifications
4. Maintains an objective, professional tone suitable for sharing with hiring managers

CANDIDATE INFORMATION:
Name: ${candidateData.name || "Unknown"}
Applied Position: ${candidateData.jobTitle || "Not specified"}
Location: ${candidateData.location || "Not specified"}
Years of Experience: ${candidateData.yearsExperience || "Not specified"}

${score ? `AI EVALUATION:
Overall Score: ${score.overall_score}/100
Key Strengths: ${score.strengths?.join(", ") || "N/A"}` : ""}

RESUME/COVER LETTER CONTENT:
${combinedText ? combinedText.substring(0, 8000) : "No resume content available"}

Write a professional summary (150-250 words):`;

    const completion = await client.chat.completions.create({
      model: modelName,
      temperature: 0.4,
      max_tokens: 500,
      messages: [
        { role: "system", content: "You are a professional HR writer creating candidate summaries for hiring managers." },
        { role: "user", content: prompt },
      ],
    });

    const summary = completion?.choices?.[0]?.message?.content?.trim();
    console.log(`[Share] Generated professional summary (${summary?.length || 0} chars)`);
    return summary;
  } catch (e) {
    console.error("[Share] Failed to generate professional summary:", e.message);
    return null;
  }
}

/**
 * Extract resume highlights from combined text
 */
function extractResumeHighlights(combinedText, maxLength = 1500) {
  if (!combinedText) return null;

  // Try to extract key sections
  let highlights = combinedText;

  // Remove common headers/footers
  highlights = highlights
    .replace(/RESUME TEXT:\n?/gi, "")
    .replace(/COVER LETTER TEXT:\n?/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Truncate if too long
  if (highlights.length > maxLength) {
    highlights = highlights.substring(0, maxLength) + "...";
  }

  return highlights;
}

/**
 * Get tenant branding from request
 */
function getTenantBranding(req) {
  const tenant = req.tenant;
  return {
    companyName: tenant?.company_name || "Company",
    logoUrl: tenant?.logo_url || null,
    primaryColor: tenant?.primary_color || "#2d5a27",
  };
}

/**
 * Get interview questions for candidate
 */
async function getInterviewQuestions(db, candidateId) {
  try {
    const result = await db.query(
      `SELECT interview_questions FROM ${PEOPLE_TABLE} WHERE ${PEOPLE_PK} = $1`,
      [candidateId]
    );

    if (result.rows.length > 0 && result.rows[0].interview_questions) {
      const data = result.rows[0].interview_questions;
      return typeof data === "string" ? JSON.parse(data) : data;
    }
    return null;
  } catch (e) {
    console.warn("[Share] Failed to get interview questions:", e.message);
    return null;
  }
}

/**
 * Aggregate all candidate data for PDF generation
 */
async function aggregateCandidateData(db, candidateId, options = {}) {
  const {
    includeProfessionalSummary = true,
    includeAiEvaluation = true,
    includeInterviewQuestions = true,
    includeResumeHighlights = true,
  } = options;

  // Get candidate VM (basic info)
  let candidate = null;
  if (buildCandidateVM) {
    candidate = await buildCandidateVM(db, candidateId);
  } else {
    // Fallback query - use to_jsonb() for application fields as they may be dynamic
    const result = await db.query(
      `SELECT p.*,
              a.job_requisition_id,
              a.application_date,
              to_jsonb(a)->>'application_source' AS application_source,
              jl.job_title
       FROM ${PEOPLE_TABLE} p
       LEFT JOIN LATERAL (
         SELECT * FROM ${APP_TABLE}
         WHERE candidate_id = p.${PEOPLE_PK}
         ORDER BY application_date DESC NULLS LAST LIMIT 1
       ) a ON TRUE
       LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON jl.job_requisition_id = a.job_requisition_id
       WHERE p.${PEOPLE_PK} = $1`,
      [candidateId]
    );
    if (result.rows.length > 0) {
      const row = result.rows[0];
      candidate = {
        id: row[PEOPLE_PK] || row.candidate_id,
        name: `${row.first_name || ""} ${row.last_name || ""}`.trim() || row.email,
        email: row.email,
        phone: row.phone,
        location: [row.city, row.state, row.country].filter(Boolean).join(", "),
        jobTitle: row.job_title,
        appliedAt: row.application_date,
        source: row.application_source,
      };
    }
  }

  if (!candidate) {
    throw new Error("Candidate not found");
  }

  // Get AI evaluation score
  let score = null;
  if (includeAiEvaluation && getLatestCandidateScore) {
    score = await getLatestCandidateScore(db, candidateId);
  }

  // Get interview questions
  let interviewQuestions = null;
  if (includeInterviewQuestions) {
    interviewQuestions = await getInterviewQuestions(db, candidateId);
  }

  // Get combined text for summary generation
  let combinedText = null;
  if (buildCandidateScoringContext && (includeProfessionalSummary || includeResumeHighlights)) {
    try {
      const ctx = await buildCandidateScoringContext(db, candidateId);
      combinedText = ctx?.combinedText || null;
    } catch (e) {
      console.warn("[Share] Failed to get scoring context:", e.message);
    }
  }

  // Generate professional summary
  let professionalSummary = null;
  if (includeProfessionalSummary) {
    professionalSummary = await generateProfessionalSummary(candidate, combinedText, score);
  }

  // Extract resume highlights
  let resumeHighlights = null;
  if (includeResumeHighlights && combinedText) {
    resumeHighlights = extractResumeHighlights(combinedText);
  }

  return {
    candidate,
    score,
    interviewQuestions,
    professionalSummary,
    resumeHighlights,
  };
}

// ==================== ROUTES ====================

console.log("[Share] Registering share routes...");

/**
 * POST /candidates/:id/share/pdf
 * Generate and download candidate profile PDF
 */
router.post("/candidates/:id/share/pdf", async (req, res) => {
  console.log("[Share] PDF route hit for candidate:", req.params.id);
  try {
    const candidateId = parseInt(req.params.id, 10);
    if (!Number.isFinite(candidateId)) {
      return res.status(400).json({ error: "invalid_candidate_id" });
    }

    // Support both { includeSections: {...} } and { includePersonalInfo, ... } formats
    const body = req.body || {};
    const sections = body.includeSections || body;
    const includePersonalInfo = sections.personalInfo ?? sections.includePersonalInfo ?? true;
    const includeJobDetails = sections.jobDetails ?? sections.includeJobDetails ?? true;
    const includeAiEvaluation = sections.aiEvaluation ?? sections.includeAiEvaluation ?? true;
    const includeProfessionalSummary = sections.professionalSummary ?? sections.includeProfessionalSummary ?? true;
    const includeInterviewQuestions = sections.interviewQuestions ?? sections.includeInterviewQuestions ?? true;
    const includeResumeHighlights = sections.resumeHighlights ?? sections.includeResumeHighlights ?? true;

    console.log(`[Share] Generating PDF for candidate ${candidateId}`);

    // Aggregate all candidate data
    const data = await aggregateCandidateData(req.db, candidateId, {
      includeProfessionalSummary,
      includeAiEvaluation,
      includeInterviewQuestions,
      includeResumeHighlights,
    });

    // Get tenant branding
    const branding = getTenantBranding(req);

    // Generate PDF
    const pdfBuffer = await generateCandidateProfilePDF(data, branding, {
      includePersonalInfo,
      includeJobDetails,
      includeAiEvaluation,
      includeProfessionalSummary,
      includeInterviewQuestions,
      includeResumeHighlights,
    });

    // Create filename
    const safeName = (data.candidate.name || "Candidate")
      .replace(/[^a-zA-Z0-9\s]/g, "")
      .replace(/\s+/g, "_");
    const filename = `${safeName}_Profile_${Date.now()}.pdf`;

    // Convert PDF buffer to base64 for JSON response
    const pdfBase64 = pdfBuffer.toString("base64");

    // Send JSON response with base64 encoded PDF
    res.json({
      success: true,
      pdfBase64,
      filename,
      candidateName: data.candidate.name,
    });

    console.log(`[Share] PDF generated successfully for candidate ${candidateId} (${pdfBuffer.length} bytes)`);
  } catch (e) {
    console.error("[Share] PDF generation failed:", e);
    return res.status(500).json({
      error: "pdf_generation_failed",
      detail: e.message,
    });
  }
});

/**
 * POST /candidates/:id/share/email
 * Send candidate profile PDF via email
 */
router.post("/candidates/:id/share/email", async (req, res) => {
  try {
    const candidateId = parseInt(req.params.id, 10);
    if (!Number.isFinite(candidateId)) {
      return res.status(400).json({ error: "invalid_candidate_id" });
    }

    const body = req.body || {};
    const { recipients, subject, message } = body;

    // Support both { includeSections: {...} } and { includePersonalInfo, ... } formats
    const sections = body.includeSections || body;
    const includePersonalInfo = sections.personalInfo ?? sections.includePersonalInfo ?? true;
    const includeJobDetails = sections.jobDetails ?? sections.includeJobDetails ?? true;
    const includeAiEvaluation = sections.aiEvaluation ?? sections.includeAiEvaluation ?? true;
    const includeProfessionalSummary = sections.professionalSummary ?? sections.includeProfessionalSummary ?? true;
    const includeInterviewQuestions = sections.interviewQuestions ?? sections.includeInterviewQuestions ?? true;
    const includeResumeHighlights = sections.resumeHighlights ?? sections.includeResumeHighlights ?? true;

    // Validate recipients
    if (!recipients || (Array.isArray(recipients) && recipients.length === 0)) {
      return res.status(400).json({ error: "recipients_required" });
    }

    const recipientList = Array.isArray(recipients)
      ? recipients
      : recipients.split(",").map((e) => e.trim()).filter(Boolean);

    if (recipientList.length === 0) {
      return res.status(400).json({ error: "recipients_required" });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const email of recipientList) {
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: "invalid_email", detail: email });
      }
    }

    console.log(`[Share] Sending PDF for candidate ${candidateId} to ${recipientList.join(", ")}`);

    // Aggregate all candidate data
    const data = await aggregateCandidateData(req.db, candidateId, {
      includeProfessionalSummary,
      includeAiEvaluation,
      includeInterviewQuestions,
      includeResumeHighlights,
    });

    // Get tenant branding
    const branding = getTenantBranding(req);

    // Generate PDF
    const pdfBuffer = await generateCandidateProfilePDF(data, branding, {
      includePersonalInfo,
      includeJobDetails,
      includeAiEvaluation,
      includeProfessionalSummary,
      includeInterviewQuestions,
      includeResumeHighlights,
    });

    // Create filename
    const safeName = (data.candidate.name || "Candidate")
      .replace(/[^a-zA-Z0-9\s]/g, "")
      .replace(/\s+/g, "_");
    const filename = `${safeName}_Profile.pdf`;

    // Build email subject
    const emailSubject = subject || `Candidate Profile: ${data.candidate.name || "Unknown"} - ${data.candidate.jobTitle || "Application"}`;

    // Build email HTML
    const senderName = req.session?.user?.displayName || req.session?.user?.name || "A recruiter";
    const companyName = branding.companyName;

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background-color: #f8f9fa; border-radius: 8px; padding: 30px; margin-bottom: 20px;">
    <h2 style="color: ${branding.primaryColor}; margin-top: 0;">Candidate Profile Shared</h2>
    <p style="margin-bottom: 0;">
      ${senderName} from <strong>${companyName}</strong> has shared a candidate profile with you.
    </p>
  </div>

  <div style="background-color: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 20px;">
    <h3 style="margin-top: 0; color: #1f2937;">Candidate: ${data.candidate.name || "Unknown"}</h3>
    <p><strong>Position:</strong> ${data.candidate.jobTitle || "Not specified"}</p>
    ${data.score ? `<p><strong>AI Evaluation Score:</strong> ${data.score.overall_score}/100</p>` : ""}
    ${message ? `<p style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #e5e7eb;"><strong>Message:</strong><br>${message}</p>` : ""}
  </div>

  <p style="color: #6b7280; font-size: 14px;">
    The full candidate profile is attached as a PDF document.
  </p>

  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">

  <p style="color: #9ca3af; font-size: 12px; margin-bottom: 0;">
    This email was sent from ${companyName}'s Applicant Tracking System.
  </p>
</body>
</html>
    `.trim();

    // Send email with attachment
    const result = await emailService.sendMailWithAttachment({
      to: recipientList,
      subject: emailSubject,
      html: emailHtml,
      attachments: [
        {
          filename,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    });

    console.log(`[Share] Email sent successfully to ${recipientList.join(", ")}`);

    return res.json({
      success: true,
      sentTo: recipientList,
      messageId: result.messageId,
    });
  } catch (e) {
    console.error("[Share] Email send failed:", e);
    return res.status(500).json({
      error: "email_send_failed",
      detail: e.message,
    });
  }
});

/**
 * GET /candidates/:id/share/preview
 * Get preview data for share modal (without generating PDF)
 */
router.get("/candidates/:id/share/preview", async (req, res) => {
  try {
    const candidateId = parseInt(req.params.id, 10);
    if (!Number.isFinite(candidateId)) {
      return res.status(400).json({ error: "invalid_candidate_id" });
    }

    // Get basic candidate info
    let candidate = null;
    if (buildCandidateVM) {
      candidate = await buildCandidateVM(req.db, candidateId);
    } else {
      const result = await req.db.query(
        `SELECT ${PEOPLE_PK} AS id, first_name, last_name, email
         FROM ${PEOPLE_TABLE} WHERE ${PEOPLE_PK} = $1`,
        [candidateId]
      );
      if (result.rows.length > 0) {
        const row = result.rows[0];
        candidate = {
          id: row.id,
          name: `${row.first_name || ""} ${row.last_name || ""}`.trim() || row.email,
          email: row.email,
        };
      }
    }

    if (!candidate) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    // Check what data is available
    let hasScore = false;
    if (getLatestCandidateScore) {
      const score = await getLatestCandidateScore(req.db, candidateId);
      hasScore = !!score;
    }

    const questions = await getInterviewQuestions(req.db, candidateId);
    const hasInterviewQuestions = !!(questions?.questions?.length > 0);

    return res.json({
      candidate: {
        id: candidate.id,
        name: candidate.name,
        email: candidate.email,
        jobTitle: candidate.jobTitle,
      },
      availableSections: {
        personalInfo: true,
        jobDetails: true,
        aiEvaluation: hasScore,
        professionalSummary: !!OPENAI_API_KEY,
        interviewQuestions: hasInterviewQuestions,
        resumeHighlights: true,
      },
      branding: getTenantBranding(req),
    });
  } catch (e) {
    console.error("[Share] Preview failed:", e);
    return res.status(500).json({
      error: "preview_failed",
      detail: e.message,
    });
  }
});

console.log("[Share] Share routes registered successfully");

module.exports = router;
module.exports.initShare = initShare;
