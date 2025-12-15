/**
 * Miscellaneous Routes Module
 * Handles routes that don't fit neatly into other modules:
 * - Health checks
 * - Departments (non-admin access)
 * - Debug endpoints
 * - Applicant history
 * - Duplicate detection
 * - Candidate reactivation suggestions
 */

const express = require("express");
const router = express.Router();

const {
  DEFAULT_SCHEMA,
  PEOPLE_TABLE,
  PEOPLE_PK,
  APP_TABLE,
  APP_PK,
  getPrimaryEmail,
  isAdmin,
  ensureAdminTables,
} = require("./helpers");

// Dependencies injected via init
let buildCandidateVM = null;
let emailService = null;

function initMisc(deps) {
  if (deps.buildCandidateVM) buildCandidateVM = deps.buildCandidateVM;
  if (deps.emailService) emailService = deps.emailService;
}

// ==================== HEALTH CHECKS ====================
router.get("/health", async (req, res) => {
  try {
    const r = await req.db.query(
      "SELECT NOW() AS now, current_database() AS db"
    );
    res.status(200).json({
      status: "OK",
      app: req.appId || "ats",
      database: "Connected",
      database_name: r.rows?.[0]?.db || null,
      timestamp: r.rows?.[0]?.now || new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({
      status: "ERROR",
      app: req.appId || "ats",
      database: "Disconnected",
      error: e.message,
    });
  }
});

router.get("/health/db", async (req, res) => {
  try {
    const r = await req.db.query("SELECT NOW() AS now");
    res.status(200).json({
      ok: true,
      app: req.appId || "ats",
      now: r.rows?.[0]?.now || new Date().toISOString(),
    });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, app: req.appId || "ats", error: e.message });
  }
});

// ==================== DEPARTMENTS (NON-ADMIN) ====================
// List departments for current user
router.get("/departments", async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const email = getPrimaryEmail(req);
    if (isAdmin(req)) {
      const { rows } = await req.db.query(
        `SELECT department_id, department_name, description, created_at FROM ${DEFAULT_SCHEMA}.departments ORDER BY department_name`
      );
      return res.json(rows);
    }
    const { rows } = await req.db.query(
      `SELECT d.department_id, d.department_name, d.description, d.created_at
         FROM ${DEFAULT_SCHEMA}.departments d
         JOIN ${DEFAULT_SCHEMA}.department_members m ON m.department_id = d.department_id
        WHERE m.email = $1
        ORDER BY d.department_name`,
      [email]
    );
    return res.json(rows);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// Department members (non-admin)
router.get("/departments/:id/members", async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const id = parseInt(req.params.id, 10);
    const { rows } = await req.db.query(
      `SELECT email, role, created_at FROM ${DEFAULT_SCHEMA}.department_members WHERE department_id = $1 ORDER BY email`,
      [id]
    );
    return res.json(rows);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// Department applicants
router.get("/departments/:id/applicants", async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const deptId = parseInt(req.params.id, 10);
    // Get department name
    const { rows: deptRows } = await req.db.query(
      `SELECT department_name FROM ${DEFAULT_SCHEMA}.departments WHERE department_id = $1`,
      [deptId]
    );
    const deptName = deptRows[0]?.department_name || "";
    // Find applications for jobs in that department
    const sql = `
      SELECT c.${PEOPLE_PK} as candidate_id, c.first_name, c.last_name, c.email,
             a.${APP_PK} as application_id, a.application_date, jl.job_title
        FROM ${APP_TABLE} a
        JOIN ${PEOPLE_TABLE} c ON c.${PEOPLE_PK} = a.candidate_id
        LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON jl.job_requisition_id = a.job_requisition_id
       WHERE jl.department = $1
       ORDER BY a.application_date DESC
       LIMIT 100`;
    const { rows } = await req.db.query(sql, [deptName]);
    return res.json(rows);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ==================== APPLICANT HISTORY ====================
router.get("/applicants/history/:email", async (req, res) => {
  try {
    const email = req.params.email;
    const sql = `
      SELECT c.${PEOPLE_PK} as candidate_id, c.first_name, c.last_name, c.email,
             a.${APP_PK} as application_id, a.application_date, a.job_title,
             (SELECT s.stage_name FROM ${DEFAULT_SCHEMA}.application_stages s
              WHERE s.application_id = a.${APP_PK}
              ORDER BY s.updated_at DESC LIMIT 1) as current_stage,
             (SELECT s.status FROM ${DEFAULT_SCHEMA}.application_stages s
              WHERE s.application_id = a.${APP_PK}
              ORDER BY s.updated_at DESC LIMIT 1) as current_status
        FROM ${PEOPLE_TABLE} c
        JOIN ${APP_TABLE} a ON a.candidate_id = c.${PEOPLE_PK}
       WHERE LOWER(c.email) = LOWER($1)
       ORDER BY a.application_date DESC`;
    const { rows } = await req.db.query(sql, [email]);
    return res.json(rows);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ==================== DUPLICATE DETECTION ====================
router.get("/candidates/:id/duplicate-applications", async (req, res) => {
  try {
    const candidateId = parseInt(req.params.id, 10);
    if (!Number.isFinite(candidateId)) {
      return res.status(400).json({ error: "invalid_candidate_id" });
    }

    const sql = `
      SELECT
        a.job_requisition_id,
        jl.job_title,
        COUNT(a.${APP_PK})::int AS application_count,
        MIN(a.application_date) AS first_application_date,
        MAX(a.application_date) AS last_application_date,
        array_agg(
          json_build_object(
            'application_id', a.${APP_PK},
            'application_date', a.application_date,
            'application_source', a.application_source
          ) ORDER BY a.application_date DESC
        ) AS applications
      FROM ${APP_TABLE} a
      LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON a.job_requisition_id = jl.job_requisition_id
      WHERE a.candidate_id = $1
      GROUP BY a.job_requisition_id, jl.job_title
      HAVING COUNT(a.${APP_PK}) > 1
      ORDER BY MAX(a.application_date) DESC
    `;

    const result = await req.db.query(sql, [candidateId]);

    return res.json({
      success: true,
      duplicates: result.rows,
      total_duplicate_jobs: result.rows.length,
    });
  } catch (error) {
    console.error("[DUPLICATE_CHECK] Error:", error);
    return res
      .status(500)
      .json({ error: "failed_to_check_duplicates", message: error.message });
  }
});

router.post("/applications/check-duplicate", async (req, res) => {
  try {
    const { email, job_requisition_id } = req.body;

    if (!email || !job_requisition_id) {
      return res.status(400).json({ error: "email_and_job_required" });
    }

    const sql = `
      SELECT
        c.${PEOPLE_PK} AS candidate_id,
        c.first_name,
        c.last_name,
        c.email,
        a.${APP_PK} AS application_id,
        a.application_date,
        a.application_source,
        jl.job_title,
        (
          SELECT s.status
          FROM ${DEFAULT_SCHEMA}.application_stages s
          WHERE s.application_id = a.${APP_PK}
          ORDER BY s.updated_at DESC NULLS LAST
          LIMIT 1
        ) AS current_status
      FROM ${PEOPLE_TABLE} c
      INNER JOIN ${APP_TABLE} a ON a.candidate_id = c.${PEOPLE_PK}
      LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON a.job_requisition_id = jl.job_requisition_id
      WHERE LOWER(c.email) = LOWER($1)
        AND a.job_requisition_id = $2
      ORDER BY a.application_date DESC
      LIMIT 1
    `;

    const result = await req.db.query(sql, [email, job_requisition_id]);

    if (result.rows.length > 0) {
      const existing = result.rows[0];
      return res.json({
        success: true,
        is_duplicate: true,
        existing_application: {
          application_id: existing.application_id,
          candidate_id: existing.candidate_id,
          candidate_name: `${existing.first_name || ""} ${existing.last_name || ""}`.trim(),
          application_date: existing.application_date,
          application_source: existing.application_source,
          job_title: existing.job_title,
          current_status: existing.current_status || "Unknown",
        },
      });
    } else {
      return res.json({
        success: true,
        is_duplicate: false,
      });
    }
  } catch (error) {
    console.error("[DUPLICATE_CHECK] Error:", error);
    return res
      .status(500)
      .json({ error: "failed_to_check_duplicate", message: error.message });
  }
});

// ==================== DEBUG ====================
router.get("/debug/candidates/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: candidate } = await req.db.query(
      `SELECT * FROM ${PEOPLE_TABLE} WHERE ${PEOPLE_PK} = $1`,
      [id]
    );
    const { rows: applications } = await req.db.query(
      `SELECT * FROM ${APP_TABLE} WHERE candidate_id = $1 ORDER BY application_date DESC`,
      [id]
    );
    const { rows: stages } = await req.db.query(
      `SELECT s.* FROM ${DEFAULT_SCHEMA}.application_stages s
         JOIN ${APP_TABLE} a ON a.${APP_PK} = s.application_id
        WHERE a.candidate_id = $1
        ORDER BY s.updated_at DESC`,
      [id]
    );
    return res.json({ candidate: candidate[0] || null, applications, stages });
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ==================== CANDIDATE STAGES ====================
router.get("/candidates/:id/stages", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const sql = `
      SELECT s.stage_id, s.application_id, s.stage_name, s.status, s.notes, s.updated_at, s.internal_score
        FROM ${DEFAULT_SCHEMA}.application_stages s
        JOIN ${APP_TABLE} a ON a.${APP_PK} = s.application_id
       WHERE a.candidate_id = $1
       ORDER BY s.updated_at DESC`;
    const { rows } = await req.db.query(sql, [id]);
    return res.json(rows);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ==================== CANDIDATE UPDATES (PUT routes) ====================
const PEOPLE_TABLE_NAME = PEOPLE_TABLE.split(".").pop();
const APP_TABLE_NAME = APP_TABLE.split(".").pop();

// PUT /candidates/:id/application - Update candidate application data
router.put("/candidates/:id/application", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = { ...(req.body || {}) };

    const { rowCount: isCandidate } = await req.db.query(
      `SELECT 1 FROM ${PEOPLE_TABLE} WHERE ${PEOPLE_PK} = $1`,
      [id]
    );

    const mapped = { ...data };
    if (mapped.position && !mapped.job_title) mapped.job_title = mapped.position;
    if (mapped.salary_expectation && !mapped.expected_salary) mapped.expected_salary = mapped.salary_expectation;
    if (mapped.experience_years && !mapped.years_experience) mapped.years_experience = mapped.experience_years;

    // Get candidate columns
    const { rows: candColsRows } = await req.db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      [DEFAULT_SCHEMA, PEOPLE_TABLE_NAME]
    );
    const candCols = new Set((candColsRows || []).map((r) => r.column_name));
    const candidateFields = [
      "first_name", "last_name", "email", "phone", "address", "city", "state",
      "country", "linkedin_url", "portfolio_url", "work_eligibility", "willing_to_relocate",
    ].filter((k) => candCols.has(k));

    const candSets = [];
    const candParams = [];
    candidateFields.forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(mapped, k)) {
        let v = mapped[k];
        if (v === "") v = null;
        candParams.push(v);
        candSets.push(`${k} = $${candParams.length}`);
      }
    });

    if (isCandidate && candSets.length) {
      candParams.push(id);
      await req.db.query(
        `UPDATE ${PEOPLE_TABLE} SET ${candSets.join(", ")} WHERE ${PEOPLE_PK} = $${candParams.length}`,
        candParams
      );
    }

    // Find application
    let applicationId = null;
    let candidateId = isCandidate ? id : null;
    if (isCandidate) {
      const { rows } = await req.db.query(
        `SELECT ${APP_PK}, candidate_id FROM ${APP_TABLE} WHERE candidate_id = $1 ORDER BY application_date DESC NULLS LAST, ${APP_PK} DESC LIMIT 1`,
        [id]
      );
      applicationId = rows[0]?.[APP_PK] || null;
    } else {
      const { rows } = await req.db.query(
        `SELECT candidate_id FROM ${APP_TABLE} WHERE ${APP_PK} = $1`,
        [id]
      );
      candidateId = rows[0]?.candidate_id || candidateId;
      applicationId = id;
    }

    // Get application columns
    const { rows: appColsRows } = await req.db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      [DEFAULT_SCHEMA, APP_TABLE_NAME]
    );
    const appCols = new Set((appColsRows || []).map((r) => r.column_name));
    const applicationFields = [
      "job_title", "job_requisition_id", "application_date", "application_source",
      "resume_url", "cover_letter_url", "expected_salary", "years_experience",
      "recruiter_assigned", "hiring_manager_assigned", "name", "email", "phone", "expected_salary_range",
    ].filter((k) => appCols.has(k));

    const appSets = [];
    const appParams = [];
    applicationFields.forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(mapped, k)) {
        let v = mapped[k];
        if (v === "") v = null;
        if (k === "expected_salary" || k === "years_experience") v = v === null ? null : Number(v);
        appParams.push(v);
        appSets.push(`${k} = $${appParams.length}`);
      }
    });

    // Update existing application
    if (applicationId && appSets.length) {
      appParams.push(applicationId);
      await req.db.query(
        `UPDATE ${APP_TABLE} SET ${appSets.join(", ")} WHERE ${APP_PK} = $${appParams.length}`,
        appParams
      );
    }

    // Handle notes
    if (Object.prototype.hasOwnProperty.call(mapped, "notes") && applicationId) {
      const notesVal = mapped.notes === "" ? null : mapped.notes;
      const { rowCount } = await req.db.query(
        `WITH latest AS (
           SELECT stage_id FROM ${DEFAULT_SCHEMA}.application_stages WHERE application_id = $1 ORDER BY updated_at DESC NULLS LAST, stage_id DESC LIMIT 1
         )
         UPDATE ${DEFAULT_SCHEMA}.application_stages SET notes = $2, updated_at = NOW()
         WHERE stage_id = (SELECT stage_id FROM latest)`,
        [applicationId, notesVal]
      );
      if (!rowCount) {
        await req.db.query(
          `INSERT INTO ${DEFAULT_SCHEMA}.application_stages (application_id, stage_name, status, notes, updated_at)
           VALUES ($1, 'Applied', 'new', $2, NOW())`,
          [applicationId, notesVal]
        );
      }
    }

    const updatedCandidate = candidateId && buildCandidateVM
      ? await buildCandidateVM(req.db, candidateId)
      : null;
    res.json({ success: true, updatedCandidate });
  } catch (e) {
    console.error("PUT /candidates/:id/application error", e);
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
});

// PUT /candidates/:id/stage - Update candidate stage
router.put("/candidates/:id/stage", async (req, res) => {
  try {
    const candidateId = Number(req.params.id);
    const { stage, status, notes, internalScore } = req.body || {};

    const { rows } = await req.db.query(
      `SELECT ${APP_PK} FROM ${APP_TABLE} WHERE candidate_id = $1 ORDER BY application_date DESC NULLS LAST, ${APP_PK} DESC LIMIT 1`,
      [candidateId]
    );
    const appId = rows[0]?.[APP_PK];
    if (!appId) return res.status(400).json({ success: false, error: "Missing application for candidate" });

    const scoreVal = internalScore === "" || internalScore === undefined || internalScore === null
      ? null
      : Number(internalScore);

    const upd = await req.db.query(
      `WITH latest AS (
         SELECT stage_id FROM ${DEFAULT_SCHEMA}.application_stages WHERE application_id = $1 ORDER BY updated_at DESC NULLS LAST, stage_id DESC LIMIT 1
       )
       UPDATE ${DEFAULT_SCHEMA}.application_stages
        SET stage_name = COALESCE($2, stage_name),
            status = COALESCE($3, status),
            notes = COALESCE($4, notes),
            internal_score = COALESCE($5::numeric, internal_score),
            updated_at = NOW()
      WHERE stage_id = (SELECT stage_id FROM latest)`,
      [appId, stage || null, status || null, notes || null, scoreVal]
    );

    if (!upd.rowCount) {
      await req.db.query(
        `INSERT INTO ${DEFAULT_SCHEMA}.application_stages (application_id, stage_name, status, notes, internal_score, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [appId, stage || "Applied", status || "new", notes || null, scoreVal]
      );
    }

    const updatedCandidate = buildCandidateVM ? await buildCandidateVM(req.db, candidateId) : null;
    res.json({ success: true, updatedCandidate });
  } catch (e) {
    console.error("PUT /candidates/:id/stage error", e);
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
});

// PUT /candidates/:id/notes - Update candidate notes
router.put("/candidates/:id/notes", async (req, res) => {
  try {
    const candidateId = Number(req.params.id);
    const { notes } = req.body || {};

    const { rows } = await req.db.query(
      `SELECT ${APP_PK} FROM ${APP_TABLE} WHERE candidate_id = $1 ORDER BY application_date DESC NULLS LAST, ${APP_PK} DESC LIMIT 1`,
      [candidateId]
    );
    const appId = rows[0]?.[APP_PK];
    if (!appId) return res.status(400).json({ success: false, error: "Missing application for candidate" });

    const notesVal = notes === "" ? null : notes;
    const upd = await req.db.query(
      `WITH latest AS (
         SELECT stage_id FROM ${DEFAULT_SCHEMA}.application_stages WHERE application_id = $1 ORDER BY updated_at DESC NULLS LAST, stage_id DESC LIMIT 1
       )
       UPDATE ${DEFAULT_SCHEMA}.application_stages SET notes = $2, updated_at = NOW()
       WHERE stage_id = (SELECT stage_id FROM latest)`,
      [appId, notesVal]
    );

    if (!upd.rowCount) {
      await req.db.query(
        `INSERT INTO ${DEFAULT_SCHEMA}.application_stages (application_id, stage_name, status, notes, updated_at)
         VALUES ($1, 'Applied', 'new', $2, NOW())`,
        [appId, notesVal]
      );
    }

    const updatedCandidate = buildCandidateVM ? await buildCandidateVM(req.db, candidateId) : null;
    res.json({ success: true, updatedCandidate });
  } catch (e) {
    console.error("PUT /candidates/:id/notes error", e);
    res.status(e.status || 500).json({ success: false, error: e.message });
  }
});

// ==================== CANDIDATE REACTIVATION ====================
function generateRecommendationReason(candidate, job, matchScore) {
  const reasons = [];
  if (candidate.overall_score >= 85) reasons.push("Exceptional candidate profile");
  else if (candidate.overall_score >= 75) reasons.push("Strong candidate profile");
  else if (candidate.overall_score >= 65) reasons.push("Good candidate profile");

  if (candidate.skills_fit >= 80) reasons.push("excellent skills match");
  else if (candidate.skills_fit >= 70) reasons.push("strong skills match");

  if (candidate.experience_fit >= 80) reasons.push("highly relevant experience");

  if (reasons.length === 0) return `Match score: ${Math.round(matchScore)}%`;
  return reasons.slice(0, 3).join(", ").replace(/^./, (str) => str.toUpperCase());
}

router.get("/jobs/:id/suggested-candidates", async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    if (!Number.isFinite(jobId)) return res.status(400).json({ error: "invalid_job_id" });

    const limit = parseInt(req.query.limit, 10) || 20;
    const minScore = parseInt(req.query.min_score, 10) || 60;
    const monthsSinceRejection = parseInt(req.query.months_since_rejection, 10) || 6;

    const jobSql = `
      SELECT job_requisition_id, job_title, job_description, department,
             location, required_skills, employment_type, min_salary, max_salary
      FROM ${DEFAULT_SCHEMA}.job_listings
      WHERE job_requisition_id = $1
    `;
    const jobResult = await req.db.query(jobSql, [jobId]);
    if (jobResult.rows.length === 0) return res.status(404).json({ error: "job_not_found" });

    const job = jobResult.rows[0];

    const candidatesSql = `
      WITH candidate_latest_status AS (
        SELECT
          a.candidate_id,
          MAX(a.application_date) AS last_application_date,
          (SELECT s.status FROM ${DEFAULT_SCHEMA}.application_stages s WHERE s.application_id = a.${APP_PK} ORDER BY s.updated_at DESC NULLS LAST LIMIT 1) AS last_status,
          (SELECT MAX(s.updated_at) FROM ${DEFAULT_SCHEMA}.application_stages s WHERE s.application_id = a.${APP_PK} AND LOWER(s.status) IN ('rejected', 'declined')) AS last_rejection_date
        FROM ${APP_TABLE} a GROUP BY a.candidate_id
      ),
      candidate_scores AS (
        SELECT candidate_id, overall_score, experience_fit, skills_fit, culture_fit, location_fit, strengths, risk_flags, created_at AS score_date
        FROM ${DEFAULT_SCHEMA}.candidate_ai_scores WHERE overall_score >= $2
      ),
      excluded_candidates AS (
        SELECT DISTINCT candidate_id FROM ${APP_TABLE} WHERE job_requisition_id = $1
        UNION SELECT DISTINCT candidate_id FROM ${DEFAULT_SCHEMA}.candidate_flags WHERE flag_type = 'do_not_consider'
        UNION SELECT DISTINCT cls.candidate_id FROM candidate_latest_status cls WHERE cls.last_status IS NOT NULL AND LOWER(cls.last_status) NOT IN ('rejected', 'declined', 'hired', 'withdrawn')
        UNION SELECT DISTINCT cls.candidate_id FROM candidate_latest_status cls WHERE cls.last_rejection_date IS NOT NULL AND cls.last_rejection_date > NOW() - INTERVAL '${monthsSinceRejection} months'
      )
      SELECT c.${PEOPLE_PK} AS candidate_id, c.first_name, c.last_name, c.email, c.phone, c.location, c.linkedin_url, c.expected_salary_range,
             cs.overall_score, cs.experience_fit, cs.skills_fit, cs.culture_fit, cs.location_fit, cs.strengths, cs.risk_flags,
             cls.last_application_date, cls.last_status
      FROM ${PEOPLE_TABLE} c
      INNER JOIN candidate_scores cs ON cs.candidate_id = c.${PEOPLE_PK}
      LEFT JOIN candidate_latest_status cls ON cls.candidate_id = c.${PEOPLE_PK}
      WHERE c.${PEOPLE_PK} NOT IN (SELECT candidate_id FROM excluded_candidates) AND c.archived = FALSE
      ORDER BY cs.overall_score DESC, cls.last_application_date DESC NULLS LAST
      LIMIT $3
    `;

    const candidatesResult = await req.db.query(candidatesSql, [jobId, minScore, limit]);

    const candidates = candidatesResult.rows.map((candidate) => {
      let recencyFactor = 0.5;
      if (candidate.last_application_date) {
        const daysSinceApplication = (Date.now() - new Date(candidate.last_application_date).getTime()) / (1000 * 60 * 60 * 24);
        recencyFactor = Math.max(0, 1 - daysSinceApplication / 730);
      }
      const matchScore =
        (candidate.skills_fit || 0) * 0.3 +
        (candidate.experience_fit || 0) * 0.25 +
        (candidate.overall_score || 0) * 0.25 +
        recencyFactor * 100 * 0.1 +
        (candidate.culture_fit || 0) * 0.1;

      return {
        ...candidate,
        match_score: Math.round(matchScore * 10) / 10,
        recency_factor: Math.round(recencyFactor * 100),
        recommendation_reason: generateRecommendationReason(candidate, job, matchScore),
      };
    });

    candidates.sort((a, b) => b.match_score - a.match_score);

    return res.json({
      success: true,
      job: { job_requisition_id: job.job_requisition_id, job_title: job.job_title, department: job.department, location: job.location },
      suggested_candidates: candidates,
      total_count: candidates.length,
      filters_applied: { min_score: minScore, months_since_rejection: monthsSinceRejection, limit },
    });
  } catch (error) {
    console.error("[REACTIVATION] Error:", error);
    return res.status(500).json({ error: "failed_to_get_suggestions", message: error.message });
  }
});

router.post("/jobs/:id/reactivate-candidates", async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    if (!Number.isFinite(jobId)) return res.status(400).json({ error: "invalid_job_id" });

    const { candidate_ids, custom_message } = req.body;
    if (!candidate_ids || !Array.isArray(candidate_ids) || candidate_ids.length === 0) {
      return res.status(400).json({ error: "candidate_ids_required" });
    }

    const jobSql = `SELECT job_requisition_id, job_title, job_description, department, location FROM ${DEFAULT_SCHEMA}.job_listings WHERE job_requisition_id = $1`;
    const jobResult = await req.db.query(jobSql, [jobId]);
    if (jobResult.rows.length === 0) return res.status(404).json({ error: "job_not_found" });

    const job = jobResult.rows[0];

    const candidatesSql = `SELECT ${PEOPLE_PK} AS candidate_id, first_name, last_name, email FROM ${PEOPLE_TABLE} WHERE ${PEOPLE_PK} = ANY($1::int[])`;
    const candidatesResult = await req.db.query(candidatesSql, [candidate_ids]);

    const results = [];
    const errors = [];

    for (const candidate of candidatesResult.rows) {
      if (!candidate.email) {
        errors.push({ candidate_id: candidate.candidate_id, error: "no_email" });
        continue;
      }

      try {
        if (emailService?.isConfigured()) {
          await emailService.sendMail({
            to: candidate.email,
            subject: `New opportunity: ${job.job_title}`,
            html: `<p>Dear ${candidate.first_name || "Candidate"},</p>
                   <p>We have a new opening for ${job.job_title} that matches your profile.</p>
                   ${custom_message ? `<p>${custom_message}</p>` : ""}
                   <p>Best regards,<br>The Hiring Team</p>`,
          });
          results.push({ candidate_id: candidate.candidate_id, email: candidate.email, status: "sent" });
        } else {
          results.push({ candidate_id: candidate.candidate_id, email: candidate.email, status: "email_not_configured" });
        }
      } catch (emailError) {
        errors.push({ candidate_id: candidate.candidate_id, error: emailError.message });
      }
    }

    return res.json({ success: true, results, errors, job_title: job.job_title });
  } catch (error) {
    console.error("[REACTIVATION] Error:", error);
    return res.status(500).json({ error: "failed_to_send_reactivation", message: error.message });
  }
});

module.exports = router;
module.exports.initMisc = initMisc;
