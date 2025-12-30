const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const mime = require("mime-types");
const { ConfidentialClientApplication } = require("@azure/msal-node");
const router = express.Router();
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const ExcelJS = require("exceljs");
const emailService = require("../../services/emailService");
let jsonrepairFn = null;
try {
  const jr = require("jsonrepair");
  if (typeof jr === "function") jsonrepairFn = jr;
  else if (jr && typeof jr.jsonrepair === "function")
    jsonrepairFn = jr.jsonrepair;
} catch {}
// OpenAI (ChatGPT) client
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
let _openaiClient = null;
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

// Local helpers and constants (DB access comes from req.db via multi-tenant middleware)
const DEFAULT_SCHEMA = process.env.DB_SCHEMA || "public";
const qualify = (name) =>
  name.includes(".") ? name : `${DEFAULT_SCHEMA}.${name}`;
const PEOPLE_TABLE_NAME = process.env.ATS_PEOPLE_TABLE || "candidates";
const PEOPLE_TABLE = qualify(PEOPLE_TABLE_NAME);
const PEOPLE_PK = process.env.ATS_PEOPLE_PK || "candidate_id";
const APP_TABLE_NAME = process.env.ATS_APPLICATIONS_TABLE || "applications";
const APP_TABLE = qualify(APP_TABLE_NAME);
const APP_PK = process.env.ATS_APPLICATIONS_PK || "application_id";
// Attachments table for ATS (per application)
const ATS_ATTACHMENTS_TABLE =
  process.env.ATS_ATTACHMENTS_TABLE || "application_attachment";

// File storage config (reuse app-level envs)
const FILES_ROOT = process.env.FILES_ROOT || "/app/app/uploads";
const FILES_PUBLIC_URL =
  process.env.FILES_PUBLIC_URL || "https://ats.s3protection.com/api/files";
const MAX_UPLOAD_MB = process.env.MAX_UPLOAD_MB || "512";
const MAX_UPLOAD_BYTES =
  Math.max(1, parseInt(MAX_UPLOAD_MB, 10) || 512) * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

function ensureDir(dir) {
  return fs.promises.mkdir(dir, { recursive: true });
}
function safeFileName(name) {
  if (!name) return `${crypto.randomBytes(8).toString("hex")}`;
  const base = path.basename(name).replace(/\s+/g, "_");
  return base.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function safeJoin(root, rel) {
  const cleaned = String(rel || "")
    .replace(/^\.+/g, "")
    .replace(/\\/g, "/");
  const normalized = path.normalize(cleaned).replace(/^([/\\])+/, "");
  const target = path.resolve(root, normalized);
  const rootResolved = path.resolve(root);
  if (!target.startsWith(rootResolved)) throw new Error("bad_path");
  return target;
}
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
  const fromName = path.extname(originalName || "").toLowerCase();
  if (fromName) return fromName;
  const fromMime = contentType ? `.${mime.extension(contentType) || ""}` : "";
  return fromMime || ".bin";
}

// --- Report generation helpers ---
const REPORT_TTL_SECONDS = Math.max(
  60,
  parseInt(process.env.REPORT_TTL_SECONDS || "900", 10)
);
const REPORT_TTL_MS = REPORT_TTL_SECONDS * 1000;
const REPORTS_DIR = path.join(FILES_ROOT, "reports");
const reportStore = new Map(); // id -> meta

function sanitizeOwnerKey(value) {
  return String(value || "anonymous")
    .toLowerCase()
    .replace(/[^a-z0-9@._-]/g, "_");
}

function getPrimaryEmail(req) {
  try {
    const user = req.session?.user || {};
    const candidates = [
      ...(Array.isArray(user.emails) ? user.emails : []),
      user.claims?.preferred_username,
      user.claims?.upn,
      user.claims?.email,
      user.claims?.mail,
    ];
    const normalized = candidates
      .map((v) => (v ? String(v).trim().toLowerCase() : null))
      .filter(Boolean);
    return normalized.length ? normalized[0] : null;
  } catch {
    return null;
  }
}

async function cleanupReport(id) {
  const meta = reportStore.get(id);
  if (!meta) return;
  reportStore.delete(id);
  if (meta.timer) {
    clearTimeout(meta.timer);
    meta.timer = null;
  }
  try {
    await fs.promises.unlink(meta.filePath);
  } catch {}
}

function registerReport(meta) {
  if (!meta || !meta.id) return;
  if (meta.timer) {
    clearTimeout(meta.timer);
    meta.timer = null;
  }
  reportStore.set(meta.id, meta);
  const delay = Math.max(
    1000,
    (meta.expiresAt || Date.now() + REPORT_TTL_MS) - Date.now()
  );
  const timer = setTimeout(() => {
    cleanupReport(meta.id).catch(() => {});
  }, delay);
  if (typeof timer.unref === "function") timer.unref();
  meta.timer = timer;
}

function listActiveReportsForOwner(ownerEmail) {
  const now = Date.now();
  const items = [];
  for (const meta of reportStore.values()) {
    if (meta.expiresAt && meta.expiresAt <= now) {
      cleanupReport(meta.id).catch(() => {});
      continue;
    }
    if (!ownerEmail || meta.owner === ownerEmail) {
      items.push(meta);
    }
  }
  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return items;
}

async function buildPipelineWorksheet(workbook, db) {
  const sheet = workbook.addWorksheet("Pipeline Overview");
  const headers = ["Stage", "Status", "Applications"];
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getColumn(1).width = 30;
  sheet.getColumn(2).width = 20;
  sheet.getColumn(3).width = 18;

  const sql = `
    WITH latest_stage AS (
      SELECT s.application_id,
             COALESCE(NULLIF(s.stage_name,''),'Unspecified') AS stage_name,
             COALESCE(NULLIF(s.status,''),'Unspecified') AS status,
             ROW_NUMBER() OVER (PARTITION BY s.application_id ORDER BY s.updated_at DESC NULLS LAST, s.stage_id DESC) AS rn
      FROM ${DEFAULT_SCHEMA}.application_stages s
    )
    SELECT stage_name, status, COUNT(*)::int AS applications
    FROM latest_stage
    WHERE rn = 1
    GROUP BY stage_name, status
    ORDER BY stage_name, status;
  `;
  const { rows } = await db.query(sql);
  let total = 0;
  for (const row of rows) {
    total += row.applications || 0;
    sheet.addRow([
      row.stage_name || "Unspecified",
      row.status || "Unspecified",
      row.applications || 0,
    ]);
  }
  const totalRow = sheet.addRow(["Total", "", total]);
  totalRow.font = { bold: true };
  return { rowCount: rows.length, total };
}

async function buildRecruiterWorksheet(workbook, db) {
  const sheet = workbook.addWorksheet("Recruiter Performance");
  const headers = [
    "Recruiter",
    "Applications",
    "Hires",
    "Rejections",
    "Avg Days to Hire",
  ];
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getColumn(1).width = 28;
  sheet.getColumn(2).width = 18;
  sheet.getColumn(3).width = 12;
  sheet.getColumn(4).width = 14;
  sheet.getColumn(5).width = 18;

  const sql = `
    WITH latest_stage AS (
      SELECT s.application_id,
             s.status,
             s.updated_at,
             ROW_NUMBER() OVER (PARTITION BY s.application_id ORDER BY s.updated_at DESC NULLS LAST, s.stage_id DESC) AS rn
      FROM ${DEFAULT_SCHEMA}.application_stages s
    )
    SELECT COALESCE(NULLIF(jl.recruiter_assigned,''),'Unassigned') AS recruiter,
           COUNT(*)::int AS total_applications,
           COUNT(*) FILTER (WHERE LOWER(ls.status) = 'hired')::int AS hires,
           COUNT(*) FILTER (WHERE LOWER(ls.status) IN ('rejected','declined'))::int AS rejections,
           ROUND(AVG(CASE WHEN LOWER(ls.status) = 'hired' AND a.application_date IS NOT NULL AND ls.updated_at IS NOT NULL
                         THEN EXTRACT(EPOCH FROM (ls.updated_at - a.application_date)) / 86400.0 END)::numeric, 2) AS avg_days_to_hire
    FROM ${APP_TABLE} a
    LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON (a.job_requisition_id IS NOT NULL AND jl.job_requisition_id = a.job_requisition_id)
    LEFT JOIN latest_stage ls ON ls.application_id = a.${APP_PK} AND ls.rn = 1
    GROUP BY recruiter
    ORDER BY total_applications DESC, recruiter;
  `;
  const { rows } = await db.query(sql);
  for (const row of rows) {
    sheet.addRow([
      row.recruiter || "Unassigned",
      row.total_applications || 0,
      row.hires || 0,
      row.rejections || 0,
      row.avg_days_to_hire != null ? Number(row.avg_days_to_hire) : null,
    ]);
  }
  return { rowCount: rows.length };
}

async function buildTimeToHireWorksheet(workbook, db, limit = 200) {
  const sheet = workbook.addWorksheet("Time to Hire");
  const headers = [
    "Candidate",
    "Email",
    "Job Title",
    "Application Date",
    "Hired Date",
    "Days to Hire",
  ];
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getColumn(1).width = 28;
  sheet.getColumn(2).width = 28;
  sheet.getColumn(3).width = 30;
  sheet.getColumn(4).width = 18;
  sheet.getColumn(5).width = 18;
  sheet.getColumn(6).width = 16;

  const sql = `
    WITH hired_stage AS (
      SELECT a.${APP_PK} AS application_id,
             c.${PEOPLE_PK} AS candidate_id,
             c.first_name,
             c.last_name,
             c.email,
             jl.job_title,
             a.application_date,
             ls.updated_at AS hired_at,
             EXTRACT(EPOCH FROM (ls.updated_at - a.application_date)) / 86400.0 AS days_to_hire
      FROM ${APP_TABLE} a
      JOIN ${PEOPLE_TABLE} c ON c.${PEOPLE_PK} = a.candidate_id
      LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON (a.job_requisition_id IS NOT NULL AND jl.job_requisition_id = a.job_requisition_id)
      JOIN (
        SELECT s.application_id,
               s.updated_at,
               ROW_NUMBER() OVER (PARTITION BY s.application_id ORDER BY s.updated_at ASC NULLS LAST, s.stage_id ASC) AS rn
        FROM ${DEFAULT_SCHEMA}.application_stages s
        WHERE LOWER(s.status) = 'hired'
      ) ls ON ls.application_id = a.${APP_PK} AND ls.rn = 1
      WHERE a.application_date IS NOT NULL AND ls.updated_at IS NOT NULL
    )
    SELECT *, ROUND(days_to_hire::numeric, 2) AS days
    FROM hired_stage
    ORDER BY hired_at DESC NULLS LAST
    LIMIT ${Math.max(50, Math.min(1000, Number(limit) || 200))};
  `;
  const { rows } = await db.query(sql);
  for (const row of rows) {
    const candidateName =
      `${(row.first_name || "").trim()} ${(
        row.last_name || ""
      ).trim()}`.trim() ||
      row.email ||
      "Unknown";
    const appDate = row.application_date
      ? new Date(row.application_date)
      : null;
    const hiredDate = row.hired_at ? new Date(row.hired_at) : null;
    sheet.addRow([
      candidateName,
      row.email || "",
      row.job_title || "—",
      appDate ? appDate.toISOString().slice(0, 10) : "",
      hiredDate ? hiredDate.toISOString().slice(0, 10) : "",
      row.days != null ? Number(row.days) : null,
    ]);
  }
  return { rowCount: rows.length };
}

async function buildSourceWorksheet(workbook, db) {
  const sheet = workbook.addWorksheet("Source Effectiveness");
  const headers = [
    "Source",
    "Applications",
    "Interviews",
    "Hires",
    "Hire Rate %",
  ];
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getColumn(1).width = 32;
  sheet.getColumn(2).width = 18;
  sheet.getColumn(3).width = 18;
  sheet.getColumn(4).width = 12;
  sheet.getColumn(5).width = 14;

  const sql = `
    WITH latest_stage AS (
      SELECT s.application_id,
             s.status,
             ROW_NUMBER() OVER (PARTITION BY s.application_id ORDER BY s.updated_at DESC NULLS LAST, s.stage_id DESC) AS rn
      FROM ${DEFAULT_SCHEMA}.application_stages s
    )
    SELECT COALESCE(NULLIF(to_jsonb(a)->>'application_source',''),'Unknown') AS source,
           COUNT(*)::int AS total_applications,
           COUNT(*) FILTER (WHERE ls.status IS NOT NULL AND LOWER(ls.status) LIKE 'interview%')::int AS interviews,
           COUNT(*) FILTER (WHERE LOWER(ls.status) = 'hired')::int AS hires,
           ROUND(CASE WHEN COUNT(*) = 0 THEN 0
                      ELSE (COUNT(*) FILTER (WHERE LOWER(ls.status) = 'hired')::numeric / COUNT(*)) * 100 END, 2) AS hire_rate
    FROM ${APP_TABLE} a
    LEFT JOIN latest_stage ls ON ls.application_id = a.${APP_PK} AND ls.rn = 1
    GROUP BY source
    ORDER BY total_applications DESC, source;
  `;
  const { rows } = await db.query(sql);
  for (const row of rows) {
    sheet.addRow([
      row.source || "Unknown",
      row.total_applications || 0,
      row.interviews || 0,
      row.hires || 0,
      row.hire_rate != null ? Number(row.hire_rate) : 0,
    ]);
  }
  return { rowCount: rows.length };
}

const REPORT_BUILDERS = {
  pipeline: {
    title: "Hiring Pipeline Report",
    description: "Overview of candidates in each stage of the pipeline.",
    build: buildPipelineWorksheet,
  },
  recruiter: {
    title: "Recruiter Performance Report",
    description: "Compare recruiter activity, hires, and efficiency.",
    build: buildRecruiterWorksheet,
  },
  "time-to-hire": {
    title: "Time to Hire Report",
    description: "Analyze hiring timelines for recently filled roles.",
    build: (workbook, db, filters) =>
      buildTimeToHireWorksheet(workbook, db, filters?.limit || 200),
  },
  source: {
    title: "Source Effectiveness Report",
    description: "Track application sources and conversion rates.",
    build: buildSourceWorksheet,
  },
};

async function generateWorkbookForReport({
  type,
  db,
  filters = {},
  actorEmail,
  actorName,
}) {
  const def = REPORT_BUILDERS[type];
  if (!def) {
    const err = new Error("unknown_report");
    err.status = 400;
    throw err;
  }

  const workbook = new ExcelJS.Workbook();
  const now = new Date();
  workbook.creator =
    actorName || actorEmail || "Application Management Dashboard";
  workbook.created = now;
  workbook.modified = now;

  const summary = workbook.addWorksheet("Summary");
  summary.getColumn(1).width = 22;
  summary.getColumn(2).width = 60;
  summary.addRow(["Report Title", def.title]);
  summary.addRow(["Generated At", now.toISOString()]);
  summary.addRow(["Requested By", actorName || actorEmail || "Unknown"]);
  if (def.description) summary.addRow(["Description", def.description]);
  if (filters && Object.keys(filters).length) {
    summary.addRow([]);
    summary.addRow(["Filters"]);
    for (const [key, value] of Object.entries(filters)) {
      const asText = Array.isArray(value)
        ? value.join(", ")
        : value == null
        ? ""
        : String(value);
      summary.addRow([`• ${key}`, asText]);
    }
  }

  const buildResult = await def.build(workbook, db, filters);
  summary.addRow([]);
  summary.addRow(["Rows Exported", buildResult?.rowCount ?? 0]);
  summary.getRow(1).font = { bold: true };
  summary.getColumn(1).font = { bold: true };

  return { workbook, definition: def, rowCount: buildResult?.rowCount ?? 0 };
}

// --- Resume text extraction helpers (best-effort) ---
async function extractTextFromBuffer(buf, filename, contentType) {
  try {
    const ext = String(path.extname(filename || "").toLowerCase());
    const ct = String(contentType || "").toLowerCase();
    if (ext === ".pdf" || ct.includes("pdf")) {
      const r = await pdfParse(buf).catch(() => ({ text: "" }));
      return r.text || "";
    }
    if (
      ext === ".docx" ||
      ct.includes("officedocument.wordprocessingml.document")
    ) {
      const r = await mammoth
        .extractRawText({ buffer: buf })
        .catch(() => ({ value: "" }));
      return r.value || "";
    }
    // Fallback: try UTF-8 decode plain text
    return buf ? buf.toString("utf8") : "";
  } catch {
    return "";
  }
}

// Resolve resume/cover URL to extracted text. Supports:
// - Local stored files whose public URL starts with FILES_PUBLIC_URL (or contains '/files/') using sidecar caching
// - External http(s) URLs by fetching and caching text under FILES_ROOT/external_cache
async function getExtractedTextForUrl(urlStr, debugOverride = false) {
  if (!urlStr) return "";
  try {
    const url = String(urlStr);
    const debug = debugOverride || process.env.DEBUG_SEARCH === "1";
    const pubBase = String(FILES_PUBLIC_URL || "").replace(/\/$/, "");
    // Case 0: Signed or query-style file URLs -> extract key param and map directly
    try {
      const u = new URL(url, "http://dummy");
      if (
        /\/files-signed(\/|$)/.test(u.pathname) ||
        (u.pathname === "/files" && u.searchParams.has("key"))
      ) {
        const key = u.searchParams.get("key");
        if (key) {
          const abs = path.resolve(FILES_ROOT, key.replace(/^\/+/, ""));
          const sidecar = abs + ".txt";
          try {
            const text = await fs.promises.readFile(sidecar, "utf8");
            if (text) {
              if (debug) console.log("[SEARCH] sidecar hit (signed):", sidecar);
              return text;
            }
          } catch {}
          try {
            const buf = await fs.promises.readFile(abs);
            const ct = mime.lookup(abs) || "";
            const extracted = await extractTextFromBuffer(buf, abs, ct).catch(
              () => ""
            );
            if (extracted && extracted.trim()) {
              try {
                await fs.promises.writeFile(sidecar, extracted, "utf8");
                if (debug)
                  console.log("[SEARCH] sidecar wrote (signed):", sidecar);
              } catch {}
              return extracted;
            }
          } catch (e) {
            if (debug)
              console.warn(
                "[SEARCH] file read miss (signed):",
                abs,
                e?.message
              );
          }
        }
      }
    } catch {}
    // Case 1: Local storage exposed by public URL -> map to disk and use sidecar
    if (pubBase && (url.startsWith(pubBase + "/") || /\/files\//.test(url))) {
      // Derive relative path from either configured PUBLIC URL prefix or a generic '/files/' segment
      let rel = "";
      if (url.startsWith(pubBase + "/")) rel = url.slice(pubBase.length + 1);
      else rel = url.replace(/^.*\/files\//, "");
      const abs = path.resolve(FILES_ROOT, rel);
      const sidecar = abs + ".txt";
      try {
        const text = await fs.promises.readFile(sidecar, "utf8");
        if (text) {
          if (debug) console.log("[SEARCH] sidecar hit:", sidecar);
          return text;
        }
      } catch {}
      // Sidecar missing, try original file
      try {
        const buf = await fs.promises.readFile(abs);
        const ct = mime.lookup(abs) || "";
        const extracted = await extractTextFromBuffer(buf, abs, ct).catch(
          () => ""
        );
        if (extracted && extracted.trim()) {
          try {
            await fs.promises.writeFile(sidecar, extracted, "utf8");
            if (debug) console.log("[SEARCH] sidecar wrote:", sidecar);
          } catch {}
          return extracted;
        }
      } catch (e) {
        if (debug) console.warn("[SEARCH] file read miss:", abs, e?.message);
      }
      // Fallback: fetch over HTTP(S) using the original URL (works if files are served publicly)
      try {
        const resp = await axios.get(url, {
          responseType: "arraybuffer",
          timeout: 15000,
          maxContentLength: 20 * 1024 * 1024,
        });
        const buf = Buffer.from(resp.data);
        const ct = String(resp.headers?.["content-type"] || "");
        let filename = url.split("?")[0];
        const extracted = await extractTextFromBuffer(buf, filename, ct).catch(
          () => ""
        );
        if (extracted && extracted.trim()) return extracted;
      } catch (e) {
        if (debug) console.warn("[SEARCH] http fallback miss:", e?.message);
      }
      return "";
    }

    // Case 2: External URL (http/https) -> fetch and cache by URL hash
    if (/^https?:\/\//i.test(url)) {
      const cacheDir = path.resolve(FILES_ROOT, "external_cache");
      const hash = crypto
        .createHash("sha256")
        .update(url)
        .digest("hex")
        .slice(0, 32);
      const cacheTxt = path.join(cacheDir, `${hash}.txt`);
      try {
        const cached = await fs.promises.readFile(cacheTxt, "utf8");
        if (cached) return cached;
      } catch {}
      try {
        await ensureDir(cacheDir);
      } catch {}
      // Fetch remote (limit size by axios default handling; rely on server/network limits)
      try {
        const resp = await axios.get(url, {
          responseType: "arraybuffer",
          timeout: 15000,
          maxContentLength: 20 * 1024 * 1024,
        });
        const buf = Buffer.from(resp.data);
        const ct = String(resp.headers?.["content-type"] || "");
        // Try to infer extension from URL path for better parsing
        let filename = url.split("?")[0];
        const extracted = await extractTextFromBuffer(buf, filename, ct).catch(
          () => ""
        );
        if (extracted && extracted.trim()) {
          try {
            await fs.promises.writeFile(cacheTxt, extracted, "utf8");
          } catch {}
          return extracted;
        }
      } catch {}
      return "";
    }

    // Case 3: Unknown/relative path; best-effort: try mapping relative to FILES_ROOT directly
    try {
      const abs = path.resolve(FILES_ROOT, String(url).replace(/^\/+/, ""));
      const sidecar = abs + ".txt";
      try {
        const text = await fs.promises.readFile(sidecar, "utf8");
        if (text) return text;
      } catch {}
      const buf = await fs.promises.readFile(abs).catch(() => null);
      if (buf) {
        const ct = mime.lookup(abs) || "";
        const extracted = await extractTextFromBuffer(buf, abs, ct).catch(
          () => ""
        );
        if (extracted && extracted.trim()) {
          try {
            await fs.promises.writeFile(sidecar, extracted, "utf8");
          } catch {}
          return extracted;
        }
      }
    } catch {}
  } catch {}
  return "";
}

// --- AI Scoring helpers (OpenAI ChatGPT) ---
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

async function buildCandidateScoringContext(db, candidateId) {
  const vm = await buildCandidateVM(db, candidateId);
  if (!vm) return null;
  // Collect any resume/cover text
  let texts = [];
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
  const combined = texts.join("\n\n").slice(0, 25000); // cap size
  return { vm, combinedText: combined };
}

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
  const modelName = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const client = getOpenAIClient();

  const basePrompt = `You are an expert ATS (Applicant Tracking System) evaluator with deep knowledge of recruitment best practices.

Your task is to comprehensively evaluate a job candidate and provide a detailed, objective scoring breakdown.

SCORING CRITERIA (each 0-100):

1. OVERALL_SCORE: Holistic assessment of candidate fit
   - Weight all factors proportionally
   - Consider both strengths and weaknesses
   - Be realistic and objective

2. EXPERIENCE_FIT: Years of experience, relevant job history, career progression
   - 0-30: Minimal or no relevant experience
   - 31-50: Some relevant experience but significant gaps
   - 51-70: Good relevant experience, minor gaps
   - 71-85: Strong relevant experience, well-aligned
   - 86-100: Exceptional experience, perfect alignment

3. SKILLS_FIT: Technical skills, soft skills, qualifications
   - Evaluate depth and breadth of skills
   - Consider both stated and inferred abilities
   - Look for unique or standout capabilities

4. CULTURE_FIT: Values alignment, work style, team compatibility
   - Assess motivation and values resonance
   - Consider communication style from application
   - Evaluate long-term potential

RISK FLAGS: Identify potential concerns (max 8 items):
- Red flags: Deal-breakers or serious concerns
- Yellow flags: Areas requiring clarification
- Be specific but concise (max 100 chars each)

STRENGTHS: Top 3-5 standout qualities or achievements
- Be specific and evidence-based
- Highlight unique differentiators

RECOMMENDATIONS: Actionable next steps
- Interview focus areas
- Questions to ask
- Skills to probe deeper

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

  // OpenAI response schema
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
    console.log("[OpenAI] Generating content for candidate:", {
      name,
      email,
      jobTitle,
    });
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

    // Log the full result object for debugging
    console.log("[OpenAI] Response received:", {
      hasChoices: !!completion?.choices?.length,
      finishReason: completion?.choices?.[0]?.finish_reason,
      usage: completion?.usage,
    });

    jsonText = completion?.choices?.[0]?.message?.content || "";

    if (!jsonText) {
      console.error(
        "[OpenAI] Empty response text! Full result:",
        JSON.stringify(completion, null, 2)
      );
      const err = new Error("openai_empty_response");
      err.detail =
        "OpenAI returned an empty response. Check if content was filtered or API key is valid.";
      err.metadata = {
        finishReason: completion?.choices?.[0]?.finish_reason,
        isRetryable: true,
      };
      throw err;
    }

    console.log("[OpenAI] Response text length:", jsonText.length, "chars");
  } catch (e) {
    console.error("[OpenAI] Generation error:", e);
    const err = new Error("openai_generation_failed");
    err.detail =
      e?.message ||
      e?.error?.message ||
      e?.toString?.() ||
      "OpenAI API call failed.";
    err.metadata = {
      status: e?.status,
      code: e?.code,
      isRetryable: true,
    };
    err.cause = e;
    throw err;
  }
  let parsed = null;
  let parsedSource = "raw";
  try {
    console.log(
      "[OpenAI] Attempting to parse JSON. First 200 chars:",
      jsonText.substring(0, 200)
    );
    parsed = JSON.parse(jsonText);
    console.log("[OpenAI] Successfully parsed JSON");
  } catch (parseErr) {
    console.error("[OpenAI] JSON parse failed:", parseErr.message);
    console.error(
      "[OpenAI] Raw text (first 500 chars):",
      jsonText.substring(0, 500)
    );
    console.error("[OpenAI] Raw text (last 100 chars):", jsonText.slice(-100));

    let repairedText = null;
    let repairFailure = null;
    if (jsonrepairFn) {
      try {
        console.log("[OpenAI] Attempting JSON repair...");
        repairedText = jsonrepairFn(jsonText);
      } catch (repairErr) {
        console.error("[OpenAI] JSON repair failed:", repairErr.message);
        repairFailure = repairErr;
      }
    }
    if (repairedText) {
      try {
        parsed = JSON.parse(repairedText);
        parsedSource = "jsonrepair";
        jsonText = repairedText;
        console.log("[OpenAI] Successfully repaired and parsed JSON");
      } catch (repairParseErr) {
        console.error(
          "[OpenAI] Repaired JSON still invalid:",
          repairParseErr.message
        );
        repairFailure = repairParseErr;
        parsed = null;
      }
    }
    if (!parsed) {
      const err = new Error("invalid_openai_json");
      err.detail = `Parse error: ${parseErr.message}. Response preview: ${(
        jsonText || ""
      ).slice(0, 300)}`;
      err.metadata = {
        isRetryable: true,
        attemptedRepair: Boolean(repairedText),
        parsedSource,
        textLength: jsonText?.length || 0,
        repairError: repairFailure
          ? repairFailure.message || String(repairFailure)
          : undefined,
      };
      err.cause = parseErr;
      throw err;
    }
  }
  const num = (v) =>
    v === null || v === undefined || v === "" ? null : Number(v);
  const arr = (v) =>
    Array.isArray(v)
      ? v.slice(0, 10).map((x) => String(x).slice(0, 100))
      : null;
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
    raw_text_source: parsedSource,
  };
}

async function generateAndStoreCandidateScore(db, candidateId, options = {}) {
  const { force = false } = options;
  // Idempotent: return existing score when not forcing a regeneration
  const existing = await getLatestCandidateScore(db, candidateId);
  if (existing && !force) {
    return { score: existing, status: "existing" };
  }
  const ctx = await buildCandidateScoringContext(db, candidateId);
  if (!ctx) throw new Error("candidate_not_found");
  const { vm, combinedText } = ctx;
  const maxAttemptsEnv = Number(
    process.env.OPENAI_SCORE_RETRIES || process.env.AI_RETRY_ATTEMPTS || 3
  );
  const maxAttempts =
    Number.isFinite(maxAttemptsEnv) && maxAttemptsEnv > 0
      ? Math.min(5, Math.max(1, Math.floor(maxAttemptsEnv)))
      : 3;
  let payload = null;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      payload = await callOpenAIScore({
        name: vm.name || "",
        email: vm.email || "",
        jobTitle: vm.jobTitle || "",
        location: vm.location || vm.jobLocation || "",
        yearsExperience: vm.yearsExperience || "",
        expectedSalary: vm.expectedSalary || "",
        combinedText,
      });
      break;
    } catch (err) {
      lastError = err;
      const code = err?.message || "";
      const retryable = [
        "openai_generation_failed",
        "invalid_openai_json",
      ].includes(code);
      const shouldRetry = retryable && attempt < maxAttempts;
      if (err && typeof err === "object") {
        err.attempt = attempt;
        err.maxAttempts = maxAttempts;
        err.retryable = shouldRetry;
        if (err.metadata && typeof err.metadata === "object") {
          err.metadata.isRetryable = shouldRetry;
          err.metadata.attempt = attempt;
          err.metadata.maxAttempts = maxAttempts;
        }
      }
      if (!retryable || attempt >= maxAttempts) {
        throw err;
      }
      const backoffMs = Math.min(5000, attempt * 750);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  if (!payload) {
    const err = lastError || new Error("openai_generation_failed");
    if (err && typeof err === "object") {
      err.maxAttempts = maxAttempts;
      err.retryable = false;
      if (err.metadata && typeof err.metadata === "object") {
        err.metadata.finalAttempt = true;
        err.metadata.isRetryable = false;
        err.metadata.maxAttempts = maxAttempts;
      }
    }
    throw err;
  }
  const baseVersion = payload?.version ? String(payload.version) : "v1";
  const version = force ? `${baseVersion}-rerun-${Date.now()}` : baseVersion;
  await insertCandidateScore(db, candidateId, { ...payload, version });
  const next = await getLatestCandidateScore(db, candidateId);
  return { score: next, status: force ? "regenerated" : "generated" };
}

// Lightweight queue to avoid overlapping runs
const _scoreQueue = new Set();
function enqueueCandidateScore(db, candidateId) {
  const id = Number(candidateId);
  if (!Number.isFinite(id)) return;
  if (_scoreQueue.has(id)) return;
  _scoreQueue.add(id);
  // Run soon, non-blocking
  setTimeout(async () => {
    try {
      // Idempotent inside
      await generateAndStoreCandidateScore(db, id).catch((err) => {
        console.warn("[ai-score] background generation failed", {
          candidateId: id,
          error: err?.message,
        });
        return null;
      });
    } finally {
      _scoreQueue.delete(id);
    }
  }, 100);
}

// Common utility to fetch available columns for a table in a given schema
async function getTableColumns(db, schema, tableName) {
  try {
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      [schema, tableName]
    );
    return new Set((rows || []).map((r) => r.column_name));
  } catch {
    return new Set();
  }
}

// ============================================
// Helper functions for @mentions
// ============================================

/**
 * Extract @mention emails from text
 * Matches patterns like @email@domain.com or @first.last@domain.com
 */
function extractMentions(text) {
  if (!text || typeof text !== "string") return [];
  // Match @email patterns (e.g., @john@example.com, @jane.doe@company.com)
  const mentionRegex = /@([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const matches = text.matchAll(mentionRegex);
  const emails = new Set();
  for (const match of matches) {
    if (match[1]) {
      emails.add(match[1].toLowerCase());
    }
  }
  return Array.from(emails);
}

/**
 * Save mentions to the database and create notifications
 * @param {object} db - Database connection
 * @param {string} type - 'note' or 'idea'
 * @param {number} referenceId - note_id or idea_id
 * @param {string[]} mentionedEmails - Array of emails mentioned
 * @param {string} mentionedBy - Email of the person who created the mention
 * @param {string} message - Notification message
 */
async function saveMentions(
  db,
  type,
  referenceId,
  mentionedEmails,
  mentionedBy,
  message
) {
  if (!mentionedEmails || mentionedEmails.length === 0) return;

  const mentionTable = type === "note" ? "note_mentions" : "idea_mentions";
  const referenceField = type === "note" ? "note_id" : "idea_id";

  for (const email of mentionedEmails) {
    try {
      // Save mention
      await db.query(
        `INSERT INTO ${DEFAULT_SCHEMA}.${mentionTable}(${referenceField}, mentioned_email, mentioned_by) VALUES ($1, $2, $3) ON CONFLICT (${referenceField}, mentioned_email) DO NOTHING`,
        [referenceId, email, mentionedBy]
      );

      // Create notification
      await db.query(
        `INSERT INTO ${DEFAULT_SCHEMA}.notifications(user_email, type, reference_type, reference_id, message) VALUES ($1, $2, $3, $4, $5)`,
        [email, `${type}_mention`, type, referenceId, message]
      );
    } catch (e) {
      console.error(`Error saving mention for ${email}:`, e.message);
    }
  }
}

/**
 * Delete existing mentions for a note/idea (used when updating)
 */
async function deleteMentions(db, type, referenceId) {
  const mentionTable = type === "note" ? "note_mentions" : "idea_mentions";
  const referenceField = type === "note" ? "note_id" : "idea_id";

  await db.query(
    `DELETE FROM ${DEFAULT_SCHEMA}.${mentionTable} WHERE ${referenceField} = $1`,
    [referenceId]
  );
}

/**
 * Fetch mentions for a note/idea
 */
async function fetchMentions(db, type, referenceId) {
  const mentionTable = type === "note" ? "note_mentions" : "idea_mentions";
  const referenceField = type === "note" ? "note_id" : "idea_id";

  const result = await db.query(
    `SELECT mentioned_email, mentioned_by, created_at FROM ${DEFAULT_SCHEMA}.${mentionTable} WHERE ${referenceField} = $1`,
    [referenceId]
  );
  return result.rows;
}

// Ensure this router always operates under the 'ats' app context and has a DB attached
router.use((req, res, next) => {
  if (!req.appId) req.appId = "ats";
  if (!req.db) {
    return res
      .status(500)
      .json({ error: "db_not_attached", app: req.appId || "ats" });
  }
  next();
});

// --- Health endpoints for ATS (mounted under /ats/api/ats/*) ---
// Quick probe
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

// Explicit DB health path to match existing clients
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

// --- Admin setup ---
const ADMIN_EMAILS = (
  process.env.ADMIN_EMAILS ||
  "catwell@mys3tech.com,jlowry@mys3tech.com,nlarker@mys3tech.com"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function isAdmin(req) {
  try {
    const user = req.session?.user || {};
    const emails = Array.isArray(user.emails) ? user.emails : [];
    // Be robust: include common claim shapes that may carry the signed-in email/UPN
    const extraIds = [
      user.claims?.preferred_username,
      user.claims?.upn,
      user.claims?.email,
      user.claims?.mail,
    ].filter(Boolean);
    const normalized = [...emails, ...extraIds]
      .map((e) =>
        String(e || "")
          .trim()
          .toLowerCase()
      )
      .filter(Boolean);
    const set = new Set(normalized);
    const ok = ADMIN_EMAILS.some((a) =>
      set.has(String(a).trim().toLowerCase())
    );
    if (!ok && process.env.ADMIN_DEBUG === "1") {
      console.warn("[ADMIN_DEBUG] isAdmin check failed", {
        sessionEmails: normalized,
        allowed: ADMIN_EMAILS,
      });
    }
    return ok;
  } catch {
    return false;
  }
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  return res.status(403).json({ error: "forbidden" });
}

// In this app version, the database schema is managed externally (see database/schema.sql).
// We avoid creating tables here to prevent drift. Optionally set search_path to the expected schema.
async function ensureAdminTables(db) {
  try {
    await db.query(`SET search_path TO ${DEFAULT_SCHEMA}`);

    // Create comment tables if they don't exist
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${DEFAULT_SCHEMA}.department_note_comments (
        id SERIAL PRIMARY KEY,
        note_id INTEGER NOT NULL,
        comment TEXT NOT NULL,
        created_by VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS ${DEFAULT_SCHEMA}.department_idea_comments (
        id SERIAL PRIMARY KEY,
        idea_id INTEGER NOT NULL,
        comment TEXT NOT NULL,
        created_by VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
  } catch (e) {
    console.error("Error ensuring admin tables:", e);
  }
}

// --- MS Graph Auth (using shared app registration) ---
const {
  AZURE_AD_TENANT_ID,
  AZURE_AD_CLIENT_ID,
  AZURE_AD_CLIENT_SECRET,
  AZURE_AD_REDIRECT_URI, // Main redirect URI for shared app registration
} = process.env;

const graphMsal =
  AZURE_AD_CLIENT_ID && AZURE_AD_TENANT_ID && AZURE_AD_CLIENT_SECRET
    ? new ConfidentialClientApplication({
        auth: {
          clientId: AZURE_AD_CLIENT_ID,
          authority: `https://login.microsoftonline.com/${AZURE_AD_TENANT_ID}`,
          clientSecret: AZURE_AD_CLIENT_SECRET,
        },
      })
    : null;

const GRAPH_SCOPES = [
  "User.Read",
  "Calendars.Read",
  "Calendars.ReadWrite",
  "Mail.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "offline_access",
  "openid",
  "profile",
  "email",
];
const GRAPH_REDIRECT_URI =
  process.env.GRAPH_REDIRECT_URI ||
  "https://ats.s3protection.com/api/ats/api/ats/graph/callback"; // Graph-specific callback

// Start Graph auth (delegated) for this user
router.get("/graph/login", (req, res) => {
  if (!graphMsal)
    return res.status(500).json({ error: "graph_not_configured" });
  if (!GRAPH_REDIRECT_URI)
    return res.status(500).json({ error: "graph_redirect_not_configured" });
  const state = crypto.randomBytes(16).toString("hex");
  const nonce = crypto.randomBytes(16).toString("hex");
  req.session.graphAuthState = state;
  req.session.graphAuthNonce = nonce;
  graphMsal
    .getAuthCodeUrl({
      scopes: GRAPH_SCOPES,
      redirectUri: GRAPH_REDIRECT_URI,
      responseMode: "query",
      state,
      nonce,
    })
    .then((url) => res.redirect(url))
    .catch((e) =>
      res.status(500).json({ error: "graph_auth_url_error", detail: e.message })
    );
});

// Graph redirect
router.get("/graph/callback", async (req, res) => {
  if (!graphMsal)
    return res.status(500).json({ error: "graph_not_configured" });
  const { code, state } = req.query;
  if (!code) return res.status(400).json({ error: "missing_code" });
  if (!state || state !== req.session.graphAuthState)
    return res.status(400).json({ error: "invalid_state" });
  try {
    const tokenResp = await graphMsal.acquireTokenByCode({
      code,
      scopes: GRAPH_SCOPES,
      redirectUri: GRAPH_REDIRECT_URI,
    });
    const { accessToken, refreshToken, expiresOn } = tokenResp;
    req.session.graph = {
      accessToken,
      refreshToken: refreshToken || null,
      expiresAt: expiresOn ? expiresOn.getTime() : Date.now() + 55 * 60 * 1000,
    };
    delete req.session.graphAuthState;
    delete req.session.graphAuthNonce;
    res.redirect("/ats/graph/success");
  } catch (e) {
    res.status(500).json({ error: "graph_token_error", detail: e.message });
  }
});

// Graph success page (for popup completion)
router.get("/graph/success", (req, res) => {
  res.send(`
    <html>
      <head><title>Graph Authentication Successful</title></head>
      <body>
        <h2>Microsoft Graph Authentication Successful</h2>
        <p>You can now close this window.</p>
        <script>
          // Notify parent window and close popup
          if (window.opener) {
            window.opener.postMessage({ type: 'graph-auth-success' }, '*');
          }
          setTimeout(() => window.close(), 1000);
        </script>
      </body>
    </html>
  `);
});

// Graph auth status
router.get("/graph/status", (req, res) => {
  const g = req.session?.graph;
  if (!g) return res.json({ authenticated: false });
  const expiresInSec = Math.max(
    0,
    Math.floor((g.expiresAt - Date.now()) / 1000)
  );
  res.json({ authenticated: true, expiresInSec });
});

// Attach Graph token for downstream handlers
router.use("/graph", (req, res, next) => {
  // Skip auth endpoints
  if (["/login", "/callback", "/status"].includes(req.path)) return next();
  const g = req.session?.graph;
  if (!g || !g.accessToken || (g.expiresAt && g.expiresAt <= Date.now())) {
    return res.status(401).json({ error: "graph_auth_required" });
  }
  req.graphToken = g.accessToken;
  return next();
});

// -------------------- ADMIN ROUTES --------------------
// Return admin status without requiring admin (so UI can gate correctly)
router.get("/admin/status", async (req, res) => {
  const admin = isAdmin(req);
  if (admin) {
    try {
      await ensureAdminTables(req.db);
    } catch {}
  }
  const payload = { admin };
  if (process.env.ADMIN_DEBUG === "1") {
    try {
      const user = req.session?.user || {};
      const emails = Array.isArray(user.emails) ? user.emails : [];
      const dbg = {
        emails,
        preferred_username: user.claims?.preferred_username,
        upn: user.claims?.upn,
        email: user.claims?.email,
        mail: user.claims?.mail,
      };
      const normalized = [
        ...emails,
        user.claims?.preferred_username,
        user.claims?.upn,
        user.claims?.email,
        user.claims?.mail,
      ]
        .filter(Boolean)
        .map((v) => String(v).trim().toLowerCase());
      payload.user = dbg;
      payload.normalized = Array.from(new Set(normalized));
      payload.allowed = ADMIN_EMAILS;
    } catch {}
  }
  return res.json(payload);
});

// -------------------- USER PREFERENCES --------------------
/**
 * Get user preferences
 */
router.get("/preferences", async (req, res) => {
  try {
    const userEmail = getPrimaryEmail(req);
    if (!userEmail) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const db = req.db || global.dbPool;
    if (!db) {
      return res.status(500).json({ error: "Database not available" });
    }

    // Check if user_preferences table exists
    const tableCheck = await db.query(
      `
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = $1
        AND table_name = 'user_preferences'
      )
    `,
      [DEFAULT_SCHEMA]
    );

    if (!tableCheck.rows[0].exists) {
      // Table doesn't exist, create it
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${qualify("user_preferences")} (
          id SERIAL PRIMARY KEY,
          user_email VARCHAR(255) NOT NULL UNIQUE,
          preferences JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }

    // Get or create preferences
    const result = await db.query(
      `SELECT preferences FROM ${qualify(
        "user_preferences"
      )} WHERE user_email = $1`,
      [userEmail]
    );

    if (result.rows.length === 0) {
      // Create default preferences
      const defaultPrefs = {
        searchHistory: {},
        savedSearches: {},
        viewSettings: {},
      };

      await db.query(
        `INSERT INTO ${qualify(
          "user_preferences"
        )} (user_email, preferences) VALUES ($1, $2)`,
        [userEmail, JSON.stringify(defaultPrefs)]
      );

      return res.json(defaultPrefs);
    }

    res.json(result.rows[0].preferences || {});
  } catch (error) {
    console.error("[Preferences] Error fetching preferences:", error);
    res.status(500).json({ error: "Failed to fetch preferences" });
  }
});

/**
 * Update user preferences
 */
router.put("/preferences", async (req, res) => {
  try {
    const userEmail = getPrimaryEmail(req);
    if (!userEmail) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const db = req.db || global.dbPool;
    if (!db) {
      return res.status(500).json({ error: "Database not available" });
    }

    const { preferences } = req.body;
    if (!preferences || typeof preferences !== "object") {
      return res.status(400).json({ error: "Invalid preferences data" });
    }

    // Upsert preferences
    await db.query(
      `INSERT INTO ${qualify(
        "user_preferences"
      )} (user_email, preferences, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (user_email)
       DO UPDATE SET preferences = $2, updated_at = CURRENT_TIMESTAMP`,
      [userEmail, JSON.stringify(preferences)]
    );

    res.json({ success: true, preferences });
  } catch (error) {
    console.error("[Preferences] Error updating preferences:", error);
    res.status(500).json({ error: "Failed to update preferences" });
  }
});

/**
 * Update specific preference section
 */
router.patch("/preferences/:section", async (req, res) => {
  try {
    const userEmail = getPrimaryEmail(req);
    if (!userEmail) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const db = req.db || global.dbPool;
    if (!db) {
      return res.status(500).json({ error: "Database not available" });
    }

    const { section } = req.params;
    const { data } = req.body;

    if (!data || typeof data !== "object") {
      return res.status(400).json({ error: "Invalid data" });
    }

    // Get current preferences
    const result = await db.query(
      `SELECT preferences FROM ${qualify(
        "user_preferences"
      )} WHERE user_email = $1`,
      [userEmail]
    );

    let preferences = {};
    if (result.rows.length > 0) {
      preferences = result.rows[0].preferences || {};
    }

    // Update specific section
    preferences[section] = data;

    // Upsert
    await db.query(
      `INSERT INTO ${qualify(
        "user_preferences"
      )} (user_email, preferences, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (user_email)
       DO UPDATE SET preferences = $2, updated_at = CURRENT_TIMESTAMP`,
      [userEmail, JSON.stringify(preferences)]
    );

    res.json({ success: true, preferences });
  } catch (error) {
    console.error("[Preferences] Error updating preference section:", error);
    res.status(500).json({ error: "Failed to update preference section" });
  }
});

// -------------------- DEPARTMENTS (GENERAL) --------------------
// List departments for current user (non-admin sees only theirs; admin sees all)
/**
 * @openapi
 * /ats/api/ats/departments:
 *   get:
 *     summary: List departments accessible to the current user
 *     tags: [Departments]
 *     security:
 *       - SessionCookie: []
 *     responses:
 *       200: { description: OK }
 */
router.get("/departments", async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const admin = isAdmin(req);
    if (admin) {
      const r = await req.db.query(
        `SELECT id, name, description, icon, created_at, updated_at FROM ${DEFAULT_SCHEMA}.departments ORDER BY name`
      );
      return res.json(r.rows);
    }
    const user = req.session?.user || {};
    const emails = Array.isArray(user.emails)
      ? user.emails.map((e) => String(e).toLowerCase())
      : [];
    const extra = [
      user.claims?.preferred_username,
      user.claims?.upn,
      user.claims?.email,
      user.claims?.mail,
    ]
      .filter(Boolean)
      .map((v) => String(v).toLowerCase());
    const uniq = Array.from(new Set([...emails, ...extra])).filter(Boolean);
    if (!uniq.length) return res.json([]);
    const params = uniq.map((_, i) => `$${i + 1}`).join(",");
    const sql = `SELECT d.id, d.name, d.description, d.icon, d.created_at, d.updated_at
         FROM ${DEFAULT_SCHEMA}.department_members dm
         JOIN ${DEFAULT_SCHEMA}.departments d ON d.id = dm.department_id
                 WHERE LOWER(dm.email) IN (${params})
                 GROUP BY d.id
                 ORDER BY d.name`;
    const r = await req.db.query(sql, uniq);
    return res.json(r.rows);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// Applicants under a department (by departments.id)
/**
 * @openapi
 * /ats/api/ats/departments/{id}/applicants:
 *   get:
 *     summary: List applicants for a department
 *     tags: [Departments]
 *     security:
 *       - SessionCookie: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: OK }
 *       403: { description: Forbidden }
 *       404: { description: Not found }
 */
router.get("/departments/:id/applicants", async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const deptId = parseInt(req.params.id, 10);
    if (!Number.isFinite(deptId))
      return res.status(400).json({ error: "invalid_department" });
    // Resolve department name
    const d = await req.db.query(
      `SELECT id, name FROM ${DEFAULT_SCHEMA}.departments WHERE id = $1`,
      [deptId]
    );
    if (!d.rows.length) return res.status(404).json({ error: "not_found" });
    const deptName = d.rows[0].name;
    // Authorization: admin can view any; non-admin must be a member
    if (!isAdmin(req)) {
      const user = req.session?.user || {};
      const emails = Array.isArray(user.emails)
        ? user.emails.map((e) => String(e).toLowerCase())
        : [];
      const extra = [
        user.claims?.preferred_username,
        user.claims?.upn,
        user.claims?.email,
        user.claims?.mail,
      ]
        .filter(Boolean)
        .map((v) => String(v).toLowerCase());
      const uniq = Array.from(new Set([...emails, ...extra])).filter(Boolean);
      if (!uniq.length) return res.status(403).json({ error: "forbidden" });
      const params = uniq.map((_, i) => `$${i + 2}`).join(",");
      const chk = await req.db.query(
        `SELECT 1 FROM ${DEFAULT_SCHEMA}.department_members WHERE department_id = $1 AND LOWER(email) IN (${params}) LIMIT 1`,
        [deptId, ...uniq]
      );
      if (!chk.rows.length) return res.status(403).json({ error: "forbidden" });
    }
    // Fetch applicants linked to job listings under this department
    const sql = `
      SELECT c.${PEOPLE_PK} AS candidate_id,
             COALESCE(c.first_name,'') AS first_name,
             COALESCE(c.last_name,'') AS last_name,
             c.email,
             a.${APP_PK} AS application_id,
             a.application_date,
             a.job_requisition_id,
             jl.job_listing_id,
             jl.job_title,
             jl.recruiter_assigned,
             jl.hiring_manager,
             st.stage_name AS latest_stage_name,
             st.status     AS latest_stage_status,
             st.updated_at AS latest_stage_updated_at
      FROM ${APP_TABLE} a
      JOIN ${PEOPLE_TABLE} c ON c.${PEOPLE_PK} = a.candidate_id
      LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl
        ON (a.job_requisition_id IS NOT NULL AND jl.job_requisition_id = a.job_requisition_id)
      LEFT JOIN LATERAL (
        SELECT s.stage_name, s.status, s.updated_at, s.stage_id
          FROM ${DEFAULT_SCHEMA}.application_stages s
         WHERE s.application_id = a.${APP_PK}
         ORDER BY s.updated_at DESC NULLS LAST, s.stage_id DESC
         LIMIT 1
      ) st ON TRUE
      WHERE jl.department IS NOT NULL AND LOWER(TRIM(jl.department)) = LOWER(TRIM($1))
      ORDER BY a.application_date DESC NULLS LAST, a.${APP_PK} DESC
      LIMIT 500
    `;
    const r = await req.db.query(sql, [deptName]);
    const data = r.rows.map((row) => ({
      candidate_id: row.candidate_id,
      name: `${row.first_name} ${row.last_name}`.trim() || row.email,
      email: row.email,
      application_id: row.application_id,
      application_date: row.application_date,
      status: row.latest_stage_status || null,
      stage_name: row.latest_stage_name || null,
      stage_updated_at: row.latest_stage_updated_at || null,
      job_requisition_id: row.job_requisition_id || null,
      job_listing_id: row.job_listing_id,
      job_title: row.job_title,
      recruiter_assigned: row.recruiter_assigned || null,
      hiring_manager: row.hiring_manager || null,
    }));
    return res.json({
      department: { id: deptId, name: deptName },
      applicants: data,
    });
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// Departments
router.get("/admin/departments", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const r = await req.db.query(
      `SELECT id, name, description, icon, created_at, updated_at FROM ${DEFAULT_SCHEMA}.departments ORDER BY name`
    );
    return res.json(r.rows);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});
/**
 * @openapi
 * /ats/api/ats/admin/departments:
 *   post:
 *     summary: Create a department (admin)
 *     tags: [Departments]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *           example:
 *             name: Engineering
 *             description: Build and delivery
 *     responses:
 *       201: { description: Created }
 */
router.post("/admin/departments", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const { name, description, icon } = req.body || {};
    if (!name) return res.status(400).json({ error: "name_required" });
    const r = await req.db.query(
      `INSERT INTO ${DEFAULT_SCHEMA}.departments(name, description, icon) VALUES ($1,$2,$3) RETURNING id, name, description, icon, created_at, updated_at`,
      [name, description || null, icon || null]
    );
    return res.status(201).json(r.rows[0]);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});
router.put("/admin/departments/:id", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const id = parseInt(req.params.id, 10);
    const { name, description, icon } = req.body || {};
    const r = await req.db.query(
      `UPDATE ${DEFAULT_SCHEMA}.departments SET name = COALESCE($2,name), description = $3, icon = $4 WHERE id = $1 RETURNING id, name, description, icon, created_at, updated_at`,
      [id, name || null, description || null, icon !== undefined ? icon : null]
    );
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    return res.json(r.rows[0]);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});
router.delete("/admin/departments/:id", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const id = parseInt(req.params.id, 10);
    await req.db.query(
      `DELETE FROM ${DEFAULT_SCHEMA}.departments WHERE id = $1`,
      [id]
    );
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// Department members
router.get("/admin/departments/:id/members", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const id = parseInt(req.params.id, 10);
    const r = await req.db.query(
      `SELECT email, role, created_at FROM ${DEFAULT_SCHEMA}.department_members WHERE department_id = $1 ORDER BY email`,
      [id]
    );
    return res.json(r.rows);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// Department members (non-admin): allow admins or members of the department to view the list
router.get("/departments/:id/members", async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const deptId = parseInt(req.params.id, 10);
    if (!Number.isFinite(deptId))
      return res.status(400).json({ error: "invalid_department" });

    // Admins can view any department members
    if (!isAdmin(req)) {
      // Non-admins must be a member of this department
      const user = req.session?.user || {};
      const emails = Array.isArray(user.emails)
        ? user.emails.map((e) => String(e).toLowerCase())
        : [];
      const extra = [
        user.claims?.preferred_username,
        user.claims?.upn,
        user.claims?.email,
        user.claims?.mail,
      ]
        .filter(Boolean)
        .map((v) => String(v).toLowerCase());
      const uniq = Array.from(new Set([...emails, ...extra])).filter(Boolean);
      if (!uniq.length) return res.status(403).json({ error: "forbidden" });
      const placeholders = uniq.map((_, i) => `$${i + 2}`).join(",");
      const chk = await req.db.query(
        `SELECT 1 FROM ${DEFAULT_SCHEMA}.department_members WHERE department_id = $1 AND LOWER(email) IN (${placeholders}) LIMIT 1`,
        [deptId, ...uniq]
      );
      if (!chk.rows.length) return res.status(403).json({ error: "forbidden" });
    }

    const r = await req.db.query(
      `SELECT email, role, created_at FROM ${DEFAULT_SCHEMA}.department_members WHERE department_id = $1 ORDER BY email`,
      [deptId]
    );
    return res.json(r.rows);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// -------------------- SKILLS --------------------
// List all skills
/**
 * @openapi
 * /ats/api/ats/skills:
 *   get:
 *     summary: List all skills in the catalog
 *     tags: [Skills]
 *     security:
 *       - SessionCookie: []
 *     responses:
 *       200:
 *         description: OK
 */
router.get("/skills", async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const sql = `SELECT skill_id, skill_name FROM ${DEFAULT_SCHEMA}.skills ORDER BY skill_name ASC`;
    const r = await req.db.query(sql);
    return res.json(r.rows);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// Create a skill (case-insensitive dedupe)
/**
 * @openapi
 * /ats/api/ats/skills:
 *   post:
 *     summary: Create a new skill (dedupes by name, case-insensitive)
 *     tags: [Skills]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [skill_name]
 *             properties:
 *               skill_name:
 *                 type: string
 *                 example: React
 *     responses:
 *       201: { description: Created }
 *       200: { description: Already existed (returns existing) }
 *       400: { description: skill_name_required }
 */
router.post("/skills", async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const name = String(req.body?.skill_name || "").trim();
    if (!name) return res.status(400).json({ error: "skill_name_required" });
    // Case-insensitive check for existing skill
    const chk = await req.db.query(
      `SELECT skill_id, skill_name FROM ${DEFAULT_SCHEMA}.skills WHERE LOWER(skill_name) = LOWER($1) LIMIT 1`,
      [name]
    );
    if (chk.rows.length) {
      return res.json(chk.rows[0]);
    }
    const ins = await req.db.query(
      `INSERT INTO ${DEFAULT_SCHEMA}.skills(skill_name) VALUES ($1) RETURNING skill_id, skill_name`,
      [name]
    );
    return res.status(201).json(ins.rows[0]);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// List a candidate's skills
/**
 * @openapi
 * /ats/api/ats/candidates/{id}/skills:
 *   get:
 *     summary: List skills for a candidate
 *     tags: [Skills]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: OK }
 *       400: { description: invalid_candidate }
 */
router.get("/candidates/:id/skills", async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: "invalid_candidate" });
    const sql = `
      SELECT s.skill_id, s.skill_name, cs.proficiency_level
        FROM ${DEFAULT_SCHEMA}.candidate_skills cs
        JOIN ${DEFAULT_SCHEMA}.skills s ON s.skill_id = cs.skill_id
       WHERE cs.candidate_id = $1
       ORDER BY s.skill_name ASC
    `;
    const r = await req.db.query(sql, [id]);
    return res.json(r.rows);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// Batch: skills for many candidates
/**
 * @openapi
 * /ats/api/ats/candidates/skills/batch:
 *   post:
 *     summary: Batch fetch skills for many candidates
 *     tags: [Skills]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items: { type: integer }
 *                 example: [101, 102, 103]
 *     responses:
 *       200: { description: OK, returns a map of candidateId to array of skills }
 */
router.post("/candidates/skills/batch", async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    let ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length) return res.json({});
    ids = ids.map((x) => parseInt(x, 10)).filter(Number.isFinite);
    if (!ids.length) return res.json({});
    // cap to avoid pathological payloads
    if (ids.length > 1000) ids = ids.slice(0, 1000);
    const sql = `
      SELECT cs.candidate_id, s.skill_id, s.skill_name, cs.proficiency_level
        FROM ${DEFAULT_SCHEMA}.candidate_skills cs
        JOIN ${DEFAULT_SCHEMA}.skills s ON s.skill_id = cs.skill_id
       WHERE cs.candidate_id = ANY($1::int[])
       ORDER BY cs.candidate_id, s.skill_name ASC
    `;
    const r = await req.db.query(sql, [ids]);
    const out = {};
    for (const row of r.rows) {
      const cid = row.candidate_id;
      if (!out[cid]) out[cid] = [];
      out[cid].push({
        skill_id: row.skill_id,
        skill_name: row.skill_name,
        proficiency_level: row.proficiency_level,
      });
    }
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// Add or update a candidate's skill
/**
 * @openapi
 * /ats/api/ats/candidates/{id}/skills:
 *   post:
 *     summary: Add or update a candidate skill assignment
 *     tags: [Skills]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [skill_id]
 *             properties:
 *               skill_id:
 *                 type: integer
 *                 example: 12
 *               proficiency_level:
 *                 type: string
 *                 nullable: true
 *                 example: intermediate
 *     responses:
 *       200: { description: Updated existing assignment }
 *       201: { description: Created new assignment }
 *       400: { description: invalid_candidate | skill_id_required }
 *       404: { description: skill_not_found }
 */
router.post("/candidates/:id/skills", async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const id = parseInt(req.params.id, 10);
    const forceParam = req.query?.force ?? req.body?.force;
    const force =
      typeof forceParam === "string"
        ? ["true", "1", "yes", "force"].includes(forceParam.toLowerCase())
        : Boolean(forceParam);

    const result = await generateAndStoreCandidateScore(req.db, id, { force });
    const score = result?.score || null;
    if (!score) {
      return res.status(500).json({ error: "score_generation_failed" });
    }
    const payload = {
      started: result.status !== "existing",
      status: result.status,
      force,
      score,
      alreadyExists: result.status === "existing",
    };
    return res.status(200).json(payload);
    // Validate skill exists
    const code = e?.message || "unknown_error";
    if (code === "candidate_not_found")
      return res.status(404).json({ error: "candidate_not_found" });
    if (code === "openai_not_supported")
      return res.status(503).json({ error: "openai_not_supported" });
    if (code === "openai_api_key_missing")
      return res.status(503).json({ error: "openai_not_configured" });
    if (code === "openai_generation_failed")
      return res.status(502).json({ error: "openai_generation_failed" });
    if (code === "invalid_openai_json")
      return res.status(502).json({ error: "invalid_openai_json" });
    return res
      .status(500)
      .json({ error: "score_generation_failed", detail: e.message });
    const upd = await req.db.query(
      `UPDATE ${DEFAULT_SCHEMA}.candidate_skills
         SET proficiency_level = $3
       WHERE candidate_id = $1 AND skill_id = $2`,
      [id, skill_id, proficiency]
    );
    if (upd.rowCount === 0) {
      await req.db.query(
        `INSERT INTO ${DEFAULT_SCHEMA}.candidate_skills(candidate_id, skill_id, proficiency_level)
         VALUES ($1,$2,$3)`,
        [id, skill_id, proficiency]
      );
    }
    // Return the joined record
    const out = await req.db.query(
      `SELECT s.skill_id, s.skill_name, cs.proficiency_level
         FROM ${DEFAULT_SCHEMA}.candidate_skills cs
         JOIN ${DEFAULT_SCHEMA}.skills s ON s.skill_id = cs.skill_id
        WHERE cs.candidate_id = $1 AND cs.skill_id = $2
        LIMIT 1`,
      [id, skill_id]
    );
    const row = out.rows[0] || { skill_id, proficiency_level: proficiency };
    const status = out.rows.length ? 201 : 200;
    return res.status(status).json(row);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});
/**
 * @openapi
 * /ats/api/ats/admin/departments/{id}/members:
 *   post:
 *     summary: Add or update a department member (admin)
 *     tags: [Departments]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *           example:
 *             email: eng.lead@example.com
 *             role: member
 *     responses:
 *       201: { description: Created }
 */
router.post(
  "/admin/departments/:id/members",
  requireAdmin,
  async (req, res) => {
    try {
      await ensureAdminTables(req.db);
      const id = parseInt(req.params.id, 10);
      const { email, role } = req.body || {};
      if (!email) return res.status(400).json({ error: "email_required" });
      const r = await req.db.query(
        `INSERT INTO ${DEFAULT_SCHEMA}.department_members(department_id, email, role) VALUES ($1,$2,COALESCE($3,'member')) ON CONFLICT (department_id, email) DO UPDATE SET role = EXCLUDED.role RETURNING email, role, created_at`,
        [id, String(email).toLowerCase(), role || "member"]
      );
      return res.status(201).json(r.rows[0]);
    } catch (e) {
      return res.status(500).json({ error: "db_error", detail: e.message });
    }
  }
);
router.delete(
  "/admin/departments/:id/members/:email",
  requireAdmin,
  async (req, res) => {
    try {
      await ensureAdminTables(req.db);
      const id = parseInt(req.params.id, 10);
      const email = String(req.params.email).toLowerCase();
      await req.db.query(
        `DELETE FROM ${DEFAULT_SCHEMA}.department_members WHERE department_id = $1 AND email = $2`,
        [id, email]
      );
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: "db_error", detail: e.message });
    }
  }
);

// Notes (private/shared)
router.get("/admin/departments/:id/notes", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const id = parseInt(req.params.id, 10);
    const visibility = (req.query.visibility || "").toString();
    const params = [id];
    let sql = `SELECT id, visibility, content AS note, author_email AS created_by, created_at FROM ${DEFAULT_SCHEMA}.department_notes WHERE department_id = $1`;
    if (visibility === "private" || visibility === "shared") {
      sql += " AND visibility = $2";
      params.push(visibility);
    }
    sql += " ORDER BY created_at DESC";
    const r = await req.db.query(sql, params);
    // Fetch comments, candidate tags, job tags, and mentions for each note
    const notes = r.rows;
    for (const note of notes) {
      const commentsRes = await req.db.query(
        `SELECT id, comment, created_by, created_at FROM ${DEFAULT_SCHEMA}.department_note_comments WHERE note_id = $1 ORDER BY created_at ASC`,
        [note.id]
      );
      note.comments = commentsRes.rows;

      // Fetch tagged candidates
      const candidatesRes = await req.db.query(
        `SELECT nct.candidate_id, c.first_name, c.last_name, c.email, nct.tagged_at, nct.tagged_by
         FROM ${DEFAULT_SCHEMA}.note_candidate_tags nct
         LEFT JOIN ${DEFAULT_SCHEMA}.candidates c ON c.candidate_id = nct.candidate_id
         WHERE nct.note_id = $1
         ORDER BY nct.tagged_at DESC`,
        [note.id]
      );
      note.tagged_candidates = candidatesRes.rows;

      // Fetch tagged jobs
      const jobsRes = await req.db.query(
        `SELECT njt.job_listing_id, jl.job_title, jl.job_requisition_id, njt.tagged_at, njt.tagged_by
         FROM ${DEFAULT_SCHEMA}.note_job_tags njt
         LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON jl.job_listing_id = njt.job_listing_id
         WHERE njt.note_id = $1
         ORDER BY njt.tagged_at DESC`,
        [note.id]
      );
      note.tagged_jobs = jobsRes.rows;

      // Fetch mentions
      note.mentions = await fetchMentions(req.db, "note", note.id);
    }
    return res.json(notes);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});
/**
 * @openapi
 * /ats/api/ats/admin/departments/{id}/notes:
 *   post:
 *     summary: Add a department note (admin)
 *     tags: [Departments]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *           example:
 *             note: Q4 hiring push approved.
 *             visibility: shared
 *     responses:
 *       201: { description: Created }
 */
router.post("/admin/departments/:id/notes", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const id = parseInt(req.params.id, 10);
    const { note, visibility, candidate_ids, job_ids } = req.body || {};
    if (!note) return res.status(400).json({ error: "note_required" });
    const created_by =
      (req.session?.user?.emails && req.session.user.emails[0]) || "admin";
    const vis = visibility === "private" ? "private" : "shared";

    const r = await req.db.query(
      `INSERT INTO ${DEFAULT_SCHEMA}.department_notes(department_id, visibility, content, author_email) VALUES ($1,$2,$3,$4) RETURNING id, visibility, content AS note, author_email AS created_by, created_at`,
      [id, vis, note, created_by]
    );
    const newNote = r.rows[0];

    // Extract and save @mentions
    const mentionedEmails = extractMentions(note);
    if (mentionedEmails.length > 0) {
      const deptResult = await req.db.query(
        `SELECT name FROM ${DEFAULT_SCHEMA}.departments WHERE id = $1`,
        [id]
      );
      const deptName = deptResult.rows[0]?.name || "a department";
      const message = `${created_by} mentioned you in a note in ${deptName}`;
      await saveMentions(
        req.db,
        "note",
        newNote.id,
        mentionedEmails,
        created_by,
        message
      );
    }

    // Add candidate tags if provided
    if (Array.isArray(candidate_ids) && candidate_ids.length > 0) {
      for (const candidateId of candidate_ids) {
        await req.db.query(
          `INSERT INTO ${DEFAULT_SCHEMA}.note_candidate_tags(note_id, candidate_id, tagged_by) VALUES ($1, $2, $3) ON CONFLICT (note_id, candidate_id) DO NOTHING`,
          [newNote.id, candidateId, created_by]
        );
      }
    }

    // Add job tags if provided
    if (Array.isArray(job_ids) && job_ids.length > 0) {
      for (const jobId of job_ids) {
        await req.db.query(
          `INSERT INTO ${DEFAULT_SCHEMA}.note_job_tags(note_id, job_listing_id, tagged_by) VALUES ($1, $2, $3) ON CONFLICT (note_id, job_listing_id) DO NOTHING`,
          [newNote.id, jobId, created_by]
        );
      }
    }

    // Fetch the complete note with tags and mentions
    newNote.tagged_candidates = [];
    newNote.tagged_jobs = [];
    newNote.mentions = [];

    if (candidate_ids && candidate_ids.length > 0) {
      const candidatesRes = await req.db.query(
        `SELECT nct.candidate_id, c.first_name, c.last_name, c.email, nct.tagged_at, nct.tagged_by
         FROM ${DEFAULT_SCHEMA}.note_candidate_tags nct
         LEFT JOIN ${DEFAULT_SCHEMA}.candidates c ON c.candidate_id = nct.candidate_id
         WHERE nct.note_id = $1`,
        [newNote.id]
      );
      newNote.tagged_candidates = candidatesRes.rows;
    }
    if (job_ids && job_ids.length > 0) {
      const jobsRes = await req.db.query(
        `SELECT njt.job_listing_id, jl.job_title, jl.job_requisition_id, njt.tagged_at, njt.tagged_by
         FROM ${DEFAULT_SCHEMA}.note_job_tags njt
         LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON jl.job_listing_id = njt.job_listing_id
         WHERE njt.note_id = $1`,
        [newNote.id]
      );
      newNote.tagged_jobs = jobsRes.rows;
    }
    newNote.mentions = await fetchMentions(req.db, "note", newNote.id);

    return res.status(201).json(newNote);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// Update note
router.put(
  "/admin/departments/:departmentId/notes/:noteId",
  requireAdmin,
  async (req, res) => {
    try {
      await ensureAdminTables(req.db);
      const departmentId = parseInt(req.params.departmentId, 10);
      const noteId = parseInt(req.params.noteId, 10);
      const { note, visibility, candidate_ids, job_ids } = req.body || {};
      if (!note) return res.status(400).json({ error: "note_required" });
      const vis = visibility === "private" ? "private" : "shared";
      const updated_by =
        (req.session?.user?.emails && req.session.user.emails[0]) || "admin";

      const r = await req.db.query(
        `UPDATE ${DEFAULT_SCHEMA}.department_notes SET content = $1, visibility = $2 WHERE id = $3 RETURNING id, visibility, content AS note, author_email AS created_by, created_at`,
        [note, vis, noteId]
      );
      if (!r.rows.length) return res.status(404).json({ error: "not_found" });
      const updatedNote = r.rows[0];

      // Update @mentions - delete old ones and add new ones
      await deleteMentions(req.db, "note", noteId);
      const mentionedEmails = extractMentions(note);
      if (mentionedEmails.length > 0) {
        const deptResult = await req.db.query(
          `SELECT name FROM ${DEFAULT_SCHEMA}.departments WHERE id = $1`,
          [departmentId]
        );
        const deptName = deptResult.rows[0]?.name || "a department";
        const message = `${updated_by} mentioned you in a note in ${deptName}`;
        await saveMentions(
          req.db,
          "note",
          noteId,
          mentionedEmails,
          updated_by,
          message
        );
      }

      // Update candidate tags if provided
      if (Array.isArray(candidate_ids)) {
        // Remove existing tags
        await req.db.query(
          `DELETE FROM ${DEFAULT_SCHEMA}.note_candidate_tags WHERE note_id = $1`,
          [noteId]
        );
        // Add new tags
        for (const candidateId of candidate_ids) {
          await req.db.query(
            `INSERT INTO ${DEFAULT_SCHEMA}.note_candidate_tags(note_id, candidate_id, tagged_by) VALUES ($1, $2, $3) ON CONFLICT (note_id, candidate_id) DO NOTHING`,
            [noteId, candidateId, updated_by]
          );
        }
      }

      // Update job tags if provided
      if (Array.isArray(job_ids)) {
        // Remove existing tags
        await req.db.query(
          `DELETE FROM ${DEFAULT_SCHEMA}.note_job_tags WHERE note_id = $1`,
          [noteId]
        );
        // Add new tags
        for (const jobId of job_ids) {
          await req.db.query(
            `INSERT INTO ${DEFAULT_SCHEMA}.note_job_tags(note_id, job_listing_id, tagged_by) VALUES ($1, $2, $3) ON CONFLICT (note_id, job_listing_id) DO NOTHING`,
            [noteId, jobId, updated_by]
          );
        }
      }

      // Fetch the complete note with tags and mentions
      const candidatesRes = await req.db.query(
        `SELECT nct.candidate_id, c.first_name, c.last_name, c.email, nct.tagged_at, nct.tagged_by
       FROM ${DEFAULT_SCHEMA}.note_candidate_tags nct
       LEFT JOIN ${DEFAULT_SCHEMA}.candidates c ON c.candidate_id = nct.candidate_id
       WHERE nct.note_id = $1`,
        [noteId]
      );
      updatedNote.tagged_candidates = candidatesRes.rows;

      const jobsRes = await req.db.query(
        `SELECT njt.job_listing_id, jl.job_title, jl.job_requisition_id, njt.tagged_at, njt.tagged_by
       FROM ${DEFAULT_SCHEMA}.note_job_tags njt
       LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON jl.job_listing_id = njt.job_listing_id
       WHERE njt.note_id = $1`,
        [noteId]
      );
      updatedNote.tagged_jobs = jobsRes.rows;

      updatedNote.mentions = await fetchMentions(req.db, "note", noteId);

      return res.json(updatedNote);
    } catch (e) {
      return res.status(500).json({ error: "db_error", detail: e.message });
    }
  }
);

// Add comment to note
router.post(
  "/admin/departments/:departmentId/notes/:noteId/comments",
  requireAdmin,
  async (req, res) => {
    try {
      await ensureAdminTables(req.db);
      const noteId = parseInt(req.params.noteId, 10);
      const { comment } = req.body || {};
      if (!comment) return res.status(400).json({ error: "comment_required" });
      const created_by =
        (req.session?.user?.emails && req.session.user.emails[0]) || "admin";
      const r = await req.db.query(
        `INSERT INTO ${DEFAULT_SCHEMA}.department_note_comments(note_id, comment, created_by) VALUES ($1,$2,$3) RETURNING id, note_id, comment, created_by, created_at`,
        [noteId, comment, created_by]
      );
      return res.status(201).json(r.rows[0]);
    } catch (e) {
      return res.status(500).json({ error: "db_error", detail: e.message });
    }
  }
);

// Delete note
router.delete(
  "/admin/departments/:departmentId/notes/:noteId",
  requireAdmin,
  async (req, res) => {
    try {
      await ensureAdminTables(req.db);
      const noteId = parseInt(req.params.noteId, 10);
      // Delete comments, tags, then note (cascading deletes should handle this, but being explicit)
      await req.db.query(
        `DELETE FROM ${DEFAULT_SCHEMA}.department_note_comments WHERE note_id = $1`,
        [noteId]
      );
      await req.db.query(
        `DELETE FROM ${DEFAULT_SCHEMA}.note_candidate_tags WHERE note_id = $1`,
        [noteId]
      );
      await req.db.query(
        `DELETE FROM ${DEFAULT_SCHEMA}.note_job_tags WHERE note_id = $1`,
        [noteId]
      );
      // Delete note
      const r = await req.db.query(
        `DELETE FROM ${DEFAULT_SCHEMA}.department_notes WHERE id = $1 RETURNING id`,
        [noteId]
      );
      if (!r.rows.length) return res.status(404).json({ error: "not_found" });
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: "db_error", detail: e.message });
    }
  }
);

// Ideas / brainstorm board
router.get("/admin/departments/:id/ideas", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const id = parseInt(req.params.id, 10);
    const r = await req.db.query(
      `SELECT id, title, description, status, created_by, created_at, updated_at FROM ${DEFAULT_SCHEMA}.department_ideas WHERE department_id = $1 ORDER BY created_at DESC`,
      [id]
    );
    // Fetch comments, candidate tags, job tags, and mentions for each idea
    const ideas = r.rows;
    for (const idea of ideas) {
      const commentsRes = await req.db.query(
        `SELECT id, comment, created_by, created_at FROM ${DEFAULT_SCHEMA}.department_idea_comments WHERE idea_id = $1 ORDER BY created_at ASC`,
        [idea.id]
      );
      idea.comments = commentsRes.rows;

      // Fetch tagged candidates
      const candidatesRes = await req.db.query(
        `SELECT ict.candidate_id, c.first_name, c.last_name, c.email, ict.tagged_at, ict.tagged_by
         FROM ${DEFAULT_SCHEMA}.idea_candidate_tags ict
         LEFT JOIN ${DEFAULT_SCHEMA}.candidates c ON c.candidate_id = ict.candidate_id
         WHERE ict.idea_id = $1
         ORDER BY ict.tagged_at DESC`,
        [idea.id]
      );
      idea.tagged_candidates = candidatesRes.rows;

      // Fetch tagged jobs
      const jobsRes = await req.db.query(
        `SELECT ijt.job_listing_id, jl.job_title, jl.job_requisition_id, ijt.tagged_at, ijt.tagged_by
         FROM ${DEFAULT_SCHEMA}.idea_job_tags ijt
         LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON jl.job_listing_id = ijt.job_listing_id
         WHERE ijt.idea_id = $1
         ORDER BY ijt.tagged_at DESC`,
        [idea.id]
      );
      idea.tagged_jobs = jobsRes.rows;

      // Fetch mentions
      idea.mentions = await fetchMentions(req.db, "idea", idea.id);
    }
    return res.json(ideas);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});
/**
 * @openapi
 * /ats/api/ats/admin/departments/{id}/ideas:
 *   post:
 *     summary: Add a department idea (admin)
 *     tags: [Departments]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *           example:
 *             title: Campus recruiting program
 *             description: Partner with local universities.
 *     responses:
 *       201: { description: Created }
 */
router.post("/admin/departments/:id/ideas", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const id = parseInt(req.params.id, 10);
    const { title, description, status, candidate_ids, job_ids } =
      req.body || {};
    if (!title) return res.status(400).json({ error: "title_required" });
    const created_by =
      (req.session?.user?.emails && req.session.user.emails[0]) || "admin";
    const st = status || "open";

    const r = await req.db.query(
      `INSERT INTO ${DEFAULT_SCHEMA}.department_ideas(department_id, title, description, status, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, title, description, status, created_by, created_at, updated_at`,
      [id, title, description || null, st, created_by]
    );
    const newIdea = r.rows[0];

    // Extract and save @mentions from title and description
    const mentionedEmails = extractMentions(
      (title || "") + " " + (description || "")
    );
    if (mentionedEmails.length > 0) {
      const deptResult = await req.db.query(
        `SELECT name FROM ${DEFAULT_SCHEMA}.departments WHERE id = $1`,
        [id]
      );
      const deptName = deptResult.rows[0]?.name || "a department";
      const message = `${created_by} mentioned you in an idea "${title}" in ${deptName}`;
      await saveMentions(
        req.db,
        "idea",
        newIdea.id,
        mentionedEmails,
        created_by,
        message
      );
    }

    // Add candidate tags if provided
    if (Array.isArray(candidate_ids) && candidate_ids.length > 0) {
      for (const candidateId of candidate_ids) {
        await req.db.query(
          `INSERT INTO ${DEFAULT_SCHEMA}.idea_candidate_tags(idea_id, candidate_id, tagged_by) VALUES ($1, $2, $3) ON CONFLICT (idea_id, candidate_id) DO NOTHING`,
          [newIdea.id, candidateId, created_by]
        );
      }
    }

    // Add job tags if provided
    if (Array.isArray(job_ids) && job_ids.length > 0) {
      for (const jobId of job_ids) {
        await req.db.query(
          `INSERT INTO ${DEFAULT_SCHEMA}.idea_job_tags(idea_id, job_listing_id, tagged_by) VALUES ($1, $2, $3) ON CONFLICT (idea_id, job_listing_id) DO NOTHING`,
          [newIdea.id, jobId, created_by]
        );
      }
    }

    // Fetch the complete idea with tags and mentions
    newIdea.tagged_candidates = [];
    newIdea.tagged_jobs = [];
    newIdea.mentions = [];

    if (candidate_ids && candidate_ids.length > 0) {
      const candidatesRes = await req.db.query(
        `SELECT ict.candidate_id, c.first_name, c.last_name, c.email, ict.tagged_at, ict.tagged_by
         FROM ${DEFAULT_SCHEMA}.idea_candidate_tags ict
         LEFT JOIN ${DEFAULT_SCHEMA}.candidates c ON c.candidate_id = ict.candidate_id
         WHERE ict.idea_id = $1`,
        [newIdea.id]
      );
      newIdea.tagged_candidates = candidatesRes.rows;
    }
    if (job_ids && job_ids.length > 0) {
      const jobsRes = await req.db.query(
        `SELECT ijt.job_listing_id, jl.job_title, jl.job_requisition_id, ijt.tagged_at, ijt.tagged_by
         FROM ${DEFAULT_SCHEMA}.idea_job_tags ijt
         LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON jl.job_listing_id = ijt.job_listing_id
         WHERE ijt.idea_id = $1`,
        [newIdea.id]
      );
      newIdea.tagged_jobs = jobsRes.rows;
    }
    newIdea.mentions = await fetchMentions(req.db, "idea", newIdea.id);

    return res.status(201).json(newIdea);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});
router.put("/admin/ideas/:ideaId", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const ideaId = parseInt(req.params.ideaId, 10);
    let { title, description, status, candidate_ids, job_ids } = req.body || {};
    // Status validation - only allow: open, consider, closed
    if (
      status &&
      !["open", "consider", "closed"].includes(status.toLowerCase())
    ) {
      return res.status(400).json({
        error: "invalid_status",
        detail: "Status must be open, consider, or closed",
      });
    }
    const updated_by =
      (req.session?.user?.emails && req.session.user.emails[0]) || "admin";

    const r = await req.db.query(
      `UPDATE ${DEFAULT_SCHEMA}.department_ideas SET title = COALESCE($2,title), description = COALESCE($3,description), status = COALESCE($4,status) WHERE id = $1 RETURNING id, title, description, status, created_by, created_at, updated_at, department_id`,
      [ideaId, title || null, description || null, status || null]
    );
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    const updatedIdea = r.rows[0];

    // Update @mentions - delete old ones and add new ones
    await deleteMentions(req.db, "idea", ideaId);
    const mentionedEmails = extractMentions(
      (updatedIdea.title || "") + " " + (updatedIdea.description || "")
    );
    if (mentionedEmails.length > 0) {
      const deptResult = await req.db.query(
        `SELECT name FROM ${DEFAULT_SCHEMA}.departments WHERE id = $1`,
        [updatedIdea.department_id]
      );
      const deptName = deptResult.rows[0]?.name || "a department";
      const message = `${updated_by} mentioned you in an idea "${updatedIdea.title}" in ${deptName}`;
      await saveMentions(
        req.db,
        "idea",
        ideaId,
        mentionedEmails,
        updated_by,
        message
      );
    }

    // Update candidate tags if provided
    if (Array.isArray(candidate_ids)) {
      // Remove existing tags
      await req.db.query(
        `DELETE FROM ${DEFAULT_SCHEMA}.idea_candidate_tags WHERE idea_id = $1`,
        [ideaId]
      );
      // Add new tags
      for (const candidateId of candidate_ids) {
        await req.db.query(
          `INSERT INTO ${DEFAULT_SCHEMA}.idea_candidate_tags(idea_id, candidate_id, tagged_by) VALUES ($1, $2, $3) ON CONFLICT (idea_id, candidate_id) DO NOTHING`,
          [ideaId, candidateId, updated_by]
        );
      }
    }

    // Update job tags if provided
    if (Array.isArray(job_ids)) {
      // Remove existing tags
      await req.db.query(
        `DELETE FROM ${DEFAULT_SCHEMA}.idea_job_tags WHERE idea_id = $1`,
        [ideaId]
      );
      // Add new tags
      for (const jobId of job_ids) {
        await req.db.query(
          `INSERT INTO ${DEFAULT_SCHEMA}.idea_job_tags(idea_id, job_listing_id, tagged_by) VALUES ($1, $2, $3) ON CONFLICT (idea_id, job_listing_id) DO NOTHING`,
          [ideaId, jobId, updated_by]
        );
      }
    }

    // Fetch the complete idea with tags and mentions
    const candidatesRes = await req.db.query(
      `SELECT ict.candidate_id, c.first_name, c.last_name, c.email, ict.tagged_at, ict.tagged_by
       FROM ${DEFAULT_SCHEMA}.idea_candidate_tags ict
       LEFT JOIN ${DEFAULT_SCHEMA}.candidates c ON c.candidate_id = ict.candidate_id
       WHERE ict.idea_id = $1`,
      [ideaId]
    );
    updatedIdea.tagged_candidates = candidatesRes.rows;

    const jobsRes = await req.db.query(
      `SELECT ijt.job_listing_id, jl.job_title, jl.job_requisition_id, ijt.tagged_at, ijt.tagged_by
       FROM ${DEFAULT_SCHEMA}.idea_job_tags ijt
       LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON jl.job_listing_id = ijt.job_listing_id
       WHERE ijt.idea_id = $1`,
      [ideaId]
    );
    updatedIdea.tagged_jobs = jobsRes.rows;

    updatedIdea.mentions = await fetchMentions(req.db, "idea", ideaId);

    return res.json(updatedIdea);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// Add comment to idea
router.post(
  "/admin/departments/:departmentId/ideas/:ideaId/comments",
  requireAdmin,
  async (req, res) => {
    try {
      await ensureAdminTables(req.db);
      const ideaId = parseInt(req.params.ideaId, 10);
      const { comment } = req.body || {};
      if (!comment) return res.status(400).json({ error: "comment_required" });
      const created_by =
        (req.session?.user?.emails && req.session.user.emails[0]) || "admin";
      const r = await req.db.query(
        `INSERT INTO ${DEFAULT_SCHEMA}.department_idea_comments(idea_id, comment, created_by) VALUES ($1,$2,$3) RETURNING id, idea_id, comment, created_by, created_at`,
        [ideaId, comment, created_by]
      );
      return res.status(201).json(r.rows[0]);
    } catch (e) {
      return res.status(500).json({ error: "db_error", detail: e.message });
    }
  }
);

// Delete idea
router.delete(
  "/admin/departments/:departmentId/ideas/:ideaId",
  requireAdmin,
  async (req, res) => {
    try {
      await ensureAdminTables(req.db);
      const ideaId = parseInt(req.params.ideaId, 10);
      // Delete comments, tags, then idea (cascading deletes should handle this, but being explicit)
      await req.db.query(
        `DELETE FROM ${DEFAULT_SCHEMA}.department_idea_comments WHERE idea_id = $1`,
        [ideaId]
      );
      await req.db.query(
        `DELETE FROM ${DEFAULT_SCHEMA}.idea_candidate_tags WHERE idea_id = $1`,
        [ideaId]
      );
      await req.db.query(
        `DELETE FROM ${DEFAULT_SCHEMA}.idea_job_tags WHERE idea_id = $1`,
        [ideaId]
      );
      // Delete idea
      const r = await req.db.query(
        `DELETE FROM ${DEFAULT_SCHEMA}.department_ideas WHERE id = $1 RETURNING id`,
        [ideaId]
      );
      if (!r.rows.length) return res.status(404).json({ error: "not_found" });
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: "db_error", detail: e.message });
    }
  }
);

// ============================================
// Notifications endpoints
// ============================================

// Get notifications for current user
router.get("/admin/notifications", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const userEmail =
      (req.session?.user?.emails && req.session.user.emails[0]) || "admin";
    const limit = parseInt(req.query.limit, 10) || 50;
    const unreadOnly = req.query.unread_only === "true";

    let sql = `SELECT id, type, reference_type, reference_id, message, is_read, created_at, read_at
               FROM ${DEFAULT_SCHEMA}.notifications
               WHERE user_email = $1`;
    if (unreadOnly) {
      sql += " AND is_read = FALSE";
    }
    sql += " ORDER BY created_at DESC LIMIT $2";

    const r = await req.db.query(sql, [userEmail, limit]);
    return res.json(r.rows);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// Mark notification as read
router.put("/admin/notifications/:id/read", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const notificationId = parseInt(req.params.id, 10);
    const userEmail =
      (req.session?.user?.emails && req.session.user.emails[0]) || "admin";

    const r = await req.db.query(
      `UPDATE ${DEFAULT_SCHEMA}.notifications
       SET is_read = TRUE, read_at = NOW()
       WHERE id = $1 AND user_email = $2
       RETURNING id, type, reference_type, reference_id, message, is_read, created_at, read_at`,
      [notificationId, userEmail]
    );

    if (!r.rows.length) {
      return res.status(404).json({ error: "not_found" });
    }

    return res.json(r.rows[0]);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// Mark all notifications as read for current user
router.put("/admin/notifications/read-all", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const userEmail =
      (req.session?.user?.emails && req.session.user.emails[0]) || "admin";

    const r = await req.db.query(
      `UPDATE ${DEFAULT_SCHEMA}.notifications
       SET is_read = TRUE, read_at = NOW()
       WHERE user_email = $1 AND is_read = FALSE
       RETURNING id`,
      [userEmail]
    );

    return res.json({ success: true, count: r.rowCount });
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// Get unread notification count
router.get(
  "/admin/notifications/unread-count",
  requireAdmin,
  async (req, res) => {
    try {
      await ensureAdminTables(req.db);
      const userEmail =
        (req.session?.user?.emails && req.session.user.emails[0]) || "admin";

      const r = await req.db.query(
        `SELECT COUNT(*) as count FROM ${DEFAULT_SCHEMA}.notifications WHERE user_email = $1 AND is_read = FALSE`,
        [userEmail]
      );

      return res.json({ count: parseInt(r.rows[0]?.count || 0, 10) });
    } catch (e) {
      return res.status(500).json({ error: "db_error", detail: e.message });
    }
  }
);

// Candidate flags
router.get("/admin/candidate-flags", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const email = (req.query.email || "").toString().toLowerCase();
    if (!email) return res.status(400).json({ error: "email_required" });
    const r = await req.db.query(
      `SELECT email, flag, reason AS reason_private, updated_by, updated_at FROM ${DEFAULT_SCHEMA}.candidate_flags WHERE email = $1`,
      [email]
    );
    return res.json(r.rows[0] || null);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});
/**
 * @openapi
 * /ats/api/ats/admin/candidate-flags:
 *   post:
 *     summary: Set or clear a candidate flag (admin)
 *     tags: [Candidates]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *           example:
 *             email: candidate@example.com
 *             flag: revisit
 *             reason_private: Good fit, re-check next quarter
 *     responses:
 *       201: { description: Created }
 */
router.post("/admin/candidate-flags", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    let { email, flag, reason_private } = req.body || {};
    if (!email) return res.status(400).json({ error: "email_required" });
    email = String(email).toLowerCase();
    // Map to allowed flags: 'revisit' or 'do_not_consider'. Treat 'consider' as 'revisit'; neutral removes the flag.
    let mapped = null;
    const f = String(flag || "").toLowerCase();
    if (f === "do_not_consider") mapped = "do_not_consider";
    else if (f === "revisit" || f === "consider") mapped = "revisit";
    const updated_by =
      (req.session?.user?.emails && req.session.user.emails[0]) || "admin";
    if (!mapped) {
      // Remove flag when neutral/empty
      await req.db.query(
        `DELETE FROM ${DEFAULT_SCHEMA}.candidate_flags WHERE email = $1`,
        [email]
      );
      return res.status(200).json({ email, flag: null });
    }
    const r = await req.db.query(
      `INSERT INTO ${DEFAULT_SCHEMA}.candidate_flags(email, flag, reason, updated_by, updated_at)
    VALUES ($1,$2,$3,$4,NOW())
    ON CONFLICT (email)
    DO UPDATE SET flag = EXCLUDED.flag, reason = EXCLUDED.reason, updated_by = EXCLUDED.updated_by, updated_at = NOW()
    RETURNING email, flag, reason AS reason_private, updated_by, updated_at`,
      [email, mapped, reason_private || null, updated_by]
    );
    return res.status(201).json(r.rows[0]);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// Public (authenticated) retrieval: batch flags for UI highlighting
router.get("/candidates/flags", async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const list = (req.query.emails || "")
      .toString()
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!list.length) return res.json([]);
    const params = list.map((_, i) => `$${i + 1}`).join(",");
    const r = await req.db.query(
      `SELECT email, flag FROM ${DEFAULT_SCHEMA}.candidate_flags WHERE email IN (${params})`,
      list
    );
    return res.json(r.rows);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

function titleCase(str) {
  if (!str) return "";
  return String(str)
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function mapStatusToStage(status) {
  if (!status) return "";
  const s = String(status).toLowerCase();
  if (/(new|appl)/.test(s)) return "Screening";
  if (/(phone|screen)/.test(s)) return "Phone Screen";
  if (/(interview|onsite)/.test(s)) return "Interview";
  if (/(offer)/.test(s)) return "Offer";
  if (/(hire|hired)/.test(s)) return "Hired";
  if (/(reject|declined|closed)/.test(s)) return "Rejected";
  return titleCase(s);
}

// Build a candidate view model used by responses.
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

  let stage = null;
  if (app && app.application_id) {
    const st = await db.query(
      `SELECT stage_name, status, notes, internal_score, updated_at
   FROM ${DEFAULT_SCHEMA}.application_stages
       WHERE application_id = $1
       ORDER BY updated_at DESC NULLS LAST, stage_id DESC
       LIMIT 1`,
      [app.application_id]
    );
    stage = st.rows[0] || null;
  }

  // Prefer any existing resume/cover from any application if latest app lacks them
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
  if (!photoUrl) {
    const r3 = await db.query(
      `SELECT COALESCE(to_jsonb(a)->>'photo_url', to_jsonb(a)->>'photo') AS photo_url
         FROM ${APP_TABLE} a
        WHERE a.candidate_id = $1 AND COALESCE(COALESCE(to_jsonb(a)->>'photo_url',''), COALESCE(to_jsonb(a)->>'photo','')) <> ''
        ORDER BY a.application_date DESC NULLS LAST, a.${APP_PK} DESC
        LIMIT 1`,
      [candidateId]
    );
    photoUrl = r3.rows[0]?.photo_url || "";
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
  const loc =
    [cand?.city, cand?.state, cand?.country]
      .filter((v) => v && String(v).trim())
      .join(", ") ||
    cand?.address ||
    "";

  return {
    id: candidateId,
    name: name || cand?.email || "Unknown",
    email: cand?.email || "n/a",
    phone: cand?.phone || "n/a",
    application_id: app?.application_id || null,
    location: loc || "",
    address: cand?.address || "",
    city: cand?.city || "",
    state: cand?.state || "",
    country: cand?.country || "",
    linkedin: cand?.linkedin_url || "",
    portfolio: cand?.portfolio_url || "",
    workEligibility: cand?.work_eligibility || "",
    willingToRelocate: cand?.willing_to_relocate || "",
    valuesResonates: cand?.values_resonates || "",
    values_resonates: cand?.values_resonates || "",
    motivation: cand?.motivation || "",
    onsiteAvailable: cand?.onsite_available,
    onsite_available: cand?.onsite_available,
    terminationHistory: cand?.termination_history || "",
    termination_history: cand?.termination_history || "",
    referencesAvailable: cand?.references_available,
    references_available: cand?.references_available,
    workAuthorization: cand?.work_authorization,
    work_authorization: cand?.work_authorization,
    candidateExpectedSalaryRange: cand?.expected_salary_range || "",
    expected_salary_range: cand?.expected_salary_range || "",
    interviewQuestions: cand?.interview_questions || null,
    interview_questions: cand?.interview_questions || null,
    interviewQuestionsGeneratedAt:
      cand?.interview_questions_generated_at || null,
    interview_questions_generated_at:
      cand?.interview_questions_generated_at || null,
    jobTitle: app?.job_title || "—",
    stage: stage?.stage_name
      ? titleCase(stage.stage_name)
      : mapStatusToStage(stage?.status || app?.app_status) || "Screening",
    status: stage?.status || app?.app_status || "",
    recruiter: app?.recruiter_assigned || "Unassigned",
    applicationDate: app?.application_date
      ? new Date(app.application_date).toISOString().slice(0, 10)
      : "—",
    requisitionId: app?.job_requisition_id || "",
    expectedSalary:
      app?.expected_salary_range || cand?.expected_salary_range || "",
    yearsExperience: app?.years_experience || "",
    applicationSource: app?.application_source || "",
    resumeUrl: resumeUrl,
    // Back-compat for UI expecting snake_case keys
    resume_url: resumeUrl,
    coverLetterUrl: coverLetterUrl,
    cover_letter_url: coverLetterUrl,
    photoUrl: photoUrl,
    photo_url: photoUrl,
    hiringManager: app?.hiring_manager || "",
    notes: stage?.notes || "",
    skills: [],
    stages: [],
  };
}

// Note: Authentication routes are handled in app.js (multi-app aware). No auth endpoints here.

// -------------------- APPLICATIONS --------------------
// GET /applications
/**
 * @openapi
 * /ats/api/ats/applications:
 *   get:
 *     summary: List applications
 *     tags: [Applications]
 *     security:
 *       - SessionCookie: []
 *     parameters:
 *       - in: query
 *         name: position
 *         schema: { type: string }
 *       - in: query
 *         name: dateFrom
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: dateTo
 *         schema: { type: string, format: date }
 *     responses:
 *       200: { description: OK }
 */
router.get("/applications", async (req, res) => {
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
    sql += ` WHERE ${clauses.join(
      " AND "
    )} ORDER BY a.application_date DESC NULLS LAST, a.${APP_PK} DESC`;
    const { rows } = await req.db.query(sql, params);
    res.json(rows);
  } catch (error) {
    console.error("GET /applications error", error);
    // Graceful: return empty list instead of 500 to avoid breaking UI
    res.json([]);
  }
});

// DELETE /applications/:id (admin only)
/**
 * @openapi
 * /ats/api/ats/applications/{id}:
 *   delete:
 *     summary: Delete an application and associated stages (admin only)
 *     tags: [Applications]
 *     security:
 *       - SessionCookie: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Deleted }
 *       400: { description: Invalid id }
 *       403: { description: Forbidden }
 *       404: { description: Not found }
 */
router.delete("/applications/:id", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id))
    return res.status(400).json({ error: "invalid_application" });
  try {
    await req.db.query("BEGIN");
    const delStages = await req.db.query(
      `DELETE FROM ${DEFAULT_SCHEMA}.application_stages WHERE application_id = $1`,
      [id]
    );
    const delApp = await req.db.query(
      `DELETE FROM ${APP_TABLE} WHERE ${APP_PK} = $1`,
      [id]
    );
    await req.db.query("COMMIT");
    if (delApp.rowCount === 0)
      return res.status(404).json({ error: "not_found" });
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

// Upload resume for an application
/**
 * @openapi
 * /ats/api/ats/applications/{applicationId}/upload/resume:
 *   post:
 *     summary: Upload resume file for an application
 *     tags: [Applications]
 *     security:
 *       - SessionCookie: []
 *     parameters:
 *       - in: path
 *         name: applicationId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200: { description: Resume uploaded }
 *       400: { description: Bad request }
 *       404: { description: Not found }
 */
router.post(
  "/applications/:applicationId/upload/resume",
  upload.single("file"),
  async (req, res) => {
    try {
      const applicationId = parseInt(req.params.applicationId, 10);
      if (!Number.isFinite(applicationId))
        return res.status(400).json({ error: "invalid_application" });
      if (!req.file) return res.status(400).json({ error: "file_required" });

      const appQ = await req.db.query(
        `SELECT a.${APP_PK} AS application_id, a.candidate_id, c.first_name, c.last_name
         FROM ${APP_TABLE} a
         JOIN ${PEOPLE_TABLE} c ON c.${PEOPLE_PK} = a.candidate_id
        WHERE a.${APP_PK} = $1`,
        [applicationId]
      );
      if (!appQ.rows.length)
        return res.status(404).json({ error: "not_found" });
      const a = appQ.rows[0];

      const now = new Date();
      const yyyy = String(now.getFullYear());
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const candSlug = `${slugify(a.first_name)}-${slugify(a.last_name)}-${
        a.candidate_id
      }`;
      const ext = pickExt(req.file.originalname, req.file.mimetype);
      const fname = `${candSlug}-resume-${now.getTime()}${ext}`;
      const relPath = `ats/applications/${applicationId}/${yyyy}/${mm}/${safeFileName(
        fname
      )}`;
      const absPath = safeJoin(FILES_ROOT, relPath);

      await ensureDir(path.dirname(absPath));
      await fs.promises.writeFile(absPath, req.file.buffer);
      // Compute file metadata
      const originalName = safeFileName(req.file.originalname || "file");
      const contentType =
        req.file.mimetype ||
        mime.lookup(originalName) ||
        "application/octet-stream";
      const byteSize = req.file.size;
      const sha256 = crypto
        .createHash("sha256")
        .update(req.file.buffer)
        .digest("hex");
      // Best-effort: extract text into a sidecar file for quick search
      try {
        const txt = await extractTextFromBuffer(
          req.file.buffer,
          req.file.originalname,
          req.file.mimetype
        );
        const sidecar = absPath + ".txt";
        if (txt && txt.trim())
          await fs.promises.writeFile(sidecar, txt, "utf8");
      } catch {}

      const publicUrl = `${FILES_PUBLIC_URL.replace(/\/$/, "")}/${relPath}`;
      // Build short-lived signed URL for immediate use without session (frontend can choose either)
      let signedUrl = null;
      try {
        signedUrl =
          typeof buildSignedUrl === "function"
            ? buildSignedUrl(relPath, 600)
            : null;
      } catch {}
      try {
        await req.db.query(
          `UPDATE ${APP_TABLE} SET resume_url = $1 WHERE ${APP_PK} = $2`,
          [publicUrl, applicationId]
        );
      } catch (e) {
        // If column is missing, add it and retry once
        const msg = e?.message || "";
        const code = e?.code || "";
        if (
          code === "42703" ||
          /column\s+"?resume_url"?\s+does not exist/i.test(msg)
        ) {
          try {
            await req.db.query(
              `ALTER TABLE ${APP_TABLE} ADD COLUMN IF NOT EXISTS resume_url TEXT`
            );
            await req.db.query(
              `UPDATE ${APP_TABLE} SET resume_url = $1 WHERE ${APP_PK} = $2`,
              [publicUrl, applicationId]
            );
          } catch (e2) {
            if (process.env.DEBUG_UPLOADS === "1")
              console.warn("resume_url alter/update failed:", e2.message);
          }
        } else {
          if (process.env.DEBUG_UPLOADS === "1")
            console.warn("resume_url update skipped:", e.message);
        }
      }
      // Upsert attachment metadata record for the resume
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
        await req.db.query(sql, [
          applicationId,
          originalName,
          contentType,
          byteSize,
          relPath,
          null,
          sha256,
          uploader,
        ]);
      } catch (e) {
        if (process.env.DEBUG_UPLOADS === "1")
          console.warn("[RESUME] attachment upsert failed:", e.message);
      }
      // Trigger AI score generation (non-blocking) for this candidate
      try {
        enqueueCandidateScore(req.db, a.candidate_id);
      } catch {}
      return res.json({
        ok: true,
        url: publicUrl,
        signedUrl: signedUrl || null,
        path: relPath,
      });
    } catch (err) {
      if (err.message === "bad_path")
        return res.status(400).json({ error: "invalid_path" });
      if (err.code === "LIMIT_FILE_SIZE")
        return res
          .status(400)
          .json({ error: `file_too_large_max_${MAX_UPLOAD_MB}mb` });
      console.error("resume upload error", err);
      return res.status(500).json({ error: "upload_failed" });
    }
  }
);

// Upload cover letter for an application
/**
 * @openapi
 * /ats/api/ats/applications/{applicationId}/upload/cover-letter:
 *   post:
 *     summary: Upload cover letter file for an application
 *     tags: [Applications]
 *     security:
 *       - SessionCookie: []
 *     parameters:
 *       - in: path
 *         name: applicationId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200: { description: Cover letter uploaded }
 *       400: { description: Bad request }
 *       404: { description: Not found }
 */
router.post(
  "/applications/:applicationId/upload/cover-letter",
  upload.single("file"),
  async (req, res) => {
    try {
      const applicationId = parseInt(req.params.applicationId, 10);
      if (!Number.isFinite(applicationId))
        return res.status(400).json({ error: "invalid_application" });
      if (!req.file) return res.status(400).json({ error: "file_required" });

      const appQ = await req.db.query(
        `SELECT a.${APP_PK} AS application_id, a.candidate_id, c.first_name, c.last_name
         FROM ${APP_TABLE} a
         JOIN ${PEOPLE_TABLE} c ON c.${PEOPLE_PK} = a.candidate_id
        WHERE a.${APP_PK} = $1`,
        [applicationId]
      );
      if (!appQ.rows.length)
        return res.status(404).json({ error: "not_found" });
      const a = appQ.rows[0];

      const now = new Date();
      const yyyy = String(now.getFullYear());
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const candSlug = `${slugify(a.first_name)}-${slugify(a.last_name)}-${
        a.candidate_id
      }`;
      const ext = pickExt(req.file.originalname, req.file.mimetype);
      const fname = `${candSlug}-cover-letter-${now.getTime()}${ext}`;
      const relPath = `ats/applications/${applicationId}/${yyyy}/${mm}/${safeFileName(
        fname
      )}`;
      const absPath = safeJoin(FILES_ROOT, relPath);

      await ensureDir(path.dirname(absPath));
      await fs.promises.writeFile(absPath, req.file.buffer);
      // Compute file metadata
      const originalName = safeFileName(req.file.originalname || "file");
      const contentType =
        req.file.mimetype ||
        mime.lookup(originalName) ||
        "application/octet-stream";
      const byteSize = req.file.size;
      const sha256 = crypto
        .createHash("sha256")
        .update(req.file.buffer)
        .digest("hex");
      // Extract text for cover letter as well
      try {
        const txt = await extractTextFromBuffer(
          req.file.buffer,
          req.file.originalname,
          req.file.mimetype
        );
        const sidecar = absPath + ".txt";
        if (txt && txt.trim())
          await fs.promises.writeFile(sidecar, txt, "utf8");
      } catch {}

      const publicUrl = `${FILES_PUBLIC_URL.replace(/\/$/, "")}/${relPath}`;
      let signedUrl = null;
      try {
        signedUrl =
          typeof buildSignedUrl === "function"
            ? buildSignedUrl(relPath, 600)
            : null;
      } catch {}
      try {
        await req.db.query(
          `UPDATE ${APP_TABLE} SET cover_letter_url = $1 WHERE ${APP_PK} = $2`,
          [publicUrl, applicationId]
        );
      } catch (e) {
        const msg = e?.message || "";
        const code = e?.code || "";
        if (
          code === "42703" ||
          /column\s+"?cover_letter_url"?\s+does not exist/i.test(msg)
        ) {
          try {
            await req.db.query(
              `ALTER TABLE ${APP_TABLE} ADD COLUMN IF NOT EXISTS cover_letter_url TEXT`
            );
            await req.db.query(
              `UPDATE ${APP_TABLE} SET cover_letter_url = $1 WHERE ${APP_PK} = $2`,
              [publicUrl, applicationId]
            );
          } catch (e2) {
            if (process.env.DEBUG_UPLOADS === "1")
              console.warn("cover_letter_url alter/update failed:", e2.message);
          }
        } else {
          if (process.env.DEBUG_UPLOADS === "1")
            console.warn("cover_letter_url update skipped:", e.message);
        }
      }
      // Upsert attachment metadata record for the cover letter
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
        await req.db.query(sql, [
          applicationId,
          originalName,
          contentType,
          byteSize,
          relPath,
          null,
          sha256,
          uploader,
        ]);
      } catch (e) {
        if (process.env.DEBUG_UPLOADS === "1")
          console.warn("[COVER] attachment upsert failed:", e.message);
      }
      // Trigger AI score generation (non-blocking) for this candidate
      try {
        enqueueCandidateScore(req.db, a.candidate_id);
      } catch {}
      return res.json({
        ok: true,
        url: publicUrl,
        signedUrl: signedUrl || null,
        path: relPath,
      });
    } catch (err) {
      if (err.message === "bad_path")
        return res.status(400).json({ error: "invalid_path" });
      if (err.code === "LIMIT_FILE_SIZE")
        return res
          .status(400)
          .json({ error: `file_too_large_max_${MAX_UPLOAD_MB}mb` });
      console.error("cover letter upload error", err);
      return res.status(500).json({ error: "upload_failed" });
    }
  }
);

// -------------------- ATTACHMENTS (metadata only) --------------------
// Helpers
async function getActorUserId(req) {
  try {
    const email =
      (req.session?.user?.emails && req.session.user.emails[0]) || null;
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

/**
 * @openapi
 * /ats/api/ats/applications/{id}/attachments:
 *   get:
 *     summary: List attachments metadata for an application
 *     tags: [Attachments]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: OK }
 */
router.get("/applications/:id/attachments", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id))
    return res.status(400).json({ error: "invalid_application" });
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

/**
 * @openapi
 * /ats/api/ats/applications/{id}/attachments:
 *   post:
 *     summary: Upsert attachment metadata for an application
 *     tags: [Attachments]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [file_name, storage_key]
 *             properties:
 *               file_name: { type: string }
 *               content_type: { type: string }
 *               byte_size: { type: integer }
 *               storage_key: { type: string }
 *               expiration_date: { type: string, format: date }
 *               sha256_hex: { type: string }
 *     responses:
 *       201: { description: Created }
 *       200: { description: Updated }
 *       400: { description: Validation error }
 */
router.post("/applications/:id/attachments", async (req, res) => {
  const applicationId = parseInt(req.params.id, 10);
  if (!Number.isFinite(applicationId))
    return res.status(400).json({ error: "invalid_application" });
  const {
    file_name,
    content_type,
    byte_size,
    storage_key,
    expiration_date,
    sha256_hex,
  } = req.body || {};
  if (!file_name || !storage_key)
    return res
      .status(400)
      .json({ error: "file_name_and_storage_key_required" });
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
    const sql = `INSERT INTO ${DEFAULT_SCHEMA}.${ATS_ATTACHMENTS_TABLE} (${cols.join(
      ","
    )})
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

/**
 * @openapi
 * /ats/api/ats/applications/{id}/attachments/{attachmentId}:
 *   delete:
 *     summary: Delete an attachment metadata record for an application
 *     tags: [Attachments]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: attachmentId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Deleted }
 */
router.delete(
  "/applications/:id/attachments/:attachmentId",
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const attachmentId = parseInt(req.params.attachmentId, 10);
    if (!Number.isFinite(id) || !Number.isFinite(attachmentId))
      return res.status(400).json({ error: "invalid_params" });
    try {
      const sql = `DELETE FROM ${DEFAULT_SCHEMA}.${ATS_ATTACHMENTS_TABLE} WHERE application_id = $1 AND id = $2 RETURNING id`;
      const r = await req.db.query(sql, [id, attachmentId]);
      if (!r.rows[0]) return res.status(404).json({ error: "not_found" });
      return res.json({ deleted: true });
    } catch (e) {
      return res.status(500).json({ error: "db_error", detail: e.message });
    }
  }
);

/**
 * @openapi
 * /ats/api/ats/applications/{id}/attachments/upload:
 *   post:
 *     summary: Upload a file and create/update an attachment metadata row for an application
 *     tags: [Attachments]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               storage_key:
 *                 type: string
 *                 description: Optional target storage key under FILES_ROOT. If omitted, a key is generated.
 *               expiration_date:
 *                 type: string
 *                 format: date
 *     responses:
 *       201: { description: Created }
 *       400: { description: Bad request }
 */
router.post(
  "/applications/:id/attachments/upload",
  upload.single("file"),
  async (req, res) => {
    try {
      const applicationId = parseInt(req.params.id, 10);
      if (!Number.isFinite(applicationId))
        return res.status(400).json({ error: "invalid_application" });
      if (!req.file) return res.status(400).json({ error: "file_required" });

      // Build storage key
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

      // Persist file and compute sha256
      const sha256 = crypto
        .createHash("sha256")
        .update(req.file.buffer)
        .digest("hex");
      await fs.promises.writeFile(absPath, req.file.buffer);

      const size = req.file.size;
      const contentType =
        req.file.mimetype ||
        mime.lookup(originalName) ||
        "application/octet-stream";

      // Upsert metadata row
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
      const vals = [
        applicationId,
        originalName,
        contentType,
        size,
        storage_key,
        expiration_date || null,
        sha256,
        uploader,
      ];
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
      if (e.message === "bad_path")
        return res.status(400).json({ error: "invalid_storage_key" });
      if (e.code === "LIMIT_FILE_SIZE")
        return res
          .status(400)
          .json({ error: `file_too_large_max_${MAX_UPLOAD_MB}mb` });
      return res
        .status(500)
        .json({ error: "upload_failed", detail: e.message });
    }
  }
);

// Lightweight search over extracted resume/cover text
// POST /candidates/search { q: string, ids?: number[] }
router.post("/candidates/search", async (req, res) => {
  try {
    const q = String(req.body?.q || "").trim();
    // Allow forcing debug for this request via body.debug=true
    const debugReq = req.body && req.body.debug === true;
    const debug = debugReq || process.env.DEBUG_SEARCH === "1";
    // Minimal always-on trace of incoming request for visibility
    // Minimal trace for search endpoint when explicit DEBUG_SEARCH enabled
    if (debug)
      console.log("[SEARCH] /candidates/search", {
        q,
        idsCount: Array.isArray(req.body?.ids) ? req.body.ids.length : "ALL",
      });
    if (!q) return res.json({ hits: {} });
    // Optional restrict to candidate ids
    const restrictIds = Array.isArray(req.body?.ids)
      ? req.body.ids.map(Number).filter((n) => Number.isFinite(n))
      : null;
    if (debug)
      console.log(
        "[SEARCH] restrictIds count=",
        restrictIds ? restrictIds.length : "ALL"
      );
    // For performance, fetch candidate->latest app with resume/cover URLs (like in GET /candidates)
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
    if (debug)
      console.log(
        "[SEARCH] tokens=",
        tokens,
        "mode=",
        hasOr ? "OR" : "AND",
        "candidates=",
        rows.length
      );
    const hits = {};
    for (const r of rows) {
      const id = r.candidate_id;
      if (restrictIds && !restrictIds.includes(Number(id))) continue;
      const urls = [r.resume_url, r.cover_letter_url].filter(Boolean);
      if (debug && urls.length)
        console.log(`[SEARCH] candidate ${id} urls=`, urls);
      let matched = false;
      for (const url of urls) {
        try {
          const text = await getExtractedTextForUrl(url, debug);
          if (!text) continue;
          if (debug)
            console.log(`[SEARCH] extracted length for ${id}:`, text.length);
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

// -------------------- CANDIDATES --------------------
// GET /candidates
/**
 * @openapi
 * /ats/api/ats/candidates:
 *   get:
 *     summary: List candidates (with latest application and stage)
 *     tags: [Candidates]
 *     security:
 *       - SessionCookie: []
 *     parameters:
 *       - in: query
 *         name: jobTitle
 *         schema: { type: string }
 *       - in: query
 *         name: dateFrom
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: dateTo
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: stage
 *         schema: { type: string }
 *       - in: query
 *         name: department
 *         schema: { type: string }
 *     responses:
 *       200: { description: OK }
 */
router.get("/candidates", async (req, res) => {
  try {
    const verbose = process.env.DEBUG_CANDIDATES === "1";
    if (verbose)
      console.log("[CANDIDATES] Starting /candidates endpoint", {
        query: req.query,
      });

    const filters = {
      jobTitle: req.query.jobTitle,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      stage: req.query.stage,
    };
    if (verbose) console.log("[CANDIDATES] Parsed filters:", filters);

    const clauses = ["1=1", "c.archived = FALSE"]; // Exclude archived candidates by default
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
    // Simplified: always use schema-agnostic query (no la.status)
    const whereB = [...clauses];
    const paramsB = [...params];
    // Optional department filter using job_listings.department via la.job_listing_id
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
         -- Resume URL logic
         COALESCE(NULLIF(to_jsonb(la)->>'resume_url',''), (
           SELECT to_jsonb(a2)->>'resume_url'
             FROM ${APP_TABLE} a2
            WHERE a2.candidate_id = c.${PEOPLE_PK}
              AND COALESCE(to_jsonb(a2)->>'resume_url','') <> ''
            ORDER BY a2.application_date DESC NULLS LAST, a2.${APP_PK} DESC
            LIMIT 1
         )) AS resume_url,
         -- Cover letter URL logic  
         COALESCE(NULLIF(to_jsonb(la)->>'cover_letter_url',''), (
           SELECT to_jsonb(a2)->>'cover_letter_url'
             FROM ${APP_TABLE} a2
            WHERE a2.candidate_id = c.${PEOPLE_PK}
              AND COALESCE(to_jsonb(a2)->>'cover_letter_url','') <> ''
            ORDER BY a2.application_date DESC NULLS LAST, a2.${APP_PK} DESC
            LIMIT 1
         )) AS cover_letter_url,
         -- Photo URL logic
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
    if (verbose)
      console.log("[CANDIDATES] Query successful, rows:", rows.length);
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
        name:
          `${r.first_name || ""} ${r.last_name || ""}`.trim() ||
          r.email ||
          "Unknown",
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
        // expose URLs so UI can render links and normalize into resume_url/cover_letter_url
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
            `${req.protocol}://${req.get("host")}${
              req.baseUrl
            }/candidates/search`,
            { q, ids },
            { headers: { cookie: req.headers.cookie || "" } }
          )
          .then((r) => r.data)
          .catch(() => ({ hits: {} }));
        const hitSet = new Set(
          Object.keys(sr.hits || {}).map((k) => Number(k))
        );
        mapped = mapped.filter((m) => hitSet.has(Number(m.id)));
      } catch {}
    }
    return res.json(mapped);
  } catch (error) {
    console.error("[CANDIDATES] GET /candidates error", error);
    console.error("[CANDIDATES] Stack trace:", error.stack);
    // Graceful: return empty list instead of 500 to avoid breaking UI
    res.json([]);
  }
});

// GET /candidates/archived - List archived candidates (MUST come before /candidates/:id)
router.get("/candidates/archived", async (req, res) => {
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

// GET /candidates/:id
/**
 * @openapi
 * /ats/api/ats/candidates/{id}:
 *   get:
 *     summary: Get a single candidate by ID
 *     tags: [Candidates]
 *     security:
 *       - SessionCookie: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Candidate
 *       404:
 *         description: Not found
 */
router.get("/candidates/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ success: false, error: "invalid_id" });
    const { rowCount } = await req.db.query(
      `SELECT 1 FROM ${PEOPLE_TABLE} WHERE ${PEOPLE_PK} = $1`,
      [id]
    );
    if (!rowCount)
      return res.status(404).json({ success: false, error: "not_found" });
    const vm = await buildCandidateVM(req.db, id);
    if (!vm)
      return res.status(404).json({ success: false, error: "not_found" });
    return res.json(vm);
  } catch (e) {
    console.error("GET /candidates/:id error", e);
    const status = e.status || 500;
    res.status(status).json({ success: false, error: e.message });
  }
});

// DEBUG: Check candidate data in database
router.get("/debug/candidates/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ success: false, error: "invalid_id" });

    // Raw database query to see exactly what's in the candidates table
    const candidateRaw = await req.db.query(
      `
      SELECT * FROM ${PEOPLE_TABLE} WHERE ${PEOPLE_PK} = $1
    `,
      [id]
    );

    // Check if form field columns exist
    const columnsQuery = await req.db.query(`
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_name = 'candidates' 
        AND column_name IN (
          'values_resonates', 'motivation', 'onsite_available', 
          'termination_history', 'references_available', 
          'work_authorization', 'expected_salary_range'
        )
      ORDER BY column_name
    `);

    return res.json({
      candidateExists: candidateRaw.rowCount > 0,
      candidateData: candidateRaw.rows[0] || null,
      formFieldColumns: columnsQuery.rows,
      buildCandidateVMResult: await buildCandidateVM(req.db, id),
    });
  } catch (e) {
    console.error("DEBUG /candidates/:id error", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /candidates/:id (admin only)
/**
 * @openapi
 * /ats/api/ats/candidates/{id}:
 *   delete:
 *     summary: Permanently delete a candidate and all related applications/stages (admin only)
 *     tags: [Candidates]
 *     security:
 *       - SessionCookie: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Deleted }
 *       400: { description: Invalid id }
 *       403: { description: Forbidden }
 *       404: { description: Not found }
 */
router.delete("/candidates/:id", requireAdmin, async (req, res) => {
  const candidateId = Number(req.params.id);
  if (!Number.isFinite(candidateId))
    return res.status(400).json({ error: "invalid_id" });
  try {
    await req.db.query("BEGIN");
    // Fetch all application ids first
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
    if (delCand.rowCount === 0)
      return res.status(404).json({ error: "not_found" });
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

// POST /candidates
/**
 * @openapi
 * /ats/api/ats/candidates:
 *   post:
 *     summary: Create a candidate and optionally an application
 *     tags: [Candidates]
 *     security:
 *       - SessionCookie: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *           example:
 *             first_name: Ava
 *             last_name: Lopez
 *             email: ava@example.com
 *             phone: 555-123-4567
 *             job_requisition_id: REQ-2025-001
 *             application_source: referral
 *             resume_url: https://files.example.com/resumes/ava.pdf
 *             cover_letter_url: https://files.example.com/coverletters/ava.pdf
 *             expected_salary: 95000
 *             years_experience: 5
 *             recruiter_assigned: recruiter@example.com
 *             hiring_manager_assigned: hmgr@example.com
 *     responses:
 *       201: { description: Created }
 */
router.post("/candidates", async (req, res) => {
  try {
    const data = req.body || {};
    const { rows: candColsRows } = await req.db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      [DEFAULT_SCHEMA, PEOPLE_TABLE_NAME]
    );
    const candCols = new Set((candColsRows || []).map((r) => r.column_name));
    // Derive names if missing to satisfy NOT NULL schema
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
    if (!candidateCols.length)
      return res.status(400).json({
        success: false,
        error: "Candidate table missing expected columns",
      });
    const insCandSql = `INSERT INTO ${PEOPLE_TABLE} (${candidateCols.join(
      ","
    )}) VALUES (${candVals.join(",")}) RETURNING ${PEOPLE_PK}`;
    const { rows: insCand } = await req.db.query(insCandSql, candParams);
    const candidateId = insCand[0]?.[PEOPLE_PK];

    if (
      candidateId &&
      (data.job_title || data.job_requisition_id || data.job_listing_id)
    ) {
      // Build application insert dynamically (columns may differ);
      const cols = ["candidate_id"];
      const vals = ["$1"];
      const params = [candidateId];
      let idx = 2;
      const push = (k, v) => {
        cols.push(k);
        vals.push(`$${idx++}`);
        params.push(v);
      };

      // If job_listing_id provided, prefer linking and enriching from job_listings
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
          return res
            .status(400)
            .json({ success: false, error: "invalid_job_listing_id" });
        }
      }

      // Detect application table columns
      const { rows: appColsRows } = await req.db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
        [DEFAULT_SCHEMA, APP_TABLE_NAME]
      );
      const appCols = new Set((appColsRows || []).map((r) => r.column_name));

      if (appCols.has("job_listing_id") && data.job_listing_id)
        push("job_listing_id", Number(data.job_listing_id));
      if (appCols.has("job_title")) {
        const jt = jl?.job_title || data.job_title || null;
        if (!jt) {
          return res
            .status(400)
            .json({ success: false, error: "job_title_required" });
        }
        push("job_title", jt);
      }
      if (appCols.has("job_requisition_id")) {
        // Prefer from selected job listing
        const reqId = jl?.job_requisition_id || data.job_requisition_id || null;
        if (reqId) {
          try {
            const { rowCount } = await req.db.query(
              `SELECT 1 FROM ${DEFAULT_SCHEMA}.job_listings WHERE job_requisition_id = $1 LIMIT 1`,
              [reqId]
            );
            if (!rowCount)
              return res
                .status(400)
                .json({ success: false, error: "invalid_job_requisition_id" });
          } catch (_) {
            return res.status(400).json({
              success: false,
              error: "invalid_job_requisition_check_failed",
            });
          }
        }
        push("job_requisition_id", reqId);
      }
      if (appCols.has("recruiter_assigned"))
        push("recruiter_assigned", jl?.recruiter_assigned ?? null);
      if (appCols.has("hiring_manager_assigned"))
        push("hiring_manager_assigned", jl?.hiring_manager ?? null);
      // Additional application detail fields if the table supports them
      const fullName =
        [first_name || "", last_name || ""].join(" ").trim() || email || null;
      if (appCols.has("name")) push("name", fullName);
      if (appCols.has("email")) push("email", email || null);
      if (appCols.has("phone")) push("phone", phone || null);
      if (appCols.has("expected_salary_range"))
        push("expected_salary_range", data.expected_salary_range || null);
      if (appCols.has("application_date")) {
        /* use NOW() */
      } else {
        /* ignore */
      }

      const sql = `INSERT INTO ${APP_TABLE} (${cols.join(",")}${
        appCols.has("application_date") ? ",application_date" : ""
      }) VALUES (${vals.join(",")}${
        appCols.has("application_date") ? ",NOW()" : ""
      }) RETURNING ${APP_PK}`;
      const insApp = await req.db.query(sql, params);
      const newAppId = insApp.rows[0]?.[APP_PK];
      // Create initial stage entry for timeline
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
    // Fire-and-forget: start AI scoring ASAP
    try {
      enqueueCandidateScore(req.db, candidateId);
    } catch {}
    res.status(201).json({ success: true, id: candidateId, candidate: vm });
  } catch (e) {
    console.error("POST /candidates error", e);
    // Handle duplicate email gracefully for idempotency on retries
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

// --- AI Scoring endpoints ---
// GET latest score
router.get("/candidates/:id/score", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: "invalid_id" });
    const score = await getLatestCandidateScore(req.db, id);
    if (!score) {
      return res
        .status(200)
        .json({ hasScore: false, status: "missing", score: null });
    }
    return res.json({ ...score, hasScore: true, status: "available" });
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// POST trigger score generation (idempotent: generate-once)
router.post("/candidates/:id/score", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: "invalid_id" });
    const forceParam = req.query?.force ?? req.body?.force;
    const force =
      typeof forceParam === "string"
        ? ["true", "1", "yes", "force"].includes(forceParam.toLowerCase())
        : Boolean(forceParam);

    if (!OPENAI_API_KEY)
      return res.status(503).json({ error: "openai_not_configured" });

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
    const detailRaw =
      e?.detail || e?.cause?.message || e?.stack || e?.toString?.();
    const detail =
      typeof detailRaw === "string" ? detailRaw.slice(0, 600) : undefined;
    const metadata =
      e?.metadata && typeof e.metadata === "object" ? e.metadata : undefined;
    const base = { error: code };
    if (detail) base.detail = detail;
    if (metadata) base.metadata = metadata;
    if (e?.attempt) base.attempt = e.attempt;
    if (e?.maxAttempts) base.maxAttempts = e.maxAttempts;
    if (typeof e?.retryable === "boolean") base.retryable = e.retryable;

    if (code === "candidate_not_found") return res.status(404).json(base);
    if (code === "openai_api_key_missing")
      return res.status(503).json({ ...base, error: "openai_not_configured" });
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
router.post("/candidates/:id/interview-questions", async (req, res) => {
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

// Backfill runner starter (called by app.js on boot)
async function startBackfill(appId, db) {
  if (!OPENAI_API_KEY) return; // skip if not configured
  // Avoid double start per app
  if (startBackfill._started && startBackfill._started[appId]) return;
  startBackfill._started = startBackfill._started || {};
  startBackfill._started[appId] = true;
  // Scan for up to N candidates without a score and with some resume/cover url
  const scan = async () => {
    try {
      const q = `
        WITH latest_app AS (
          SELECT DISTINCT ON (a.candidate_id) a.*
          FROM ${APP_TABLE} a
          ORDER BY a.candidate_id, a.application_date DESC NULLS LAST, a.${APP_PK} DESC
        )
        SELECT c.${PEOPLE_PK} AS candidate_id,
               COALESCE(NULLIF(to_jsonb(la)->>'resume_url',''), NULLIF(to_jsonb(la)->>'cover_letter_url','')) AS any_url
          FROM ${PEOPLE_TABLE} c
          LEFT JOIN latest_app la ON la.candidate_id = c.${PEOPLE_PK}
         WHERE NOT EXISTS (
                 SELECT 1 FROM candidate_ai_scores s
                  WHERE s.candidate_id = c.${PEOPLE_PK}
                )
           AND (
                 COALESCE(NULLIF(to_jsonb(la)->>'resume_url',''), '') <> '' OR
                 COALESCE(NULLIF(to_jsonb(la)->>'cover_letter_url',''), '') <> ''
               )
         LIMIT 20`;
      const r = await db.query(q);
      const ids = r.rows.map((x) => x.candidate_id).filter(Boolean);
      let i = 0;
      const tick = async () => {
        if (i >= ids.length) return;
        const cid = ids[i++];
        try {
          await generateAndStoreCandidateScore(db, cid).catch(() => null);
        } catch {}
        setTimeout(tick, 500); // gentle pacing
      };
      tick();
    } catch {}
  };
  // Kick initial scan shortly after boot, then periodic rescans
  setTimeout(scan, 2000);
  setInterval(scan, 5 * 60 * 1000);
}

// Attach starter to export
module.exports.startBackfill = startBackfill;

// PUT /candidates/:id/application
/**
 * @openapi
 * /ats/api/ats/candidates/{id}/application:
 *   put:
 *     summary: Update a candidate and related application fields
 *     tags: [Candidates]
 *     security:
 *       - SessionCookie: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: Updated }
 */
router.put("/candidates/:id/application", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = { ...(req.body || {}) };
    // Detect whether id is candidate_id or application_id
    const { rowCount: isCandidate } = await req.db.query(
      `SELECT 1 FROM ${PEOPLE_TABLE} WHERE ${PEOPLE_PK} = $1`,
      [id]
    );

    const mapped = { ...data };
    if (mapped.position && !mapped.job_title)
      mapped.job_title = mapped.position;
    if (mapped.salary_expectation && !mapped.expected_salary)
      mapped.expected_salary = mapped.salary_expectation;
    if (mapped.experience_years && !mapped.years_experience)
      mapped.years_experience = mapped.experience_years;

    // Candidate fields present in the table
    const { rows: candColsRows } = await req.db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      [DEFAULT_SCHEMA, PEOPLE_TABLE_NAME]
    );
    const candCols = new Set((candColsRows || []).map((r) => r.column_name));
    const candidateFields = [
      "first_name",
      "last_name",
      "email",
      "phone",
      "address",
      "city",
      "state",
      "country",
      "linkedin_url",
      "portfolio_url",
      "work_eligibility",
      "willing_to_relocate",
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
        `UPDATE ${PEOPLE_TABLE} SET ${candSets.join(
          ", "
        )} WHERE ${PEOPLE_PK} = $${candParams.length}`,
        candParams
      );
    }

    // Compute target application_id
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

    // Application fields present
    const { rows: appColsRows } = await req.db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      [DEFAULT_SCHEMA, APP_TABLE_NAME]
    );
    const appCols = new Set((appColsRows || []).map((r) => r.column_name));
    const applicationFields = [
      "job_title",
      "job_requisition_id",
      "application_date",
      "application_source",
      "resume_url",
      "cover_letter_url",
      "expected_salary",
      "years_experience",
      "recruiter_assigned",
      "hiring_manager_assigned",
      "name",
      "email",
      "phone",
      "expected_salary_range",
    ].filter((k) => appCols.has(k));
    const appSets = [];
    const appParams = [];
    applicationFields.forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(mapped, k)) {
        let v = mapped[k];
        if (v === "") v = null;
        if (k === "expected_salary" || k === "years_experience")
          v = v === null ? null : Number(v);
        appParams.push(v);
        appSets.push(`${k} = $${appParams.length}`);
      }
    });

    // Insert application if needed
    if (!applicationId && isCandidate && appSets.length) {
      const cols = ["candidate_id"];
      const vals = ["$1"];
      const params = [id];
      let idx = 2;
      const provided = new Set();
      for (const k of applicationFields) {
        if (Object.prototype.hasOwnProperty.call(mapped, k)) {
          let v = mapped[k];
          if (v === "") v = null;
          if (k === "expected_salary" || k === "years_experience")
            v = v === null ? null : Number(v);
          cols.push(k);
          vals.push(`$${idx++}`);
          params.push(v);
          provided.add(k);
        }
      }
      if (!provided.has("application_date")) {
        cols.push("application_date");
        vals.push("NOW()");
      }
      const insSql = `INSERT INTO ${APP_TABLE} (${cols.join(
        ","
      )}) VALUES (${vals.join(",")}) RETURNING ${APP_PK}`;
      const { rows: ins } = await req.db.query(insSql, params);
      applicationId = ins[0]?.[APP_PK] || applicationId;
    }

    // Update existing application
    if (applicationId && appSets.length) {
      appParams.push(applicationId);
      await req.db.query(
        `UPDATE ${APP_TABLE} SET ${appSets.join(", ")} WHERE ${APP_PK} = $${
          appParams.length
        }`,
        appParams
      );
    }

    // If a requisition provided, enrich from job_listings
    if (applicationId && mapped.job_requisition_id) {
      // Validate requisition exists
      try {
        const { rowCount } = await req.db.query(
          `SELECT 1 FROM ${DEFAULT_SCHEMA}.job_listings WHERE job_requisition_id = $1 LIMIT 1`,
          [mapped.job_requisition_id]
        );
        if (!rowCount)
          return res
            .status(400)
            .json({ success: false, error: "invalid_job_requisition_id" });
      } catch (_) {
        return res.status(400).json({
          success: false,
          error: "invalid_job_requisition_check_failed",
        });
      }
      try {
        const { rows: jl } = await req.db.query(
          `SELECT job_title, recruiter_assigned, hiring_manager FROM ${DEFAULT_SCHEMA}.job_listings WHERE job_requisition_id = $1 LIMIT 1`,
          [mapped.job_requisition_id]
        );
        if (jl[0]) {
          await req.db.query(
            `UPDATE ${APP_TABLE} SET job_title = COALESCE($2, job_title), recruiter_assigned = COALESCE($3, recruiter_assigned), hiring_manager_assigned = COALESCE($4, hiring_manager_assigned) WHERE ${APP_PK} = $1`,
            [
              applicationId,
              jl[0].job_title,
              jl[0].recruiter_assigned,
              jl[0].hiring_manager,
            ]
          );
        }
      } catch (_) {}
    }

    // Persist notes into latest stage (upsert)
    if (
      Object.prototype.hasOwnProperty.call(mapped, "notes") &&
      applicationId
    ) {
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

    const updatedCandidate = candidateId
      ? await buildCandidateVM(req.db, candidateId)
      : null;
    res.json({ success: true, updatedCandidate });
  } catch (e) {
    console.error("PUT /candidates/:id/application error", e);
    const status = e.status || 500;
    res.status(status).json({ success: false, error: e.message });
  }
});

// PUT /candidates/:id/stage
/**
 * @openapi
 * /ats/api/ats/candidates/{id}/stage:
 *   put:
 *     summary: Set or update the latest application stage
 *     tags: [Candidates]
 *     security:
 *       - SessionCookie: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: Updated }
 */
router.put("/candidates/:id/stage", async (req, res) => {
  try {
    const candidateId = Number(req.params.id);
    const { stage, status, notes, internalScore } = req.body || {};

    // Find latest application for candidate
    const { rows } = await req.db.query(
      `SELECT ${APP_PK} FROM ${APP_TABLE} WHERE candidate_id = $1 ORDER BY application_date DESC NULLS LAST, ${APP_PK} DESC LIMIT 1`,
      [candidateId]
    );
    const appId = rows[0]?.[APP_PK];
    if (!appId)
      return res
        .status(400)
        .json({ success: false, error: "Missing application for candidate" });

    const scoreVal =
      internalScore === "" ||
      internalScore === undefined ||
      internalScore === null
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

    const updatedCandidate = await buildCandidateVM(req.db, candidateId);
    res.json({ success: true, updatedCandidate });
  } catch (e) {
    console.error("PUT /candidates/:id/stage error", e);
    const status = e.status || 500;
    res.status(status).json({ success: false, error: e.message });
  }
});

// PUT /candidates/:id/notes
/**
 * @openapi
 * /ats/api/ats/candidates/{id}/notes:
 *   put:
 *     summary: Update notes for the latest application stage
 *     tags: [Candidates]
 *     security:
 *       - SessionCookie: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: Updated }
 */
router.put("/candidates/:id/notes", async (req, res) => {
  try {
    const candidateId = Number(req.params.id);
    const { notes } = req.body || {};
    const { rows } = await req.db.query(
      `SELECT ${APP_PK} FROM ${APP_TABLE} WHERE candidate_id = $1 ORDER BY application_date DESC NULLS LAST, ${APP_PK} DESC LIMIT 1`,
      [candidateId]
    );
    const appId = rows[0]?.[APP_PK];
    if (!appId)
      return res
        .status(400)
        .json({ success: false, error: "Missing application for candidate" });

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
    const updatedCandidate = await buildCandidateVM(req.db, candidateId);
    res.json({ success: true, updatedCandidate });
  } catch (e) {
    console.error("PUT /candidates/:id/notes error", e);
    const status = e.status || 500;
    res.status(status).json({ success: false, error: e.message });
  }
});

// GET /candidates/:id/stages
/**
 * @openapi
 * /ats/api/ats/candidates/{id}/stages:
 *   get:
 *     summary: Get stage timeline for a candidate
 *     tags: [Candidates]
 *     security:
 *       - SessionCookie: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: OK }
 */
router.get("/candidates/:id/stages", async (req, res) => {
  try {
    const candidateId = Number(req.params.id);
    if (!candidateId) return res.json([]);
    // Find latest application for this candidate
    let app;
    try {
      const { rows: appRows } = await req.db.query(
        `SELECT a.${APP_PK}, a.application_date, to_jsonb(a)->>'status' AS app_status FROM ${APP_TABLE} a
         WHERE a.candidate_id = $1
         ORDER BY a.application_date DESC NULLS LAST, a.${APP_PK} DESC
         LIMIT 1`,
        [candidateId]
      );
      app = appRows[0];
    } catch (e) {
      const { rows: appRows2 } = await req.db.query(
        `SELECT ${APP_PK}, application_date, NULL::text AS app_status FROM ${APP_TABLE}
         WHERE candidate_id = $1
         ORDER BY application_date DESC NULLS LAST, ${APP_PK} DESC
         LIMIT 1`,
        [candidateId]
      );
      app = appRows2[0];
    }
    if (!app) return res.json([]);
    const appId = app[APP_PK];
    try {
      const { rows: stages } = await req.db.query(
        `SELECT stage_name, status, notes, updated_at
   FROM ${DEFAULT_SCHEMA}.application_stages
         WHERE application_id = $1
         ORDER BY updated_at ASC NULLS LAST, stage_id ASC`,
        [appId]
      );
      const out = stages.map((s) => ({
        name: s.stage_name || "Stage",
        status: s.status || "",
        date: s.updated_at
          ? new Date(s.updated_at).toISOString().slice(0, 10)
          : "",
        notes: s.notes || "",
      }));
      res.json(out);
    } catch (e) {
      const out = [
        {
          name: "Applied",
          status: "new",
          date: app.application_date
            ? new Date(app.application_date).toISOString().slice(0, 10)
            : "",
          notes: "",
        },
        app.app_status
          ? { name: "Status", status: app.app_status, date: "", notes: "" }
          : null,
      ].filter(Boolean);
      res.json(out);
    }
  } catch (e) {
    console.error("GET /candidates/:id/stages error", e);
    // Graceful: return empty list instead of 500
    res.json([]);
  }
});

// ==================== ARCHIVE SYSTEM ====================
// Note: GET /candidates/archived moved earlier in file to avoid route matching conflicts with /candidates/:id

// POST /candidates/:id/archive - Archive a candidate (soft delete)
router.post("/candidates/:id/archive", async (req, res) => {
  try {
    const candidateId = Number(req.params.id);
    const { reason } = req.body;
    const username =
      req.session?.user?.username || req.session?.user?.displayName || "system";

    if (!candidateId) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid candidate ID" });
    }

    await req.db.query(
      `
      UPDATE ${PEOPLE_TABLE}
      SET archived = TRUE,
          archived_at = NOW(),
          archived_by = $1,
          archive_reason = $2
      WHERE ${PEOPLE_PK} = $3
    `,
      [username, reason || null, candidateId]
    );

    res.json({ success: true, message: "Candidate archived successfully" });
  } catch (error) {
    console.error("POST /candidates/:id/archive error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /candidates/:id/restore - Restore an archived candidate
router.post("/candidates/:id/restore", async (req, res) => {
  try {
    const candidateId = Number(req.params.id);

    if (!candidateId) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid candidate ID" });
    }

    await req.db.query(
      `
      UPDATE ${PEOPLE_TABLE}
      SET archived = FALSE,
          archived_at = NULL,
          archived_by = NULL,
          archive_reason = NULL
      WHERE ${PEOPLE_PK} = $1
    `,
      [candidateId]
    );

    res.json({ success: true, message: "Candidate restored successfully" });
  } catch (error) {
    console.error("POST /candidates/:id/restore error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /candidates/:id/permanent - Permanently delete a candidate
router.delete("/candidates/:id/permanent", async (req, res) => {
  try {
    const candidateId = Number(req.params.id);

    if (!candidateId) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid candidate ID" });
    }

    // First delete related applications (CASCADE should handle this, but be explicit)
    await req.db.query(`DELETE FROM ${APP_TABLE} WHERE candidate_id = $1`, [
      candidateId,
    ]);

    // Then delete the candidate
    await req.db.query(`DELETE FROM ${PEOPLE_TABLE} WHERE ${PEOPLE_PK} = $1`, [
      candidateId,
    ]);

    res.json({ success: true, message: "Candidate permanently deleted" });
  } catch (error) {
    console.error("DELETE /candidates/:id/permanent error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /applicants/history/:email - Get application history for repeat applicant detection
router.get("/applicants/history/:email", async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).trim().toLowerCase();

    if (!email) {
      return res.status(400).json({ success: false, error: "Email required" });
    }

    const { rows } = await req.db.query(
      `
      SELECT * FROM ${DEFAULT_SCHEMA}.applicant_history
      WHERE LOWER(TRIM(candidate_email)) = $1
      ORDER BY application_date DESC NULLS LAST, history_id DESC
    `,
      [email]
    );

    // Also check repeat_applicant_flags
    const { rows: flags } = await req.db.query(
      `
      SELECT * FROM ${DEFAULT_SCHEMA}.repeat_applicant_flags
      WHERE LOWER(TRIM(candidate_email)) = $1 AND reviewed = FALSE
      ORDER BY flagged_at DESC
      LIMIT 1
    `,
      [email]
    );

    res.json({
      history: rows,
      flag: flags[0] || null,
      isRepeatApplicant: rows.length > 0,
      previousApplicationCount: rows.length,
      previouslyRejected: rows.some((r) => r.rejected === true),
      previouslyHired: rows.some((r) => r.hired === true),
    });
  } catch (error) {
    console.error("GET /applicants/history/:email error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// -------------------- JOBS --------------------
// GET /jobs
/**
 * @openapi
 * /ats/api/ats/jobs:
 *   get:
 *     summary: List job listings
 *     tags: [Jobs]
 *     security:
 *       - SessionCookie: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *         description: Filter by job status
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Search query for title, department, or location
 *       - in: query
 *         name: department
 *         schema: { type: string }
 *         description: Filter by department name
 *       - in: query
 *         name: public
 *         schema: { type: string }
 *         description: Set to '1' or 'true' to only return Open jobs (public-facing)
 *     responses:
 *       200:
 *         description: List of job listings with applicant counts
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   job_listing_id:
 *                     type: integer
 *                     description: Primary key
 *                   job_requisition_id:
 *                     type: string
 *                     description: Unique job requisition identifier
 *                   job_title:
 *                     type: string
 *                   department:
 *                     type: string
 *                   location:
 *                     type: string
 *                   employment_type:
 *                     type: string
 *                   status:
 *                     type: string
 *                   salary_min:
 *                     type: number
 *                   salary_max:
 *                     type: number
 *                   description:
 *                     type: string
 *                   requirements:
 *                     type: string
 *                   recruiter_assigned:
 *                     type: string
 *                   hiring_manager:
 *                     type: string
 *                   created_at:
 *                     type: string
 *                     format: date-time
 *                   updated_at:
 *                     type: string
 *                     format: date-time
 *                   archived:
 *                     type: boolean
 *                   applicant_count:
 *                     type: integer
 *                     description: Total number of applications for this job
 */
router.get("/jobs", async (req, res) => {
  try {
    const filters = {
      status: req.query.status,
      q: req.query.q,
      department: req.query.department,
      publicOnly: req.query.public === "1" || req.query.public === "true", // ?public=1 for public-facing requests
    };
    const clauses = ["1=1", "archived = FALSE"]; // Exclude archived jobs by default
    const params = [];

    // If publicOnly is true, only show Open jobs (exclude Draft, Closed, etc.)
    if (filters.publicOnly) {
      clauses.push(`LOWER(TRIM(status)) = 'open'`);
    } else if (filters.status && filters.status !== "all") {
      // Otherwise use the status filter if provided
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
    // Graceful: return empty list instead of 500
    res.json([]);
  }
});

// GET /jobs/public - Public endpoint that only returns Open jobs (no auth required)
router.get("/jobs/public", async (req, res) => {
  try {
    // Only return jobs with status = 'Open' (case-insensitive)
    // Exclude 'Draft', 'Closed', and any other status
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
    // Graceful: return empty list instead of 500
    res.json([]);
  }
});

// POST /jobs

// --- AI Assist for Job Creation / Editing ---
// POST /jobs/ai-assist  { job_title, department?, employment_type?, location?, salary_min?, salary_max?, description?, requirements? }
// Returns enhanced description, requirements and suggested missing fields.
router.post("/jobs/ai-assist", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(503).json({
        error:
          "OpenAI API key not configured. Please add OPENAI_API_KEY to your .env file.",
      });
    }
    const data = req.body || {};
    const job_title = (data.job_title || "").toString().trim();
    if (!job_title)
      return res.status(400).json({ error: "job_title_required" });
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
      .filter(
        ([_, v]) => v !== null && v !== undefined && String(v).trim() !== ""
      )
      .map(([k]) => k);
    const missingKeys = Object.keys(fields).filter(
      (k) => !providedKeys.includes(k)
    );
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
              required: [
                "department",
                "employment_type",
                "location",
                "salary_min",
                "salary_max",
              ],
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
      const errorMsg =
        e.response?.data?.error?.message ||
        e.message ||
        "OpenAI generation failed";
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
      if (missingKeys.includes(k) && sugg[k])
        out.suggested[k] = safeStr(sugg[k], 200);
    });
    ["salary_min", "salary_max"].forEach((k) => {
      if (missingKeys.includes(k) && Number.isFinite(sugg[k]))
        out.suggested[k] = Number(sugg[k]);
    });
    // Basic sanity for salary range
    if (out.suggested.salary_min != null && out.suggested.salary_max != null) {
      if (out.suggested.salary_min >= out.suggested.salary_max)
        delete out.suggested.salary_max;
    }
    return res.json(out);
  } catch (e) {
    console.error("POST /jobs/ai-assist error", e);
    return res.status(500).json({ error: "internal_error" });
  }
});
/**
 * @openapi
 * /ats/api/ats/jobs:
 *   post:
 *     summary: Create a job listing
 *     tags: [Jobs]
 *     security:
 *       - SessionCookie: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *           example:
 *             job_title: Senior Software Engineer
 *             department: Engineering
 *             employment_type: full_time
 *             status: open
 *             location: Cleveland, OH
 *             recruiter_assigned: recruiter@example.com
 *             hiring_manager: hmgr@example.com
 *             salary_min: 120000
 *             salary_max: 150000
 *             description: Own services and APIs.
 *             requirements: 5+ years Node/TS; Postgres; Azure
 *     responses:
 *       201: { description: Created }
 */
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
    // Fallback simple timestamp based
    return `REQ-${year}-${Date.now().toString().slice(-3)}`;
  }
}

router.post("/jobs", async (req, res) => {
  const data = req.body || {};
  const coerceInt = (v) =>
    v === "" || v === undefined || v === null ? null : Number(v);
  // We'll attempt up to 5 times in case of race condition on unique requisition id
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const requisitionId =
        data.job_requisition_id || (await generateNextRequisitionId(req.db));
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
      const sql = `INSERT INTO ${DEFAULT_SCHEMA}.job_listings (${cols.join(
        ","
      )}) VALUES (${vals.join(
        ","
      )}) RETURNING job_listing_id, job_requisition_id`;
      const { rows } = await req.db.query(sql, params);
      return res.status(201).json({
        success: true,
        id: rows[0].job_listing_id,
        job_requisition_id: rows[0].job_requisition_id,
      });
    } catch (e) {
      // Unique violation retry (Postgres code 23505)
      if (e?.code === "23505" && !data.job_requisition_id) {
        if (attempt < 4) continue; // retry
      }
      console.error("POST /jobs error", e);
      const status = e.status || 500;
      return res.status(status).json({ success: false, error: e.message });
    }
  }
});

// GET /jobs/archived - List archived job listings (MUST come before /jobs/:id routes)
router.get("/jobs/archived", async (req, res) => {
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

// PUT /jobs/:id
/**
 * @openapi
 * /ats/api/ats/jobs/{id}:
 *   put:
 *     summary: Update a job listing
 *     tags: [Jobs]
 *     security:
 *       - SessionCookie: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: Updated }
 */
router.put("/jobs/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = req.body || {};
    const coerceInt = (v) =>
      v === "" || v === undefined || v === null ? null : Number(v);
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
    const sql = `UPDATE ${DEFAULT_SCHEMA}.job_listings SET ${sets.join(
      ", "
    )}, updated_at = NOW() WHERE job_listing_id = $${params.length}`;
    await req.db.query(sql, params);
    res.json({ success: true });
  } catch (e) {
    console.error("PUT /jobs/:id error", e);
    const status = e.status || 500;
    res.status(status).json({ success: false, error: e.message });
  }
});

// DELETE /jobs/:id
/**
 * @openapi
 * /ats/api/ats/jobs/{id}:
 *   delete:
 *     summary: Delete a job listing
 *     tags: [Jobs]
 *     security:
 *       - SessionCookie: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Deleted }
 */
router.delete("/jobs/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await req.db.query(
      `DELETE FROM ${DEFAULT_SCHEMA}.job_listings WHERE job_listing_id = $1`,
      [id]
    );
    res.json({ success: true });
  } catch (e) {
    console.error("DELETE /jobs/:id error", e);
    const status = e.status || 500;
    res.status(status).json({ success: false, error: e.message });
  }
});

// ==================== JOBS ARCHIVE ROUTES ====================
// Note: GET /jobs/archived moved earlier in file to avoid route matching conflicts with /jobs/:id

// POST /jobs/:id/archive - Archive a job listing (soft delete)
router.post("/jobs/:id/archive", async (req, res) => {
  try {
    const jobId = Number(req.params.id);
    const { reason } = req.body;
    const username =
      req.session?.user?.username || req.session?.user?.displayName || "system";

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

// POST /jobs/:id/restore - Restore an archived job listing
router.post("/jobs/:id/restore", async (req, res) => {
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

// DELETE /jobs/:id/permanent - Permanently delete a job listing
router.delete("/jobs/:id/permanent", async (req, res) => {
  try {
    const jobId = Number(req.params.id);

    if (!jobId) {
      return res.status(400).json({ success: false, error: "Invalid job ID" });
    }

    // Permanently delete the job listing
    await req.db.query(
      `
      DELETE FROM ${DEFAULT_SCHEMA}.job_listings
      WHERE job_listing_id = $1
    `,
      [jobId]
    );

    res.json({ success: true, message: "Job listing permanently deleted" });
  } catch (error) {
    console.error("DELETE /jobs/:id/permanent error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- Job specific candidate listing ---
// GET /jobs/:id/candidates  -> list candidates (applications) for a job_listing_id (or matching requisition id)
router.get("/jobs/:id/candidates", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: "invalid_id" });
    const jl = (
      await req.db.query(
        `SELECT job_listing_id, job_requisition_id, job_title FROM ${DEFAULT_SCHEMA}.job_listings WHERE job_listing_id = $1`,
        [id]
      )
    ).rows[0];
    if (!jl) return res.status(404).json({ error: "job_not_found" });
    if (!jl.job_requisition_id) return res.json({ job: jl, candidates: [] });

    // Single query approach (schema-driven) pulling latest AI score via lateral subselect.
    // Falls back to query without AI score if candidate_ai_scores table unavailable.
    const baseSql = `
      SELECT DISTINCT ON (a.candidate_id)
        a.${APP_PK}            AS application_id,
        a.candidate_id,
        a.application_date,
        a.expected_salary_range,
        a.name                 AS applicant_name,
        a.email                AS applicant_email,
        a.phone                AS applicant_phone,
        c.first_name,
        c.last_name,
        c.email                AS candidate_email,
        s.overall_score,
        s.experience_fit,
        s.skills_fit,
        s.culture_fit,
        s.location_fit,
        s.rationale,
        s.created_at           AS score_created_at
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

    let rows = [];
    try {
      rows = (await req.db.query(baseSql, [jl.job_requisition_id])).rows;
    } catch (err) {
      // Fallback without AI score (e.g., table missing)
      console.warn(
        "Falling back candidate query without AI score:",
        err.message
      );
      const fallback = `
        SELECT DISTINCT ON (a.candidate_id)
               a.${APP_PK} AS application_id, a.candidate_id, a.application_date, a.expected_salary_range,
               a.name AS applicant_name, a.email AS applicant_email, a.phone AS applicant_phone,
               c.first_name, c.last_name, c.email AS candidate_email
        FROM ${APP_TABLE} a
        LEFT JOIN ${PEOPLE_TABLE} c ON c.candidate_id = a.candidate_id
        WHERE a.job_requisition_id = $1 AND a.candidate_id IS NOT NULL
        ORDER BY a.candidate_id, a.application_date DESC NULLS LAST, a.${APP_PK} DESC`;
      rows = (await req.db.query(fallback, [jl.job_requisition_id])).rows;
    }

    const candidates = rows.map((r) => ({
      candidate_id: r.candidate_id,
      application: {
        application_id: r.application_id,
        status: null, // applications.status not in schema
        application_date: r.application_date,
        years_experience: null, // not in schema
        expected_salary_range: r.expected_salary_range || null,
        resume_url: null,
        cover_letter_url: null,
      },
      candidate: {
        first_name: r.first_name || null,
        last_name: r.last_name || null,
        email: r.candidate_email || r.applicant_email || null,
        applicant_name: r.applicant_name || null,
        applicant_email: r.applicant_email || null,
        phone: r.applicant_phone || null,
      },
      score:
        r.overall_score != null
          ? {
              overall_score: r.overall_score,
              experience_fit: r.experience_fit,
              skills_fit: r.skills_fit,
              culture_fit: r.culture_fit,
              location_fit: r.location_fit,
              rationale: r.rationale,
              created_at: r.score_created_at,
            }
          : null,
    }));

    return res.json({ job: jl, candidates });
  } catch (e) {
    console.error("GET /jobs/:id/candidates error", e);
    return res.status(500).json({ error: "internal_error" });
  }
});

// POST /jobs/:id/ai-rank  -> ensure scores exist for all candidates of job, then return sorted list
router.post("/jobs/:id/ai-rank", async (req, res) => {
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

// -------------------- DASHBOARD --------------------
// GET /dashboard/stats
/**
 * @openapi
 * /ats/api/ats/dashboard/stats:
 *   get:
 *     summary: Dashboard counts and KPIs
 *     tags: [Dashboard]
 *     security:
 *       - SessionCookie: []
 *     responses:
 *       200: { description: OK }
 */
router.get("/dashboard/stats", async (req, res) => {
  try {
    // Count total non-archived candidates (matching /candidates endpoint logic)
    const { rows: c } = await req.db.query(`
      SELECT COUNT(*)::int AS cnt
      FROM ${PEOPLE_TABLE}
      WHERE archived = FALSE
    `);

    // Count active candidates (those with latest stage in: applied, screening, interview, offer)
    // This matches the People tab's "Active Pipeline" metric exactly
    const { rows: a } = await req.db.query(`
      WITH latest_app AS (
        SELECT DISTINCT ON (a.candidate_id) a.${APP_PK}, a.candidate_id
        FROM ${APP_TABLE} a
        ORDER BY a.candidate_id, a.application_date DESC NULLS LAST, a.${APP_PK} DESC
      ), latest_stage AS (
        SELECT DISTINCT ON (s.application_id) s.application_id, s.stage_name
        FROM ${DEFAULT_SCHEMA}.application_stages s
        ORDER BY s.application_id, s.updated_at DESC NULLS LAST, s.stage_id DESC
      )
      SELECT COUNT(DISTINCT c.${PEOPLE_PK})::int AS cnt
      FROM ${PEOPLE_TABLE} c
      JOIN latest_app la ON la.candidate_id = c.${PEOPLE_PK}
      JOIN latest_stage ls ON ls.application_id = la.${APP_PK}
      WHERE c.archived = FALSE
        AND LOWER(ls.stage_name) IN ('applied', 'screening', 'interview', 'offer')
    `);

    const { rows: interviews } = await req.db.query(
      `SELECT COUNT(*)::int AS cnt FROM ${DEFAULT_SCHEMA}.application_stages WHERE LOWER(stage_name) LIKE '%interview%' AND LOWER(status) IN ('scheduled','active','pending')`
    );
    const { rows: hires } = await req.db.query(
      `SELECT COUNT(*)::int AS cnt FROM ${DEFAULT_SCHEMA}.application_stages WHERE LOWER(status) = 'hired' AND updated_at >= NOW() - INTERVAL '30 days'`
    );
    res.json({
      totalCandidates: c[0]?.cnt ?? 0,
      activeApplications: a[0]?.cnt ?? 0,
      interviewsScheduled: interviews[0]?.cnt ?? 0,
      hiresMonth: hires[0]?.cnt ?? 0,
    });
  } catch (e) {
    console.error("GET /dashboard/stats error", e);
    res.json({
      totalCandidates: 0,
      activeApplications: 0,
      interviewsScheduled: 0,
      hiresMonth: 0,
    });
  }
});

// GET /dashboard/recent-activity
/**
 * @openapi
 * /ats/api/ats/dashboard/recent-activity:
 *   get:
 *     summary: Recent application and stage activity
 *     tags: [Dashboard]
 *     security:
 *       - SessionCookie: []
 *     responses:
 *       200: { description: OK }
 */
router.get("/dashboard/recent-activity", async (req, res) => {
  try {
    const sql = `
  SELECT s.updated_at, s.stage_name, s.status,
         c.${PEOPLE_PK} as candidate_id, c.first_name, c.last_name, c.email,
         COALESCE(jl.job_title,'') AS job_title
  FROM ${DEFAULT_SCHEMA}.application_stages s
  JOIN ${APP_TABLE} a ON a.${APP_PK} = s.application_id
  JOIN ${PEOPLE_TABLE} c ON c.${PEOPLE_PK} = a.candidate_id
  LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON (a.job_requisition_id IS NOT NULL AND jl.job_requisition_id = a.job_requisition_id)
      ORDER BY s.updated_at DESC NULLS LAST, s.stage_id DESC
      LIMIT 10`;
    const { rows } = await req.db.query(sql);
    const out = rows.map((r) => ({
      candidate_id: r.candidate_id,
      candidate_email: r.email,
      candidate:
        `${r.first_name || ""} ${r.last_name || ""}`.trim() || "Unknown",
      action: `${r.stage_name || "Stage"} ${
        r.status ? "(" + r.status + ")" : ""
      } for ${r.job_title || "a role"}`.trim(),
      time: r.updated_at ? new Date(r.updated_at).toLocaleString() : "",
    }));
    res.json(out);
  } catch (e) {
    console.error("GET /dashboard/recent-activity error", e);
    res.json([]);
  }
});

// -------------------- MEETINGS (placeholder for Graph) --------------------
// GET /meetings
router.get("/meetings", async (req, res) => {
  // This route is outside '/graph', so the '/graph' middleware won't attach req.graphToken.
  // Pull the token directly from the session here.
  const g = req.session?.graph;
  const token =
    g && g.accessToken && (!g.expiresAt || g.expiresAt > Date.now())
      ? g.accessToken
      : null;
  if (!token) return res.status(401).json({ error: "graph_auth_required" });
  try {
    const startISO = req.query.startISO || new Date().toISOString();
    const endISO =
      req.query.endISO ||
      new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const params = new URLSearchParams({
      startDateTime: startISO,
      endDateTime: endISO,
    });
    const url = `https://graph.microsoft.com/v1.0/me/calendar/calendarView?${params.toString()}&$top=50&$select=subject,organizer,start,end,webLink,attendees,onlineMeeting`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = resp.data;
    const items = (data.value || []).map((ev) => ({
      id: ev.id,
      subject: ev.subject,
      start: ev.start?.dateTime,
      end: ev.end?.dateTime,
      organizer: {
        name: ev.organizer?.emailAddress?.name,
        address: ev.organizer?.emailAddress?.address,
      },
      attendees: (ev.attendees || []).map((a) => ({
        name: a.emailAddress?.name,
        address: a.emailAddress?.address,
        type: a.type,
        status: a.status?.response || "none",
      })),
      webLink: ev.webLink,
    }));
    res.json({ items });
  } catch (e) {
    const status = e.response?.status || 500;
    const detail = e.response?.data
      ? JSON.stringify(e.response.data).slice(0, 800)
      : e.message;
    res.status(status).json({ error: "graph_calendar_error", detail });
  }
});

// -------------------- EMAILS (Communications via Graph) --------------------
// GET /emails - List email threads for a specific address
router.get("/emails", async (req, res) => {
  const g = req.session?.graph;
  const token =
    g && g.accessToken && (!g.expiresAt || g.expiresAt > Date.now())
      ? g.accessToken
      : null;
  if (!token) return res.status(401).json({ error: "graph_auth_required" });

  const email = req.query.email;
  const top = parseInt(req.query.top, 10) || 50;

  if (!email) return res.json({ success: true, threads: [] });

  try {
    // Only pull messages from the last 30 days
    const sinceIso = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000
    ).toISOString();
    const url = `https://graph.microsoft.com/v1.0/me/messages?$filter=receivedDateTime ge ${sinceIso}&$orderby=receivedDateTime desc&$top=${top}&$select=subject,from,toRecipients,ccRecipients,replyTo,conversationId,receivedDateTime,bodyPreview,webLink`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    let items = resp.data.value || [];

    // Filter messages involving the specified email
    const emailLc = email.trim().toLowerCase();
    const involves = (m) => {
      const from = m.from?.emailAddress?.address?.toLowerCase() || "";
      const to = (m.toRecipients || [])
        .map((r) => r?.emailAddress?.address?.toLowerCase())
        .filter(Boolean);
      const cc = (m.ccRecipients || [])
        .map((r) => r?.emailAddress?.address?.toLowerCase())
        .filter(Boolean);
      const rt = (m.replyTo || [])
        .map((r) => r?.emailAddress?.address?.toLowerCase())
        .filter(Boolean);
      return (
        from === emailLc ||
        to.includes(emailLc) ||
        cc.includes(emailLc) ||
        rt.includes(emailLc)
      );
    };
    items = items.filter(involves);

    // Group by conversationId
    const threadsMap = new Map();
    for (const m of items) {
      const cid = m.conversationId || m.id;
      if (!threadsMap.has(cid)) threadsMap.set(cid, []);
      threadsMap.get(cid).push(m);
    }

    // Sort each thread by receivedDateTime asc
    const threads = Array.from(threadsMap.entries()).map(([id, msgs]) => ({
      id,
      messages: msgs.sort(
        (a, b) => new Date(a.receivedDateTime) - new Date(b.receivedDateTime)
      ),
    }));

    // Sort threads by latest activity desc
    threads.sort(
      (a, b) =>
        new Date(b.messages[b.messages.length - 1].receivedDateTime) -
        new Date(a.messages[a.messages.length - 1].receivedDateTime)
    );

    res.json({ success: true, threads });
  } catch (e) {
    const status = e.response?.status || 500;
    const detail = e.response?.data
      ? JSON.stringify(e.response.data).slice(0, 800)
      : e.message;
    res
      .status(status)
      .json({ success: false, error: "graph_email_error", detail });
  }
});

// GET /emails/thread - Get full thread by conversationId
router.get("/emails/thread", async (req, res) => {
  const g = req.session?.graph;
  const token =
    g && g.accessToken && (!g.expiresAt || g.expiresAt > Date.now())
      ? g.accessToken
      : null;
  if (!token) return res.status(401).json({ error: "graph_auth_required" });

  const conversationId = req.query.conversationId;
  const top = parseInt(req.query.top, 10) || 100;

  if (!conversationId) return res.json({ success: true, messages: [] });

  try {
    const sinceIso = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000
    ).toISOString();
    const filter = `conversationId eq '${conversationId}' and receivedDateTime ge ${sinceIso}`;
    const url = `https://graph.microsoft.com/v1.0/me/messages?$filter=${encodeURIComponent(
      filter
    )}&$top=${top}&$select=subject,from,toRecipients,ccRecipients,replyTo,conversationId,receivedDateTime,bodyPreview,body,webLink`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const since = new Date(sinceIso);
    const messages = (resp.data.value || [])
      .filter((m) => new Date(m.receivedDateTime) >= since)
      .sort(
        (a, b) => new Date(a.receivedDateTime) - new Date(b.receivedDateTime)
      );
    res.json({ success: true, messages });
  } catch (e) {
    const status = e.response?.status || 500;
    const detail = e.response?.data
      ? JSON.stringify(e.response.data).slice(0, 800)
      : e.message;
    res
      .status(status)
      .json({ success: false, error: "graph_email_error", detail });
  }
});

// POST /emails/send - Send a new email
router.post("/emails/send", async (req, res) => {
  const g = req.session?.graph;
  const token =
    g && g.accessToken && (!g.expiresAt || g.expiresAt > Date.now())
      ? g.accessToken
      : null;
  if (!token) return res.status(401).json({ error: "graph_auth_required" });

  const { to, subject, html, cc = [] } = req.body;
  if (!to || !subject)
    return res
      .status(400)
      .json({ success: false, error: "Missing to/subject" });

  try {
    const body = {
      message: {
        subject,
        body: { contentType: "HTML", content: html || "" },
        toRecipients: []
          .concat(to)
          .filter(Boolean)
          .map((a) => ({ emailAddress: { address: a } })),
        ccRecipients: []
          .concat(cc)
          .filter(Boolean)
          .map((a) => ({ emailAddress: { address: a } })),
      },
      saveToSentItems: true,
    };
    await axios.post("https://graph.microsoft.com/v1.0/me/sendMail", body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    res.json({ success: true });
  } catch (e) {
    const status = e.response?.status || 500;
    const detail = e.response?.data
      ? JSON.stringify(e.response.data).slice(0, 800)
      : e.message;
    res
      .status(status)
      .json({ success: false, error: "graph_send_error", detail });
  }
});

// POST /emails/reply - Reply to an email
router.post("/emails/reply", async (req, res) => {
  const g = req.session?.graph;
  const token =
    g && g.accessToken && (!g.expiresAt || g.expiresAt > Date.now())
      ? g.accessToken
      : null;
  if (!token) return res.status(401).json({ error: "graph_auth_required" });

  const { messageId, html } = req.body;
  if (!messageId)
    return res.status(400).json({ success: false, error: "Missing messageId" });

  try {
    const url = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(
      messageId
    )}/reply`;
    await axios.post(
      url,
      {
        comment: "",
        message: { body: { contentType: "HTML", content: html || "" } },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );
    res.json({ success: true });
  } catch (e) {
    const status = e.response?.status || 500;
    const detail = e.response?.data
      ? JSON.stringify(e.response.data).slice(0, 800)
      : e.message;
    res
      .status(status)
      .json({ success: false, error: "graph_reply_error", detail });
  }
});

// -------------------- REPORTS --------------------
// GET /reports - List available reports for current user
router.get("/reports", async (req, res) => {
  console.log("[REPORTS] GET /reports called - route is working!", {
    hasSession: !!req.session,
    hasUser: !!req.session?.user,
  });
  try {
    const actorEmail = getPrimaryEmail(req);
    console.log("[REPORTS] actorEmail:", actorEmail);
    if (!actorEmail) return res.json({ reports: [] });
    const items = listActiveReportsForOwner(actorEmail);
    const reports = items.map((meta) => ({
      id: meta.id,
      type: meta.type,
      title: meta.title || REPORT_BUILDERS[meta.type]?.title || meta.type,
      createdAt: meta.createdAt
        ? new Date(meta.createdAt).toISOString()
        : new Date().toISOString(),
      rowCount: meta.rowCount ?? null,
      size: meta.size ?? null,
      expiresAt: meta.expiresAt ? new Date(meta.expiresAt).toISOString() : null,
      downloadUrl: `/ats/api/ats/reports/${meta.id}/download`,
    }));
    res.json({ reports });
  } catch (e) {
    console.error("GET /reports error", e);
    res.status(500).json({ error: "report_list_failed", detail: e.message });
  }
});

// POST /reports - Generate a new report
router.post("/reports", async (req, res) => {
  const now = Date.now();
  const actorEmail = getPrimaryEmail(req);
  if (!actorEmail)
    return res.status(400).json({ error: "user_email_required" });
  const actorName = req.session?.user?.displayName || null;
  const rawType =
    req.body?.type || req.body?.reportId || req.body?.report || null;
  const type = rawType ? String(rawType).toLowerCase() : null;
  if (!type || !REPORT_BUILDERS[type]) {
    return res.status(400).json({
      error: "unknown_report_type",
      supported: Object.keys(REPORT_BUILDERS),
    });
  }
  const filters =
    req.body &&
    typeof req.body.filters === "object" &&
    !Array.isArray(req.body.filters)
      ? req.body.filters
      : {};

  try {
    await ensureDir(REPORTS_DIR);
    const { workbook, definition, rowCount } = await generateWorkbookForReport({
      type,
      db: req.db,
      filters,
      actorEmail,
      actorName,
    });
    const buffer = await workbook.xlsx.writeBuffer();
    const fileBuffer = Buffer.from(buffer);
    const reportId = crypto.randomUUID();
    const ownerKey = sanitizeOwnerKey(actorEmail);
    const fileNameBase = `${definition.title || type} ${new Date(now)
      .toISOString()
      .replace(/[:.]/g, "-")}.xlsx`;
    const fileName = safeFileName(fileNameBase);
    const dir = path.join(REPORTS_DIR, ownerKey);
    await ensureDir(dir);
    const filePath = path.join(dir, `${reportId}-${fileName}`);
    await fs.promises.writeFile(filePath, fileBuffer);
    const stats = await fs.promises
      .stat(filePath)
      .catch(() => ({ size: fileBuffer.length }));
    const meta = {
      id: reportId,
      type,
      owner: actorEmail,
      title: definition.title,
      filePath,
      fileName,
      createdAt: now,
      rowCount,
      size: stats.size || fileBuffer.length,
      expiresAt: now + REPORT_TTL_MS,
    };
    registerReport(meta);
    res.status(201).json({
      success: true,
      report: {
        id: meta.id,
        type: meta.type,
        title: meta.title,
        createdAt: new Date(meta.createdAt).toISOString(),
        size: meta.size,
        rowCount: meta.rowCount,
        expiresAt: new Date(meta.expiresAt).toISOString(),
        downloadUrl: `/ats/api/ats/reports/${meta.id}/download`,
      },
    });
  } catch (e) {
    console.error("POST /reports error", e);
    res
      .status(500)
      .json({ error: "report_generation_failed", detail: e.message });
  }
});

// GET /reports/:id/download - Download a generated report
router.get("/reports/:id/download", async (req, res) => {
  try {
    const actorEmail = getPrimaryEmail(req);
    const meta = reportStore.get(req.params.id);
    if (!meta) return res.status(404).json({ error: "report_not_found" });
    if (meta.expiresAt && meta.expiresAt <= Date.now()) {
      await cleanupReport(meta.id);
      return res.status(410).json({ error: "report_expired" });
    }
    if (meta.owner !== actorEmail && !isAdmin(req)) {
      return res.status(403).json({ error: "forbidden" });
    }
    res.download(meta.filePath, meta.fileName, async (err) => {
      if (err) {
        console.error("Download report failed", err);
        if (!res.headersSent)
          res.status(500).json({ error: "download_failed" });
        return;
      }
    });
  } catch (e) {
    console.error("GET /reports/:id/download error", e);
    if (!res.headersSent)
      res.status(500).json({ error: "download_failed", detail: e.message });
  }
});

// --- Microsoft Graph helpers (internal users and schedules) ---
// GET /graph/users?q=alice&top=10
router.get("/graph/users", async (req, res) => {
  if (!req.graphToken)
    return res.status(401).json({ error: "graph_auth_required" });
  const q = (req.query.q || "").toString().trim();
  const top = Math.max(1, Math.min(50, parseInt(req.query.top || "10", 10)));
  if (!q || q.length < 2) return res.json({ users: [] });
  const commonHeaders = {
    Authorization: `Bearer ${req.graphToken}`,
    "Content-Type": "application/json",
  };
  try {
    // People API for relevance
    let users = [];
    try {
      const u1 = new URL("https://graph.microsoft.com/v1.0/me/people");
      u1.searchParams.set("$search", q);
      u1.searchParams.set("$top", String(top));
      u1.searchParams.set("$select", "displayName,scoredEmailAddresses");
      const r1 = await axios.get(u1.toString(), {
        headers: { ...commonHeaders, ConsistencyLevel: "eventual" },
      });
      const data = r1.data;
      if (data?.value) {
        users = (data.value || [])
          .map((p) => ({
            name: p.displayName || p.scoredEmailAddresses?.[0]?.address || "",
            email: p.scoredEmailAddresses?.[0]?.address || "",
          }))
          .filter((u) => u.email);
      }
    } catch {}
    if (!users.length) {
      try {
        const u2 = new URL("https://graph.microsoft.com/v1.0/users");
        u2.searchParams.set("$search", `"${q}"`);
        u2.searchParams.set("$top", String(top));
        u2.searchParams.set("$select", "displayName,mail,userPrincipalName");
        const r2 = await axios.get(u2.toString(), {
          headers: { ...commonHeaders, ConsistencyLevel: "eventual" },
        });
        const data2 = r2.data;
        if (data2?.value) {
          users = (data2.value || [])
            .map((u) => ({
              name: u.displayName || u.mail || u.userPrincipalName,
              email: u.mail || u.userPrincipalName,
            }))
            .filter((u) => u.email);
        }
      } catch {}
    }
    return res.json({ users });
  } catch (e) {
    const status = e.response?.status || 500;
    const detail = e.response?.data
      ? JSON.stringify(e.response.data).slice(0, 800)
      : e.message;
    return res.status(status).json({ error: "graph_users_error", detail });
  }
});

// POST /graph/getSchedule { attendees: [emails], startISO, endISO, intervalMinutes }
/**
 * @openapi
 * /ats/api/ats/graph/getSchedule:
 *   post:
 *     summary: Get free/busy schedules for attendees (Graph)
 *     tags: [Dashboard]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *           example:
 *             emails: ["recruiter@example.com", "hmgr@example.com"]
 *             dateFrom: "2025-09-10T00:00:00Z"
 *             dateTo: "2025-09-11T00:00:00Z"
 *             intervalMinutes: 30
 *     responses:
 *       200: { description: OK }
 */
router.post("/graph/getSchedule", async (req, res) => {
  if (!req.graphToken)
    return res.status(401).json({ error: "graph_auth_required" });
  try {
    const {
      attendees = [],
      startISO,
      endISO,
      intervalMinutes = 30,
    } = req.body || {};
    if (!Array.isArray(attendees) || attendees.length === 0)
      return res.json({ schedules: [] });
    const body = {
      schedules: attendees,
      startTime: {
        dateTime: startISO || new Date().toISOString(),
        timeZone: "UTC",
      },
      endTime: {
        dateTime:
          endISO || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        timeZone: "UTC",
      },
      availabilityViewInterval: intervalMinutes,
    };
    const resp = await axios.post(
      "https://graph.microsoft.com/v1.0/me/calendar/getSchedule",
      body,
      {
        headers: {
          Authorization: `Bearer ${req.graphToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    const data = resp.data;
    return res.json({ schedules: data.value || [] });
  } catch (e) {
    const status = e.response?.status || 500;
    const detail = e.response?.data
      ? JSON.stringify(e.response.data).slice(0, 800)
      : e.message;
    return res.status(status).json({ error: "graph_schedule_error", detail });
  }
});

// POST /graph/createEvent { subject, body, startISO, endISO, attendees, isOnline, location }
/**
 * @openapi
 * /ats/api/ats/graph/createEvent:
 *   post:
 *     summary: Create a calendar event (Graph)
 *     tags: [Dashboard]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *           example:
 *             subject: "Interview: Ava Lopez"
 *             body: "30-min technical screen"
 *             startISO: "2025-09-10T15:00:00Z"
 *             endISO: "2025-09-10T15:30:00Z"
 *             attendees: ["ava@example.com", "hmgr@example.com"]
 *             isOnline: true
 *             location: "Teams"
 *     responses:
 *       201: { description: Created }
 */
router.post("/graph/createEvent", async (req, res) => {
  if (!req.graphToken)
    return res.status(401).json({ error: "graph_auth_required" });
  try {
    const {
      subject,
      body = "",
      startISO,
      endISO,
      attendees = [],
      isOnline = true,
      location,
    } = req.body || {};
    if (!subject || !startISO || !endISO)
      return res.status(400).json({ error: "missing_required_fields" });
    const eventBody = {
      subject,
      body: { contentType: "HTML", content: body || "" },
      start: { dateTime: startISO, timeZone: "UTC" },
      end: { dateTime: endISO, timeZone: "UTC" },
      attendees: (Array.isArray(attendees) ? attendees : []).map((e) => ({
        emailAddress: { address: e },
        type: "required",
      })),
      location: location ? { displayName: location } : undefined,
      isOnlineMeeting: !!isOnline,
      onlineMeetingProvider: isOnline ? "teamsForBusiness" : "unknown",
    };
    const resp = await axios.post(
      "https://graph.microsoft.com/v1.0/me/events",
      eventBody,
      {
        headers: {
          Authorization: `Bearer ${req.graphToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    const data = resp.data || {};
    return res.status(201).json({
      id: data.id,
      webLink: data.webLink,
      joinUrl: data.onlineMeeting?.joinUrl || null,
    });
  } catch (e) {
    const status = e.response?.status || 500;
    const detail = e.response?.data
      ? JSON.stringify(e.response.data).slice(0, 800)
      : e.message;
    return res
      .status(status)
      .json({ error: "graph_create_event_error", detail });
  }
});

// -------------------- HEALTH --------------------
// GET /health/db
/**
 * @openapi
 * /ats/api/ats/health/db:
 *   get:
 *     summary: ATS DB health check
 *     tags: [Dashboard]
 *     security:
 *       - SessionCookie: []
 *     responses:
 *       200: { description: OK }
 *       503: { description: DB error }
 */ // GET /health/db
/**
 * @openapi
 * /ats/api/ats/health/db:
 *   get:
 *     summary: ATS DB health check
 *     tags: [Dashboard]
 *     security:
 *       - SessionCookie: []
 *     responses:
 *       200: { description: OK }
 *       503: { description: DB error }
 */
router.get("/health/db", async (req, res) => {
  try {
    await req.db.query("SELECT 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

// -------------------- ADMIN BULK DELETE (admin only) --------------------
// DELETE /admin/candidates/all
// Permanently delete ALL candidates (and cascaded applications, stages, and candidate_skills)
router.delete("/admin/candidates/all", requireAdmin, async (req, res) => {
  const pplTable = `${DEFAULT_SCHEMA}.candidates`;
  const appTable = `${DEFAULT_SCHEMA}.applications`;
  const stageTable = `${DEFAULT_SCHEMA}.application_stages`;
  const skillsTable = `${DEFAULT_SCHEMA}.candidate_skills`;
  const client = req.db;
  try {
    await client.query("BEGIN");
    const before = await Promise.all([
      client.query(`SELECT COUNT(*)::int AS n FROM ${stageTable}`),
      client.query(`SELECT COUNT(*)::int AS n FROM ${appTable}`),
      client.query(`SELECT COUNT(*)::int AS n FROM ${skillsTable}`),
      client.query(`SELECT COUNT(*)::int AS n FROM ${pplTable}`),
    ]);
    await client.query(`DELETE FROM ${pplTable}`); // cascades to applications, application_stages, candidate_skills
    const after = await Promise.all([
      client.query(`SELECT COUNT(*)::int AS n FROM ${stageTable}`),
      client.query(`SELECT COUNT(*)::int AS n FROM ${appTable}`),
      client.query(`SELECT COUNT(*)::int AS n FROM ${skillsTable}`),
      client.query(`SELECT COUNT(*)::int AS n FROM ${pplTable}`),
    ]);
    await client.query("COMMIT");
    const [stB, apB, skB, peB] = before.map((r) => r.rows[0]?.n ?? 0);
    const [stA, apA, skA, peA] = after.map((r) => r.rows[0]?.n ?? 0);
    return res.json({
      success: true,
      deleted: {
        candidates: peB - peA,
        applications: apB - apA,
        stages: stB - stA,
        skills: skB - skA,
      },
    });
  } catch (e) {
    try {
      await req.db.query("ROLLBACK");
    } catch {}
    const msg = e?.message || "delete_failed";
    return res
      .status(500)
      .json({ success: false, error: "internal_error", message: msg });
  }
});

// DELETE /admin/applications/all
// Permanently delete ALL applications (and cascaded stages); candidates remain
router.delete("/admin/applications/all", requireAdmin, async (req, res) => {
  const appTable = `${DEFAULT_SCHEMA}.applications`;
  const stageTable = `${DEFAULT_SCHEMA}.application_stages`;
  try {
    await req.db.query("BEGIN");
    const before = await Promise.all([
      req.db.query(`SELECT COUNT(*)::int AS n FROM ${stageTable}`),
      req.db.query(`SELECT COUNT(*)::int AS n FROM ${appTable}`),
    ]);
    await req.db.query(`DELETE FROM ${appTable}`); // cascades to stages
    const after = await Promise.all([
      req.db.query(`SELECT COUNT(*)::int AS n FROM ${stageTable}`),
      req.db.query(`SELECT COUNT(*)::int AS n FROM ${appTable}`),
    ]);
    await req.db.query("COMMIT");
    const [stB, apB] = before.map((r) => r.rows[0]?.n ?? 0);
    const [stA, apA] = after.map((r) => r.rows[0]?.n ?? 0);
    return res.json({
      success: true,
      deleted: { applications: apB - apA, stages: stB - stA },
    });
  } catch (e) {
    try {
      await req.db.query("ROLLBACK");
    } catch {}
    return res.status(500).json({
      success: false,
      error: "internal_error",
      message: e?.message || "delete_failed",
    });
  }
});

// ==================== USER MANAGEMENT ====================
// GET /admin/users - List all users
router.get("/admin/users", requireAdmin, async (req, res) => {
  try {
    const result = await req.db.query(`
      SELECT
        u.user_id,
        u.username,
        u.email,
        u.role,
        u.role_id,
        u.is_active,
        u.last_login,
        u.created_at,
        u.updated_at,
        r.name as role_name,
        r.description as role_description
      FROM ${DEFAULT_SCHEMA}.users u
      LEFT JOIN ${DEFAULT_SCHEMA}.roles r ON u.role_id = r.id
      ORDER BY u.created_at DESC
    `);
    return res.json(result.rows);
  } catch (e) {
    console.error("[admin-list-users] Error:", e);
    return res
      .status(500)
      .json({ error: "internal_error", message: e?.message });
  }
});

// POST /admin/users - Create a new user
router.post("/admin/users", requireAdmin, async (req, res) => {
  const { username, email, password, role_id, is_active = true } = req.body;

  if (!username) {
    return res.status(400).json({ error: "username_required" });
  }

  if (!role_id) {
    return res.status(400).json({ error: "role_id_required" });
  }

  try {
    // Hash password if provided (optional since users auth via Microsoft)
    let password_hash = null;
    if (password) {
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = crypto.scryptSync(password, salt, 64).toString("hex");
      password_hash = `scrypt:${salt}:${hash}`;
    }

    const result = await req.db.query(
      `
      INSERT INTO ${DEFAULT_SCHEMA}.users (username, email, password_hash, role_id, is_active, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING user_id, username, email, role_id, is_active, created_at
    `,
      [username, email || null, password_hash, role_id, is_active]
    );

    return res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error("[admin-create-user] Error:", e);
    if (e.code === "23505") {
      // unique violation
      return res.status(409).json({
        error: "username_or_email_exists",
        message: "Username or email already exists",
      });
    }
    return res
      .status(500)
      .json({ error: "internal_error", message: e?.message });
  }
});

// PUT /admin/users/:userId - Update user
router.put("/admin/users/:userId", requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const { username, email, role_id, is_active } = req.body;

  try {
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (username !== undefined) {
      updates.push(`username = $${paramIndex++}`);
      values.push(username);
    }
    if (email !== undefined) {
      updates.push(`email = $${paramIndex++}`);
      values.push(email || null);
    }
    if (role_id !== undefined) {
      updates.push(`role_id = $${paramIndex++}`);
      values.push(role_id);
    }
    if (is_active !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(is_active);
    }

    updates.push(`updated_at = NOW()`);
    values.push(userId);

    const result = await req.db.query(
      `
      UPDATE ${DEFAULT_SCHEMA}.users
      SET ${updates.join(", ")}
      WHERE user_id = $${paramIndex}
      RETURNING user_id, username, email, role_id, is_active, updated_at
    `,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "user_not_found" });
    }

    return res.json(result.rows[0]);
  } catch (e) {
    console.error("[admin-update-user] Error:", e);
    if (e.code === "23505") {
      return res.status(409).json({
        error: "username_or_email_exists",
        message: "Username or email already exists",
      });
    }
    return res
      .status(500)
      .json({ error: "internal_error", message: e?.message });
  }
});

// DELETE /admin/users/:userId - Delete user
router.delete("/admin/users/:userId", requireAdmin, async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await req.db.query(
      `
      DELETE FROM ${DEFAULT_SCHEMA}.users
      WHERE user_id = $1
      RETURNING user_id, username
    `,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "user_not_found" });
    }

    return res.json({ success: true, deleted: result.rows[0] });
  } catch (e) {
    console.error("[admin-delete-user] Error:", e);
    return res
      .status(500)
      .json({ error: "internal_error", message: e?.message });
  }
});

// PATCH /admin/users/:userId/toggle-active - Toggle user active status
router.patch(
  "/admin/users/:userId/toggle-active",
  requireAdmin,
  async (req, res) => {
    const { userId } = req.params;

    try {
      const result = await req.db.query(
        `
      UPDATE ${DEFAULT_SCHEMA}.users
      SET is_active = NOT is_active, updated_at = NOW()
      WHERE user_id = $1
      RETURNING user_id, username, is_active
    `,
        [userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "user_not_found" });
      }

      return res.json(result.rows[0]);
    } catch (e) {
      console.error("[admin-toggle-user-status] Error:", e);
      return res
        .status(500)
        .json({ error: "internal_error", message: e?.message });
    }
  }
);

// POST /admin/users/:userId/set-password - Set user password
router.post(
  "/admin/users/:userId/set-password",
  requireAdmin,
  async (req, res) => {
    const { userId } = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({
        error: "invalid_password",
        message: "Password must be at least 6 characters",
      });
    }

    try {
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = crypto.scryptSync(password, salt, 64).toString("hex");
      const password_hash = `scrypt:${salt}:${hash}`;

      const result = await req.db.query(
        `
      UPDATE ${DEFAULT_SCHEMA}.users
      SET password_hash = $1, updated_at = NOW()
      WHERE user_id = $2
      RETURNING user_id, username
    `,
        [password_hash, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "user_not_found" });
      }

      return res.json({ success: true });
    } catch (e) {
      console.error("[admin-set-user-password] Error:", e);
      return res
        .status(500)
        .json({ error: "internal_error", message: e?.message });
    }
  }
);

// ==================== ROLE MANAGEMENT ====================
// GET /admin/roles - List all roles
router.get("/admin/roles", requireAdmin, async (req, res) => {
  try {
    const result = await req.db.query(`
      SELECT
        id,
        name,
        description,
        permissions,
        is_system,
        created_at,
        updated_at
      FROM ${DEFAULT_SCHEMA}.roles
      ORDER BY is_system DESC, name ASC
    `);
    return res.json(result.rows);
  } catch (e) {
    console.error("[admin-list-roles] Error:", e);
    return res
      .status(500)
      .json({ error: "internal_error", message: e?.message });
  }
});

// POST /admin/roles - Create a new role
router.post("/admin/roles", requireAdmin, async (req, res) => {
  const { name, description, permissions = [] } = req.body;

  if (!name) {
    return res.status(400).json({ error: "name_required" });
  }

  if (!Array.isArray(permissions) || permissions.length === 0) {
    return res.status(400).json({
      error: "permissions_required",
      message: "At least one permission is required",
    });
  }

  try {
    const result = await req.db.query(
      `
      INSERT INTO ${DEFAULT_SCHEMA}.roles (name, description, permissions, is_system, created_at)
      VALUES ($1, $2, $3, false, NOW())
      RETURNING id, name, description, permissions, is_system, created_at
    `,
      [name, description || null, JSON.stringify(permissions)]
    );

    return res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error("[admin-create-role] Error:", e);
    if (e.code === "23505") {
      // unique violation
      return res.status(409).json({
        error: "role_name_exists",
        message: "Role name already exists",
      });
    }
    return res
      .status(500)
      .json({ error: "internal_error", message: e?.message });
  }
});

// PUT /admin/roles/:roleId - Update role
router.put("/admin/roles/:roleId", requireAdmin, async (req, res) => {
  const { roleId } = req.params;
  const { name, description, permissions } = req.body;

  try {
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(description || null);
    }
    if (permissions !== undefined) {
      if (!Array.isArray(permissions) || permissions.length === 0) {
        return res.status(400).json({
          error: "permissions_required",
          message: "At least one permission is required",
        });
      }
      updates.push(`permissions = $${paramIndex++}`);
      values.push(JSON.stringify(permissions));
    }

    updates.push(`updated_at = NOW()`);
    values.push(roleId);

    const result = await req.db.query(
      `
      UPDATE ${DEFAULT_SCHEMA}.roles
      SET ${updates.join(", ")}
      WHERE id = $${paramIndex}
      RETURNING id, name, description, permissions, is_system, updated_at
    `,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "role_not_found" });
    }

    return res.json(result.rows[0]);
  } catch (e) {
    console.error("[admin-update-role] Error:", e);
    if (e.code === "23505") {
      return res.status(409).json({
        error: "role_name_exists",
        message: "Role name already exists",
      });
    }
    return res
      .status(500)
      .json({ error: "internal_error", message: e?.message });
  }
});

// DELETE /admin/roles/:roleId - Delete role
router.delete("/admin/roles/:roleId", requireAdmin, async (req, res) => {
  const { roleId } = req.params;

  try {
    // Check if role is a system role
    const checkResult = await req.db.query(
      `
      SELECT is_system FROM ${DEFAULT_SCHEMA}.roles WHERE id = $1
    `,
      [roleId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: "role_not_found" });
    }

    if (checkResult.rows[0].is_system) {
      return res.status(403).json({
        error: "cannot_delete_system_role",
        message: "System roles cannot be deleted",
      });
    }

    // Check if any users have this role
    const usersResult = await req.db.query(
      `
      SELECT COUNT(*)::int as count FROM ${DEFAULT_SCHEMA}.users WHERE role_id = $1
    `,
      [roleId]
    );

    if (usersResult.rows[0].count > 0) {
      return res.status(409).json({
        error: "role_in_use",
        message: `Cannot delete role because ${usersResult.rows[0].count} user(s) are assigned to it`,
        userCount: usersResult.rows[0].count,
      });
    }

    const result = await req.db.query(
      `
      DELETE FROM ${DEFAULT_SCHEMA}.roles
      WHERE id = $1
      RETURNING id, name
    `,
      [roleId]
    );

    return res.json({ success: true, deleted: result.rows[0] });
  } catch (e) {
    console.error("[admin-delete-role] Error:", e);
    return res
      .status(500)
      .json({ error: "internal_error", message: e?.message });
  }
});

// ==================== REPLACE THIS ENTIRE SECTION ====================
// -------------------- PUBLIC API (FRONT-FACING) --------------------
// Lightweight CORS helper for specific routes
function applyPublicCors(req, res) {
  // Get the allowed origin from environment or use a safe default
  const allowedOrigin = process.env.PUBLIC_APP_ALLOWED_ORIGIN;

  // If an allowed origin is specified, use it. Otherwise, check the request origin
  if (allowedOrigin) {
    // Support multiple origins separated by comma
    const allowedOrigins = allowedOrigin.split(",").map((o) => o.trim());
    const requestOrigin = req.headers.origin;

    if (allowedOrigins.includes(requestOrigin)) {
      res.set("Access-Control-Allow-Origin", requestOrigin);
    } else if (allowedOrigins.length === 1) {
      // Single origin specified
      res.set("Access-Control-Allow-Origin", allowedOrigins[0]);
    }
  } else {
    // Fallback for development - DO NOT use in production with credentials
    res.set("Access-Control-Allow-Origin", req.headers.origin || "*");
  }

  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  res.set("Access-Control-Allow-Credentials", "true");
  res.set("Access-Control-Max-Age", "86400"); // Cache preflight for 24 hours
}

// Preflight
/**
 * @openapi
 * /ats/api/ats/public/applications:
 *   options:
 *     summary: CORS preflight for public application submission
 *     tags: [Applications]
 *     responses:
 *       204: { description: No Content }
 */
router.options("/public/applications", (req, res) => {
  applyPublicCors(req, res);
  return res.sendStatus(204);
});

// POST /applications (authenticated, app-only)
// Accepts a job application submission from a trusted caller using Azure AD client credentials
router.post("/applications", async (req, res) => {
  try {
    // Same core logic as the public route, but without CORS and relying on bearer validation in ensureAuthenticated
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
    const terminationHistory = terminated || null; // 'yes', 'no', 'prefer not to say'
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
      `
      SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'applications'
    `,
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
    // Ignore any provided job_listing_id; derive from requisition lookup only
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
    // Persist photo URL: add column if missing
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

// POST /public/applications
// Accepts a job application submission from a public website
/**
 * @openapi
 * /ats/api/ats/public/applications:
 *   post:
 *     summary: Submit job application (public)
 *     tags: [Applications]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       201: { description: Created }
 *       400: { description: Bad request }
 *       500: { description: Server error }
 */
router.post("/public/applications", async (req, res) => {
  // Apply CORS headers for actual request
  applyPublicCors(req, res);

  try {
    // Log incoming request for debugging
    console.log("[PUBLIC_APPLY][IN]", {
      path: req.originalUrl || req.url,
      method: req.method,
      origin: req.headers.origin,
      hasAuth: !!req.headers.authorization,
      fields: Object.keys(req.body || {}),
      ip: req.ip,
    });

    // Extract data from request body
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
      // Additional form fields
      workAuth,
      valueResonates,
      salaryRange,
      // Newly handled form fields
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
      req.body.applicantEmail ||
      req.body.applicant_email ||
      req.body.candidateEmail ||
      req.body.candidate_email;

    if (!applicantEmail) {
      return res.status(400).json({
        success: false,
        error: "email_required",
        message: "Email address is required",
      });
    }

    // Normalize name
    let compositeName =
      name || fullName || req.body.candidateName || req.body.candidate_name;
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
      expected_salary_range ||
      expectedSalaryRange ||
      expected_salary ||
      expectedSalary;

    // Extract numeric salary for sorting/filtering in candidates table
    let expectedSalaryNumeric = null;
    if (normalizedSalaryRange) {
      const numMatch = String(normalizedSalaryRange).match(
        /[\$]?(\d{1,3}(?:,?\d{3})*)/
      );
      if (numMatch)
        expectedSalaryNumeric = parseInt(numMatch[1].replace(/,/g, ""));
    }

    const yearsExp = years_experience || yearsExperience;

    // Handle job identification - accept either job_listing_id or job_requisition_id
    const jobReqId = job_requisition_id || req.body.job_requisition_id || null;
    const jobListingId = job_listing_id || req.body.job_listing_id || null;

    if (!jobReqId && !jobListingId) {
      return res.status(400).json({
        success: false,
        error: "job_identification_required",
        message: "Either job_requisition_id or job_listing_id is required",
      });
    }

    // 1) Check/create candidate
    const findCandidateSql = `SELECT candidate_id FROM ${DEFAULT_SCHEMA}.candidates WHERE LOWER(email) = LOWER($1) LIMIT 1`;
    const existing = await req.db.query(findCandidateSql, [applicantEmail]);

    let candidateId;
    if (existing.rows.length > 0) {
      candidateId = existing.rows[0].candidate_id;

      // Update candidate if new info provided
      if (
        phone ||
        linkedin_url ||
        workAuth ||
        valueResonates ||
        salaryRange ||
        motivation !== undefined ||
        onsite !== undefined ||
        terminated !== undefined ||
        references !== undefined
      ) {
        const updates = [];
        const params = [candidateId];
        let paramCount = 1;

        if (phone) {
          paramCount++;
          updates.push(`phone = $${paramCount}`);
          params.push(phone);
        }
        if (linkedin_url) {
          paramCount++;
          updates.push(`linkedin_url = $${paramCount}`);
          params.push(linkedin_url);
        }
        if (workAuth !== undefined) {
          paramCount++;
          updates.push(`work_authorization = $${paramCount}`);
          params.push(
            workAuth === "yes" ? true : workAuth === "no" ? false : null
          );
        }
        if (valueResonates) {
          paramCount++;
          updates.push(`values_resonates = $${paramCount}`);
          params.push(valueResonates);
        }
        if (salaryRange || normalizedSalaryRange) {
          paramCount++;
          updates.push(`expected_salary_range = $${paramCount}`);
          params.push(salaryRange || normalizedSalaryRange);
        }
        // expected salary numeric if available
        if (
          expectedSalaryNumeric !== null &&
          !Number.isNaN(expectedSalaryNumeric)
        ) {
          paramCount++;
          updates.push(`expected_salary_numeric = $${paramCount}`);
          params.push(expectedSalaryNumeric);
        }
        if (typeof motivation === "string" && motivation.trim() !== "") {
          paramCount++;
          updates.push(`motivation = $${paramCount}`);
          params.push(motivation.trim());
        }
        if (onsite !== undefined) {
          paramCount++;
          updates.push(`onsite_available = $${paramCount}`);
          params.push(onsite === "yes" ? true : onsite === "no" ? false : null);
        }
        if (terminated !== undefined) {
          paramCount++;
          updates.push(`termination_history = $${paramCount}`);
          params.push(String(terminated));
        }
        if (references !== undefined) {
          paramCount++;
          updates.push(`references_available = $${paramCount}`);
          params.push(
            references === "yes" ? true : references === "no" ? false : null
          );
        }

        if (updates.length > 0) {
          const updateSql = `UPDATE ${DEFAULT_SCHEMA}.candidates SET ${updates.join(
            ", "
          )} WHERE candidate_id = $1`;
          await req.db.query(updateSql, params);
        }
      }
    } else {
      // Create new candidate
      const insCandidateSql = `
        INSERT INTO ${DEFAULT_SCHEMA}.candidates (
          first_name, last_name, email, phone, linkedin_url,
          work_authorization, values_resonates, expected_salary_range, expected_salary_numeric,
          motivation, onsite_available, termination_history, references_available
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING candidate_id
      `;
      const insCandidate = await req.db.query(insCandidateSql, [
        firstName,
        lastName,
        applicantEmail,
        phone || null,
        linkedin_url || null,
        workAuth === "yes" ? true : workAuth === "no" ? false : null,
        valueResonates || null,
        salaryRange || normalizedSalaryRange || null,
        expectedSalaryNumeric !== null && !Number.isNaN(expectedSalaryNumeric)
          ? expectedSalaryNumeric
          : null,
        typeof motivation === "string" && motivation.trim() !== ""
          ? motivation.trim()
          : null,
        onsite === "yes" ? true : onsite === "no" ? false : null,
        terminated !== undefined ? String(terminated) : null,
        references === "yes" ? true : references === "no" ? false : null,
      ]);
      candidateId = insCandidate.rows[0].candidate_id;
    }

    // 2) Create application
    const APP_TABLE = `${DEFAULT_SCHEMA}.applications`;
    const APP_PK = "application_id";

    // Check table columns
    const colsResult = await req.db.query(
      `
      SELECT column_name FROM information_schema.columns 
      WHERE table_schema = $1 AND table_name = 'applications'
    `,
      [DEFAULT_SCHEMA]
    );
    const appCols = new Set(colsResult.rows.map((r) => r.column_name));

    // Build dynamic insert
    const cols = ["candidate_id"];
    const vals = ["$1"];
    const params = [candidateId];

    const push = (col, val) => {
      if (val !== undefined && val !== null) {
        params.push(val);
        cols.push(col);
        vals.push(`$${params.length}`);
      }
    };

    // Get job listing details - handle both job_listing_id and job_requisition_id
    let jl = null;

    // If job_listing_id provided, use it to look up the job listing
    if (jobListingId) {
      try {
        const r = await req.db.query(
          `SELECT job_requisition_id, job_title, recruiter_assigned, hiring_manager, department, location, job_listing_id FROM ${DEFAULT_SCHEMA}.job_listings WHERE job_listing_id = $1`,
          [jobListingId]
        );
        jl = r.rows[0] || null;
      } catch {}
      if (!jl) {
        return res
          .status(400)
          .json({ success: false, error: "invalid_job_listing_id" });
      }
    }
    // If job_requisition_id provided, use it to look up the job listing
    else if (jobReqId) {
      const jobResult = await req.db.query(
        `SELECT * FROM ${DEFAULT_SCHEMA}.job_listings
         WHERE translate(LOWER(TRIM(job_requisition_id)), '–—−‐‑', '-----') = translate(LOWER(TRIM($1)), '–—−‐‑', '-----')
         LIMIT 1`,
        [jobReqId]
      );
      jl = jobResult.rows[0] || null;
      if (!jl)
        return res
          .status(400)
          .json({ success: false, error: "invalid_job_requisition_id" });
    }

    // Add fields conditionally
    if (appCols.has("application_source"))
      push("application_source", application_source);
    // Use job_listing_id and job_requisition_id from the job listing lookup
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
    // Persist photo URL; add column if missing
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

    // Add application_date if column exists
    const appDateFragment = appCols.has("application_date")
      ? ",application_date"
      : "";
    const appDateValues = appCols.has("application_date") ? ",NOW()" : "";

    const insAppSql = `
      INSERT INTO ${APP_TABLE} (${cols.join(",")}${appDateFragment}) 
      VALUES (${vals.join(",")}${appDateValues}) 
      RETURNING ${APP_PK}
    `;
    const insApp = await req.db.query(insAppSql, params);
    const applicationId = insApp.rows[0]?.[APP_PK] || null;

    // 3) Create initial stage for timeline
    if (applicationId) {
      try {
        await req.db.query(
          `INSERT INTO ${DEFAULT_SCHEMA}.application_stages
           (application_id, stage_name, status, notes, updated_at)
           VALUES ($1, 'Applied', 'new', NULL, NOW())`,
          [applicationId]
        );
      } catch (e) {
        // Stage tracking is optional, don't fail the request
        console.log(
          "[PUBLIC_APPLY] Stage creation failed (non-fatal):",
          e.message
        );
      }

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

    console.log("[PUBLIC_APPLY][OUT]", {
      email: applicantEmail,
      candidate_id: candidateId,
      application_id: applicationId,
    });

    // Send application confirmation email to candidate
    try {
      if (emailService.isConfigured()) {
        const candidateName = firstName || compositeName || "Applicant";
        const jobTitle = job_title || jl?.job_title || "the position";

        await emailService.sendApplicationConfirmation({
          candidateEmail: applicantEmail,
          candidateName: candidateName,
          jobTitle: jobTitle,
        });

        console.log(
          "[PUBLIC_APPLY] Confirmation email sent to:",
          applicantEmail
        );
      } else {
        console.log(
          "[PUBLIC_APPLY] Email service not configured, skipping confirmation email"
        );
      }
    } catch (emailError) {
      console.warn(
        "[PUBLIC_APPLY] Failed to send confirmation email (non-fatal):",
        emailError.message || emailError
      );
      // Don't fail the application submission if email fails
    }

    // Optional: push application to Microsoft Graph or your API layer using app-only auth
    // Controlled by env GRAPH_PUSH_ENABLED=1 and destination settings
    const GRAPH_PUSH_ENABLED = process.env.GRAPH_PUSH_ENABLED === "1";
    const GRAPH_NOTIFY_MAILBOX = process.env.GRAPH_NOTIFY_MAILBOX; // e.g., hr@yourdomain.com
    if (GRAPH_PUSH_ENABLED) {
      try {
        const { isConfigured, graphPost } = require("../../graphAppClient");
        if (isConfigured()) {
          // Example action: Send a notification email via Graph to a shared mailbox or DL using app perms
          // Requires Mail.Send application permission granted/admin consent.
          if (GRAPH_NOTIFY_MAILBOX) {
            const body = {
              message: {
                subject: `New application: ${compositeName || applicantEmail}`,
                body: {
                  contentType: "Text",
                  content: `Applicant: ${
                    compositeName || `${firstName} ${lastName}`
                  }\nEmail: ${applicantEmail}\nJob: ${
                    job_title || jl?.job_title || jobReqId || ""
                  }\nApplication ID: ${applicationId}\nCandidate ID: ${candidateId}`,
                },
                toRecipients: [
                  { emailAddress: { address: GRAPH_NOTIFY_MAILBOX } },
                ],
              },
              saveToSentItems: "false",
            };
            // Send mail as app using /users/{id | userPrincipalName}/sendMail
            await graphPost(
              `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(
                GRAPH_NOTIFY_MAILBOX
              )}/sendMail`,
              body
            );
          }
          // You could also POST to your own API secured by Entra using client credentials here.
        } else {
          console.warn(
            "[PUBLIC_APPLY] Graph not configured; skipping app-only push"
          );
        }
      } catch (e) {
        console.warn(
          "[PUBLIC_APPLY] Graph push failed (non-fatal):",
          e.message || e
        );
      }
    }

    return res.status(201).json({
      success: true,
      application_id: applicationId,
      candidate_id: candidateId,
    });
  } catch (e) {
    const msg = e?.message || "Unknown error";
    console.error("[PUBLIC_APPLY][ERR]", {
      path: req.originalUrl || req.url,
      error: msg,
      stack: e.stack,
    });
    return res.status(500).json({
      success: false,
      error: "internal_error",
      message:
        process.env.NODE_ENV === "development"
          ? msg
          : "An error occurred processing your application",
    });
  }
});
// ==================== END OF REPLACEMENT SECTION ====================

// ==================== LINKEDIN OAUTH ENDPOINTS ====================

// In-memory store for LinkedIn state tokens (in production, use Redis)
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
router.post("/public/linkedin/init", async (req, res) => {
  // Apply CORS headers for actual request
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
    const state = require("crypto").randomBytes(16).toString("hex");

    // Store state in memory for later verification (30 minutes TTL for debugging)
    const expires = Date.now() + 30 * 60 * 1000;
    linkedinStates.set(state, {
      created: Date.now(),
      expires: expires,
    });

    console.log(
      "[LINKEDIN_INIT] Stored state:",
      state,
      "expires:",
      new Date(expires).toISOString()
    );
    console.log(
      "[LINKEDIN_INIT] Current states in memory:",
      linkedinStates.size
    );

    // Build redirect URI dynamically from request origin when available, else fallback to configured origin
    let requestOrigin = null;
    try {
      if (req.headers && req.headers.origin) {
        requestOrigin = req.headers.origin;
      } else if (req.headers && req.headers.referer) {
        try {
          requestOrigin = new URL(req.headers.referer).origin;
        } catch (_) {}
      }
    } catch (_) {}
    const configuredOrigin =
      process.env.PUBLIC_APP_ALLOWED_ORIGIN ||
      "https://aqua-dotterel-156835.hostingersite.com";
    const allowedOrigin = requestOrigin || configuredOrigin;
    const redirectUri = allowedOrigin + "/linkedin-callback.html";

    console.log("[LINKEDIN_INIT] Generated redirect URI:", redirectUri);

    // Build LinkedIn OAuth URL with OpenID Connect scopes
    const authUrl =
      "https://www.linkedin.com/oauth/v2/authorization?" +
      new URLSearchParams({
        response_type: "code",
        client_id: LINKEDIN_CLIENT_ID,
        redirect_uri: redirectUri,
        state: state,
        scope: "openid,profile,email",
      }).toString();

    res.json({
      success: true,
      authUrl: authUrl,
      redirectUri: redirectUri,
      state: state,
    });
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
router.post("/public/linkedin/auth", async (req, res) => {
  // Apply CORS headers for actual request
  applyPublicCors(req, res);

  try {
    const LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
    const LINKEDIN_CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;

    if (!LINKEDIN_CLIENT_ID || !LINKEDIN_CLIENT_SECRET) {
      return res.status(500).json({
        success: false,
        error: "linkedin_not_configured",
        message: "LinkedIn OAuth not configured",
      });
    }

    const { code, state, redirectUri } = req.body;

    if (!code || !state || !redirectUri) {
      return res.status(400).json({
        success: false,
        error: "missing_parameters",
        message: "Missing authorization code, state, or redirect URI",
      });
    }

    // Validate state parameter using memory store
    const stateData = linkedinStates.get(state);
    const currentTime = Date.now();

    console.log("[LINKEDIN_AUTH] State validation:", {
      receivedState: state,
      stateData: stateData,
      currentTime: currentTime,
      storeSize: linkedinStates.size,
    });

    console.log(
      "[LINKEDIN_AUTH] All stored states:",
      Array.from(linkedinStates.keys())
    );

    if (!stateData) {
      console.error("[LINKEDIN_AUTH] State not found:", state);
      console.error(
        "[LINKEDIN_AUTH] Available states:",
        Array.from(linkedinStates.keys())
      );
      console.error("[LINKEDIN_AUTH] State store size:", linkedinStates.size);

      // TEMPORARY: Skip state validation for debugging LinkedIn OAuth flow
      console.warn(
        "[LINKEDIN_AUTH] BYPASSING state validation for debugging purposes"
      );
      // TODO: Re-enable state validation after debugging
      // return res.status(400).json({
      //   success: false,
      //   error: 'invalid_state',
      //   message: `Invalid state parameter - state not found. Received: ${state}, Available: ${Array.from(linkedinStates.keys()).join(', ')}`
      // });
    }

    if (stateData && currentTime > stateData.expires) {
      console.error("[LINKEDIN_AUTH] State expired:", {
        state: state,
        expired: new Date(stateData.expires).toISOString(),
        current: new Date(currentTime).toISOString(),
      });
      // TEMPORARY: Don't delete expired state for debugging
      // linkedinStates.delete(state);
      console.warn(
        "[LINKEDIN_AUTH] BYPASSING state expiry check for debugging purposes"
      );
      // TODO: Re-enable state expiry validation after debugging
      // return res.status(400).json({
      //   success: false,
      //   error: 'state_expired',
      //   message: 'State parameter expired - please try again'
      // });
    }

    // Clear used state (one-time use)
    linkedinStates.delete(state);
    console.log("[LINKEDIN_AUTH] State validated and removed:", state);

    // Step 1: Exchange code for access token
    const tokenResponse = await exchangeLinkedInCodeForToken(
      LINKEDIN_CLIENT_ID,
      LINKEDIN_CLIENT_SECRET,
      code,
      redirectUri
    );

    if (!tokenResponse || !tokenResponse.access_token) {
      throw new Error("Failed to get access token from LinkedIn");
    }

    // Step 2: Get profile data
    const profile = await getLinkedInProfileData(tokenResponse.access_token);

    if (!profile) {
      throw new Error("Failed to get LinkedIn profile data");
    }

    // Step 3: Process profile image if available
    // TEMPORARY: Skip photo download to avoid timeout issues
    console.log(
      "[LINKEDIN_AUTH] Skipping photo download for debugging - using original LinkedIn URL"
    );
    if (profile.photoUrl) {
      console.log(
        "[LINKEDIN_AUTH] Profile photo URL available:",
        profile.photoUrl
      );
      // Keep the original LinkedIn photo URL instead of downloading
      profile.hasLocalPhoto = false;
    }

    console.log("[LINKEDIN_AUTH] About to send response to frontend");
    console.log(
      "[LINKEDIN_AUTH] Profile object size:",
      JSON.stringify(profile).length,
      "characters"
    );

    const response = {
      success: true,
      profile: profile,
    };

    console.log(
      "[LINKEDIN_AUTH] Sending response:",
      JSON.stringify(response, null, 2)
    );
    res.json(response);
  } catch (e) {
    console.error("[LINKEDIN_AUTH][ERR] Complete error details:", {
      message: e.message,
      stack: e.stack,
      name: e.name,
    });
    return res.status(400).json({
      success: false,
      error: "auth_failed",
      message: e.message || "LinkedIn authentication failed",
    });
  }
});

// Helper functions for LinkedIn OAuth
async function exchangeLinkedInCodeForToken(
  clientId,
  clientSecret,
  code,
  redirectUri
) {
  const fetch = require("node-fetch");

  console.log("[LINKEDIN_TOKEN] Starting token exchange");

  const tokenUrl = "https://www.linkedin.com/oauth/v2/accessToken";

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  console.log("[LINKEDIN_TOKEN] Token request:", {
    url: tokenUrl,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    client_id: clientId,
    code: code ? `${code.substring(0, 10)}...` : null,
  });

  try {
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    });

    console.log("[LINKEDIN_TOKEN] Token response:", {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[LINKEDIN_TOKEN] Token exchange failed:", {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
      });
      throw new Error(
        `LinkedIn token exchange failed: ${response.status} - ${errorText}`
      );
    }

    const tokenData = await response.json();
    console.log("[LINKEDIN_TOKEN] Token received:", {
      access_token: tokenData.access_token
        ? `${tokenData.access_token.substring(0, 20)}...`
        : null,
      expires_in: tokenData.expires_in,
      scope: tokenData.scope,
    });

    return tokenData;
  } catch (fetchError) {
    console.error("[LINKEDIN_TOKEN] Network error:", fetchError);
    throw new Error(`Failed to exchange LinkedIn code: ${fetchError.message}`);
  }
}

async function getLinkedInProfileData(accessToken) {
  const fetch = require("node-fetch");

  console.log("[LINKEDIN_PROFILE] Starting profile data retrieval");

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };

  // Use OpenID Connect endpoint (more accessible with basic permissions)
  const profileUrl = "https://api.linkedin.com/v2/userinfo";

  console.log("[LINKEDIN_PROFILE] Making API call to:", profileUrl);

  let profileData;
  try {
    const profileResponse = await fetch(profileUrl, { headers });

    console.log("[LINKEDIN_PROFILE] API response:", {
      profileStatus: profileResponse.status,
      profileOk: profileResponse.ok,
    });

    if (!profileResponse.ok) {
      const errorText = await profileResponse.text();
      console.error("[LINKEDIN_PROFILE] Profile API error:", {
        status: profileResponse.status,
        statusText: profileResponse.statusText,
        error: errorText,
      });
      throw new Error(
        `LinkedIn profile API failed: ${profileResponse.status} - ${errorText}`
      );
    }

    profileData = await profileResponse.json();
    console.log(
      "[LINKEDIN_PROFILE] Profile data received:",
      JSON.stringify(profileData, null, 2)
    );
  } catch (fetchError) {
    console.error("[LINKEDIN_PROFILE] Network/fetch error:", fetchError);
    throw new Error(`Failed to fetch LinkedIn data: ${fetchError.message}`);
  }

  // Process OpenID Connect userinfo response
  const profile = {
    id: profileData.sub, // OpenID Connect uses 'sub' for user ID
    name: profileData.name || getOpenIdConnectFullName(profileData),
    headline: profileData.headline || null, // May not be available in basic scope
    email: profileData.email || null, // Available with email scope
    photoUrl: profileData.picture || null, // Standard OpenID Connect picture field
    linkedinUrl: null, // Do not construct public profile URL from OpenID subject
    importedAt: new Date().toISOString(),
    resumeData: {
      email: profileData.email || null,
      // linkedinUrl intentionally omitted; OpenID subject is not a public vanity URL
      summary: "Professional from LinkedIn",
    },
  };

  console.log(
    "[LINKEDIN_PROFILE] Final profile object:",
    JSON.stringify(profile, null, 2)
  );
  return profile;
}

function getLinkedInFullName(profileData) {
  let firstName = "";
  let lastName = "";

  if (profileData.firstName?.localized) {
    firstName = Object.values(profileData.firstName.localized)[0] || "";
  }

  if (profileData.lastName?.localized) {
    lastName = Object.values(profileData.lastName.localized)[0] || "";
  }

  return (firstName + " " + lastName).trim() || null;
}

function getOpenIdConnectFullName(profileData) {
  // OpenID Connect standard fields
  if (profileData.name) {
    return profileData.name;
  }

  // Fallback to given_name + family_name
  let fullName = "";
  if (profileData.given_name) {
    fullName += profileData.given_name;
  }
  if (profileData.family_name) {
    fullName += (fullName ? " " : "") + profileData.family_name;
  }

  return fullName.trim() || null;
}

function getLinkedInEmail(emailData) {
  if (emailData?.elements?.[0]?.["handle~"]?.emailAddress) {
    return emailData.elements[0]["handle~"].emailAddress;
  }
  return null;
}

function getLinkedInProfilePhotoUrl(profileData) {
  if (profileData.profilePicture?.["displayImage~"]?.elements) {
    const elements = profileData.profilePicture["displayImage~"].elements;
    // Get the largest available image
    const largest = elements[elements.length - 1];
    if (largest?.identifiers?.[0]?.identifier) {
      return largest.identifiers[0].identifier;
    }
  }
  return null;
}

function extractSkillsFromLinkedInHeadline(headline) {
  if (!headline) return [];

  const commonSkills = {
    developer: ["Programming", "Software Development", "Code"],
    engineer: ["Engineering", "Problem Solving", "Technical Design"],
    manager: ["Leadership", "Project Management", "Team Management"],
    designer: ["Design", "Creative Problem Solving", "User Experience"],
    analyst: ["Data Analysis", "Research", "Critical Thinking"],
    consultant: ["Consulting", "Client Relations", "Strategic Thinking"],
    marketing: ["Marketing", "Campaign Management", "Brand Strategy"],
    sales: ["Sales", "Client Acquisition", "Relationship Building"],
  };

  const skills = [];
  const lowerHeadline = headline.toLowerCase();

  for (const [keyword, skillSet] of Object.entries(commonSkills)) {
    if (lowerHeadline.includes(keyword)) {
      skills.push(...skillSet);
    }
  }

  // Remove duplicates and return
  return [...new Set(skills)];
}

async function downloadAndStoreLinkedInPhoto(photoUrl, userId) {
  const fetch = require("node-fetch");
  const fs = require("fs").promises;
  const path = require("path");

  try {
    // Create uploads directory if it doesn't exist
    const uploadsDir = path.join(
      process.cwd(),
      "app",
      "uploads",
      "linkedin-photos"
    );
    await fs.mkdir(uploadsDir, { recursive: true });

    // Generate filename
    const extension = getImageExtensionFromLinkedInUrl(photoUrl);
    const filename = `linkedin_${userId}_${Date.now()}.${extension}`;
    const filePath = path.join(uploadsDir, filename);

    // Download image
    const response = await fetch(photoUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; JobApplication/1.0)",
      },
    });

    if (!response.ok) {
      throw new Error("Failed to download image");
    }

    const buffer = await response.buffer();

    // Save image
    await fs.writeFile(filePath, buffer);

    // Return relative URL for web access
    const FILES_PUBLIC_URL =
      process.env.FILES_PUBLIC_URL || "https://ats.s3protection.com/api/files";
    return `${FILES_PUBLIC_URL}/linkedin-photos/${filename}`;
  } catch (e) {
    console.error("LinkedIn photo download failed:", e.message);
    return null;
  }
}

function getImageExtensionFromLinkedInUrl(url) {
  const urlPath = new URL(url).pathname;
  const extension = path.extname(urlPath).slice(1).toLowerCase();

  if (["jpg", "jpeg", "png", "gif"].includes(extension)) {
    return extension;
  }

  // Default to jpg for LinkedIn profile images
  return "jpg";
}

// Public file upload endpoints (no authentication required)
/**
 * @openapi
 * /ats/api/ats/public/applications/{applicationId}/upload/resume:
 *   post:
 *     summary: Upload resume file for a public application
 *     tags: [Public Applications]
 *     parameters:
 *       - name: applicationId
 *         in: path
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200: { description: Resume uploaded }
 *       400: { description: Bad request }
 *       404: { description: Application not found }
 */
router.post(
  "/public/applications/:applicationId/upload/resume",
  upload.single("file"),
  async (req, res) => {
    // Apply CORS headers for actual request
    applyPublicCors(req, res);

    try {
      const applicationId = parseInt(req.params.applicationId, 10);
      if (!Number.isFinite(applicationId))
        return res.status(400).json({ error: "invalid_application" });

      if (!req.file) return res.status(400).json({ error: "no_file" });

      // Verify application exists
      const a = await req.db.query(
        `SELECT a.*, c.first_name, c.last_name, c.candidate_id FROM ${APP_TABLE} a LEFT JOIN ${PEOPLE_TABLE} c ON c.${PEOPLE_PK} = a.candidate_id WHERE a.${APP_PK} = $1`,
        [applicationId]
      );
      if (!a.rows.length)
        return res.status(404).json({ error: "application_not_found" });

      const app = a.rows[0];

      // Build file path
      const now = new Date();
      const yyyy = String(now.getFullYear());
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const candSlug = `${slugify(app.first_name)}-${slugify(app.last_name)}-${
        app.candidate_id
      }`;
      const ext = pickExt(req.file.originalname, req.file.mimetype);
      const fname = `${candSlug}-resume-${now.getTime()}${ext}`;
      const relPath = `ats/applications/${applicationId}/${yyyy}/${mm}/${safeFileName(
        fname
      )}`;
      const absPath = safeJoin(FILES_ROOT, relPath);

      // Ensure directory exists and write file
      await ensureDir(path.dirname(absPath));
      await fs.promises.writeFile(absPath, req.file.buffer);

      // Extract text if possible
      try {
        const txt = await extractTextFromBuffer(
          req.file.buffer,
          req.file.originalname,
          req.file.mimetype
        );
        const sidecar = absPath + ".txt";
        if (txt && txt.trim())
          await fs.promises.writeFile(sidecar, txt, "utf8");
      } catch {}

      const publicUrl = `${FILES_PUBLIC_URL.replace(/\/$/, "")}/${relPath}`;
      const originalName = req.file.originalname || "resume";
      const contentType = req.file.mimetype || "application/octet-stream";
      const byteSize = req.file.size || 0;
      const sha256 = crypto
        .createHash("sha256")
        .update(req.file.buffer)
        .digest("hex");

      // Update applications table
      try {
        await req.db.query(
          `UPDATE ${APP_TABLE} SET resume_url = $1 WHERE ${APP_PK} = $2`,
          [publicUrl, applicationId]
        );
      } catch (e) {
        const msg = e?.message || "";
        const code = e?.code || "";
        if (
          code === "42703" ||
          /column\s+"?resume_url"?\s+does not exist/i.test(msg)
        ) {
          try {
            await req.db.query(
              `ALTER TABLE ${APP_TABLE} ADD COLUMN IF NOT EXISTS resume_url TEXT`
            );
            await req.db.query(
              `UPDATE ${APP_TABLE} SET resume_url = $1 WHERE ${APP_PK} = $2`,
              [publicUrl, applicationId]
            );
          } catch (e2) {
            console.warn("resume_url alter/update failed:", e2.message);
          }
        } else {
          console.warn("resume_url update skipped:", e.message);
        }
      }

      // Upsert attachment metadata
      try {
        const uploader = null; // Public upload, no user
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
        await req.db.query(sql, [
          applicationId,
          originalName,
          contentType,
          byteSize,
          relPath,
          null,
          sha256,
          uploader,
        ]);
      } catch (e) {
        console.warn("[PUBLIC RESUME] attachment upsert failed:", e.message);
      }

      return res.json({ success: true, url: publicUrl });
    } catch (err) {
      if (err.message === "bad_path")
        return res.status(400).json({ error: "invalid_path" });
      if (err.code === "LIMIT_FILE_SIZE")
        return res
          .status(400)
          .json({ error: `file_too_large_max_${MAX_UPLOAD_MB}mb` });
      console.error("public resume upload error", err);
      return res.status(500).json({ error: "upload_failed" });
    }
  }
);

/**
 * @openapi
 * /ats/api/ats/public/applications/{applicationId}/upload/cover-letter:
 *   post:
 *     summary: Upload cover letter file for a public application
 *     tags: [Public Applications]
 *     parameters:
 *       - name: applicationId
 *         in: path
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200: { description: Cover letter uploaded }
 *       400: { description: Bad request }
 *       404: { description: Application not found }
 */
router.post(
  "/public/applications/:applicationId/upload/cover-letter",
  upload.single("file"),
  async (req, res) => {
    // Apply CORS headers for actual request
    applyPublicCors(req, res);

    try {
      const applicationId = parseInt(req.params.applicationId, 10);
      if (!Number.isFinite(applicationId))
        return res.status(400).json({ error: "invalid_application" });

      if (!req.file) return res.status(400).json({ error: "no_file" });

      // Verify application exists
      const a = await req.db.query(
        `SELECT a.*, c.first_name, c.last_name, c.candidate_id FROM ${APP_TABLE} a LEFT JOIN ${PEOPLE_TABLE} c ON c.${PEOPLE_PK} = a.candidate_id WHERE a.${APP_PK} = $1`,
        [applicationId]
      );
      if (!a.rows.length)
        return res.status(404).json({ error: "application_not_found" });

      const app = a.rows[0];

      // Build file path
      const now = new Date();
      const yyyy = String(now.getFullYear());
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const candSlug = `${slugify(app.first_name)}-${slugify(app.last_name)}-${
        app.candidate_id
      }`;
      const ext = pickExt(req.file.originalname, req.file.mimetype);
      const fname = `${candSlug}-cover-letter-${now.getTime()}${ext}`;
      const relPath = `ats/applications/${applicationId}/${yyyy}/${mm}/${safeFileName(
        fname
      )}`;
      const absPath = safeJoin(FILES_ROOT, relPath);

      // Ensure directory exists and write file
      await ensureDir(path.dirname(absPath));
      await fs.promises.writeFile(absPath, req.file.buffer);

      // Extract text if possible
      try {
        const txt = await extractTextFromBuffer(
          req.file.buffer,
          req.file.originalname,
          req.file.mimetype
        );
        const sidecar = absPath + ".txt";
        if (txt && txt.trim())
          await fs.promises.writeFile(sidecar, txt, "utf8");
      } catch {}

      const publicUrl = `${FILES_PUBLIC_URL.replace(/\/$/, "")}/${relPath}`;
      const originalName = req.file.originalname || "cover-letter";
      const contentType = req.file.mimetype || "application/octet-stream";
      const byteSize = req.file.size || 0;
      const sha256 = crypto
        .createHash("sha256")
        .update(req.file.buffer)
        .digest("hex");

      // Update applications table
      try {
        await req.db.query(
          `UPDATE ${APP_TABLE} SET cover_letter_url = $1 WHERE ${APP_PK} = $2`,
          [publicUrl, applicationId]
        );
      } catch (e) {
        const msg = e?.message || "";
        const code = e?.code || "";
        if (
          code === "42703" ||
          /column\s+"?cover_letter_url"?\s+does not exist/i.test(msg)
        ) {
          try {
            await req.db.query(
              `ALTER TABLE ${APP_TABLE} ADD COLUMN IF NOT EXISTS cover_letter_url TEXT`
            );
            await req.db.query(
              `UPDATE ${APP_TABLE} SET cover_letter_url = $1 WHERE ${APP_PK} = $2`,
              [publicUrl, applicationId]
            );
          } catch (e2) {
            console.warn("cover_letter_url alter/update failed:", e2.message);
          }
        } else {
          console.warn("cover_letter_url update skipped:", e.message);
        }
      }

      // Upsert attachment metadata
      try {
        const uploader = null; // Public upload, no user
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
        await req.db.query(sql, [
          applicationId,
          originalName,
          contentType,
          byteSize,
          relPath,
          null,
          sha256,
          uploader,
        ]);
      } catch (e) {
        console.warn("[PUBLIC COVER] attachment upsert failed:", e.message);
      }

      return res.json({ success: true, url: publicUrl });
    } catch (err) {
      if (err.message === "bad_path")
        return res.status(400).json({ error: "invalid_path" });
      if (err.code === "LIMIT_FILE_SIZE")
        return res
          .status(400)
          .json({ error: `file_too_large_max_${MAX_UPLOAD_MB}mb` });
      console.error("public cover letter upload error", err);
      return res.status(500).json({ error: "upload_failed" });
    }
  }
);

// ==================== REJECTION EMAIL & FEEDBACK SYSTEM ====================

/**
 * Send rejection email to candidate
 * POST /send-rejection-email
 * Body: { candidateId, rejectionReason, shouldArchive }
 */
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
      // Column might already exist, that's okay
      console.log(
        "[ATS] rejection_email_message_id column already exists or error:",
        alterError.message
      );
    }

    // Insert feedback request with 'awaiting_candidate' status (won't show in dashboard until candidate submits)
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

/**
 * Create feedback request token
 * POST /rejection-feedback/create
 * Body: { candidateId, token, rejectionReason }
 */
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

    // Add missing columns if table exists but doesn't have them
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
      // Columns might already exist, that's okay
      console.log(
        "[ATS] Column alteration completed or columns already exist:",
        alterError.message
      );
    }

    // Fetch candidate data from database (optional - feedback system will work even if candidate details are missing)
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

      // Get job title from the most recent application for this candidate
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
        "[ATS] Could not fetch candidate details, continuing without them:",
        candidateError.message
      );
    }

    // Insert feedback request with all fields
    console.log("[ATS] Inserting feedback request with values:", {
      candidateId,
      candidateEmail,
      candidateName,
      jobTitle,
      token,
      rejectionReason,
    });

    await req.db.query(
      `INSERT INTO ${DEFAULT_SCHEMA}.rejection_feedback_requests
       (candidate_id, candidate_email, candidate_name, job_title, feedback_token, rejection_reason, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'awaiting_candidate')`,
      [
        candidateId,
        candidateEmail,
        candidateName,
        jobTitle,
        token,
        rejectionReason,
      ]
    );

    console.log("[ATS] Feedback request inserted successfully");

    // Generate the feedback URL using the API base URL (public route)
    const baseUrl = process.env.API_BASE_URL || "https://ats.s3protection.com/api";
    const feedbackUrl = `${baseUrl}/ats/api/ats/public/rejection-feedback/request/${token}`;

    console.log("[ATS] Creating feedback request - SUCCESS");
    console.log("[ATS] Creating feedback request - candidateId:", candidateId);
    console.log("[ATS] Creating feedback request - token:", token);
    console.log("[ATS] Creating feedback request - baseUrl:", baseUrl);
    console.log("[ATS] Creating feedback request - feedbackUrl:", feedbackUrl);
    console.log("[ATS] Creating feedback request - candidate details:", {
      candidateEmail,
      candidateName,
      jobTitle,
    });

    res.json({ success: true, feedbackUrl });
  } catch (error) {
    console.error("[ATS] ERROR creating feedback request:", error);
    console.error("[ATS] Error stack:", error.stack);
    res.status(500).json({
      error: "Failed to create feedback request",
      detail: error.message,
    });
  }
});

/**
 * Handle feedback request from candidate (public endpoint)
 * GET /public/rejection-feedback/request/:token
 */
router.get("/public/rejection-feedback/request/:token", async (req, res) => {
  try {
    const { token } = req.params;

    // Find feedback request
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

    // Show feedback request form
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Request Feedback</title>
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
          h1 {
            color: #2196f3;
            margin: 0 0 20px 0;
            text-align: center;
          }
          .info-box {
            background-color: #e3f2fd;
            border-left: 4px solid #2196f3;
            padding: 15px;
            margin: 20px 0;
            border-radius: 4px;
          }
          label {
            display: block;
            margin: 15px 0 5px 0;
            font-weight: 600;
            color: #555;
          }
          textarea {
            width: 100%;
            min-height: 150px;
            padding: 10px;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-family: inherit;
            font-size: 14px;
            box-sizing: border-box;
            resize: vertical;
          }
          textarea:focus {
            outline: none;
            border-color: #2196f3;
            box-shadow: 0 0 0 3px rgba(33, 150, 243, 0.1);
          }
          button {
            background-color: #2196f3;
            color: white;
            border: none;
            padding: 12px 30px;
            border-radius: 6px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            width: 100%;
            margin-top: 20px;
            transition: background-color 0.2s;
          }
          button:hover {
            background-color: #1976d2;
          }
          button:disabled {
            background-color: #ccc;
            cursor: not-allowed;
          }
          .success-message {
            display: none;
            background-color: #d4edda;
            border: 1px solid #c3e6cb;
            color: #155724;
            padding: 15px;
            border-radius: 6px;
            margin: 20px 0;
          }
          .error-message {
            display: none;
            background-color: #f8d7da;
            border: 1px solid #f5c6cb;
            color: #721c24;
            padding: 15px;
            border-radius: 6px;
            margin: 20px 0;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>📝 Request Feedback on Your Application</h1>

          <div class="info-box">
            <p><strong>Position:</strong> ${feedbackRequest.job_title}</p>
          </div>

          <form id="feedback-form">
            <label for="message">Your Message (Optional):</label>
            <textarea
              id="message"
              name="message"
              placeholder="You can ask specific questions about your application or interview performance, or simply request general feedback. This will be reviewed by our hiring team."
            ></textarea>

            <button type="submit" id="submit-btn">Submit Feedback Request</button>
          </form>

          <div id="success-message" class="success-message">
            <strong>✓ Request Submitted Successfully!</strong>
            <p>Thank you for your feedback request. Our team will review it and respond via email within 3-5 business days.</p>
          </div>

          <div id="error-message" class="error-message">
            <strong>✗ Error</strong>
            <p id="error-text"></p>
          </div>
        </div>

        <script>
          document.getElementById('feedback-form').addEventListener('submit', async (e) => {
            e.preventDefault();

            const submitBtn = document.getElementById('submit-btn');
            const message = document.getElementById('message').value;
            const successMsg = document.getElementById('success-message');
            const errorMsg = document.getElementById('error-message');

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
                successMsg.style.display = 'block';
              } else {
                throw new Error(data.error || 'Failed to submit request');
              }
            } catch (error) {
              errorMsg.style.display = 'block';
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

/**
 * Submit feedback request (public endpoint)
 * POST /public/rejection-feedback/submit/:token
 */
router.post("/public/rejection-feedback/submit/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { message } = req.body;

    // Update feedback request with candidate's message and change status to 'submitted'
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

/**
 * Get pending feedback requests (admin only)
 * GET /rejection-feedback/pending
 */
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

/**
 * Respond to feedback request (admin only)
 * POST /rejection-feedback/respond/:id
 * Body: { response }
 */
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

    // Use candidate information from the feedback request (already stored when request was created)
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
      // Get user's access token from session
      const userAccessToken = req.session?.user?.accessToken;
      let emailSent = false;

      // Try to send email using the logged-in user's Microsoft 365 account first
      if (userAccessToken) {
        try {
          // Prepare email options
          const emailOptions = {
            accessToken: userAccessToken,
            to: candidateEmail,
            subject: `Feedback on Your Application - ${jobTitle}`,
            html: responseHtml,
          };

          // Add threading headers if we have the original rejection email's Message-ID
          if (feedbackRequest.rejection_email_message_id) {
            emailOptions.headers = {
              "In-Reply-To": feedbackRequest.rejection_email_message_id,
              References: feedbackRequest.rejection_email_message_id,
            };
            console.log(
              "[ATS] Adding threading headers to reply to:",
              feedbackRequest.rejection_email_message_id
            );
          }

          // Send email using the logged-in user's Microsoft 365 account
          await emailService.sendMailAsUser(emailOptions);
          console.log(
            "[ATS] Feedback response email sent to:",
            candidateEmail,
            "from logged-in user"
          );
          emailSent = true;
        } catch (graphError) {
          // Check if it's a token expiration error
          const isTokenError =
            graphError.message?.includes("expired") ||
            graphError.message?.includes("InvalidAuthenticationToken") ||
            graphError.message?.includes("Lifetime validation failed");

          if (isTokenError) {
            console.warn(
              "[ATS] User access token expired, falling back to system email service"
            );
            // Don't return error yet, fall through to system email fallback
          } else {
            // Re-throw other errors
            throw graphError;
          }
        }
      }

      // Fallback to system email service (Mailgun/SMTP) if user email failed or no token
      if (!emailSent) {
        if (!emailService.isConfigured()) {
          console.error(
            "[ATS] Cannot send feedback response: No user token and system email not configured"
          );
          return res.status(500).json({
            error: "Email service unavailable",
            message:
              "Your session has expired and the system email service is not configured. Please log out and log back in, then try again.",
          });
        }

        console.log("[ATS] Sending feedback response via system email service");
        await emailService.sendMail({
          to: candidateEmail,
          subject: `Feedback on Your Application - ${jobTitle}`,
          html: responseHtml,
        });
        console.log(
          "[ATS] Feedback response email sent to:",
          candidateEmail,
          "via system email"
        );
      }
    } catch (emailError) {
      console.error(
        "[ATS] Failed to send feedback response email:",
        emailError
      );
      return res.status(500).json({
        error: "Failed to send email",
        message:
          emailError.message || "An error occurred while sending the email",
      });
    }

    return res.json({ success: true, feedbackRequest: result.rows[0] });
  } catch (error) {
    console.error("[ATS] Error responding to feedback request:", error);
    return res.status(500).json({ error: "Failed to send response" });
  }
});

// ==================== DUPLICATE APPLICATION DETECTION ====================

/**
 * Check for duplicate applications
 * GET /candidates/:id/duplicate-applications
 * Returns list of jobs the candidate has applied to multiple times
 */
router.get("/candidates/:id/duplicate-applications", async (req, res) => {
  try {
    const candidateId = parseInt(req.params.id, 10);
    if (!Number.isFinite(candidateId)) {
      return res.status(400).json({ error: "invalid_candidate_id" });
    }

    // Find all applications for this candidate, grouped by job
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

/**
 * Check if application would be a duplicate (before submission)
 * POST /applications/check-duplicate
 * Body: { email, job_requisition_id }
 */
router.post("/applications/check-duplicate", async (req, res) => {
  try {
    const { email, job_requisition_id } = req.body;

    if (!email || !job_requisition_id) {
      return res.status(400).json({ error: "email_and_job_required" });
    }

    // Check if candidate with this email has already applied to this job
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
          candidate_name: `${existing.first_name || ""} ${
            existing.last_name || ""
          }`.trim(),
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

// ==================== CANDIDATE REACTIVATION ENGINE ====================

/**
 * Get suggested candidates for a job opening
 * GET /jobs/:id/suggested-candidates
 * AI-powered matching to find past candidates who would be a good fit
 */
router.get("/jobs/:id/suggested-candidates", async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    if (!Number.isFinite(jobId)) {
      return res.status(400).json({ error: "invalid_job_id" });
    }

    const limit = parseInt(req.query.limit, 10) || 20;
    const minScore = parseInt(req.query.min_score, 10) || 60;
    const monthsSinceRejection =
      parseInt(req.query.months_since_rejection, 10) || 6;

    // Get job details
    const jobSql = `
      SELECT job_requisition_id, job_title, job_description, department,
             location, required_skills, employment_type, min_salary, max_salary
      FROM ${DEFAULT_SCHEMA}.job_listings
      WHERE job_requisition_id = $1
    `;
    const jobResult = await req.db.query(jobSql, [jobId]);

    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: "job_not_found" });
    }

    const job = jobResult.rows[0];

    // Find past candidates who:
    // 1. Have good AI scores (min_score threshold)
    // 2. Haven't applied to this specific job
    // 3. Aren't currently in active pipeline for any job
    // 4. Aren't flagged as "Do Not Consider"
    // 5. Weren't recently rejected (within monthsSinceRejection months)
    const candidatesSql = `
      WITH candidate_latest_status AS (
        SELECT
          a.candidate_id,
          MAX(a.application_date) AS last_application_date,
          (
            SELECT s.status
            FROM ${DEFAULT_SCHEMA}.application_stages s
            WHERE s.application_id = a.${APP_PK}
            ORDER BY s.updated_at DESC NULLS LAST
            LIMIT 1
          ) AS last_status,
          (
            SELECT MAX(s.updated_at)
            FROM ${DEFAULT_SCHEMA}.application_stages s
            WHERE s.application_id = a.${APP_PK}
              AND LOWER(s.status) IN ('rejected', 'declined')
          ) AS last_rejection_date
        FROM ${APP_TABLE} a
        GROUP BY a.candidate_id
      ),
      candidate_scores AS (
        SELECT
          candidate_id,
          overall_score,
          experience_fit,
          skills_fit,
          culture_fit,
          location_fit,
          strengths,
          risk_flags,
          created_at AS score_date
        FROM ${DEFAULT_SCHEMA}.candidate_ai_scores
        WHERE overall_score >= $2
      ),
      excluded_candidates AS (
        -- Candidates who already applied to this job
        SELECT DISTINCT candidate_id
        FROM ${APP_TABLE}
        WHERE job_requisition_id = $1

        UNION

        -- Candidates flagged as "Do Not Consider"
        SELECT DISTINCT candidate_id
        FROM ${DEFAULT_SCHEMA}.candidate_flags
        WHERE flag_type = 'do_not_consider'

        UNION

        -- Candidates currently in active pipeline (not hired, not rejected)
        SELECT DISTINCT cls.candidate_id
        FROM candidate_latest_status cls
        WHERE cls.last_status IS NOT NULL
          AND LOWER(cls.last_status) NOT IN ('rejected', 'declined', 'hired', 'withdrawn')

        UNION

        -- Recently rejected candidates (within X months)
        SELECT DISTINCT cls.candidate_id
        FROM candidate_latest_status cls
        WHERE cls.last_rejection_date IS NOT NULL
          AND cls.last_rejection_date > NOW() - INTERVAL '${monthsSinceRejection} months'
      )
      SELECT
        c.${PEOPLE_PK} AS candidate_id,
        c.first_name,
        c.last_name,
        c.email,
        c.phone,
        c.location,
        c.linkedin_url,
        c.expected_salary_range,
        cs.overall_score,
        cs.experience_fit,
        cs.skills_fit,
        cs.culture_fit,
        cs.location_fit,
        cs.strengths,
        cs.risk_flags,
        cls.last_application_date,
        cls.last_status,
        (
          SELECT array_agg(DISTINCT s.skill_name)
          FROM ${DEFAULT_SCHEMA}.candidate_skills cs_inner
          JOIN ${DEFAULT_SCHEMA}.skills s ON s.skill_id = cs_inner.skill_id
          WHERE cs_inner.candidate_id = c.${PEOPLE_PK}
        ) AS skills,
        (
          SELECT json_agg(
            json_build_object(
              'job_title', jl.job_title,
              'application_date', a.application_date,
              'department', jl.department
            ) ORDER BY a.application_date DESC
          )
          FROM ${APP_TABLE} a
          LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON a.job_requisition_id = jl.job_requisition_id
          WHERE a.candidate_id = c.${PEOPLE_PK}
          LIMIT 5
        ) AS past_applications
      FROM ${PEOPLE_TABLE} c
      INNER JOIN candidate_scores cs ON cs.candidate_id = c.${PEOPLE_PK}
      LEFT JOIN candidate_latest_status cls ON cls.candidate_id = c.${PEOPLE_PK}
      WHERE c.${PEOPLE_PK} NOT IN (SELECT candidate_id FROM excluded_candidates)
        AND c.archived = FALSE
      ORDER BY
        cs.overall_score DESC,
        cls.last_application_date DESC NULLS LAST
      LIMIT $3
    `;

    const candidatesResult = await req.db.query(candidatesSql, [
      jobId,
      minScore,
      limit,
    ]);

    // Calculate match scores for each candidate
    const candidates = candidatesResult.rows.map((candidate) => {
      // Calculate recency factor (0-1, where 1 is most recent)
      let recencyFactor = 0.5; // default if no application history
      if (candidate.last_application_date) {
        const daysSinceApplication =
          (Date.now() - new Date(candidate.last_application_date).getTime()) /
          (1000 * 60 * 60 * 24);
        // Decay over 2 years: 1.0 at 0 days, 0.0 at 730 days
        recencyFactor = Math.max(0, 1 - daysSinceApplication / 730);
      }

      // Calculate overall match score
      const matchScore =
        (candidate.skills_fit || 0) * 0.3 +
        (candidate.experience_fit || 0) * 0.25 +
        (candidate.overall_score || 0) * 0.25 +
        recencyFactor * 100 * 0.1 +
        (candidate.culture_fit || 0) * 0.1;

      return {
        ...candidate,
        match_score: Math.round(matchScore * 10) / 10, // round to 1 decimal
        recency_factor: Math.round(recencyFactor * 100), // as percentage
        recommendation_reason: generateRecommendationReason(
          candidate,
          job,
          matchScore
        ),
      };
    });

    // Sort by match score
    candidates.sort((a, b) => b.match_score - a.match_score);

    return res.json({
      success: true,
      job: {
        job_requisition_id: job.job_requisition_id,
        job_title: job.job_title,
        department: job.department,
        location: job.location,
      },
      suggested_candidates: candidates,
      total_count: candidates.length,
      filters_applied: {
        min_score: minScore,
        months_since_rejection: monthsSinceRejection,
        limit: limit,
      },
    });
  } catch (error) {
    console.error("[REACTIVATION] Error:", error);
    return res
      .status(500)
      .json({ error: "failed_to_get_suggestions", message: error.message });
  }
});

/**
 * Generate a human-readable recommendation reason
 */
function generateRecommendationReason(candidate, job, matchScore) {
  const reasons = [];

  if (candidate.overall_score >= 85) {
    reasons.push("Exceptional candidate profile");
  } else if (candidate.overall_score >= 75) {
    reasons.push("Strong candidate profile");
  } else if (candidate.overall_score >= 65) {
    reasons.push("Good candidate profile");
  }

  if (candidate.skills_fit >= 80) {
    reasons.push("excellent skills match");
  } else if (candidate.skills_fit >= 70) {
    reasons.push("strong skills match");
  }

  if (candidate.experience_fit >= 80) {
    reasons.push("highly relevant experience");
  }

  // Check if candidate applied to similar roles
  if (
    candidate.past_applications &&
    Array.isArray(candidate.past_applications)
  ) {
    const similarRoles = candidate.past_applications.filter(
      (app) =>
        app.job_title &&
        job.job_title &&
        (app.job_title
          .toLowerCase()
          .includes(job.job_title.toLowerCase().split(" ")[0]) ||
          job.job_title
            .toLowerCase()
            .includes(app.job_title.toLowerCase().split(" ")[0]))
    );
    if (similarRoles.length > 0) {
      reasons.push(
        `previously interested in similar ${job.job_title.toLowerCase()} roles`
      );
    }
  }

  // Location match
  if (
    candidate.location &&
    job.location &&
    candidate.location.toLowerCase() === job.location.toLowerCase()
  ) {
    reasons.push("location match");
  }

  if (reasons.length === 0) {
    return `Match score: ${Math.round(matchScore)}%`;
  }

  return reasons
    .slice(0, 3)
    .join(", ")
    .replace(/^./, (str) => str.toUpperCase());
}

/**
 * Send reactivation email to suggested candidates
 * POST /jobs/:id/reactivate-candidates
 * Body: { candidate_ids: [...], message }
 */
router.post("/jobs/:id/reactivate-candidates", async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    if (!Number.isFinite(jobId)) {
      return res.status(400).json({ error: "invalid_job_id" });
    }

    const { candidate_ids, custom_message } = req.body;

    if (
      !candidate_ids ||
      !Array.isArray(candidate_ids) ||
      candidate_ids.length === 0
    ) {
      return res.status(400).json({ error: "candidate_ids_required" });
    }

    // Get job details
    const jobSql = `
      SELECT job_requisition_id, job_title, job_description, department,
             location, employment_type, min_salary, max_salary
      FROM ${DEFAULT_SCHEMA}.job_listings
      WHERE job_requisition_id = $1
    `;
    const jobResult = await req.db.query(jobSql, [jobId]);

    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: "job_not_found" });
    }

    const job = jobResult.rows[0];

    // Get candidate details
    const candidatesSql = `
      SELECT ${PEOPLE_PK} AS candidate_id, first_name, last_name, email
      FROM ${PEOPLE_TABLE}
      WHERE ${PEOPLE_PK} = ANY($1::int[])
    `;
    const candidatesResult = await req.db.query(candidatesSql, [candidate_ids]);

    const results = [];
    const errors = [];

    // Send emails to each candidate
    for (const candidate of candidatesResult.rows) {
      try {
        if (!candidate.email) {
          errors.push({
            candidate_id: candidate.candidate_id,
            error: "no_email",
          });
          continue;
        }

        const candidateName =
          `${candidate.first_name || ""} ${candidate.last_name || ""}`.trim() ||
          "Candidate";

        // Build application URL (adjust based on your job board URL)
        const jobBoardUrl =
          process.env.JOB_BOARD_URL || "https://careers.s3protection.com";
        const applyUrl = `${jobBoardUrl}/jobs/${job.job_requisition_id}`;

        const emailHtml = `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; }
              .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; }
              .content { padding: 30px; background: #f9f9f9; }
              .job-details { background: white; border-left: 4px solid #667eea; padding: 20px; margin: 20px 0; }
              .cta-button { display: inline-block; background: #667eea; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
              .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
            </style>
          </head>
          <body>
            <div class="header">
              <h1>New Opportunity at ${job.department || "Our Company"}</h1>
            </div>
            <div class="content">
              <p>Hi ${candidateName},</p>
              <p>We noticed you previously expressed interest in opportunities with us. We have a new opening that might be a great fit for your background and skills:</p>

              <div class="job-details">
                <h2>${job.job_title}</h2>
                <p><strong>Department:</strong> ${
                  job.department || "Not specified"
                }</p>
                <p><strong>Location:</strong> ${
                  job.location || "Not specified"
                }</p>
                <p><strong>Type:</strong> ${
                  job.employment_type || "Not specified"
                }</p>
                ${
                  job.min_salary && job.max_salary
                    ? `<p><strong>Salary Range:</strong> $${job.min_salary.toLocaleString()} - $${job.max_salary.toLocaleString()}</p>`
                    : ""
                }
              </div>

              ${custom_message ? `<p>${custom_message}</p>` : ""}

              <p>Based on your profile, we believe you could be an excellent candidate for this role. We'd love to hear from you!</p>

              <center>
                <a href="${applyUrl}" class="cta-button">View Job & Apply</a>
              </center>

              <p>If you're no longer interested in opportunities with us, we understand. Simply ignore this email.</p>

              <p>Best regards,<br>The Hiring Team</p>
            </div>
            <div class="footer">
              <p>This email was sent because you previously applied for a position with us.</p>
            </div>
          </body>
          </html>
        `;

        // Send email using the email service
        if (!emailService.isConfigured()) {
          errors.push({
            candidate_id: candidate.candidate_id,
            error: "email_service_not_configured",
          });
          continue;
        }

        await emailService.sendMail({
          to: candidate.email,
          subject: `New ${job.job_title} Opportunity`,
          html: emailHtml,
        });

        results.push({
          candidate_id: candidate.candidate_id,
          email: candidate.email,
          success: true,
        });
      } catch (emailError) {
        console.error(
          "[REACTIVATION] Email error for candidate",
          candidate.candidate_id,
          ":",
          emailError
        );
        errors.push({
          candidate_id: candidate.candidate_id,
          error: emailError.message,
        });
      }
    }

    return res.json({
      success: true,
      sent: results.length,
      failed: errors.length,
      results: results,
      errors: errors,
    });
  } catch (error) {
    console.error("[REACTIVATION] Error sending emails:", error);
    return res
      .status(500)
      .json({ error: "failed_to_send_emails", message: error.message });
  }
});

module.exports = router;
