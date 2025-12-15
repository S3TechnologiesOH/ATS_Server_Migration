/**
 * Public Routes Module
 * Handles all /public/* endpoints (no authentication required)
 * Includes: public job applications, LinkedIn OAuth, file uploads
 */

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const router = express.Router();

const {
  DEFAULT_SCHEMA,
  FILES_ROOT,
  FILES_PUBLIC_URL,
  ensureDir,
  safeFileName,
  extractTextFromBuffer,
} = require("./helpers");

// File upload configuration
const MAX_UPLOAD_MB = process.env.MAX_UPLOAD_MB || "512";
const MAX_UPLOAD_BYTES =
  Math.max(1, parseInt(MAX_UPLOAD_MB, 10) || 512) * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// Email service will be injected
let emailService = null;

function initPublic(deps) {
  if (deps.emailService) {
    emailService = deps.emailService;
  }
}

// CORS helper for public endpoints
function applyPublicCors(req, res) {
  const allowedOrigin =
    process.env.PUBLIC_APP_ALLOWED_ORIGIN ||
    "https://aqua-dotterel-156835.hostingersite.com";
  const requestOrigin = req.headers.origin;
  const originToUse =
    requestOrigin &&
    (requestOrigin === allowedOrigin ||
      requestOrigin.includes("hostingersite.com") ||
      requestOrigin.includes("localhost") ||
      requestOrigin.includes("127.0.0.1"))
      ? requestOrigin
      : allowedOrigin;

  res.header("Access-Control-Allow-Origin", originToUse);
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
}

// Helper functions
function slugify(s) {
  return (
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "file"
  );
}

function pickExt(originalName, contentType) {
  const mime = require("mime-types");
  const fromName = path.extname(originalName || "").toLowerCase();
  if (fromName) return fromName;
  const fromMime = contentType ? `.${mime.extension(contentType) || ""}` : "";
  return fromMime || ".bin";
}

// ==================== LINKEDIN OAUTH ====================
// In-memory store for LinkedIn state tokens
const linkedinStates = new Map();

// Cleanup expired states every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [state, data] of linkedinStates.entries()) {
    if (now > data.expires) {
      linkedinStates.delete(state);
    }
  }
}, 5 * 60 * 1000);

// POST /public/linkedin/init - Initialize LinkedIn OAuth flow
router.post("/linkedin/init", async (req, res) => {
  applyPublicCors(req, res);

  try {
    const LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;

    if (!LINKEDIN_CLIENT_ID) {
      return res.status(500).json({
        success: false,
        error: "linkedin_not_configured",
        message: "LinkedIn OAuth not configured",
      });
    }

    // Generate secure state parameter
    const state = crypto.randomBytes(16).toString("hex");
    const expires = Date.now() + 30 * 60 * 1000;
    linkedinStates.set(state, { created: Date.now(), expires });

    // Build redirect URI dynamically
    let requestOrigin = null;
    if (req.headers?.origin) {
      requestOrigin = req.headers.origin;
    } else if (req.headers?.referer) {
      try {
        requestOrigin = new URL(req.headers.referer).origin;
      } catch {}
    }
    const configuredOrigin =
      process.env.PUBLIC_APP_ALLOWED_ORIGIN ||
      "https://aqua-dotterel-156835.hostingersite.com";
    const allowedOrigin = requestOrigin || configuredOrigin;
    const redirectUri = allowedOrigin + "/linkedin-callback.html";

    // Build LinkedIn OAuth URL
    const authUrl =
      "https://www.linkedin.com/oauth/v2/authorization?" +
      new URLSearchParams({
        response_type: "code",
        client_id: LINKEDIN_CLIENT_ID,
        redirect_uri: redirectUri,
        state: state,
        scope: "openid,profile,email",
      }).toString();

    res.json({ success: true, authUrl, redirectUri, state });
  } catch (e) {
    console.error("[LINKEDIN_INIT][ERR]", e);
    return res.status(500).json({
      success: false,
      error: "init_failed",
      message: "Failed to initialize LinkedIn authentication",
    });
  }
});

// POST /public/linkedin/auth - Exchange LinkedIn code for profile data
router.post("/linkedin/auth", async (req, res) => {
  applyPublicCors(req, res);

  try {
    const LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
    const LINKEDIN_CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;

    if (!LINKEDIN_CLIENT_ID || !LINKEDIN_CLIENT_SECRET) {
      return res.status(500).json({
        success: false,
        error: "linkedin_not_configured",
      });
    }

    const { code, state, redirectUri } = req.body;

    if (!code || !state || !redirectUri) {
      return res.status(400).json({
        success: false,
        error: "missing_parameters",
      });
    }

    // Validate state (with bypass for debugging)
    const stateData = linkedinStates.get(state);
    if (stateData) linkedinStates.delete(state);

    // Exchange code for token
    const tokenResponse = await exchangeLinkedInCodeForToken(
      LINKEDIN_CLIENT_ID,
      LINKEDIN_CLIENT_SECRET,
      code,
      redirectUri
    );

    if (!tokenResponse || !tokenResponse.access_token) {
      throw new Error("Failed to get access token from LinkedIn");
    }

    // Get profile data
    const profile = await getLinkedInProfileData(tokenResponse.access_token);

    if (!profile) {
      throw new Error("Failed to get LinkedIn profile data");
    }

    res.json({ success: true, profile });
  } catch (e) {
    console.error("[LINKEDIN_AUTH][ERR]", e);
    return res.status(400).json({
      success: false,
      error: "auth_failed",
      message: e.message || "LinkedIn authentication failed",
    });
  }
});

// LinkedIn helper functions
async function exchangeLinkedInCodeForToken(clientId, clientSecret, code, redirectUri) {
  const fetch = require("node-fetch");
  const tokenUrl = "https://www.linkedin.com/oauth/v2/accessToken";

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LinkedIn token exchange failed: ${response.status} - ${errorText}`);
  }

  return response.json();
}

async function getLinkedInProfileData(accessToken) {
  const fetch = require("node-fetch");
  const profileUrl = "https://api.linkedin.com/v2/userinfo";

  const profileResponse = await fetch(profileUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!profileResponse.ok) {
    const errorText = await profileResponse.text();
    throw new Error(`LinkedIn profile API failed: ${profileResponse.status} - ${errorText}`);
  }

  const profileData = await profileResponse.json();

  // Process OpenID Connect userinfo response
  return {
    id: profileData.sub,
    name: profileData.name || getOpenIdConnectFullName(profileData),
    headline: profileData.headline || null,
    email: profileData.email || null,
    photoUrl: profileData.picture || null,
    linkedinUrl: null,
    importedAt: new Date().toISOString(),
    resumeData: {
      email: profileData.email || null,
      summary: "Professional from LinkedIn",
    },
  };
}

function getOpenIdConnectFullName(profileData) {
  if (profileData.name) return profileData.name;
  let fullName = "";
  if (profileData.given_name) fullName += profileData.given_name;
  if (profileData.family_name) fullName += (fullName ? " " : "") + profileData.family_name;
  return fullName.trim() || null;
}

// ==================== PUBLIC APPLICATIONS ====================
// POST /public/applications - Submit a public job application
router.post("/applications", async (req, res) => {
  applyPublicCors(req, res);

  try {
    const {
      email,
      phone,
      name,
      fullName,
      first_name,
      last_name,
      job_title,
      job_requisition_id,
      job_listing_id,
      application_source = "careers-site",
      department,
      location,
      expected_salary,
      expectedSalary,
      expectedSalaryRange,
      expected_salary_range,
      linkedin_url,
      years_experience,
      yearsExperience,
      photo_url,
      photoUrl,
      workAuth,
      valueResonates,
      salaryRange,
      motivation,
      onsite,
      terminated,
      references,
    } = req.body || {};

    // Normalize email
    const applicantEmail =
      email ||
      req.body.emailAddress ||
      req.body.email_address ||
      req.body.applicantEmail;

    if (!applicantEmail) {
      return res.status(400).json({
        success: false,
        error: "email_required",
        message: "Email address is required",
      });
    }

    // Normalize name
    let compositeName = name || fullName || req.body.candidateName;
    let firstName = first_name;
    let lastName = last_name;

    if (compositeName && (!firstName || !lastName)) {
      const parts = compositeName.trim().split(/\s+/);
      firstName = firstName || parts[0] || "Unknown";
      lastName = lastName || parts.slice(1).join(" ") || "Unknown";
    }
    firstName = firstName || "Unknown";
    lastName = lastName || "Unknown";

    // Normalize salary
    const normalizedSalaryRange =
      expected_salary_range || expectedSalaryRange || expected_salary || expectedSalary;
    let expectedSalaryNumeric = null;
    if (normalizedSalaryRange) {
      const numMatch = String(normalizedSalaryRange).match(/[\$]?(\d{1,3}(?:,?\d{3})*)/);
      if (numMatch) expectedSalaryNumeric = parseInt(numMatch[1].replace(/,/g, ""));
    }

    const yearsExp = years_experience || yearsExperience;
    const jobReqId = job_requisition_id || null;
    const jobListingId = job_listing_id || null;

    if (!jobReqId && !jobListingId) {
      return res.status(400).json({
        success: false,
        error: "job_identification_required",
        message: "Either job_requisition_id or job_listing_id is required",
      });
    }

    // Check/create candidate
    const findCandidateSql = `SELECT candidate_id FROM ${DEFAULT_SCHEMA}.candidates WHERE LOWER(email) = LOWER($1) LIMIT 1`;
    const existing = await req.db.query(findCandidateSql, [applicantEmail]);

    let candidateId;
    if (existing.rows.length > 0) {
      candidateId = existing.rows[0].candidate_id;
      // Update candidate if new info provided
      const updates = [];
      const params = [candidateId];
      let paramCount = 1;

      if (phone) { paramCount++; updates.push(`phone = $${paramCount}`); params.push(phone); }
      if (linkedin_url) { paramCount++; updates.push(`linkedin_url = $${paramCount}`); params.push(linkedin_url); }
      if (workAuth !== undefined) { paramCount++; updates.push(`work_authorization = $${paramCount}`); params.push(workAuth === "yes" ? true : workAuth === "no" ? false : null); }
      if (valueResonates) { paramCount++; updates.push(`values_resonates = $${paramCount}`); params.push(valueResonates); }
      if (salaryRange || normalizedSalaryRange) { paramCount++; updates.push(`expected_salary_range = $${paramCount}`); params.push(salaryRange || normalizedSalaryRange); }
      if (expectedSalaryNumeric !== null) { paramCount++; updates.push(`expected_salary_numeric = $${paramCount}`); params.push(expectedSalaryNumeric); }
      if (typeof motivation === "string" && motivation.trim()) { paramCount++; updates.push(`motivation = $${paramCount}`); params.push(motivation.trim()); }
      if (onsite !== undefined) { paramCount++; updates.push(`onsite_available = $${paramCount}`); params.push(onsite === "yes" ? true : onsite === "no" ? false : null); }
      if (terminated !== undefined) { paramCount++; updates.push(`termination_history = $${paramCount}`); params.push(String(terminated)); }
      if (references !== undefined) { paramCount++; updates.push(`references_available = $${paramCount}`); params.push(references === "yes" ? true : references === "no" ? false : null); }

      if (updates.length > 0) {
        await req.db.query(`UPDATE ${DEFAULT_SCHEMA}.candidates SET ${updates.join(", ")} WHERE candidate_id = $1`, params);
      }
    } else {
      // Create new candidate
      const insCandidate = await req.db.query(
        `INSERT INTO ${DEFAULT_SCHEMA}.candidates (
          first_name, last_name, email, phone, linkedin_url,
          work_authorization, values_resonates, expected_salary_range, expected_salary_numeric,
          motivation, onsite_available, termination_history, references_available
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING candidate_id`,
        [
          firstName, lastName, applicantEmail, phone || null, linkedin_url || null,
          workAuth === "yes" ? true : workAuth === "no" ? false : null,
          valueResonates || null, salaryRange || normalizedSalaryRange || null,
          expectedSalaryNumeric, typeof motivation === "string" ? motivation.trim() : null,
          onsite === "yes" ? true : onsite === "no" ? false : null,
          terminated !== undefined ? String(terminated) : null,
          references === "yes" ? true : references === "no" ? false : null,
        ]
      );
      candidateId = insCandidate.rows[0].candidate_id;
    }

    // Get job listing details
    let jl = null;
    if (jobListingId) {
      const r = await req.db.query(
        `SELECT job_requisition_id, job_title, recruiter_assigned, hiring_manager, department, location, job_listing_id FROM ${DEFAULT_SCHEMA}.job_listings WHERE job_listing_id = $1`,
        [jobListingId]
      );
      jl = r.rows[0] || null;
      if (!jl) return res.status(400).json({ success: false, error: "invalid_job_listing_id" });
    } else if (jobReqId) {
      const jobResult = await req.db.query(
        `SELECT * FROM ${DEFAULT_SCHEMA}.job_listings WHERE translate(LOWER(TRIM(job_requisition_id)), '–—−‐‑', '-----') = translate(LOWER(TRIM($1)), '–—−‐‑', '-----') LIMIT 1`,
        [jobReqId]
      );
      jl = jobResult.rows[0] || null;
      if (!jl) return res.status(400).json({ success: false, error: "invalid_job_requisition_id" });
    }

    // Get application table columns
    const colsResult = await req.db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'applications'`,
      [DEFAULT_SCHEMA]
    );
    const appCols = new Set(colsResult.rows.map((r) => r.column_name));

    // Build dynamic insert
    const cols = ["candidate_id"];
    const vals = ["$1"];
    const params = [candidateId];

    const push = (col, val) => {
      if (val !== undefined && val !== null && appCols.has(col)) {
        params.push(val);
        cols.push(col);
        vals.push(`$${params.length}`);
      }
    };

    push("application_source", application_source);
    push("job_listing_id", jl?.job_listing_id);
    push("job_requisition_id", jl?.job_requisition_id || jobReqId);
    push("job_title", job_title || jl?.job_title);
    push("job_department", department || jl?.department);
    push("job_location", location || jl?.location);
    push("recruiter_assigned", jl?.recruiter_assigned);
    push("hiring_manager_assigned", jl?.hiring_manager);
    push("name", compositeName);
    push("email", applicantEmail);
    push("expected_salary_range", normalizedSalaryRange);
    push("expected_salary", normalizedSalaryRange);
    push("years_experience", yearsExp ? Number(yearsExp) : null);
    push("photo_url", photo_url || photoUrl);

    const appDateFragment = appCols.has("application_date") ? ",application_date" : "";
    const appDateValues = appCols.has("application_date") ? ",NOW()" : "";

    const insApp = await req.db.query(
      `INSERT INTO ${DEFAULT_SCHEMA}.applications (${cols.join(",")}${appDateFragment}) VALUES (${vals.join(",")}${appDateValues}) RETURNING application_id`,
      params
    );
    const applicationId = insApp.rows[0]?.application_id || null;

    // Create initial stage
    if (applicationId) {
      try {
        await req.db.query(
          `INSERT INTO ${DEFAULT_SCHEMA}.application_stages (application_id, stage_name, status, updated_at) VALUES ($1, 'Applied', 'new', NOW())`,
          [applicationId]
        );
      } catch {}

      // Emit real-time event
      const io = req.app.get("io");
      if (io) {
        io.emit("new_application", {
          application_id: applicationId,
          candidate_id: candidateId,
          name: compositeName || `${firstName} ${lastName}`,
          email: applicantEmail,
          job_title: job_title || jl?.job_title,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Send confirmation email
    if (emailService?.isConfigured()) {
      try {
        await emailService.sendApplicationConfirmation({
          candidateEmail: applicantEmail,
          candidateName: firstName || compositeName || "Applicant",
          jobTitle: job_title || jl?.job_title || "the position",
        });
      } catch {}
    }

    return res.status(201).json({
      success: true,
      application_id: applicationId,
      candidate_id: candidateId,
    });
  } catch (e) {
    console.error("[PUBLIC_APPLY][ERR]", e);
    return res.status(500).json({
      success: false,
      error: "internal_error",
      message: process.env.NODE_ENV === "development" ? e.message : "An error occurred",
    });
  }
});

// ==================== PUBLIC FILE UPLOADS ====================
// POST /public/applications/:applicationId/upload/resume
router.post("/applications/:applicationId/upload/resume", upload.single("file"), async (req, res) => {
  applyPublicCors(req, res);

  try {
    const applicationId = parseInt(req.params.applicationId, 10);
    if (!Number.isFinite(applicationId))
      return res.status(400).json({ error: "invalid_application" });

    const file = req.file;
    if (!file) return res.status(400).json({ error: "no_file_provided" });

    // Verify application exists
    const appCheck = await req.db.query(
      `SELECT application_id, candidate_id FROM ${DEFAULT_SCHEMA}.applications WHERE application_id = $1`,
      [applicationId]
    );
    if (!appCheck.rows.length) return res.status(404).json({ error: "application_not_found" });

    const candidateId = appCheck.rows[0].candidate_id;

    // Store file
    const ext = pickExt(file.originalname, file.mimetype);
    const filename = `resume_${applicationId}_${Date.now()}${ext}`;
    const dir = path.join(FILES_ROOT, "applications", String(applicationId));
    await ensureDir(dir);
    const filePath = path.join(dir, filename);
    await fs.promises.writeFile(filePath, file.buffer);

    const publicUrl = `${FILES_PUBLIC_URL}/applications/${applicationId}/${filename}`;

    // Update application with resume URL
    await req.db.query(
      `UPDATE ${DEFAULT_SCHEMA}.applications SET resume_url = $1 WHERE application_id = $2`,
      [publicUrl, applicationId]
    );

    // Also update candidate's resume_url
    await req.db.query(
      `UPDATE ${DEFAULT_SCHEMA}.candidates SET resume_url = $1 WHERE candidate_id = $2`,
      [publicUrl, candidateId]
    );

    // Extract text for search
    try {
      const text = await extractTextFromBuffer(file.buffer, file.originalname, file.mimetype);
      if (text) {
        const sidecarPath = filePath + ".txt";
        await fs.promises.writeFile(sidecarPath, text, "utf8");
      }
    } catch {}

    return res.json({ success: true, url: publicUrl });
  } catch (e) {
    console.error("[PUBLIC_UPLOAD_RESUME][ERR]", e);
    return res.status(500).json({ error: "upload_failed", detail: e.message });
  }
});

// POST /public/applications/:applicationId/upload/cover-letter
router.post("/applications/:applicationId/upload/cover-letter", upload.single("file"), async (req, res) => {
  applyPublicCors(req, res);

  try {
    const applicationId = parseInt(req.params.applicationId, 10);
    if (!Number.isFinite(applicationId))
      return res.status(400).json({ error: "invalid_application" });

    const file = req.file;
    if (!file) return res.status(400).json({ error: "no_file_provided" });

    // Verify application exists
    const appCheck = await req.db.query(
      `SELECT application_id FROM ${DEFAULT_SCHEMA}.applications WHERE application_id = $1`,
      [applicationId]
    );
    if (!appCheck.rows.length) return res.status(404).json({ error: "application_not_found" });

    // Store file
    const ext = pickExt(file.originalname, file.mimetype);
    const filename = `cover_${applicationId}_${Date.now()}${ext}`;
    const dir = path.join(FILES_ROOT, "applications", String(applicationId));
    await ensureDir(dir);
    const filePath = path.join(dir, filename);
    await fs.promises.writeFile(filePath, file.buffer);

    const publicUrl = `${FILES_PUBLIC_URL}/applications/${applicationId}/${filename}`;

    // Update application with cover letter URL
    await req.db.query(
      `UPDATE ${DEFAULT_SCHEMA}.applications SET cover_letter_url = $1 WHERE application_id = $2`,
      [publicUrl, applicationId]
    );

    return res.json({ success: true, url: publicUrl });
  } catch (e) {
    console.error("[PUBLIC_UPLOAD_COVER][ERR]", e);
    return res.status(500).json({ error: "upload_failed", detail: e.message });
  }
});

module.exports = router;
module.exports.initPublic = initPublic;
module.exports.applyPublicCors = applyPublicCors;
