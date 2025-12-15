/**
 * Applications Routes Module
 * Handles all /applications/* endpoints for the ATS application
 */

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const mime = require("mime-types");
const router = express.Router();

const {
  DEFAULT_SCHEMA,
  APP_TABLE,
  APP_PK,
  PEOPLE_TABLE,
  PEOPLE_PK,
  ATS_ATTACHMENTS_TABLE,
  FILES_ROOT,
  FILES_PUBLIC_URL,
  MAX_UPLOAD_MB,
  upload,
  requireAdmin,
  ensureDir,
  safeFileName,
  safeJoin,
  slugify,
  pickExt,
  extractTextFromBuffer,
} = require("./helpers");

// Dependencies injected during initialization
let enqueueCandidateScore = null;
let buildSignedUrl = null;

/**
 * Initialize the applications router with required dependencies
 */
function initApplications(deps) {
  enqueueCandidateScore = deps.enqueueCandidateScore;
  buildSignedUrl = deps.buildSignedUrl;
}

// Helper to get actor user ID for uploads
async function getActorUserId(req) {
  try {
    const email = (req.session?.user?.emails && req.session.user.emails[0]) || null;
    const displayName = req.session?.user?.displayName || null;
    if (!email) return null;
    const q = `
      INSERT INTO ${DEFAULT_SCHEMA}.app_user (email, display_name)
      VALUES ($1, $2)
      ON CONFLICT (email) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, app_user.display_name)
      RETURNING id`;
    const r = await req.db.query(q, [email, displayName]);
    return r.rows[0]?.id || null;
  } catch {
    return null;
  }
}

// CORS helper for public endpoints
function applyPublicCors(req, res) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
}

// GET /applications - List applications
router.get("/", async (req, res) => {
  try {
    const filters = {
      position: req.query.position,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
    };
    const clauses = ["1=1"];
    const params = [];

    if (filters.position) {
      params.push(`%${filters.position}%`);
    }
    if (filters.dateFrom) {
      params.push(filters.dateFrom);
      clauses.push(`a.application_date >= $${params.length}`);
    }
    if (filters.dateTo) {
      params.push(filters.dateTo);
      clauses.push(`a.application_date <= $${params.length}`);
    }

    let sql = `SELECT a.* FROM ${APP_TABLE} a`;
    if (filters.position) {
      sql += ` LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON (a.job_requisition_id IS NOT NULL AND jl.job_requisition_id = a.job_requisition_id)`;
      clauses.push(`COALESCE(jl.job_title,'') ILIKE $${params.length}`);
    }
    sql += ` WHERE ${clauses.join(" AND ")} ORDER BY a.application_date DESC NULLS LAST, a.${APP_PK} DESC`;

    const { rows } = await req.db.query(sql, params);
    res.json(rows);
  } catch (error) {
    console.error("GET /applications error", error);
    res.json([]);
  }
});

// DELETE /applications/:id - Delete application (admin only)
router.delete("/:id", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "invalid_application" });
  }
  try {
    await req.db.query("BEGIN");
    const delStages = await req.db.query(
      `DELETE FROM ${DEFAULT_SCHEMA}.application_stages WHERE application_id = $1`,
      [id]
    );
    const delApp = await req.db.query(`DELETE FROM ${APP_TABLE} WHERE ${APP_PK} = $1`, [id]);
    await req.db.query("COMMIT");

    if (delApp.rowCount === 0) {
      return res.status(404).json({ error: "not_found" });
    }
    return res.json({
      success: true,
      deleted: { application: delApp.rowCount, stages: delStages.rowCount },
    });
  } catch (e) {
    try {
      await req.db.query("ROLLBACK");
    } catch {}
    console.error("DELETE /applications/:id error", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// POST /applications/:applicationId/upload/resume - Upload resume
router.post("/:applicationId/upload/resume", upload.single("file"), async (req, res) => {
  try {
    const applicationId = parseInt(req.params.applicationId, 10);
    if (!Number.isFinite(applicationId)) {
      return res.status(400).json({ error: "invalid_application" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "file_required" });
    }

    const appQ = await req.db.query(
      `SELECT a.${APP_PK} AS application_id, a.candidate_id, c.first_name, c.last_name
       FROM ${APP_TABLE} a
       JOIN ${PEOPLE_TABLE} c ON c.${PEOPLE_PK} = a.candidate_id
       WHERE a.${APP_PK} = $1`,
      [applicationId]
    );
    if (!appQ.rows.length) {
      return res.status(404).json({ error: "not_found" });
    }
    const a = appQ.rows[0];

    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const candSlug = `${slugify(a.first_name)}-${slugify(a.last_name)}-${a.candidate_id}`;
    const ext = pickExt(req.file.originalname, req.file.mimetype);
    const fname = `${candSlug}-resume-${now.getTime()}${ext}`;
    const relPath = `ats/applications/${applicationId}/${yyyy}/${mm}/${safeFileName(fname)}`;
    const absPath = safeJoin(FILES_ROOT, relPath);

    await ensureDir(path.dirname(absPath));
    await fs.promises.writeFile(absPath, req.file.buffer);

    const originalName = safeFileName(req.file.originalname || "file");
    const contentType = req.file.mimetype || mime.lookup(originalName) || "application/octet-stream";
    const byteSize = req.file.size;
    const sha256 = crypto.createHash("sha256").update(req.file.buffer).digest("hex");

    // Extract text for search
    try {
      const txt = await extractTextFromBuffer(req.file.buffer, req.file.originalname, req.file.mimetype);
      const sidecar = absPath + ".txt";
      if (txt && txt.trim()) await fs.promises.writeFile(sidecar, txt, "utf8");
    } catch {}

    const publicUrl = `${FILES_PUBLIC_URL.replace(/\/$/, "")}/${relPath}`;

    // Update application with resume URL
    try {
      await req.db.query(`UPDATE ${APP_TABLE} SET resume_url = $1 WHERE ${APP_PK} = $2`, [
        publicUrl,
        applicationId,
      ]);
    } catch (e) {
      const msg = e?.message || "";
      const code = e?.code || "";
      if (code === "42703" || /column\s+"?resume_url"?\s+does not exist/i.test(msg)) {
        try {
          await req.db.query(`ALTER TABLE ${APP_TABLE} ADD COLUMN IF NOT EXISTS resume_url TEXT`);
          await req.db.query(`UPDATE ${APP_TABLE} SET resume_url = $1 WHERE ${APP_PK} = $2`, [
            publicUrl,
            applicationId,
          ]);
        } catch (e2) {
          if (process.env.DEBUG_UPLOADS === "1")
            console.warn("resume_url alter/update failed:", e2.message);
        }
      }
    }

    // Upsert attachment metadata
    try {
      const uploader = await getActorUserId(req);
      const sql = `INSERT INTO ${DEFAULT_SCHEMA}.${ATS_ATTACHMENTS_TABLE}
                  (application_id, file_name, content_type, byte_size, storage_key, expiration_date, sha256_hex, uploaded_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                 ON CONFLICT (application_id, file_name)
                 DO UPDATE SET content_type = EXCLUDED.content_type,
                               byte_size = EXCLUDED.byte_size,
                               storage_key = EXCLUDED.storage_key,
                               expiration_date = EXCLUDED.expiration_date,
                               sha256_hex = EXCLUDED.sha256_hex,
                               uploaded_by = COALESCE(EXCLUDED.uploaded_by, ${DEFAULT_SCHEMA}.${ATS_ATTACHMENTS_TABLE}.uploaded_by),
                               uploaded_at = NOW()`;
      await req.db.query(sql, [applicationId, originalName, contentType, byteSize, relPath, null, sha256, uploader]);
    } catch (e) {
      if (process.env.DEBUG_UPLOADS === "1")
        console.warn("[RESUME] attachment upsert failed:", e.message);
    }

    // Trigger AI scoring
    try {
      if (enqueueCandidateScore) enqueueCandidateScore(req.db, a.candidate_id);
    } catch {}

    let signedUrl = null;
    try {
      signedUrl = typeof buildSignedUrl === "function" ? buildSignedUrl(relPath, 600) : null;
    } catch {}

    return res.json({ ok: true, url: publicUrl, signedUrl, path: relPath });
  } catch (err) {
    if (err.message === "bad_path") return res.status(400).json({ error: "invalid_path" });
    if (err.code === "LIMIT_FILE_SIZE")
      return res.status(400).json({ error: `file_too_large_max_${MAX_UPLOAD_MB}mb` });
    console.error("resume upload error", err);
    return res.status(500).json({ error: "upload_failed" });
  }
});

// POST /applications/:applicationId/upload/cover-letter - Upload cover letter
router.post("/:applicationId/upload/cover-letter", upload.single("file"), async (req, res) => {
  try {
    const applicationId = parseInt(req.params.applicationId, 10);
    if (!Number.isFinite(applicationId)) {
      return res.status(400).json({ error: "invalid_application" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "file_required" });
    }

    const appQ = await req.db.query(
      `SELECT a.${APP_PK} AS application_id, a.candidate_id, c.first_name, c.last_name
       FROM ${APP_TABLE} a
       JOIN ${PEOPLE_TABLE} c ON c.${PEOPLE_PK} = a.candidate_id
       WHERE a.${APP_PK} = $1`,
      [applicationId]
    );
    if (!appQ.rows.length) {
      return res.status(404).json({ error: "not_found" });
    }
    const a = appQ.rows[0];

    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const candSlug = `${slugify(a.first_name)}-${slugify(a.last_name)}-${a.candidate_id}`;
    const ext = pickExt(req.file.originalname, req.file.mimetype);
    const fname = `${candSlug}-cover-letter-${now.getTime()}${ext}`;
    const relPath = `ats/applications/${applicationId}/${yyyy}/${mm}/${safeFileName(fname)}`;
    const absPath = safeJoin(FILES_ROOT, relPath);

    await ensureDir(path.dirname(absPath));
    await fs.promises.writeFile(absPath, req.file.buffer);

    const originalName = safeFileName(req.file.originalname || "file");
    const contentType = req.file.mimetype || mime.lookup(originalName) || "application/octet-stream";
    const byteSize = req.file.size;
    const sha256 = crypto.createHash("sha256").update(req.file.buffer).digest("hex");

    // Extract text
    try {
      const txt = await extractTextFromBuffer(req.file.buffer, req.file.originalname, req.file.mimetype);
      const sidecar = absPath + ".txt";
      if (txt && txt.trim()) await fs.promises.writeFile(sidecar, txt, "utf8");
    } catch {}

    const publicUrl = `${FILES_PUBLIC_URL.replace(/\/$/, "")}/${relPath}`;

    // Update application
    try {
      await req.db.query(`UPDATE ${APP_TABLE} SET cover_letter_url = $1 WHERE ${APP_PK} = $2`, [
        publicUrl,
        applicationId,
      ]);
    } catch (e) {
      const msg = e?.message || "";
      const code = e?.code || "";
      if (code === "42703" || /column\s+"?cover_letter_url"?\s+does not exist/i.test(msg)) {
        try {
          await req.db.query(`ALTER TABLE ${APP_TABLE} ADD COLUMN IF NOT EXISTS cover_letter_url TEXT`);
          await req.db.query(`UPDATE ${APP_TABLE} SET cover_letter_url = $1 WHERE ${APP_PK} = $2`, [
            publicUrl,
            applicationId,
          ]);
        } catch (e2) {
          if (process.env.DEBUG_UPLOADS === "1")
            console.warn("cover_letter_url alter/update failed:", e2.message);
        }
      }
    }

    // Upsert attachment metadata
    try {
      const uploader = await getActorUserId(req);
      const sql = `INSERT INTO ${DEFAULT_SCHEMA}.${ATS_ATTACHMENTS_TABLE}
                  (application_id, file_name, content_type, byte_size, storage_key, expiration_date, sha256_hex, uploaded_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                 ON CONFLICT (application_id, file_name)
                 DO UPDATE SET content_type = EXCLUDED.content_type,
                               byte_size = EXCLUDED.byte_size,
                               storage_key = EXCLUDED.storage_key,
                               expiration_date = EXCLUDED.expiration_date,
                               sha256_hex = EXCLUDED.sha256_hex,
                               uploaded_by = COALESCE(EXCLUDED.uploaded_by, ${DEFAULT_SCHEMA}.${ATS_ATTACHMENTS_TABLE}.uploaded_by),
                               uploaded_at = NOW()`;
      await req.db.query(sql, [applicationId, originalName, contentType, byteSize, relPath, null, sha256, uploader]);
    } catch (e) {
      if (process.env.DEBUG_UPLOADS === "1")
        console.warn("[COVER] attachment upsert failed:", e.message);
    }

    // Trigger AI scoring
    try {
      if (enqueueCandidateScore) enqueueCandidateScore(req.db, a.candidate_id);
    } catch {}

    let signedUrl = null;
    try {
      signedUrl = typeof buildSignedUrl === "function" ? buildSignedUrl(relPath, 600) : null;
    } catch {}

    return res.json({ ok: true, url: publicUrl, signedUrl, path: relPath });
  } catch (err) {
    if (err.message === "bad_path") return res.status(400).json({ error: "invalid_path" });
    if (err.code === "LIMIT_FILE_SIZE")
      return res.status(400).json({ error: `file_too_large_max_${MAX_UPLOAD_MB}mb` });
    console.error("cover letter upload error", err);
    return res.status(500).json({ error: "upload_failed" });
  }
});

// GET /applications/:id/attachments - List attachments
router.get("/:id/attachments", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "invalid_application" });
  }
  try {
    const sql = `SELECT id, file_name, content_type, byte_size, storage_key, uploaded_by, uploaded_at, expiration_date
                 FROM ${DEFAULT_SCHEMA}.${ATS_ATTACHMENTS_TABLE}
                 WHERE application_id = $1
                 ORDER BY uploaded_at DESC, id DESC`;
    const r = await req.db.query(sql, [id]);
    return res.json(r.rows);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// POST /applications/:id/attachments - Upsert attachment metadata
router.post("/:id/attachments", async (req, res) => {
  const applicationId = parseInt(req.params.id, 10);
  if (!Number.isFinite(applicationId)) {
    return res.status(400).json({ error: "invalid_application" });
  }
  const { file_name, content_type, byte_size, storage_key, expiration_date, sha256_hex } = req.body || {};
  if (!file_name || !storage_key) {
    return res.status(400).json({ error: "file_name_and_storage_key_required" });
  }
  try {
    const uploader = await getActorUserId(req);
    const cols = [
      "application_id",
      "file_name",
      "content_type",
      "byte_size",
      "storage_key",
      "expiration_date",
      "sha256_hex",
      "uploaded_by",
    ];
    const vals = [
      applicationId,
      file_name,
      content_type || null,
      Number(byte_size) || null,
      storage_key,
      expiration_date || null,
      sha256_hex || null,
      uploader,
    ];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
    const sql = `INSERT INTO ${DEFAULT_SCHEMA}.${ATS_ATTACHMENTS_TABLE} (${cols.join(",")})
                 VALUES (${placeholders})
                 ON CONFLICT (application_id, file_name)
                 DO UPDATE SET content_type = EXCLUDED.content_type,
                               byte_size = EXCLUDED.byte_size,
                               storage_key = EXCLUDED.storage_key,
                               expiration_date = EXCLUDED.expiration_date,
                               sha256_hex = EXCLUDED.sha256_hex,
                               uploaded_by = COALESCE(EXCLUDED.uploaded_by, ${DEFAULT_SCHEMA}.${ATS_ATTACHMENTS_TABLE}.uploaded_by),
                               uploaded_at = NOW()
                 RETURNING *`;
    const r = await req.db.query(sql, vals);
    const status = r.command === "INSERT" ? 201 : 200;
    return res.status(status).json(r.rows[0]);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// DELETE /applications/:id/attachments/:attachmentId - Delete attachment
router.delete("/:id/attachments/:attachmentId", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const attachmentId = parseInt(req.params.attachmentId, 10);
  if (!Number.isFinite(id) || !Number.isFinite(attachmentId)) {
    return res.status(400).json({ error: "invalid_params" });
  }
  try {
    const sql = `DELETE FROM ${DEFAULT_SCHEMA}.${ATS_ATTACHMENTS_TABLE} WHERE application_id = $1 AND id = $2 RETURNING id`;
    const r = await req.db.query(sql, [id, attachmentId]);
    if (!r.rows[0]) return res.status(404).json({ error: "not_found" });
    return res.json({ deleted: true });
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// POST /applications/:id/attachments/upload - Upload generic attachment
router.post("/:id/attachments/upload", upload.single("file"), async (req, res) => {
  try {
    const applicationId = parseInt(req.params.id, 10);
    if (!Number.isFinite(applicationId)) {
      return res.status(400).json({ error: "invalid_application" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "file_required" });
    }

    let { storage_key, expiration_date } = req.body || {};
    const originalName = safeFileName(req.file.originalname || "file");
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, "0");

    if (!storage_key) {
      const uuid = crypto.randomUUID();
      storage_key = `ats/applications/${applicationId}/${yyyy}/${mm}/${uuid}-${originalName}`;
    }
    const absPath = safeJoin(FILES_ROOT, storage_key);
    await ensureDir(path.dirname(absPath));

    const sha256 = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
    await fs.promises.writeFile(absPath, req.file.buffer);

    const size = req.file.size;
    const contentType = req.file.mimetype || mime.lookup(originalName) || "application/octet-stream";

    // Upsert metadata
    const uploader = await getActorUserId(req);
    const sql = `INSERT INTO ${DEFAULT_SCHEMA}.${ATS_ATTACHMENTS_TABLE}
                (application_id, file_name, content_type, byte_size, storage_key, expiration_date, sha256_hex, uploaded_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT (application_id, file_name)
               DO UPDATE SET content_type = EXCLUDED.content_type,
                             byte_size = EXCLUDED.byte_size,
                             storage_key = EXCLUDED.storage_key,
                             expiration_date = EXCLUDED.expiration_date,
                             sha256_hex = EXCLUDED.sha256_hex,
                             uploaded_by = COALESCE(EXCLUDED.uploaded_by, ${DEFAULT_SCHEMA}.${ATS_ATTACHMENTS_TABLE}.uploaded_by),
                             uploaded_at = NOW()
               RETURNING *`;
    const vals = [applicationId, originalName, contentType, size, storage_key, expiration_date || null, sha256, uploader];
    const r = await req.db.query(sql, vals);

    const publicUrl = `${FILES_PUBLIC_URL.replace(/\/$/, "")}/${storage_key}`;
    return res.status(201).json({
      storage_key,
      public_url: publicUrl,
      file_name: originalName,
      content_type: contentType,
      byte_size: size,
      sha256_hex: sha256,
      attachment: r.rows[0] || null,
    });
  } catch (e) {
    if (e.message === "bad_path") return res.status(400).json({ error: "invalid_storage_key" });
    if (e.code === "LIMIT_FILE_SIZE")
      return res.status(400).json({ error: `file_too_large_max_${MAX_UPLOAD_MB}mb` });
    return res.status(500).json({ error: "upload_failed", detail: e.message });
  }
});

// POST /applications (authenticated, app-only)
// Accepts a job application submission from a trusted caller using Azure AD client credentials
router.post("/", async (req, res) => {
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
      application_source = "api-app",
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
    } = req.body || {};

    const applicantEmail =
      email ||
      req.body?.emailAddress ||
      req.body?.email_address ||
      req.body?.applicantEmail ||
      req.body?.applicant_email ||
      req.body?.candidateEmail ||
      req.body?.candidate_email;
    if (!applicantEmail)
      return res.status(400).json({ success: false, error: "email_required" });

    let compositeName =
      name || fullName || req.body?.candidateName || req.body?.candidate_name;
    let firstName = first_name;
    let lastName = last_name;
    if (compositeName && (!firstName || !lastName)) {
      const parts = compositeName.trim().split(/\s+/);
      firstName = firstName || parts[0] || "Unknown";
      lastName = lastName || parts.slice(1).join(" ") || "Unknown";
    }
    firstName = firstName || "Unknown";
    lastName = lastName || "Unknown";

    const normalizedSalaryRange =
      expected_salary_range ||
      expectedSalaryRange ||
      expected_salary ||
      expectedSalary;
    const yearsExp = years_experience || yearsExperience;
    // Requisition-only enforcement
    const jobReqId = job_requisition_id || req.body?.job_requisition_id || null;
    if (!jobReqId)
      return res
        .status(400)
        .json({ success: false, error: "job_requisition_id_required" });

    // Extract form fields for candidate profile
    const {
      valueResonates,
      motivation,
      onsite,
      terminated,
      references,
      workAuth,
      salaryRange,
    } = req.body || {};

    // Convert form values to database format
    const valuesResonatesText = valueResonates || null;
    const motivationText = motivation || null;
    const onsiteAvailable =
      onsite === "yes" ? true : onsite === "no" ? false : null;
    const terminationHistory = terminated || null;
    const referencesAvailable =
      references === "yes" ? true : references === "no" ? false : null;
    const workAuthorization =
      workAuth === "yes" ? true : workAuth === "no" ? false : null;
    const formSalaryRange = salaryRange || null;

    // Extract numeric salary for sorting/filtering
    let expectedSalaryNumeric = null;
    if (expectedSalaryRange) {
      const numMatch = expectedSalaryRange.match(/[\$]?(\d{1,3}(?:,?\d{3})*)/);
      if (numMatch)
        expectedSalaryNumeric = parseInt(numMatch[1].replace(/,/g, ""));
    }

    // Candidate upsert with form fields
    const findCandidateSql = `SELECT candidate_id FROM ${DEFAULT_SCHEMA}.candidates WHERE LOWER(email) = LOWER($1) LIMIT 1`;
    const existing = await req.db.query(findCandidateSql, [applicantEmail]);
    let candidateId;
    if (existing.rows.length > 0) {
      candidateId = existing.rows[0].candidate_id;
      // Update existing candidate with new form data
      const updates = [];
      const params = [candidateId];
      let i = 1;

      if (phone) {
        i++;
        updates.push(`phone = $${i}`);
        params.push(phone);
      }
      if (linkedin_url) {
        i++;
        updates.push(`linkedin_url = $${i}`);
        params.push(linkedin_url);
      }
      if (valuesResonatesText !== null) {
        i++;
        updates.push(`values_resonates = $${i}`);
        params.push(valuesResonatesText);
      }
      if (motivationText !== null) {
        i++;
        updates.push(`motivation = $${i}`);
        params.push(motivationText);
      }
      if (onsiteAvailable !== null) {
        i++;
        updates.push(`onsite_available = $${i}`);
        params.push(onsiteAvailable);
      }
      if (terminationHistory !== null) {
        i++;
        updates.push(`termination_history = $${i}`);
        params.push(terminationHistory);
      }
      if (referencesAvailable !== null) {
        i++;
        updates.push(`references_available = $${i}`);
        params.push(referencesAvailable);
      }
      if (workAuthorization !== null) {
        i++;
        updates.push(`work_authorization = $${i}`);
        params.push(workAuthorization);
      }
      if (expectedSalaryRange !== null) {
        i++;
        updates.push(`expected_salary_range = $${i}`);
        params.push(expectedSalaryRange);
      }
      if (expectedSalaryNumeric !== null) {
        i++;
        updates.push(`expected_salary_numeric = $${i}`);
        params.push(expectedSalaryNumeric);
      }

      if (updates.length) {
        await req.db.query(
          `UPDATE ${DEFAULT_SCHEMA}.candidates SET ${updates.join(
            ", "
          )} WHERE candidate_id = $1`,
          params
        );
      }
    } else {
      const ins = await req.db.query(
        `INSERT INTO ${DEFAULT_SCHEMA}.candidates (
          first_name, last_name, email, phone, linkedin_url,
          values_resonates, motivation, onsite_available, termination_history,
          references_available, work_authorization, expected_salary_range, expected_salary_numeric
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING candidate_id`,
        [
          firstName,
          lastName,
          applicantEmail,
          phone || null,
          linkedin_url || null,
          valuesResonatesText,
          motivationText,
          onsiteAvailable,
          terminationHistory,
          referencesAvailable,
          workAuthorization,
          expectedSalaryRange,
          expectedSalaryNumeric,
        ]
      );
      candidateId = ins.rows[0].candidate_id;
    }

    // Application insert (dynamic)
    const colsResult = await req.db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'applications'`,
      [DEFAULT_SCHEMA]
    );
    const appCols = new Set(colsResult.rows.map((r) => r.column_name));
    const cols = ["candidate_id"];
    const vals = ["$1"];
    const params = [candidateId];
    const push = (c, v) => {
      if (v !== undefined && v !== null) {
        params.push(v);
        cols.push(c);
        vals.push(`$${params.length}`);
      }
    };

    // Always resolve job listing by requisition id only
    let jl = null;
    {
      const r = await req.db.query(
        `SELECT * FROM ${DEFAULT_SCHEMA}.job_listings WHERE job_requisition_id = $1 LIMIT 1`,
        [jobReqId]
      );
      jl = r.rows[0] || null;
      if (!jl)
        return res
          .status(400)
          .json({ success: false, error: "invalid_job_requisition_id" });
    }

    if (appCols.has("application_source"))
      push("application_source", application_source);
    if (appCols.has("job_listing_id"))
      push("job_listing_id", jl?.job_listing_id ?? null);
    if (appCols.has("job_requisition_id"))
      push("job_requisition_id", jl?.job_requisition_id || jobReqId);
    if (appCols.has("job_title"))
      push("job_title", job_title || jl?.job_title || null);
    if (appCols.has("job_department"))
      push("job_department", department || jl?.department || null);
    if (appCols.has("job_location"))
      push("job_location", location || jl?.location || null);
    if (appCols.has("recruiter_assigned"))
      push("recruiter_assigned", jl?.recruiter_assigned || null);
    if (appCols.has("hiring_manager_assigned"))
      push("hiring_manager_assigned", jl?.hiring_manager || null);
    if (appCols.has("name")) push("name", compositeName || null);
    if (appCols.has("email")) push("email", applicantEmail || null);
    if (appCols.has("expected_salary_range"))
      push("expected_salary_range", normalizedSalaryRange || null);
    if (appCols.has("expected_salary"))
      push("expected_salary", normalizedSalaryRange || null);
    if (appCols.has("years_experience"))
      push("years_experience", yearsExp ? Number(yearsExp) : null);
    // Persist photo URL
    const photoUrlValue = photo_url || photoUrl || null;
    if (photoUrlValue) {
      if (!appCols.has("photo_url")) {
        try {
          await req.db.query(
            `ALTER TABLE ${APP_TABLE} ADD COLUMN IF NOT EXISTS photo_url TEXT`
          );
          appCols.add("photo_url");
        } catch {}
      }
      if (appCols.has("photo_url")) push("photo_url", photoUrlValue);
    }

    const appDateFragment = appCols.has("application_date")
      ? ",application_date"
      : "";
    const appDateValues = appCols.has("application_date") ? ",NOW()" : "";
    const insSql = `INSERT INTO ${DEFAULT_SCHEMA}.applications (${cols.join(
      ","
    )}${appDateFragment}) VALUES (${vals.join(
      ","
    )}${appDateValues}) RETURNING application_id`;
    const insApp = await req.db.query(insSql, params);
    const applicationId = insApp.rows[0]?.application_id || null;

    if (applicationId) {
      try {
        await req.db.query(
          `INSERT INTO ${DEFAULT_SCHEMA}.application_stages (application_id, stage_name, status, notes, updated_at) VALUES ($1,'Applied','new',NULL,NOW())`,
          [applicationId]
        );
      } catch {}

      // Emit real-time event for new application
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

    return res.status(201).json({
      success: true,
      application_id: applicationId,
      candidate_id: candidateId,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ success: false, error: "internal_error", message: e.message });
  }
});

module.exports = router;
module.exports.initApplications = initApplications;
module.exports.applyPublicCors = applyPublicCors;
module.exports.getActorUserId = getActorUserId;
