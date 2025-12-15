/**
 * Candidates Routes Module
 * Handles all /candidates/* endpoints for the ATS application
 */

const express = require("express");
const axios = require("axios");
const router = express.Router();

const {
  DEFAULT_SCHEMA,
  PEOPLE_TABLE,
  PEOPLE_TABLE_NAME,
  PEOPLE_PK,
  APP_TABLE,
  APP_PK,
  requireAdmin,
  getOpenAIClient,
  OPENAI_API_KEY,
} = require("./helpers");

// Default titleCase implementation (can be overridden via initCandidates)
const defaultTitleCase = (str) => {
  if (!str) return str;
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
};

/**
 * Default implementation of buildCandidateVM
 * Fetches a candidate by ID and joins with their latest application data
 */
async function defaultBuildCandidateVM(db, candidateId) {
  const { rows } = await db.query(
    `SELECT
      p.*,
      a.${APP_PK} AS application_id,
      a.resume_url,
      a.cover_letter_url,
      a.job_id,
      a.applied_at,
      a.status AS application_status,
      j.title AS job_title,
      j.location AS job_location
    FROM ${PEOPLE_TABLE} p
    LEFT JOIN LATERAL (
      SELECT * FROM ${APP_TABLE}
      WHERE candidate_id = p.${PEOPLE_PK}
      ORDER BY applied_at DESC
      LIMIT 1
    ) a ON TRUE
    LEFT JOIN jobs j ON a.job_id = j.id
    WHERE p.${PEOPLE_PK} = $1`,
    [candidateId]
  );
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    application_id: row.application_id,
    location: row.location || "",
    address: row.address || "",
    city: row.city || "",
    state: row.state || "",
    country: row.country || "",
    linkedin: row.linkedin || "",
    portfolio: row.portfolio || "",
    workEligibility: row.work_eligibility || "",
    willingToRelocate: row.willing_to_relocate || "",
    desiredSalary: row.desired_salary || "",
    resumeUrl: row.resume_url || "",
    coverLetterUrl: row.cover_letter_url || "",
    status: row.application_status || "new",
    stage: row.stage || "Screening",
    source: row.source || "",
    rating: row.rating || null,
    notes: row.notes || "",
    appliedAt: row.applied_at,
    jobId: row.job_id,
    jobTitle: row.job_title || "",
    jobLocation: row.job_location || "",
    archived: row.archived || false,
    archivedAt: row.archived_at || null,
    archivedReason: row.archived_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// These functions need to be passed in during initialization
let buildCandidateVM = defaultBuildCandidateVM;
let buildCandidateScoringContext = null;
let getLatestCandidateScore = null;
let generateAndStoreCandidateScore = null;
let enqueueCandidateScore = null;
let getExtractedTextForUrl = null;
let mapStatusToStage = null;
let titleCase = defaultTitleCase;

/**
 * Initialize the candidates router with required dependencies
 * @param {Object} deps - Dependencies object
 */
function initCandidates(deps) {
  if (deps.buildCandidateVM) buildCandidateVM = deps.buildCandidateVM;
  if (deps.buildCandidateScoringContext) buildCandidateScoringContext = deps.buildCandidateScoringContext;
  if (deps.getLatestCandidateScore) getLatestCandidateScore = deps.getLatestCandidateScore;
  if (deps.generateAndStoreCandidateScore) generateAndStoreCandidateScore = deps.generateAndStoreCandidateScore;
  if (deps.enqueueCandidateScore) enqueueCandidateScore = deps.enqueueCandidateScore;
  if (deps.getExtractedTextForUrl) getExtractedTextForUrl = deps.getExtractedTextForUrl;
  if (deps.mapStatusToStage) mapStatusToStage = deps.mapStatusToStage;
  if (deps.titleCase) titleCase = deps.titleCase;
}

// POST /candidates/search - Lightweight search over extracted resume/cover text
router.post("/search", async (req, res) => {
  try {
    const q = String(req.body?.q || "").trim();
    const debugReq = req.body && req.body.debug === true;
    const debug = debugReq || process.env.DEBUG_SEARCH === "1";

    if (debug) {
      console.log("[SEARCH] /candidates/search", {
        q,
        idsCount: Array.isArray(req.body?.ids) ? req.body.ids.length : "ALL",
      });
    }

    if (!q) return res.json({ hits: {} });

    const restrictIds = Array.isArray(req.body?.ids)
      ? req.body.ids.map(Number).filter((n) => Number.isFinite(n))
      : null;

    if (debug) {
      console.log("[SEARCH] restrictIds count=", restrictIds ? restrictIds.length : "ALL");
    }

    const sql = `
      WITH latest_app AS (
        SELECT DISTINCT ON (a.candidate_id) a.*
        FROM ${APP_TABLE} a
        ORDER BY a.candidate_id, a.application_date DESC NULLS LAST, a.${APP_PK} DESC
      )
      SELECT c.${PEOPLE_PK} AS candidate_id,
             COALESCE(NULLIF(to_jsonb(la)->>'resume_url',''), (
               SELECT to_jsonb(a2)->>'resume_url' FROM ${APP_TABLE} a2
               WHERE a2.candidate_id = c.${PEOPLE_PK}
               AND COALESCE(to_jsonb(a2)->>'resume_url','') <> ''
               ORDER BY a2.application_date DESC NULLS LAST, a2.${APP_PK} DESC LIMIT 1
             )) AS resume_url,
             COALESCE(NULLIF(to_jsonb(la)->>'cover_letter_url',''), (
               SELECT to_jsonb(a2)->>'cover_letter_url' FROM ${APP_TABLE} a2
               WHERE a2.candidate_id = c.${PEOPLE_PK}
               AND COALESCE(to_jsonb(a2)->>'cover_letter_url','') <> ''
               ORDER BY a2.application_date DESC NULLS LAST, a2.${APP_PK} DESC LIMIT 1
             )) AS cover_letter_url
      FROM ${PEOPLE_TABLE} c
      LEFT JOIN latest_app la ON la.candidate_id = c.${PEOPLE_PK}
    `;

    const { rows } = await req.db.query(sql);
    const tokens = (q.match(/\"[^\"]+\"|[^\s,|]+/g) || []).map((t) =>
      t.replace(/^\"|\"$/g, "").toLowerCase()
    );
    const hasOr = /\sor\s|,|\|/i.test(q);

    if (debug) {
      console.log("[SEARCH] tokens=", tokens, "mode=", hasOr ? "OR" : "AND", "candidates=", rows.length);
    }

    const hits = {};
    for (const r of rows) {
      const id = r.candidate_id;
      if (restrictIds && !restrictIds.includes(Number(id))) continue;
      const urls = [r.resume_url, r.cover_letter_url].filter(Boolean);

      if (debug && urls.length) {
        console.log(`[SEARCH] candidate ${id} urls=`, urls);
      }

      let matched = false;
      for (const url of urls) {
        try {
          const text = await getExtractedTextForUrl(url, debug);
          if (!text) continue;
          if (debug) {
            console.log(`[SEARCH] extracted length for ${id}:`, text.length);
          }
          const blob = text.toLowerCase();
          if (!tokens.length) continue;
          const ok = hasOr
            ? tokens.some((t) => blob.includes(t))
            : tokens.every((t) => blob.includes(t));
          if (ok) {
            matched = true;
            break;
          }
        } catch {}
      }
      if (matched) hits[id] = true;
    }
    return res.json({ hits });
  } catch (e) {
    console.error("POST /candidates/search error", e);
    return res.status(500).json({ error: "search_failed" });
  }
});

// GET /candidates - List candidates with latest application and stage
router.get("/", async (req, res) => {
  try {
    const verbose = process.env.DEBUG_CANDIDATES === "1";
    if (verbose) {
      console.log("[CANDIDATES] Starting /candidates endpoint", { query: req.query });
    }

    const filters = {
      jobTitle: req.query.jobTitle,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      stage: req.query.stage,
    };

    if (verbose) console.log("[CANDIDATES] Parsed filters:", filters);

    const clauses = ["1=1", "c.archived = FALSE"];
    const params = [];

    if (filters.jobTitle) {
      params.push(`%${filters.jobTitle}%`);
      clauses.push(`COALESCE(jl.job_title,'') ILIKE $${params.length}`);
    }
    if (filters.dateFrom) {
      params.push(filters.dateFrom);
      clauses.push(`la.application_date >= $${params.length}`);
    }
    if (filters.dateTo) {
      params.push(filters.dateTo);
      clauses.push(`la.application_date <= $${params.length}`);
    }

    const baseCte = `
      WITH latest_app AS (
        SELECT DISTINCT ON (a.candidate_id) a.*
        FROM ${APP_TABLE} a
        ORDER BY a.candidate_id, a.application_date DESC NULLS LAST, a.${APP_PK} DESC
      ), latest_stage AS (
        SELECT DISTINCT ON (s.application_id) s.*
        FROM ${DEFAULT_SCHEMA}.application_stages s
        ORDER BY s.application_id, s.updated_at DESC NULLS LAST, s.stage_id DESC
      )`;

    const whereB = [...clauses];
    const paramsB = [...params];

    if (req.query.department) {
      paramsB.push(String(req.query.department));
      whereB.push(
        `(jl.department IS NOT NULL AND LOWER(TRIM(jl.department)) = LOWER(TRIM($${paramsB.length})))`
      );
    }
    if (filters.stage && filters.stage !== "all") {
      paramsB.push(String(filters.stage).toLowerCase());
      whereB.push(
        `(LOWER(ls.stage_name) = $${paramsB.length} OR LOWER(ls.status) = $${paramsB.length})`
      );
    }

    const sqlB = `
      ${baseCte}
      SELECT c.${PEOPLE_PK}, c.first_name, c.last_name, c.email, c.phone,
             c.address, c.city, c.state, c.country, c.linkedin_url, c.portfolio_url,
             c.work_eligibility, c.willing_to_relocate,
             c.values_resonates, c.motivation, c.onsite_available, c.termination_history,
             c.references_available, c.work_authorization,
             c.expected_salary_range AS candidate_expected_salary_range,
             la.${APP_PK}, jl.job_title, la.job_requisition_id, la.application_date,
             la.expected_salary_range AS expected_salary,
             to_jsonb(la)->>'application_source' AS application_source,
             COALESCE(NULLIF(to_jsonb(la)->>'resume_url',''), (
               SELECT to_jsonb(a2)->>'resume_url'
                 FROM ${APP_TABLE} a2
                WHERE a2.candidate_id = c.${PEOPLE_PK}
                  AND COALESCE(to_jsonb(a2)->>'resume_url','') <> ''
                ORDER BY a2.application_date DESC NULLS LAST, a2.${APP_PK} DESC
                LIMIT 1
             )) AS resume_url,
             COALESCE(NULLIF(to_jsonb(la)->>'cover_letter_url',''), (
               SELECT to_jsonb(a2)->>'cover_letter_url'
                 FROM ${APP_TABLE} a2
                WHERE a2.candidate_id = c.${PEOPLE_PK}
                  AND COALESCE(to_jsonb(a2)->>'cover_letter_url','') <> ''
                ORDER BY a2.application_date DESC NULLS LAST, a2.${APP_PK} DESC
                LIMIT 1
             )) AS cover_letter_url,
             COALESCE(NULLIF(COALESCE(to_jsonb(la)->>'photo_url', to_jsonb(la)->>'photo'),''), (
               SELECT COALESCE(to_jsonb(a2)->>'photo_url', to_jsonb(a2)->>'photo')
                 FROM ${APP_TABLE} a2
                WHERE a2.candidate_id = c.${PEOPLE_PK}
                  AND COALESCE(COALESCE(to_jsonb(a2)->>'photo_url',''), COALESCE(to_jsonb(a2)->>'photo','')) <> ''
                ORDER BY a2.application_date DESC NULLS LAST, a2.${APP_PK} DESC
                LIMIT 1
             )) AS photo_url,
             NULL::text AS years_experience,
             jl.recruiter_assigned AS recruiter_assigned,
             jl.hiring_manager AS hiring_manager_assigned,
             to_jsonb(jl)->>'location' AS job_location,
             NULL::text AS app_status,
             ls.stage_name, ls.status AS stage_status, ls.notes AS stage_notes, ls.internal_score
        FROM ${PEOPLE_TABLE} c
        LEFT JOIN latest_app la ON la.candidate_id = c.${PEOPLE_PK}
        LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON (la.job_requisition_id IS NOT NULL AND jl.job_requisition_id = la.job_requisition_id)
        LEFT JOIN latest_stage ls ON ls.application_id = la.${APP_PK}
        WHERE ${whereB.join(" AND ")}
        ORDER BY la.application_date DESC NULLS LAST, c.${PEOPLE_PK} DESC`;

    if (verbose) {
      console.log("[CANDIDATES] Executing candidates query");
      console.log("[CANDIDATES] SQL:", sqlB.substring(0, 200) + "...");
      console.log("[CANDIDATES] Params:", paramsB);
    }

    const { rows } = await req.db.query(sqlB, paramsB);
    if (verbose) console.log("[CANDIDATES] Query successful, rows:", rows.length);

    let mapped = rows.map((r) => {
      const loc =
        [r.city, r.state, r.country]
          .filter((v) => v && String(v).trim())
          .join(", ") ||
        r.address ||
        "";
      return {
        id: r[PEOPLE_PK],
        application_id: r[APP_PK] || null,
        name: `${r.first_name || ""} ${r.last_name || ""}`.trim() || r.email || "Unknown",
        email: r.email || "n/a",
        phone: r.phone || "n/a",
        location: loc || "",
        jobLocation: r.job_location || "",
        address: r.address || "",
        city: r.city || "",
        state: r.state || "",
        country: r.country || "",
        linkedin: r.linkedin_url || "",
        portfolio: r.portfolio_url || "",
        workEligibility: r.work_eligibility || "",
        willingToRelocate: r.willing_to_relocate || "",
        valuesResonates: r.values_resonates || "",
        values_resonates: r.values_resonates || "",
        motivation: r.motivation || "",
        onsiteAvailable: r.onsite_available,
        onsite_available: r.onsite_available,
        terminationHistory: r.termination_history || "",
        termination_history: r.termination_history || "",
        referencesAvailable: r.references_available,
        references_available: r.references_available,
        workAuthorization: r.work_authorization,
        work_authorization: r.work_authorization,
        candidateExpectedSalaryRange: r.candidate_expected_salary_range || "",
        expected_salary_range: r.candidate_expected_salary_range || "",
        jobTitle: r.job_title || "—",
        stage: r.stage_name
          ? titleCase(r.stage_name)
          : mapStatusToStage(r.stage_status) || "Screening",
        status: r.stage_status || "",
        recruiter: r.recruiter_assigned || "Unassigned",
        applicationDate: r.application_date
          ? new Date(r.application_date).toISOString().slice(0, 10)
          : "—",
        requisitionId: r.job_requisition_id || "",
        expectedSalary: r.expected_salary || "",
        yearsExperience: r.years_experience || "",
        hiringManager: r.hiring_manager_assigned || "",
        applicationSource: r.application_source || "",
        resumeUrl: r.resume_url || "",
        resume_url: r.resume_url || "",
        coverLetterUrl: r.cover_letter_url || "",
        cover_letter_url: r.cover_letter_url || "",
        photoUrl: r.photo_url || "",
        photo_url: r.photo_url || "",
        notes: r.stage_notes || "",
        skills: [],
        stages: [],
      };
    });

    // Optional: if a quick search query param 'q' is present, refine by resume/cover text hits
    const q = String(req.query.q || "").trim();
    if (q) {
      try {
        const ids = mapped.map((m) => m.id).filter(Boolean);
        const sr = await axios
          .post(
            `${req.protocol}://${req.get("host")}${req.baseUrl}/candidates/search`,
            { q, ids },
            { headers: { cookie: req.headers.cookie || "" } }
          )
          .then((r) => r.data)
          .catch(() => ({ hits: {} }));
        const hitSet = new Set(Object.keys(sr.hits || {}).map((k) => Number(k)));
        mapped = mapped.filter((m) => hitSet.has(Number(m.id)));
      } catch {}
    }
    return res.json(mapped);
  } catch (error) {
    console.error("[CANDIDATES] GET /candidates error", error);
    console.error("[CANDIDATES] Stack trace:", error.stack);
    res.json([]);
  }
});

// GET /candidates/archived - List archived candidates
router.get("/archived", async (req, res) => {
  try {
    const { rows } = await req.db.query(`
      WITH latest_app AS (
        SELECT DISTINCT ON (a.candidate_id) a.*
        FROM ${APP_TABLE} a
        WHERE a.candidate_id IN (SELECT ${PEOPLE_PK} FROM ${PEOPLE_TABLE} WHERE archived = TRUE)
        ORDER BY a.candidate_id, a.application_date DESC NULLS LAST, a.${APP_PK} DESC
      )
      SELECT c.*,
             jl.job_title,
             la.job_requisition_id,
             la.application_date,
             to_jsonb(la)->>'expected_salary' AS expected_salary,
             to_jsonb(la)->>'years_experience' AS years_experience,
             to_jsonb(la)->>'resume_url' AS resume_url,
             to_jsonb(la)->>'cover_letter_url' AS cover_letter_url,
             to_jsonb(la)->>'application_source' AS application_source,
             jl.recruiter_assigned,
             jl.hiring_manager AS hiring_manager_assigned,
             ast.stage_name,
             ast.status
      FROM ${PEOPLE_TABLE} c
      LEFT JOIN latest_app la ON la.candidate_id = c.${PEOPLE_PK}
      LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON (la.job_requisition_id IS NOT NULL AND jl.job_requisition_id = la.job_requisition_id)
      LEFT JOIN LATERAL (
        SELECT stage_name, status
        FROM ${DEFAULT_SCHEMA}.application_stages
        WHERE application_id = la.${APP_PK}
        ORDER BY updated_at DESC NULLS LAST, stage_id DESC
        LIMIT 1
      ) ast ON TRUE
      WHERE c.archived = TRUE
      ORDER BY c.archived_at DESC NULLS LAST, c.${PEOPLE_PK} DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error("GET /candidates/archived error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /candidates/flags - Get candidate flags
router.get("/flags", async (req, res) => {
  try {
    const { rows } = await req.db.query(`
      SELECT cf.id, cf.name, cf.color, cf.description, cf.is_active, cf.created_at,
             COALESCE(
               (SELECT json_agg(json_build_object('candidate_id', ccf.candidate_id))
                FROM ${DEFAULT_SCHEMA}.candidate_candidate_flags ccf
                WHERE ccf.flag_id = cf.id),
               '[]'::json
             ) as assigned_candidates
      FROM ${DEFAULT_SCHEMA}.candidate_flags cf
      WHERE cf.is_active = true
      ORDER BY cf.name
    `);
    res.json(rows);
  } catch (error) {
    console.error("GET /candidates/flags error:", error);
    res.status(500).json({ error: "db_error", detail: error.message });
  }
});

// GET /candidates/:id - Get single candidate
router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, error: "invalid_id" });
    }
    const { rowCount } = await req.db.query(
      `SELECT 1 FROM ${PEOPLE_TABLE} WHERE ${PEOPLE_PK} = $1`,
      [id]
    );
    if (!rowCount) {
      return res.status(404).json({ success: false, error: "not_found" });
    }
    const vm = await buildCandidateVM(req.db, id);
    if (!vm) {
      return res.status(404).json({ success: false, error: "not_found" });
    }
    return res.json(vm);
  } catch (e) {
    console.error("GET /candidates/:id error", e);
    const status = e.status || 500;
    res.status(status).json({ success: false, error: e.message });
  }
});

// DELETE /candidates/:id - Permanently delete candidate (admin only)
router.delete("/:id", requireAdmin, async (req, res) => {
  const candidateId = Number(req.params.id);
  if (!Number.isFinite(candidateId)) {
    return res.status(400).json({ error: "invalid_id" });
  }
  try {
    await req.db.query("BEGIN");
    const apps = await req.db.query(
      `SELECT ${APP_PK} AS id FROM ${APP_TABLE} WHERE candidate_id = $1`,
      [candidateId]
    );
    const appIds = apps.rows.map((r) => r.id);
    if (appIds.length) {
      await req.db.query(
        `DELETE FROM ${DEFAULT_SCHEMA}.application_stages WHERE application_id = ANY($1::int[])`,
        [appIds]
      );
      await req.db.query(
        `DELETE FROM ${APP_TABLE} WHERE ${APP_PK} = ANY($1::int[])`,
        [appIds]
      );
    }
    const delCand = await req.db.query(
      `DELETE FROM ${PEOPLE_TABLE} WHERE ${PEOPLE_PK} = $1`,
      [candidateId]
    );
    await req.db.query("COMMIT");
    if (delCand.rowCount === 0) {
      return res.status(404).json({ error: "not_found" });
    }
    return res.json({
      success: true,
      deleted: { candidate: delCand.rowCount, applications: appIds.length },
    });
  } catch (e) {
    try {
      await req.db.query("ROLLBACK");
    } catch {}
    console.error("DELETE /candidates/:id error", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// POST /candidates - Create candidate
router.post("/", async (req, res) => {
  try {
    const data = req.body || {};
    const { rows: candColsRows } = await req.db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      [DEFAULT_SCHEMA, PEOPLE_TABLE_NAME]
    );
    const candCols = new Set((candColsRows || []).map((r) => r.column_name));

    let first_name = data.first_name || null;
    let last_name = data.last_name || null;
    if (!first_name || !last_name) {
      const rawName = String(data.name || "").trim();
      if ((!first_name || !last_name) && rawName) {
        const parts = rawName.split(/\s+/).filter(Boolean);
        if (!first_name && parts.length) first_name = parts.shift() || null;
        if (!last_name && parts.length) last_name = parts.join(" ") || null;
      }
      if (!first_name) {
        const em = String(data.email || "").toLowerCase();
        const handle = em.split("@")[0] || "";
        const p = handle.split(/[._-]+/).filter(Boolean);
        if (p.length) {
          first_name = p[0];
          if (!last_name && p.length > 1) last_name = p.slice(1).join(" ");
        }
      }
    }
    if (!first_name) first_name = "Applicant";
    if (last_name == null) last_name = "";

    const email = data.email || null;
    const phone = data.phone || null;
    const candidateCols = ["first_name", "last_name", "email", "phone"].filter(
      (k) => candCols.has(k)
    );
    const candVals = candidateCols.map((k, i) => `$${i + 1}`);
    const candParams = candidateCols.map(
      (k) => ({ first_name, last_name, email, phone }[k] ?? null)
    );

    if (!candidateCols.length) {
      return res.status(400).json({
        success: false,
        error: "Candidate table missing expected columns",
      });
    }

    const insCandSql = `INSERT INTO ${PEOPLE_TABLE} (${candidateCols.join(",")}) VALUES (${candVals.join(",")}) RETURNING ${PEOPLE_PK}`;
    const { rows: insCand } = await req.db.query(insCandSql, candParams);
    const candidateId = insCand[0]?.[PEOPLE_PK];

    if (candidateId && (data.job_title || data.job_requisition_id || data.job_listing_id)) {
      const cols = ["candidate_id"];
      const vals = ["$1"];
      const params = [candidateId];
      let idx = 2;
      const push = (k, v) => {
        cols.push(k);
        vals.push(`$${idx++}`);
        params.push(v);
      };

      let jl = null;
      if (data.job_listing_id) {
        try {
          const r = await req.db.query(
            `SELECT job_requisition_id, job_title, recruiter_assigned, hiring_manager FROM ${DEFAULT_SCHEMA}.job_listings WHERE job_listing_id = $1`,
            [data.job_listing_id]
          );
          jl = r.rows[0] || null;
        } catch {}
        if (!jl) {
          return res.status(400).json({ success: false, error: "invalid_job_listing_id" });
        }
      }

      const { rows: appColsRows } = await req.db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
        [DEFAULT_SCHEMA, APP_TABLE.split(".").pop()]
      );
      const appCols = new Set((appColsRows || []).map((r) => r.column_name));

      if (appCols.has("job_listing_id") && data.job_listing_id) {
        push("job_listing_id", Number(data.job_listing_id));
      }
      if (appCols.has("job_title")) {
        const jt = jl?.job_title || data.job_title || null;
        if (!jt) {
          return res.status(400).json({ success: false, error: "job_title_required" });
        }
        push("job_title", jt);
      }
      if (appCols.has("job_requisition_id")) {
        const reqId = jl?.job_requisition_id || data.job_requisition_id || null;
        if (reqId) {
          try {
            const { rowCount } = await req.db.query(
              `SELECT 1 FROM ${DEFAULT_SCHEMA}.job_listings WHERE job_requisition_id = $1 LIMIT 1`,
              [reqId]
            );
            if (!rowCount) {
              return res.status(400).json({ success: false, error: "invalid_job_requisition_id" });
            }
          } catch (_) {
            return res.status(400).json({ success: false, error: "invalid_job_requisition_check_failed" });
          }
        }
        push("job_requisition_id", reqId);
      }
      if (appCols.has("recruiter_assigned")) {
        push("recruiter_assigned", jl?.recruiter_assigned ?? null);
      }
      if (appCols.has("hiring_manager_assigned")) {
        push("hiring_manager_assigned", jl?.hiring_manager ?? null);
      }

      const fullName = [first_name || "", last_name || ""].join(" ").trim() || email || null;
      if (appCols.has("name")) push("name", fullName);
      if (appCols.has("email")) push("email", email || null);
      if (appCols.has("phone")) push("phone", phone || null);
      if (appCols.has("expected_salary_range")) {
        push("expected_salary_range", data.expected_salary_range || null);
      }

      const sql = `INSERT INTO ${APP_TABLE} (${cols.join(",")}${
        appCols.has("application_date") ? ",application_date" : ""
      }) VALUES (${vals.join(",")}${
        appCols.has("application_date") ? ",NOW()" : ""
      }) RETURNING ${APP_PK}`;

      const insApp = await req.db.query(sql, params);
      const newAppId = insApp.rows[0]?.[APP_PK];

      if (newAppId) {
        try {
          await req.db.query(
            `INSERT INTO ${DEFAULT_SCHEMA}.application_stages (application_id, stage_name, status, notes, updated_at)
             VALUES ($1, 'Applied', 'new', NULL, NOW())`,
            [newAppId]
          );
        } catch {}
      }
    }

    const vm = await buildCandidateVM(req.db, candidateId);
    try {
      enqueueCandidateScore(req.db, candidateId);
    } catch {}
    res.status(201).json({ success: true, id: candidateId, candidate: vm });
  } catch (e) {
    console.error("POST /candidates error", e);
    const msg = e?.message || "";
    if (
      /duplicate key value/i.test(msg) &&
      /candidates_email_key|email_key/i.test(msg) &&
      req?.body?.email
    ) {
      try {
        const { rows } = await req.db.query(
          `SELECT ${PEOPLE_PK} FROM ${PEOPLE_TABLE} WHERE email = $1 LIMIT 1`,
          [req.body.email]
        );
        const existingId = rows[0]?.[PEOPLE_PK];
        if (existingId) {
          const vm = await buildCandidateVM(req.db, existingId);
          return res.status(200).json({
            success: true,
            id: existingId,
            candidate: vm,
            duplicate: true,
          });
        }
      } catch (_) {}
    }
    const status = e.status || 500;
    res.status(status).json({ success: false, error: e.message });
  }
});

// GET /candidates/:id/score - Get AI score
router.get("/:id/score", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const score = await getLatestCandidateScore(req.db, id);
    if (!score) {
      return res.status(200).json({ hasScore: false, status: "missing", score: null });
    }
    return res.json({ ...score, hasScore: true, status: "available" });
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// POST /candidates/:id/score - Trigger score generation
router.post("/:id/score", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const forceParam = req.query?.force ?? req.body?.force;
    const force =
      typeof forceParam === "string"
        ? ["true", "1", "yes", "force"].includes(forceParam.toLowerCase())
        : Boolean(forceParam);

    if (!OPENAI_API_KEY) {
      return res.status(503).json({ error: "openai_not_configured" });
    }

    const result = await generateAndStoreCandidateScore(req.db, id, { force });
    const score = result?.score || null;
    if (!score) {
      return res.status(500).json({ error: "score_generation_failed" });
    }

    const payload = {
      status: result.status,
      force,
      hasScore: true,
      score,
      alreadyExists: result.status === "existing",
    };

    const statusCode = result.status === "existing" ? 200 : 201;
    return res.status(statusCode).json(payload);
  } catch (e) {
    const code = e?.message || "trigger_failed";
    const detailRaw = e?.detail || e?.cause?.message || e?.stack || e?.toString?.();
    const detail = typeof detailRaw === "string" ? detailRaw.slice(0, 600) : undefined;
    const metadata = e?.metadata && typeof e.metadata === "object" ? e.metadata : undefined;
    const base = { error: code };
    if (detail) base.detail = detail;
    if (metadata) base.metadata = metadata;
    if (e?.attempt) base.attempt = e.attempt;
    if (e?.maxAttempts) base.maxAttempts = e.maxAttempts;
    if (typeof e?.retryable === "boolean") base.retryable = e.retryable;

    if (code === "candidate_not_found") return res.status(404).json(base);
    if (code === "openai_api_key_missing") {
      return res.status(503).json({ ...base, error: "openai_not_configured" });
    }
    if (code === "openai_generation_failed" || code === "invalid_openai_json") {
      return res.status(200).json({
        ...base,
        status: "error",
        hasScore: false,
        started: false,
        pending: false,
        alreadyExists: false,
      });
    }
    return res.status(500).json({ ...base, error: "trigger_failed" });
  }
});

// POST /candidates/:id/interview-questions - Generate personalized interview questions using AI
router.post("/:id/interview-questions", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: "invalid_id" });

    if (!OPENAI_API_KEY)
      return res.status(503).json({ error: "openai_not_configured" });

    // Check for existing interview questions unless force regenerate is requested
    const forceRegenerate =
      req.body?.force === true || req.query?.force === "true";

    if (!forceRegenerate) {
      const existingQuery = await req.db.query(
        `SELECT interview_questions, interview_questions_generated_at
         FROM ${PEOPLE_TABLE}
         WHERE ${PEOPLE_PK} = $1 AND interview_questions IS NOT NULL`,
        [id]
      );

      if (
        existingQuery.rowCount > 0 &&
        existingQuery.rows[0].interview_questions
      ) {
        const storedData = existingQuery.rows[0].interview_questions;
        const generatedAt =
          existingQuery.rows[0].interview_questions_generated_at;

        // Get candidate basic info for response
        const ctx = await buildCandidateScoringContext(req.db, id);
        if (!ctx) return res.status(404).json({ error: "candidate_not_found" });
        const { vm } = ctx;

        return res.json({
          success: true,
          cached: true,
          candidate: {
            id,
            name: vm.name,
            email: vm.email,
            jobTitle: vm.jobTitle,
          },
          questions: storedData.questions || [],
          focus_areas: storedData.focus_areas || [],
          red_flags_to_probe: storedData.red_flags_to_probe || [],
          generated_at: generatedAt || storedData.generated_at,
        });
      }
    }

    // Build candidate context for AI generation
    const ctx = await buildCandidateScoringContext(req.db, id);
    if (!ctx) return res.status(404).json({ error: "candidate_not_found" });

    const { vm, combinedText } = ctx;

    // Get existing AI score if available
    const score = await getLatestCandidateScore(req.db, id);

    // Build AI prompt for interview questions
    const systemPrompt = `You are an expert HR interviewer. Generate personalized, insightful interview questions for a candidate based on their profile and application materials.

INSTRUCTIONS:
- Generate 8-12 targeted interview questions
- Focus on areas that need clarification or deeper exploration
- Include behavioral, technical, and situational questions as appropriate
- Questions should be specific to THIS candidate, not generic
- Consider gaps, concerns, or standout elements in their profile
- Mix question types: clarification, behavioral (STAR method), technical depth, cultural fit, motivation

Categories to cover:
1. Experience & Background (2-3 questions)
2. Skills & Technical Competency (2-3 questions)
3. Behavioral & Cultural Fit (2-3 questions)
4. Motivation & Career Goals (1-2 questions)
5. Situational/Scenario-based (1-2 questions)

Return ONLY valid JSON (no markdown, no code blocks) in this exact format:
{
  "questions": [
    {
      "category": "Experience & Background",
      "question": "Your detailed question here",
      "rationale": "Why this question matters for this specific candidate"
    }
  ],
  "focus_areas": ["area1", "area2", "area3"],
  "red_flags_to_probe": ["concern1", "concern2"]
}`;

    const userContext = `CANDIDATE PROFILE:
Name: ${vm.name || "Not provided"}
Email: ${vm.email || "Not provided"}
Applied Position: ${vm.jobTitle || "Not specified"}
Location: ${vm.location || "Not specified"}
Years of Experience: ${vm.yearsExperience || "Not specified"}
Expected Salary: ${vm.expectedSalary || "Not specified"}

APPLICATION MATERIALS:
${combinedText || "No additional information provided"}

${
  score
    ? `AI EVALUATION SCORES:
Overall Score: ${score.overall_score || "N/A"}
Experience Fit: ${score.experience_fit || "N/A"}
Skills Fit: ${score.skills_fit || "N/A"}
Culture Fit: ${score.culture_fit || "N/A"}

${
  score.risk_flags && score.risk_flags.length
    ? `Risk Flags: ${score.risk_flags.join("; ")}`
    : ""
}
${
  score.strengths && score.strengths.length
    ? `Strengths: ${score.strengths.join("; ")}`
    : ""
}
${
  score.recommendations && score.recommendations.length
    ? `Recommendations: ${score.recommendations.join("; ")}`
    : ""
}
`
    : ""
}`;

    const responseFormat = {
      type: "json_schema",
      json_schema: {
        name: "interview_questions",
        strict: true,
        schema: {
          type: "object",
          properties: {
            questions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  category: { type: "string" },
                  question: { type: "string" },
                  rationale: { type: "string" },
                },
                required: ["category", "question", "rationale"],
                additionalProperties: false,
              },
            },
            focus_areas: { type: "array", items: { type: "string" } },
            red_flags_to_probe: { type: "array", items: { type: "string" } },
          },
          required: ["questions", "focus_areas", "red_flags_to_probe"],
          additionalProperties: false,
        },
      },
    };

    const client = getOpenAIClient();
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      max_tokens: 2048,
      response_format: responseFormat,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContext },
      ],
    });

    const jsonText = completion?.choices?.[0]?.message?.content || "";

    if (!jsonText) {
      return res.status(500).json({ error: "openai_empty_response" });
    }

    const parsed = JSON.parse(jsonText);

    // Save interview questions to database for persistence
    const questionsData = {
      questions: parsed.questions || [],
      focus_areas: parsed.focus_areas || [],
      red_flags_to_probe: parsed.red_flags_to_probe || [],
      generated_at: new Date().toISOString(),
    };

    try {
      await req.db.query(
        `UPDATE ${PEOPLE_TABLE}
         SET interview_questions = $1, interview_questions_generated_at = NOW()
         WHERE ${PEOPLE_PK} = $2`,
        [JSON.stringify(questionsData), id]
      );
    } catch (dbErr) {
      console.error("[interview-questions] Failed to save to DB:", dbErr);
      // Continue anyway - we'll still return the questions
    }

    return res.json({
      success: true,
      cached: false,
      candidate: {
        id,
        name: vm.name,
        email: vm.email,
        jobTitle: vm.jobTitle,
      },
      questions: parsed.questions || [],
      focus_areas: parsed.focus_areas || [],
      red_flags_to_probe: parsed.red_flags_to_probe || [],
      generated_at: questionsData.generated_at,
    });
  } catch (e) {
    console.error("[interview-questions] Error:", e);
    const detail =
      e?.detail || e?.message || "Failed to generate interview questions";
    return res.status(500).json({ error: "generation_failed", detail });
  }
});

// POST /candidates/:id/archive - Archive candidate
router.post("/:id/archive", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, error: "invalid_id" });
    }
    const result = await req.db.query(
      `UPDATE ${PEOPLE_TABLE} SET archived = TRUE, archived_at = NOW() WHERE ${PEOPLE_PK} = $1 RETURNING ${PEOPLE_PK}`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: "not_found" });
    }
    return res.json({ success: true, id });
  } catch (error) {
    console.error("POST /candidates/:id/archive error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /candidates/:id/restore - Restore archived candidate
router.post("/:id/restore", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, error: "invalid_id" });
    }
    const result = await req.db.query(
      `UPDATE ${PEOPLE_TABLE} SET archived = FALSE, archived_at = NULL WHERE ${PEOPLE_PK} = $1 RETURNING ${PEOPLE_PK}`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: "not_found" });
    }
    return res.json({ success: true, id });
  } catch (error) {
    console.error("POST /candidates/:id/restore error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /candidates/:id/permanent - Permanently delete (admin only)
router.delete("/:id/permanent", async (req, res) => {
  const candidateId = Number(req.params.id);
  if (!Number.isFinite(candidateId)) {
    return res.status(400).json({ error: "invalid_id" });
  }
  try {
    await req.db.query("BEGIN");
    const apps = await req.db.query(
      `SELECT ${APP_PK} AS id FROM ${APP_TABLE} WHERE candidate_id = $1`,
      [candidateId]
    );
    const appIds = apps.rows.map((r) => r.id);
    if (appIds.length) {
      await req.db.query(
        `DELETE FROM ${DEFAULT_SCHEMA}.application_stages WHERE application_id = ANY($1::int[])`,
        [appIds]
      );
      await req.db.query(
        `DELETE FROM ${APP_TABLE} WHERE ${APP_PK} = ANY($1::int[])`,
        [appIds]
      );
    }
    const delCand = await req.db.query(
      `DELETE FROM ${PEOPLE_TABLE} WHERE ${PEOPLE_PK} = $1`,
      [candidateId]
    );
    await req.db.query("COMMIT");
    if (delCand.rowCount === 0) {
      return res.status(404).json({ error: "not_found" });
    }
    return res.json({ success: true });
  } catch (e) {
    try {
      await req.db.query("ROLLBACK");
    } catch {}
    console.error("DELETE /candidates/:id/permanent error", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

module.exports = router;
module.exports.initCandidates = initCandidates;
