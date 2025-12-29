/**
 * AI Scoring Service
 * Provides candidate scoring functionality using OpenAI
 */

const config = require('../config');

// OpenAI client singleton
const OPENAI_API_KEY = config.ai.openaiApiKey;
let _openaiClient = null;

// JSON repair utility
let jsonrepairFn = null;
try {
  const jr = require("jsonrepair");
  if (typeof jr === "function") jsonrepairFn = jr;
  else if (jr && typeof jr.jsonrepair === "function")
    jsonrepairFn = jr.jsonrepair;
} catch {}

// Database schema constants
const DEFAULT_SCHEMA = config.db.schema || "public";
const qualify = (name) => name.includes(".") ? name : `${DEFAULT_SCHEMA}.${name}`;
const PEOPLE_TABLE_NAME = config.atsTables.peopleTable || "candidates";
const PEOPLE_TABLE = qualify(PEOPLE_TABLE_NAME);
const PEOPLE_PK = config.atsTables.peoplePk || "candidate_id";
const APP_TABLE_NAME = config.atsTables.applicationsTable || "applications";
const APP_TABLE = qualify(APP_TABLE_NAME);
const APP_PK = config.atsTables.applicationsPk || "application_id";

function getOpenAIClient() {
  if (!OPENAI_API_KEY) {
    throw new Error("openai_not_configured");
  }
  if (!_openaiClient) {
    try {
      const OpenAI = require("openai");
      _openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
    } catch (e) {
      throw new Error("openai_sdk_not_installed");
    }
  }
  return _openaiClient;
}

/**
 * Get the latest AI score for a candidate
 */
async function getLatestCandidateScore(db, candidateId) {
  try {
    const sql = `SELECT id, candidate_id, model, version, created_at, overall_score,
                        experience_fit, skills_fit, culture_fit, location_fit,
                        risk_flags, rationale, raw_json
                   FROM candidate_ai_scores
                  WHERE candidate_id = $1
               ORDER BY created_at DESC, id DESC
                  LIMIT 1`;
    const r = await db.query(sql, [candidateId]);
    return r.rows[0] || null;
  } catch {
    return null;
  }
}

/**
 * Insert or update a candidate's AI score
 */
async function insertCandidateScore(db, candidateId, payload) {
  const {
    model = "gpt-4o-mini",
    version = "v1",
    overall_score = null,
    experience_fit = null,
    skills_fit = null,
    culture_fit = null,
    risk_flags = null,
    strengths = null,
    recommendations = null,
    rationale = null,
    raw_json = null,
  } = payload || {};
  const versionValue = String(version || "v1");
  const sql = `INSERT INTO candidate_ai_scores
    (candidate_id, model, version, overall_score, experience_fit, skills_fit, culture_fit, risk_flags, strengths, recommendations, rationale, raw_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (candidate_id, model, version) DO UPDATE SET
      overall_score = EXCLUDED.overall_score,
      experience_fit = EXCLUDED.experience_fit,
      skills_fit = EXCLUDED.skills_fit,
      culture_fit = EXCLUDED.culture_fit,
      risk_flags = EXCLUDED.risk_flags,
      strengths = EXCLUDED.strengths,
      recommendations = EXCLUDED.recommendations,
      rationale = EXCLUDED.rationale,
      raw_json = EXCLUDED.raw_json,
      created_at = NOW()
    RETURNING id`;
  const params = [
    candidateId,
    model,
    versionValue,
    overall_score,
    experience_fit,
    skills_fit,
    culture_fit,
    risk_flags,
    strengths,
    recommendations,
    rationale,
    raw_json,
  ];
  try {
    const r = await db.query(sql, params);
    return r.rows[0]?.id || null;
  } catch (e) {
    console.error("[insertCandidateScore] Error:", e.message);
    return null;
  }
}

/**
 * Build a candidate view model for scoring
 */
async function buildCandidateVM(db, candidateId) {
  if (!candidateId) return null;

  const candSql = `
    SELECT
      ${PEOPLE_PK} AS id,
      COALESCE(first_name, '') AS first_name,
      COALESCE(last_name, '') AS last_name,
      email,
      phone,
      address,
      city,
      state,
      country,
      linkedin_url,
      portfolio_url,
      work_eligibility,
      willing_to_relocate,
      values_resonates,
      motivation,
      onsite_available,
      termination_history,
      references_available,
      work_authorization,
      expected_salary_range,
      interview_questions,
      interview_questions_generated_at
    FROM ${PEOPLE_TABLE}
    WHERE ${PEOPLE_PK} = $1
  `;
  const cand = (await db.query(candSql, [candidateId])).rows[0] || null;

  const appSql = `
    SELECT a.${APP_PK} AS application_id,
         a.job_requisition_id,
         a.application_date,
         to_jsonb(a)->>'status' AS app_status,
         a.expected_salary_range,
         to_jsonb(a)->>'years_experience' AS years_experience,
         to_jsonb(a)->>'application_source' AS application_source,
         to_jsonb(a)->>'resume_url' AS resume_url,
         to_jsonb(a)->>'cover_letter_url' AS cover_letter_url,
         COALESCE(to_jsonb(a)->>'photo_url', to_jsonb(a)->>'photo') AS photo_url,
         a.name AS applicant_name,
         a.email AS applicant_email,
         a.phone AS applicant_phone,
         jl.job_title,
         jl.recruiter_assigned,
         jl.hiring_manager
    FROM ${APP_TABLE} a
    LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON (a.job_requisition_id IS NOT NULL AND jl.job_requisition_id = a.job_requisition_id)
    WHERE a.candidate_id = $1
    ORDER BY a.application_date DESC NULLS LAST, a.${APP_PK} DESC
    LIMIT 1
  `;
  const app = (await db.query(appSql, [candidateId])).rows[0] || null;

  // Get resume/cover URLs from any application if latest lacks them
  let resumeUrl = app?.resume_url || "";
  let coverLetterUrl = app?.cover_letter_url || "";
  let photoUrl = app?.photo_url || "";

  if (!resumeUrl) {
    const r = await db.query(
      `SELECT to_jsonb(a)->>'resume_url' AS resume_url
         FROM ${APP_TABLE} a
        WHERE a.candidate_id = $1 AND COALESCE(to_jsonb(a)->>'resume_url','') <> ''
        ORDER BY a.application_date DESC NULLS LAST, a.${APP_PK} DESC
        LIMIT 1`,
      [candidateId]
    );
    resumeUrl = r.rows[0]?.resume_url || "";
  }
  if (!coverLetterUrl) {
    const r2 = await db.query(
      `SELECT to_jsonb(a)->>'cover_letter_url' AS cover_letter_url
         FROM ${APP_TABLE} a
        WHERE a.candidate_id = $1 AND COALESCE(to_jsonb(a)->>'cover_letter_url','') <> ''
        ORDER BY a.application_date DESC NULLS LAST, a.${APP_PK} DESC
        LIMIT 1`,
      [candidateId]
    );
    coverLetterUrl = r2.rows[0]?.cover_letter_url || "";
  }

  const name = `${cand?.first_name || ""} ${cand?.last_name || ""}`.trim();
  const loc = [cand?.city, cand?.state, cand?.country]
    .filter((v) => v && String(v).trim())
    .join(", ") || cand?.address || "";

  return {
    id: candidateId,
    name: name || cand?.email || "Unknown",
    email: cand?.email || "n/a",
    phone: cand?.phone || "n/a",
    application_id: app?.application_id || null,
    location: loc || "",
    jobTitle: app?.job_title || "",
    jobLocation: loc || "",
    yearsExperience: app?.years_experience || "",
    expectedSalary: app?.expected_salary_range || cand?.expected_salary_range || "",
    resumeUrl,
    coverLetterUrl,
    photoUrl,
  };
}

/**
 * Build candidate scoring context (VM + extracted text)
 */
async function buildCandidateScoringContext(db, candidateId, getExtractedTextForUrl) {
  const vm = await buildCandidateVM(db, candidateId);
  if (!vm) return null;

  let texts = [];
  if (getExtractedTextForUrl) {
    try {
      if (vm.resumeUrl) {
        const t = await getExtractedTextForUrl(vm.resumeUrl);
        if (t) texts.push(`RESUME TEXT:\n${t}`);
      }
    } catch {}
    try {
      if (vm.coverLetterUrl) {
        const t = await getExtractedTextForUrl(vm.coverLetterUrl);
        if (t) texts.push(`COVER LETTER TEXT:\n${t}`);
      }
    } catch {}
  }
  const combined = texts.join("\n\n").slice(0, 25000);
  return { vm, combinedText: combined };
}

/**
 * Call OpenAI to generate candidate score
 */
async function callOpenAIScore({
  name,
  email,
  jobTitle,
  location,
  yearsExperience,
  expectedSalary,
  combinedText,
}) {
  if (!OPENAI_API_KEY) throw new Error("openai_api_key_missing");
  const modelName = config.ai.openaiModel || "gpt-4o-mini";
  const client = getOpenAIClient();

  const basePrompt = `You are an expert ATS (Applicant Tracking System) evaluator with deep knowledge of recruitment best practices.

Your task is to comprehensively evaluate a job candidate and provide a detailed, objective scoring breakdown.

SCORING CRITERIA (each 0-100):

1. OVERALL_SCORE: Holistic assessment of candidate fit
2. EXPERIENCE_FIT: Years of experience, relevant job history, career progression
3. SKILLS_FIT: Technical skills, soft skills, qualifications
4. CULTURE_FIT: Values alignment, work style, team compatibility

RISK FLAGS: Identify potential concerns (max 8 items)
STRENGTHS: Top 3-5 standout qualities or achievements
RECOMMENDATIONS: Actionable next steps
RATIONALE: Clear 200-500 character explanation of overall assessment

Return ONLY valid JSON (no markdown, no code blocks).`;

  const userContext = `CANDIDATE PROFILE:
Name: ${name || "Not provided"}
Email: ${email || "Not provided"}
Applied Position: ${jobTitle || "Not specified"}
Location: ${location || "Not specified"}
Years of Experience: ${yearsExperience || "Not specified"}
Expected Salary: ${expectedSalary ? expectedSalary : "Not specified"}

APPLICATION DETAILS:
${combinedText || "No additional information provided"}`;

  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: "candidate_evaluation",
      strict: true,
      schema: {
        type: "object",
        properties: {
          overall_score: { type: "number" },
          experience_fit: { type: "number" },
          skills_fit: { type: "number" },
          culture_fit: { type: "number" },
          risk_flags: { type: "array", items: { type: "string" } },
          strengths: { type: "array", items: { type: "string" } },
          recommendations: { type: "array", items: { type: "string" } },
          rationale: { type: "string" },
        },
        required: [
          "overall_score",
          "experience_fit",
          "skills_fit",
          "culture_fit",
          "risk_flags",
          "strengths",
          "recommendations",
          "rationale",
        ],
        additionalProperties: false,
      },
    },
  };

  let jsonText = "";
  try {
    console.log("[OpenAI] Generating content for candidate:", { name, email, jobTitle });
    const completion = await client.chat.completions.create({
      model: modelName,
      temperature: 0.3,
      max_tokens: 2048,
      response_format: responseFormat,
      messages: [
        { role: "system", content: basePrompt },
        { role: "user", content: userContext },
      ],
    });

    jsonText = completion?.choices?.[0]?.message?.content || "";

    if (!jsonText) {
      const err = new Error("openai_empty_response");
      err.detail = "OpenAI returned an empty response.";
      err.metadata = { isRetryable: true };
      throw err;
    }
  } catch (e) {
    console.error("[OpenAI] Generation error:", e);
    const err = new Error("openai_generation_failed");
    err.detail = e?.message || "OpenAI API call failed.";
    err.metadata = { isRetryable: true };
    err.cause = e;
    throw err;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(jsonText);
  } catch (parseErr) {
    if (jsonrepairFn) {
      try {
        const repairedText = jsonrepairFn(jsonText);
        parsed = JSON.parse(repairedText);
      } catch {}
    }
    if (!parsed) {
      const err = new Error("invalid_openai_json");
      err.detail = `Parse error: ${parseErr.message}`;
      err.metadata = { isRetryable: true };
      throw err;
    }
  }

  const num = (v) => v === null || v === undefined || v === "" ? null : Number(v);
  const arr = (v) => Array.isArray(v) ? v.slice(0, 10).map((x) => String(x).slice(0, 100)) : null;

  return {
    model: modelName,
    version: "v2",
    overall_score: num(parsed.overall_score),
    experience_fit: num(parsed.experience_fit),
    skills_fit: num(parsed.skills_fit),
    culture_fit: num(parsed.culture_fit),
    risk_flags: arr(parsed.risk_flags),
    strengths: arr(parsed.strengths),
    recommendations: arr(parsed.recommendations),
    rationale: parsed.rationale ? String(parsed.rationale).slice(0, 800) : null,
    raw_json: parsed,
  };
}

/**
 * Generate and store AI score for a candidate
 */
async function generateAndStoreCandidateScore(db, candidateId, options = {}) {
  const { force = false, getExtractedTextForUrl = null } = options;

  // Return existing score if not forcing regeneration
  const existing = await getLatestCandidateScore(db, candidateId);
  if (existing && !force) {
    return { score: existing, status: "existing" };
  }

  const ctx = await buildCandidateScoringContext(db, candidateId, getExtractedTextForUrl);
  if (!ctx) throw new Error("candidate_not_found");

  const { vm, combinedText } = ctx;
  const maxAttempts = 3;
  let payload = null;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      payload = await callOpenAIScore({
        name: vm.name || "",
        email: vm.email || "",
        jobTitle: vm.jobTitle || "",
        location: vm.location || "",
        yearsExperience: vm.yearsExperience || "",
        expectedSalary: vm.expectedSalary || "",
        combinedText,
      });
      break;
    } catch (err) {
      lastError = err;
      const retryable = ["openai_generation_failed", "invalid_openai_json"].includes(err?.message);
      if (!retryable || attempt >= maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }

  if (!payload) throw lastError || new Error("openai_generation_failed");

  const version = force ? `${payload.version}-rerun-${Date.now()}` : payload.version;
  await insertCandidateScore(db, candidateId, { ...payload, version });

  const next = await getLatestCandidateScore(db, candidateId);
  return { score: next, status: force ? "regenerated" : "generated" };
}

// Score queue to prevent overlapping runs
const _scoreQueue = new Set();

/**
 * Enqueue a candidate for background scoring
 */
function enqueueCandidateScore(db, candidateId, getExtractedTextForUrl = null) {
  const id = Number(candidateId);
  if (!Number.isFinite(id)) return;
  if (_scoreQueue.has(id)) return;
  _scoreQueue.add(id);

  setTimeout(async () => {
    try {
      await generateAndStoreCandidateScore(db, id, { getExtractedTextForUrl }).catch((err) => {
        console.warn("[ai-score] background generation failed", {
          candidateId: id,
          error: err?.message,
        });
      });
    } finally {
      _scoreQueue.delete(id);
    }
  }, 100);
}

module.exports = {
  getLatestCandidateScore,
  insertCandidateScore,
  buildCandidateVM,
  buildCandidateScoringContext,
  callOpenAIScore,
  generateAndStoreCandidateScore,
  enqueueCandidateScore,
};
