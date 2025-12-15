/**
 * Reports Routes Module
 * Handles all /reports/* endpoints
 * Includes report generation, listing, and downloading
 */

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");
const router = express.Router();

const {
  DEFAULT_SCHEMA,
  PEOPLE_TABLE,
  PEOPLE_PK,
  APP_TABLE,
  APP_PK,
  FILES_ROOT,
  ensureDir,
  safeFileName,
  isAdmin,
  getPrimaryEmail,
} = require("./helpers");

// Report configuration
const REPORT_TTL_SECONDS = Math.max(
  60,
  parseInt(process.env.REPORT_TTL_SECONDS || "900", 10)
);
const REPORT_TTL_MS = REPORT_TTL_SECONDS * 1000;
const REPORTS_DIR = path.join(FILES_ROOT, "reports");

// In-memory report store
const reportStore = new Map(); // id -> meta

function sanitizeOwnerKey(value) {
  return String(value || "anonymous")
    .toLowerCase()
    .replace(/[^a-z0-9@._-]/g, "_");
}

// ==================== REPORT CLEANUP ====================
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

// ==================== WORKSHEET BUILDERS ====================
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

// ==================== REPORT BUILDERS CONFIG ====================
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
      summary.addRow([`  ${key}`, asText]);
    }
  }

  const buildResult = await def.build(workbook, db, filters);
  summary.addRow([]);
  summary.addRow(["Rows Exported", buildResult?.rowCount ?? 0]);
  summary.getRow(1).font = { bold: true };
  summary.getColumn(1).font = { bold: true };

  return { workbook, definition: def, rowCount: buildResult?.rowCount ?? 0 };
}

// ==================== ROUTES ====================
// GET /reports - List available reports for current user
router.get("/", async (req, res) => {
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
router.post("/", async (req, res) => {
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
router.get("/:id/download", async (req, res) => {
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

module.exports = router;
module.exports.REPORT_BUILDERS = REPORT_BUILDERS;
module.exports.generateWorkbookForReport = generateWorkbookForReport;
