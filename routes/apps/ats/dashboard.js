/**
 * Dashboard Routes Module
 * Handles all /dashboard/* endpoints for stats and activity
 */

const express = require("express");
const router = express.Router();

const {
  DEFAULT_SCHEMA,
  PEOPLE_TABLE,
  PEOPLE_PK,
  APP_TABLE,
  APP_PK,
} = require("./helpers");

// ==================== DASHBOARD ====================
// GET /dashboard/stats - Get dashboard statistics
router.get("/stats", async (req, res) => {
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

// GET /dashboard/recent-activity - Recent application and stage activity
router.get("/recent-activity", async (req, res) => {
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
      LIMIT 10
    `;
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

module.exports = router;
