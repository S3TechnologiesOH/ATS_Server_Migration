/**
 * Skills Routes Module
 * Handles all /skills/* and /candidates/:id/skills endpoints
 */

const express = require("express");
const router = express.Router();

const {
  DEFAULT_SCHEMA,
  ensureAdminTables,
} = require("./helpers");

// ==================== SKILLS ====================
// GET /skills - List all skills
router.get("/", async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const sql = `SELECT skill_id, skill_name FROM ${DEFAULT_SCHEMA}.skills ORDER BY skill_name ASC`;
    const r = await req.db.query(sql);
    return res.json(r.rows);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// POST /skills - Create a new skill (case-insensitive dedupe)
router.post("/", async (req, res) => {
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

// ==================== CANDIDATE SKILLS ====================
// These routes are mounted at /candidates in the main router

// GET /candidates/:id/skills - List skills for a candidate
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

// POST /candidates/skills/batch - Batch fetch skills for many candidates
router.post("/candidates/skills/batch", async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    let ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length) return res.json({});
    ids = ids.map((x) => parseInt(x, 10)).filter(Number.isFinite);
    if (!ids.length) return res.json({});
    // Cap to avoid pathological payloads
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

// POST /candidates/:id/skills - Add or update a candidate's skill
router.post("/candidates/:id/skills", async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: "invalid_candidate" });

    const skill_id = parseInt(req.body?.skill_id, 10);
    if (!Number.isFinite(skill_id))
      return res.status(400).json({ error: "skill_id_required" });

    const proficiency = req.body?.proficiency_level || null;

    // Validate skill exists
    const skillCheck = await req.db.query(
      `SELECT skill_id FROM ${DEFAULT_SCHEMA}.skills WHERE skill_id = $1`,
      [skill_id]
    );
    if (!skillCheck.rows.length) {
      return res.status(404).json({ error: "skill_not_found" });
    }

    // Upsert candidate skill
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
    const status = upd.rowCount === 0 ? 201 : 200;
    return res.status(status).json(row);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// DELETE /candidates/:id/skills/:skillId - Remove a skill from a candidate
router.delete("/candidates/:id/skills/:skillId", async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const id = parseInt(req.params.id, 10);
    const skillId = parseInt(req.params.skillId, 10);
    if (!Number.isFinite(id) || !Number.isFinite(skillId)) {
      return res.status(400).json({ error: "invalid_params" });
    }
    await req.db.query(
      `DELETE FROM ${DEFAULT_SCHEMA}.candidate_skills WHERE candidate_id = $1 AND skill_id = $2`,
      [id, skillId]
    );
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

module.exports = router;
