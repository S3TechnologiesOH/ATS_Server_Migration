/**
 * Jobs Routes Module
 * Handles all /jobs/* endpoints for the ATS application
 */

const express = require("express");
const router = express.Router();

const {
  DEFAULT_SCHEMA,
  APP_TABLE,
  APP_PK,
  PEOPLE_TABLE,
  PEOPLE_PK,
  getOpenAIClient,
  OPENAI_API_KEY,
} = require("./helpers");

// Dependencies injected via init
let getLatestCandidateScore = null;
let generateAndStoreCandidateScore = null;

function initJobs(deps) {
  if (deps.getLatestCandidateScore) getLatestCandidateScore = deps.getLatestCandidateScore;
  if (deps.generateAndStoreCandidateScore) generateAndStoreCandidateScore = deps.generateAndStoreCandidateScore;
}

// Helper to generate next requisition id (format: REQ-YYYY-###)
async function generateNextRequisitionId(db) {
  const year = new Date().getFullYear();
  const prefix = `REQ-${year}-`;
  try {
    const { rows } = await db.query(
      `SELECT job_requisition_id FROM ${DEFAULT_SCHEMA}.job_listings WHERE job_requisition_id LIKE $1 ORDER BY job_requisition_id DESC LIMIT 1`,
      [prefix + "%"]
    );
    let next = 1;
    if (rows[0]?.job_requisition_id) {
      const m = rows[0].job_requisition_id.match(/(\d+)$/);
      if (m) next = parseInt(m[1], 10) + 1;
    }
    return prefix + String(next).padStart(3, "0");
  } catch (e) {
    console.error("generateNextRequisitionId error", e);
    return `REQ-${year}-${Date.now().toString().slice(-3)}`;
  }
}

// GET /jobs - List job listings
router.get("/", async (req, res) => {
  try {
    const filters = {
      status: req.query.status,
      q: req.query.q,
      department: req.query.department,
      publicOnly: req.query.public === "1" || req.query.public === "true",
    };
    const clauses = ["1=1", "archived = FALSE"];
    const params = [];

    if (filters.publicOnly) {
      clauses.push(`LOWER(TRIM(status)) = 'open'`);
    } else if (filters.status && filters.status !== "all") {
      params.push(filters.status);
      clauses.push(`status = $${params.length}`);
    }

    if (filters.q) {
      params.push(`%${filters.q}%`);
      clauses.push(
        `(job_title ILIKE $${params.length} OR department ILIKE $${params.length} OR location ILIKE $${params.length})`
      );
    }
    if (filters.department) {
      params.push(filters.department);
      clauses.push(`LOWER(TRIM(department)) = LOWER(TRIM($${params.length}))`);
    }

    const { rows } = await req.db.query(
      `
      SELECT
        jl.*,
        COALESCE(COUNT(DISTINCT a.application_id), 0)::int AS applicant_count
      FROM ${DEFAULT_SCHEMA}.job_listings jl
      LEFT JOIN ${APP_TABLE} a ON a.job_requisition_id = jl.job_requisition_id
      WHERE ${clauses.join(" AND ")}
      GROUP BY jl.job_listing_id
      ORDER BY jl.created_at DESC, jl.job_listing_id DESC
    `,
      params
    );
    res.json(rows);
  } catch (e) {
    console.error("GET /jobs error", e);
    res.json([]);
  }
});

// GET /jobs/public - Public endpoint that only returns Open jobs (no auth required)
router.get("/public", async (req, res) => {
  try {
    const { rows } = await req.db.query(
      `SELECT
        job_listing_id,
        job_requisition_id,
        job_title,
        department,
        employment_type,
        status,
        location,
        salary_min,
        salary_max,
        description,
        requirements,
        role_snapshot,
        day_in_the_life,
        thrive_here_if,
        what_you_bring,
        what_s3_brings,
        created_at,
        updated_at
      FROM ${DEFAULT_SCHEMA}.job_listings
      WHERE LOWER(TRIM(status)) = 'open'
      ORDER BY created_at DESC, job_listing_id DESC`
    );
    res.json(rows);
  } catch (e) {
    console.error("GET /jobs/public error", e);
    res.json([]);
  }
});

// GET /jobs/archived - List archived job listings
router.get("/archived", async (req, res) => {
  try {
    const { rows } = await req.db.query(`
      SELECT * FROM ${DEFAULT_SCHEMA}.job_listings
      WHERE archived = TRUE
      ORDER BY archived_at DESC NULLS LAST, job_listing_id DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error("GET /jobs/archived error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /jobs/ai-assist - AI assistance for job creation
router.post("/ai-assist", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(503).json({
        error: "OpenAI API key not configured. Please add OPENAI_API_KEY to your .env file.",
      });
    }

    const data = req.body || {};
    const job_title = (data.job_title || "").toString().trim();
    if (!job_title) {
      return res.status(400).json({ error: "job_title_required" });
    }

    const fields = {
      department: data.department,
      employment_type: data.employment_type,
      location: data.location,
      salary_min: data.salary_min,
      salary_max: data.salary_max,
      description: data.description,
      requirements: data.requirements,
    };

    const providedKeys = Object.entries(fields)
      .filter(([_, v]) => v !== null && v !== undefined && String(v).trim() !== "")
      .map(([k]) => k);
    const missingKeys = Object.keys(fields).filter((k) => !providedKeys.includes(k));

    const modelName = process.env.OPENAI_MODEL || "gpt-4o-mini";
    let client;
    try {
      client = getOpenAIClient();
    } catch (e) {
      return res.status(503).json({ error: e.message });
    }

    const basePrompt = `You are an expert technical recruiter and copywriter. Given partial job listing input, produce:
1. A professional, concise, inclusive Description (2-4 short paragraphs, no fluff, US spellings).
2. A Requirements section as bullet points (each starts with '- ').
If some key fields are missing (department, employment_type, location, salary_min, salary_max) propose realistic, neutral defaults based ONLY on the job title and any provided context. Keep salary dollars integers (USD) and ensure salary_min < salary_max when both present. Never hallucinate extremely high salaries. If existing description or requirements are provided, improve clarity rather than replacing unique details.
Return ONLY JSON (no markdown) matching the response schema.`;

    const userContext = JSON.stringify(
      { job_title, ...fields, provided: providedKeys, missing: missingKeys },
      null,
      2
    );

    const responseFormat = {
      type: "json_schema",
      json_schema: {
        name: "job_assist",
        strict: true,
        schema: {
          type: "object",
          properties: {
            description: { type: "string" },
            requirements: { type: "string" },
            suggested: {
              type: "object",
              properties: {
                department: { type: "string" },
                employment_type: { type: "string" },
                location: { type: "string" },
                salary_min: { type: "number" },
                salary_max: { type: "number" },
              },
              required: ["department", "employment_type", "location", "salary_min", "salary_max"],
              additionalProperties: false,
            },
          },
          required: ["description", "requirements", "suggested"],
          additionalProperties: false,
        },
      },
    };

    let jsonText = "";
    try {
      const completion = await client.chat.completions.create({
        model: modelName,
        temperature: 0.4,
        max_tokens: 768,
        response_format: responseFormat,
        messages: [
          { role: "system", content: basePrompt },
          { role: "user", content: userContext },
        ],
      });
      jsonText = completion?.choices?.[0]?.message?.content || "";
    } catch (e) {
      console.error("OpenAI API error:", e.message, e.response?.data);
      const errorMsg = e.response?.data?.error?.message || e.message || "OpenAI generation failed";
      return res.status(502).json({ error: `OpenAI error: ${errorMsg}` });
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return res.status(500).json({ error: "invalid_openai_json" });
    }

    const safeStr = (v, max = 4000) => (v ? String(v).slice(0, max) : null);
    const cleanReq = (v) =>
      v
        ? v
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => (l.startsWith("-") ? l : `- ${l}`))
            .join("\n")
        : null;

    const out = {
      description: safeStr(parsed.description),
      requirements: safeStr(cleanReq(parsed.requirements), 5000),
      suggested: {},
    };

    const sugg = parsed.suggested || {};
    ["department", "employment_type", "location"].forEach((k) => {
      if (missingKeys.includes(k) && sugg[k]) out.suggested[k] = safeStr(sugg[k], 200);
    });
    ["salary_min", "salary_max"].forEach((k) => {
      if (missingKeys.includes(k) && Number.isFinite(sugg[k])) out.suggested[k] = Number(sugg[k]);
    });

    if (out.suggested.salary_min != null && out.suggested.salary_max != null) {
      if (out.suggested.salary_min >= out.suggested.salary_max) delete out.suggested.salary_max;
    }

    return res.json(out);
  } catch (e) {
    console.error("POST /jobs/ai-assist error", e);
    return res.status(500).json({ error: "internal_error" });
  }
});

// POST /jobs - Create job listing
router.post("/", async (req, res) => {
  const data = req.body || {};
  const coerceInt = (v) => (v === "" || v === undefined || v === null ? null : Number(v));

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const requisitionId = data.job_requisition_id || (await generateNextRequisitionId(req.db));
      const payload = {
        job_requisition_id: requisitionId,
        job_title: data?.job_title ?? null,
        department: data?.department ?? null,
        employment_type: data?.employment_type ?? null,
        status: data?.status ?? "open",
        location: data?.location ?? null,
        recruiter_assigned: data?.recruiter_assigned ?? null,
        hiring_manager: data?.hiring_manager ?? null,
        salary_min: coerceInt(data?.salary_min),
        salary_max: coerceInt(data?.salary_max),
        description: data?.description ?? null,
        requirements: data?.requirements ?? null,
        role_snapshot: data?.role_snapshot ?? null,
        day_in_the_life: data?.day_in_the_life ?? null,
        thrive_here_if: data?.thrive_here_if ?? null,
        what_you_bring: data?.what_you_bring ?? null,
        what_s3_brings: data?.what_s3_brings ?? null,
      };

      const cols = Object.keys(payload);
      const vals = cols.map((_, i) => `$${i + 1}`);
      const params = cols.map((k) => payload[k]);
      const sql = `INSERT INTO ${DEFAULT_SCHEMA}.job_listings (${cols.join(",")}) VALUES (${vals.join(",")}) RETURNING job_listing_id, job_requisition_id`;

      const { rows } = await req.db.query(sql, params);
      return res.status(201).json({
        success: true,
        id: rows[0].job_listing_id,
        job_requisition_id: rows[0].job_requisition_id,
      });
    } catch (e) {
      if (e?.code === "23505" && !data.job_requisition_id) {
        if (attempt < 4) continue;
      }
      console.error("POST /jobs error", e);
      const status = e.status || 500;
      return res.status(status).json({ success: false, error: e.message });
    }
  }
});

// PUT /jobs/:id - Update job listing
router.put("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = req.body || {};
    const coerceInt = (v) => (v === "" || v === undefined || v === null ? null : Number(v));

    const allowed = [
      "job_title",
      "department",
      "employment_type",
      "status",
      "location",
      "recruiter_assigned",
      "hiring_manager",
      "salary_min",
      "salary_max",
      "description",
      "requirements",
      "role_snapshot",
      "day_in_the_life",
      "thrive_here_if",
      "what_you_bring",
      "what_s3_brings",
    ];

    const sets = [];
    const params = [];

    allowed.forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(data, k)) {
        const value =
          k === "salary_min" || k === "salary_max"
            ? coerceInt(data[k])
            : data[k] === ""
            ? null
            : data[k];
        params.push(value);
        sets.push(`${k} = $${params.length}`);
      }
    });

    if (!sets.length) return res.json({ success: true });

    params.push(id);
    const sql = `UPDATE ${DEFAULT_SCHEMA}.job_listings SET ${sets.join(", ")}, updated_at = NOW() WHERE job_listing_id = $${params.length}`;
    await req.db.query(sql, params);
    res.json({ success: true });
  } catch (e) {
    console.error("PUT /jobs/:id error", e);
    const status = e.status || 500;
    res.status(status).json({ success: false, error: e.message });
  }
});

// DELETE /jobs/:id - Delete job listing
router.delete("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await req.db.query(`DELETE FROM ${DEFAULT_SCHEMA}.job_listings WHERE job_listing_id = $1`, [id]);
    res.json({ success: true });
  } catch (e) {
    console.error("DELETE /jobs/:id error", e);
    const status = e.status || 500;
    res.status(status).json({ success: false, error: e.message });
  }
});

// POST /jobs/:id/archive - Archive job listing
router.post("/:id/archive", async (req, res) => {
  try {
    const jobId = Number(req.params.id);
    const { reason } = req.body;
    const username = req.session?.user?.username || req.session?.user?.displayName || "system";

    if (!jobId) {
      return res.status(400).json({ success: false, error: "Invalid job ID" });
    }

    await req.db.query(
      `
      UPDATE ${DEFAULT_SCHEMA}.job_listings
      SET archived = TRUE,
          archived_at = NOW(),
          archived_by = $1,
          archive_reason = $2
      WHERE job_listing_id = $3
    `,
      [username, reason || null, jobId]
    );

    res.json({ success: true, message: "Job listing archived successfully" });
  } catch (error) {
    console.error("POST /jobs/:id/archive error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /jobs/:id/restore - Restore archived job listing
router.post("/:id/restore", async (req, res) => {
  try {
    const jobId = Number(req.params.id);

    if (!jobId) {
      return res.status(400).json({ success: false, error: "Invalid job ID" });
    }

    await req.db.query(
      `
      UPDATE ${DEFAULT_SCHEMA}.job_listings
      SET archived = FALSE,
          archived_at = NULL,
          archived_by = NULL,
          archive_reason = NULL
      WHERE job_listing_id = $1
    `,
      [jobId]
    );

    res.json({ success: true, message: "Job listing restored successfully" });
  } catch (error) {
    console.error("POST /jobs/:id/restore error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /jobs/:id/permanent - Permanently delete job listing
router.delete("/:id/permanent", async (req, res) => {
  try {
    const jobId = Number(req.params.id);

    if (!jobId) {
      return res.status(400).json({ success: false, error: "Invalid job ID" });
    }

    await req.db.query(`DELETE FROM ${DEFAULT_SCHEMA}.job_listings WHERE job_listing_id = $1`, [jobId]);
    res.json({ success: true, message: "Job listing permanently deleted" });
  } catch (error) {
    console.error("DELETE /jobs/:id/permanent error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /jobs/:id/candidates - List candidates for a specific job
router.get("/:id/candidates", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const jl = (
      await req.db.query(
        `SELECT job_listing_id, job_requisition_id, job_title FROM ${DEFAULT_SCHEMA}.job_listings WHERE job_listing_id = $1`,
        [id]
      )
    ).rows[0];

    if (!jl) return res.status(404).json({ error: "job_not_found" });
    if (!jl.job_requisition_id) return res.json({ job: jl, candidates: [] });

    const baseSql = `
      SELECT DISTINCT ON (a.candidate_id)
        a.${APP_PK} AS application_id,
        a.candidate_id,
        a.application_date,
        a.expected_salary_range,
        a.name AS applicant_name,
        a.email AS applicant_email,
        a.phone AS applicant_phone,
        c.first_name,
        c.last_name,
        c.email AS candidate_email,
        s.overall_score,
        s.experience_fit,
        s.skills_fit,
        s.culture_fit,
        s.location_fit,
        s.rationale,
        s.created_at AS score_created_at
      FROM ${APP_TABLE} a
      LEFT JOIN ${PEOPLE_TABLE} c ON c.candidate_id = a.candidate_id
      LEFT JOIN LATERAL (
        SELECT overall_score, experience_fit, skills_fit, culture_fit, location_fit, rationale, created_at
        FROM candidate_ai_scores cs
        WHERE cs.candidate_id = a.candidate_id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) s ON true
      WHERE a.job_requisition_id = $1 AND a.candidate_id IS NOT NULL
      ORDER BY a.candidate_id, a.application_date DESC NULLS LAST, a.${APP_PK} DESC`;

    let candidates = [];
    try {
      const result = await req.db.query(baseSql, [jl.job_requisition_id]);
      candidates = result.rows;
    } catch (queryErr) {
      // Fallback without AI scores if table doesn't exist
      const fallbackSql = `
        SELECT DISTINCT ON (a.candidate_id)
          a.${APP_PK} AS application_id,
          a.candidate_id,
          a.application_date,
          a.expected_salary_range,
          a.name AS applicant_name,
          a.email AS applicant_email,
          a.phone AS applicant_phone,
          c.first_name,
          c.last_name,
          c.email AS candidate_email
        FROM ${APP_TABLE} a
        LEFT JOIN ${PEOPLE_TABLE} c ON c.candidate_id = a.candidate_id
        WHERE a.job_requisition_id = $1 AND a.candidate_id IS NOT NULL
        ORDER BY a.candidate_id, a.application_date DESC NULLS LAST, a.${APP_PK} DESC`;
      const fallbackResult = await req.db.query(fallbackSql, [jl.job_requisition_id]);
      candidates = fallbackResult.rows;
    }

    const mapped = candidates.map((r) => ({
      application_id: r.application_id,
      candidate_id: r.candidate_id,
      name:
        r.applicant_name ||
        `${r.first_name || ""} ${r.last_name || ""}`.trim() ||
        r.candidate_email ||
        "Unknown",
      email: r.applicant_email || r.candidate_email || "",
      phone: r.applicant_phone || "",
      applicationDate: r.application_date
        ? new Date(r.application_date).toISOString().slice(0, 10)
        : null,
      expectedSalary: r.expected_salary_range || "",
      aiScore: r.overall_score
        ? {
            overall: r.overall_score,
            experience: r.experience_fit,
            skills: r.skills_fit,
            culture: r.culture_fit,
            location: r.location_fit,
            rationale: r.rationale,
            scoredAt: r.score_created_at,
          }
        : null,
    }));

    res.json({ job: jl, candidates: mapped });
  } catch (e) {
    console.error("GET /jobs/:id/candidates error", e);
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// POST /jobs/:id/ai-rank - Ensure scores exist for all candidates of job, then return sorted list
router.post("/:id/ai-rank", async (req, res) => {
  try {
    if (!OPENAI_API_KEY)
      return res.status(503).json({ error: "openai_not_configured" });
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: "invalid_id" });
    const jl = (
      await req.db.query(
        `SELECT job_listing_id, job_requisition_id FROM ${DEFAULT_SCHEMA}.job_listings WHERE job_listing_id = $1`,
        [id]
      )
    ).rows[0];
    if (!jl) return res.status(404).json({ error: "job_not_found" });
    if (!jl.job_requisition_id) return res.json({ success: true, ranked: [] });
    const apps = (
      await req.db.query(
        `SELECT DISTINCT candidate_id FROM ${APP_TABLE} a WHERE a.job_requisition_id = $1`,
        [jl.job_requisition_id]
      )
    ).rows.map((r) => r.candidate_id);
    // Generate scores where missing (sequential to reduce rate-limit risk)
    for (const cid of apps) {
      const existing = await getLatestCandidateScore(req.db, cid);
      if (!existing) {
        try {
          await generateAndStoreCandidateScore(req.db, cid);
        } catch {}
      }
    }
    // Fetch latest scores
    const scored = [];
    for (const cid of apps) {
      const s = await getLatestCandidateScore(req.db, cid);
      if (s && s.overall_score != null) {
        scored.push({
          candidate_id: cid,
          overall_score: s.overall_score,
          experience_fit: s.experience_fit,
          skills_fit: s.skills_fit,
          culture_fit: s.culture_fit,
          location_fit: s.location_fit,
          rationale: s.rationale,
          created_at: s.created_at,
        });
      }
    }
    scored.sort((a, b) => (b.overall_score || 0) - (a.overall_score || 0));
    return res.json({ success: true, ranked: scored });
  } catch (e) {
    console.error("POST /jobs/:id/ai-rank error", e);
    return res.status(500).json({ error: "internal_error" });
  }
});

module.exports = router;
module.exports.initJobs = initJobs;
