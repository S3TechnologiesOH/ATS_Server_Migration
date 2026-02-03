/**
 * Admin Routes Module
 * Handles all /admin/* endpoints for the ATS application
 * Includes departments, users, roles, flags, notes, ideas, notifications, bulk operations
 */

const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const {
  DEFAULT_SCHEMA,
  PEOPLE_TABLE,
  PEOPLE_PK,
  APP_TABLE,
  APP_PK,
  ADMIN_EMAILS,
  isAdmin,
  requireAdmin,
  ensureAdminTables,
  getPrimaryEmail,
  qualify,
  extractMentions,
  saveMentions,
  deleteMentions,
  fetchMentions,
} = require("./helpers");

const dbManager = require("../../../dbManager");

// Import API key generator (optional - graceful fallback if middleware not deployed yet)
let generateApiKey;
try {
  generateApiKey = require("../../../middleware/apiKeyAuth").generateApiKey;
} catch (e) {
  console.warn("[admin] apiKeyAuth middleware not found, using fallback");
  generateApiKey = () => {
    const crypto = require("crypto");
    const randomPart = crypto.randomBytes(28).toString("hex");
    const apiKey = `pk_live_${randomPart}`;
    const apiKeyPrefix = apiKey.substring(0, 12);
    return { apiKey, apiKeyPrefix };
  };
}

// ==================== ADMIN STATUS ====================
// Return admin status without requiring admin (so UI can gate correctly)
router.get("/status", async (req, res) => {
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

// ==================== DEPARTMENTS ====================
// GET /admin/departments - List all departments
router.get("/departments", requireAdmin, async (req, res) => {
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

// POST /admin/departments - Create department
router.post("/departments", requireAdmin, async (req, res) => {
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

// PUT /admin/departments/:id - Update department
router.put("/departments/:id", requireAdmin, async (req, res) => {
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

// DELETE /admin/departments/:id - Delete department
router.delete("/departments/:id", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const id = parseInt(req.params.id, 10);
    await req.db.query(`DELETE FROM ${DEFAULT_SCHEMA}.departments WHERE id = $1`, [id]);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ==================== DEPARTMENT MEMBERS ====================
// GET /admin/departments/:id/members - List department members
router.get("/departments/:id/members", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const id = parseInt(req.params.id, 10);
    const r = await req.db.query(
      `SELECT email, role, access_scope, created_at FROM ${DEFAULT_SCHEMA}.department_members WHERE department_id = $1 ORDER BY email`,
      [id]
    );
    return res.json(r.rows);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// POST /admin/departments/:id/members - Add member to department
router.post("/departments/:id/members", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const id = parseInt(req.params.id, 10);
    const { email, role } = req.body || {};
    if (!email) return res.status(400).json({ error: "email_required" });
    const r = await req.db.query(
      `INSERT INTO ${DEFAULT_SCHEMA}.department_members(department_id, email, role) VALUES ($1,$2,$3) ON CONFLICT (department_id, email) DO UPDATE SET role = EXCLUDED.role RETURNING email, role, created_at`,
      [id, email.toLowerCase(), role || "member"]
    );
    return res.status(201).json(r.rows[0]);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// DELETE /admin/departments/:id/members/:email - Remove member from department
router.delete("/departments/:id/members/:email", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const id = parseInt(req.params.id, 10);
    const email = req.params.email.toLowerCase();
    await req.db.query(
      `DELETE FROM ${DEFAULT_SCHEMA}.department_members WHERE department_id = $1 AND LOWER(email) = $2`,
      [id, email]
    );
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ==================== JOB-LEVEL ACCESS PERMISSIONS ====================
// GET /admin/departments/:id/members/:email/access-scope - Get member's access scope
router.get("/departments/:id/members/:email/access-scope", requireAdmin, async (req, res) => {
  try {
    const departmentId = parseInt(req.params.id, 10);
    const email = decodeURIComponent(req.params.email).toLowerCase();

    const r = await req.db.query(
      `SELECT access_scope FROM ${DEFAULT_SCHEMA}.department_members
       WHERE department_id = $1 AND LOWER(email) = $2`,
      [departmentId, email]
    );

    if (!r.rows.length) {
      return res.status(404).json({ error: "member_not_found" });
    }

    return res.json({ access_scope: r.rows[0].access_scope || 'all' });
  } catch (e) {
    console.error("GET /admin/departments/:id/members/:email/access-scope error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// PUT /admin/departments/:id/members/:email/access-scope - Set member's access scope
router.put("/departments/:id/members/:email/access-scope", requireAdmin, async (req, res) => {
  try {
    const departmentId = parseInt(req.params.id, 10);
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const { access_scope } = req.body || {};

    if (!access_scope || !['all', 'specific_jobs'].includes(access_scope)) {
      return res.status(400).json({ error: "invalid_access_scope", message: "access_scope must be 'all' or 'specific_jobs'" });
    }

    const r = await req.db.query(
      `UPDATE ${DEFAULT_SCHEMA}.department_members
       SET access_scope = $1
       WHERE department_id = $2 AND LOWER(email) = $3
       RETURNING email, role, access_scope`,
      [access_scope, departmentId, email]
    );

    if (!r.rows.length) {
      return res.status(404).json({ error: "member_not_found" });
    }

    return res.json(r.rows[0]);
  } catch (e) {
    console.error("PUT /admin/departments/:id/members/:email/access-scope error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// GET /admin/departments/:id/members/:email/job-access - List jobs member can access
router.get("/departments/:id/members/:email/job-access", requireAdmin, async (req, res) => {
  try {
    const departmentId = parseInt(req.params.id, 10);
    const email = decodeURIComponent(req.params.email).toLowerCase();

    // Get member's access scope
    const memberResult = await req.db.query(
      `SELECT access_scope FROM ${DEFAULT_SCHEMA}.department_members
       WHERE department_id = $1 AND LOWER(email) = $2`,
      [departmentId, email]
    );

    if (!memberResult.rows.length) {
      return res.status(404).json({ error: "member_not_found" });
    }

    const accessScope = memberResult.rows[0].access_scope || 'all';

    // Get department name
    const deptResult = await req.db.query(
      `SELECT name FROM ${DEFAULT_SCHEMA}.departments WHERE id = $1`,
      [departmentId]
    );

    if (!deptResult.rows.length) {
      return res.status(404).json({ error: "department_not_found" });
    }

    const departmentName = deptResult.rows[0].name;

    // Get all jobs in this department
    const jobsResult = await req.db.query(
      `SELECT jl.job_listing_id, jl.job_title, jl.job_requisition_id, jl.status
       FROM ${DEFAULT_SCHEMA}.job_listings jl
       WHERE LOWER(jl.department) = LOWER($1)
       ORDER BY jl.job_title`,
      [departmentName]
    );

    // Get specifically granted job access
    const accessResult = await req.db.query(
      `SELECT job_listing_id, granted_by, granted_at
       FROM ${DEFAULT_SCHEMA}.department_member_job_access
       WHERE department_id = $1 AND LOWER(member_email) = $2`,
      [departmentId, email]
    );

    const grantedJobIds = new Set(accessResult.rows.map(r => r.job_listing_id));
    const grantedJobsMap = new Map(accessResult.rows.map(r => [r.job_listing_id, r]));

    // Build response with access info for each job
    const jobs = jobsResult.rows.map(job => ({
      job_listing_id: job.job_listing_id,
      job_title: job.job_title,
      job_requisition_id: job.job_requisition_id,
      status: job.status,
      has_access: accessScope === 'all' || grantedJobIds.has(job.job_listing_id),
      explicitly_granted: grantedJobIds.has(job.job_listing_id),
      granted_by: grantedJobsMap.get(job.job_listing_id)?.granted_by || null,
      granted_at: grantedJobsMap.get(job.job_listing_id)?.granted_at || null
    }));

    return res.json({
      access_scope: accessScope,
      department_id: departmentId,
      department_name: departmentName,
      member_email: email,
      jobs
    });
  } catch (e) {
    console.error("GET /admin/departments/:id/members/:email/job-access error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// PUT /admin/departments/:id/members/:email/job-access - Set job access (array of job IDs)
router.put("/departments/:id/members/:email/job-access", requireAdmin, async (req, res) => {
  try {
    const departmentId = parseInt(req.params.id, 10);
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const grantedBy = getPrimaryEmail(req) || 'admin';
    const { job_listing_ids, access_scope } = req.body || {};

    // Verify member exists
    const memberResult = await req.db.query(
      `SELECT email FROM ${DEFAULT_SCHEMA}.department_members
       WHERE department_id = $1 AND LOWER(email) = $2`,
      [departmentId, email]
    );

    if (!memberResult.rows.length) {
      return res.status(404).json({ error: "member_not_found" });
    }

    // Start transaction
    await req.db.query('BEGIN');

    try {
      // Update access_scope if provided
      if (access_scope && ['all', 'specific_jobs'].includes(access_scope)) {
        await req.db.query(
          `UPDATE ${DEFAULT_SCHEMA}.department_members
           SET access_scope = $1
           WHERE department_id = $2 AND LOWER(email) = $3`,
          [access_scope, departmentId, email]
        );
      }

      // Only update job grants if job_listing_ids is provided
      if (Array.isArray(job_listing_ids)) {
        // Remove all existing job access for this member in this department
        await req.db.query(
          `DELETE FROM ${DEFAULT_SCHEMA}.department_member_job_access
           WHERE department_id = $1 AND LOWER(member_email) = $2`,
          [departmentId, email]
        );

        // Insert new job access grants
        if (job_listing_ids.length > 0) {
          const values = job_listing_ids.map((_, i) =>
            `($1, $2, $${i + 3}, $${job_listing_ids.length + 3})`
          ).join(', ');

          await req.db.query(
            `INSERT INTO ${DEFAULT_SCHEMA}.department_member_job_access
               (department_id, member_email, job_listing_id, granted_by)
             VALUES ${values}
             ON CONFLICT (department_id, member_email, job_listing_id) DO NOTHING`,
            [departmentId, email, ...job_listing_ids, grantedBy]
          );
        }
      }

      await req.db.query('COMMIT');

      // Return updated job access
      const accessResult = await req.db.query(
        `SELECT ja.job_listing_id, ja.granted_by, ja.granted_at, jl.job_title
         FROM ${DEFAULT_SCHEMA}.department_member_job_access ja
         JOIN ${DEFAULT_SCHEMA}.job_listings jl ON jl.job_listing_id = ja.job_listing_id
         WHERE ja.department_id = $1 AND LOWER(ja.member_email) = $2
         ORDER BY jl.job_title`,
        [departmentId, email]
      );

      // Get updated access_scope
      const scopeResult = await req.db.query(
        `SELECT access_scope FROM ${DEFAULT_SCHEMA}.department_members
         WHERE department_id = $1 AND LOWER(email) = $2`,
        [departmentId, email]
      );

      return res.json({
        success: true,
        access_scope: scopeResult.rows[0]?.access_scope || 'all',
        granted_jobs: accessResult.rows
      });
    } catch (err) {
      await req.db.query('ROLLBACK');
      throw err;
    }
  } catch (e) {
    console.error("PUT /admin/departments/:id/members/:email/job-access error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// GET /admin/departments/:id/jobs - List all jobs in department (for UI dropdown)
router.get("/departments/:id/jobs", requireAdmin, async (req, res) => {
  try {
    const departmentId = parseInt(req.params.id, 10);

    // Get department name
    const deptResult = await req.db.query(
      `SELECT name FROM ${DEFAULT_SCHEMA}.departments WHERE id = $1`,
      [departmentId]
    );

    if (!deptResult.rows.length) {
      return res.status(404).json({ error: "department_not_found" });
    }

    const departmentName = deptResult.rows[0].name;

    // Get all jobs in this department
    const jobsResult = await req.db.query(
      `SELECT job_listing_id, job_title, job_requisition_id, status, hiring_manager, recruiter_assigned
       FROM ${DEFAULT_SCHEMA}.job_listings
       WHERE LOWER(department) = LOWER($1)
       ORDER BY job_title`,
      [departmentName]
    );

    return res.json({
      department_id: departmentId,
      department_name: departmentName,
      jobs: jobsResult.rows
    });
  } catch (e) {
    console.error("GET /admin/departments/:id/jobs error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ==================== DEPARTMENT NOTES ====================
// GET /admin/departments/:id/notes - List notes for department
router.get("/departments/:id/notes", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const departmentId = parseInt(req.params.id, 10);
    if (!Number.isFinite(departmentId)) {
      return res.status(400).json({ error: "invalid_department_id" });
    }

    const r = await req.db.query(
      `SELECT n.id, n.department_id, n.content, n.priority, n.is_pinned, n.created_by, n.created_at, n.updated_at
       FROM ${DEFAULT_SCHEMA}.department_notes n
       WHERE n.department_id = $1
       ORDER BY n.is_pinned DESC, n.created_at DESC`,
      [departmentId]
    );

    // Fetch comments for each note
    const notes = await Promise.all(
      r.rows.map(async (note) => {
        const commentsResult = await req.db.query(
          `SELECT id, comment, created_by, created_at FROM ${DEFAULT_SCHEMA}.department_note_comments WHERE note_id = $1 ORDER BY created_at ASC`,
          [note.id]
        );
        const mentions = await fetchMentions(req.db, "note", note.id);
        return { ...note, comments: commentsResult.rows, mentions };
      })
    );

    return res.json(notes);
  } catch (e) {
    console.error("GET /admin/departments/:id/notes error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// POST /admin/departments/:id/notes - Create note
router.post("/departments/:id/notes", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const departmentId = parseInt(req.params.id, 10);
    if (!Number.isFinite(departmentId)) {
      return res.status(400).json({ error: "invalid_department_id" });
    }

    const { content, priority, is_pinned } = req.body || {};
    if (!content) return res.status(400).json({ error: "content_required" });

    const createdBy = getPrimaryEmail(req) || "unknown";
    const r = await req.db.query(
      `INSERT INTO ${DEFAULT_SCHEMA}.department_notes (department_id, content, priority, is_pinned, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, department_id, content, priority, is_pinned, created_by, created_at, updated_at`,
      [departmentId, content, priority || "medium", is_pinned || false, createdBy]
    );

    const noteId = r.rows[0].id;

    // Extract and save mentions
    const mentionedEmails = extractMentions(content);
    if (mentionedEmails.length > 0) {
      const truncatedContent = content.length > 100 ? content.substring(0, 100) + "..." : content;
      await saveMentions(
        req.db,
        "note",
        noteId,
        mentionedEmails,
        createdBy,
        `You were mentioned in a note: "${truncatedContent}"`
      );
    }

    return res.status(201).json({ ...r.rows[0], comments: [], mentions: [] });
  } catch (e) {
    console.error("POST /admin/departments/:id/notes error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// PUT /admin/notes/:noteId - Update note
router.put("/notes/:noteId", requireAdmin, async (req, res) => {
  try {
    const noteId = parseInt(req.params.noteId, 10);
    if (!Number.isFinite(noteId)) {
      return res.status(400).json({ error: "invalid_note_id" });
    }

    const { content, priority, is_pinned } = req.body || {};
    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (content !== undefined) {
      updates.push(`content = $${paramIndex++}`);
      params.push(content);
    }
    if (priority !== undefined) {
      updates.push(`priority = $${paramIndex++}`);
      params.push(priority);
    }
    if (is_pinned !== undefined) {
      updates.push(`is_pinned = $${paramIndex++}`);
      params.push(is_pinned);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "no_updates_provided" });
    }

    updates.push(`updated_at = NOW()`);
    params.push(noteId);

    const r = await req.db.query(
      `UPDATE ${DEFAULT_SCHEMA}.department_notes SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
      params
    );

    if (!r.rows.length) return res.status(404).json({ error: "not_found" });

    // Update mentions if content changed
    if (content !== undefined) {
      await deleteMentions(req.db, "note", noteId);
      const mentionedEmails = extractMentions(content);
      if (mentionedEmails.length > 0) {
        const createdBy = getPrimaryEmail(req) || "unknown";
        const truncatedContent = content.length > 100 ? content.substring(0, 100) + "..." : content;
        await saveMentions(
          req.db,
          "note",
          noteId,
          mentionedEmails,
          createdBy,
          `You were mentioned in a note: "${truncatedContent}"`
        );
      }
    }

    return res.json(r.rows[0]);
  } catch (e) {
    console.error("PUT /admin/notes/:noteId error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// DELETE /admin/notes/:noteId - Delete note
router.delete("/notes/:noteId", requireAdmin, async (req, res) => {
  try {
    const noteId = parseInt(req.params.noteId, 10);
    if (!Number.isFinite(noteId)) {
      return res.status(400).json({ error: "invalid_note_id" });
    }

    // Delete comments and mentions first
    await req.db.query(`DELETE FROM ${DEFAULT_SCHEMA}.department_note_comments WHERE note_id = $1`, [noteId]);
    await deleteMentions(req.db, "note", noteId);

    const r = await req.db.query(
      `DELETE FROM ${DEFAULT_SCHEMA}.department_notes WHERE id = $1 RETURNING id`,
      [noteId]
    );

    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    return res.json({ success: true });
  } catch (e) {
    console.error("DELETE /admin/notes/:noteId error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// POST /admin/notes/:noteId/comments - Add comment to note
router.post("/notes/:noteId/comments", requireAdmin, async (req, res) => {
  try {
    const noteId = parseInt(req.params.noteId, 10);
    if (!Number.isFinite(noteId)) {
      return res.status(400).json({ error: "invalid_note_id" });
    }

    const { comment } = req.body || {};
    if (!comment) return res.status(400).json({ error: "comment_required" });

    const createdBy = getPrimaryEmail(req) || "unknown";
    const r = await req.db.query(
      `INSERT INTO ${DEFAULT_SCHEMA}.department_note_comments (note_id, comment, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, comment, created_by, created_at`,
      [noteId, comment, createdBy]
    );

    return res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error("POST /admin/notes/:noteId/comments error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ==================== DEPARTMENT IDEAS ====================
// GET /admin/departments/:id/ideas - List ideas for department
router.get("/departments/:id/ideas", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const departmentId = parseInt(req.params.id, 10);
    if (!Number.isFinite(departmentId)) {
      return res.status(400).json({ error: "invalid_department_id" });
    }

    const r = await req.db.query(
      `SELECT i.id, i.department_id, i.title, i.description, i.status, i.priority, i.category, i.votes, i.created_by, i.created_at, i.updated_at
       FROM ${DEFAULT_SCHEMA}.department_ideas i
       WHERE i.department_id = $1
       ORDER BY i.votes DESC, i.created_at DESC`,
      [departmentId]
    );

    // Fetch comments for each idea
    const ideas = await Promise.all(
      r.rows.map(async (idea) => {
        const commentsResult = await req.db.query(
          `SELECT id, comment, created_by, created_at FROM ${DEFAULT_SCHEMA}.department_idea_comments WHERE idea_id = $1 ORDER BY created_at ASC`,
          [idea.id]
        );
        const mentions = await fetchMentions(req.db, "idea", idea.id);
        return { ...idea, comments: commentsResult.rows, mentions };
      })
    );

    return res.json(ideas);
  } catch (e) {
    console.error("GET /admin/departments/:id/ideas error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// POST /admin/departments/:id/ideas - Create idea
router.post("/departments/:id/ideas", requireAdmin, async (req, res) => {
  try {
    await ensureAdminTables(req.db);
    const departmentId = parseInt(req.params.id, 10);
    if (!Number.isFinite(departmentId)) {
      return res.status(400).json({ error: "invalid_department_id" });
    }

    const { title, description, status, priority, category } = req.body || {};
    if (!title) return res.status(400).json({ error: "title_required" });

    const createdBy = getPrimaryEmail(req) || "unknown";
    const r = await req.db.query(
      `INSERT INTO ${DEFAULT_SCHEMA}.department_ideas (department_id, title, description, status, priority, category, votes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7)
       RETURNING id, department_id, title, description, status, priority, category, votes, created_by, created_at, updated_at`,
      [
        departmentId,
        title,
        description || null,
        status || "proposed",
        priority || "medium",
        category || null,
        createdBy,
      ]
    );

    const ideaId = r.rows[0].id;

    // Extract and save mentions
    const fullText = `${title} ${description || ""}`;
    const mentionedEmails = extractMentions(fullText);
    if (mentionedEmails.length > 0) {
      await saveMentions(
        req.db,
        "idea",
        ideaId,
        mentionedEmails,
        createdBy,
        `You were mentioned in an idea: "${title}"`
      );
    }

    return res.status(201).json({ ...r.rows[0], comments: [], mentions: [] });
  } catch (e) {
    console.error("POST /admin/departments/:id/ideas error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// PUT /admin/ideas/:ideaId - Update idea
router.put("/ideas/:ideaId", requireAdmin, async (req, res) => {
  try {
    const ideaId = parseInt(req.params.ideaId, 10);
    if (!Number.isFinite(ideaId)) {
      return res.status(400).json({ error: "invalid_idea_id" });
    }

    const { title, description, status, priority, category, votes } = req.body || {};
    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (title !== undefined) {
      updates.push(`title = $${paramIndex++}`);
      params.push(title);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      params.push(description);
    }
    if (status !== undefined) {
      updates.push(`status = $${paramIndex++}`);
      params.push(status);
    }
    if (priority !== undefined) {
      updates.push(`priority = $${paramIndex++}`);
      params.push(priority);
    }
    if (category !== undefined) {
      updates.push(`category = $${paramIndex++}`);
      params.push(category);
    }
    if (votes !== undefined) {
      updates.push(`votes = $${paramIndex++}`);
      params.push(votes);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "no_updates_provided" });
    }

    updates.push(`updated_at = NOW()`);
    params.push(ideaId);

    const r = await req.db.query(
      `UPDATE ${DEFAULT_SCHEMA}.department_ideas SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
      params
    );

    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    return res.json(r.rows[0]);
  } catch (e) {
    console.error("PUT /admin/ideas/:ideaId error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// DELETE /admin/ideas/:ideaId - Delete idea
router.delete("/ideas/:ideaId", requireAdmin, async (req, res) => {
  try {
    const ideaId = parseInt(req.params.ideaId, 10);
    if (!Number.isFinite(ideaId)) {
      return res.status(400).json({ error: "invalid_idea_id" });
    }

    // Delete comments and mentions first
    await req.db.query(`DELETE FROM ${DEFAULT_SCHEMA}.department_idea_comments WHERE idea_id = $1`, [ideaId]);
    await deleteMentions(req.db, "idea", ideaId);

    const r = await req.db.query(
      `DELETE FROM ${DEFAULT_SCHEMA}.department_ideas WHERE id = $1 RETURNING id`,
      [ideaId]
    );

    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    return res.json({ success: true });
  } catch (e) {
    console.error("DELETE /admin/ideas/:ideaId error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// POST /admin/ideas/:ideaId/vote - Vote for idea
router.post("/ideas/:ideaId/vote", requireAdmin, async (req, res) => {
  try {
    const ideaId = parseInt(req.params.ideaId, 10);
    if (!Number.isFinite(ideaId)) {
      return res.status(400).json({ error: "invalid_idea_id" });
    }

    const r = await req.db.query(
      `UPDATE ${DEFAULT_SCHEMA}.department_ideas SET votes = votes + 1, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [ideaId]
    );

    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    return res.json(r.rows[0]);
  } catch (e) {
    console.error("POST /admin/ideas/:ideaId/vote error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// POST /admin/ideas/:ideaId/comments - Add comment to idea
router.post("/ideas/:ideaId/comments", requireAdmin, async (req, res) => {
  try {
    const ideaId = parseInt(req.params.ideaId, 10);
    if (!Number.isFinite(ideaId)) {
      return res.status(400).json({ error: "invalid_idea_id" });
    }

    const { comment } = req.body || {};
    if (!comment) return res.status(400).json({ error: "comment_required" });

    const createdBy = getPrimaryEmail(req) || "unknown";
    const r = await req.db.query(
      `INSERT INTO ${DEFAULT_SCHEMA}.department_idea_comments (idea_id, comment, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, comment, created_by, created_at`,
      [ideaId, comment, createdBy]
    );

    return res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error("POST /admin/ideas/:ideaId/comments error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ==================== NOTIFICATIONS ====================
// GET /admin/notifications - List notifications for current user
router.get("/notifications", requireAdmin, async (req, res) => {
  try {
    const userEmail = getPrimaryEmail(req);
    if (!userEmail) return res.json([]);

    const r = await req.db.query(
      `SELECT id, type, reference_type, reference_id, message, is_read, created_at
       FROM ${DEFAULT_SCHEMA}.notifications
       WHERE user_email = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [userEmail]
    );
    return res.json(r.rows);
  } catch (e) {
    console.error("GET /admin/notifications error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// PUT /admin/notifications/:id/read - Mark notification as read
router.put("/notifications/:id/read", requireAdmin, async (req, res) => {
  try {
    const notificationId = parseInt(req.params.id, 10);
    const userEmail = getPrimaryEmail(req);

    const r = await req.db.query(
      `UPDATE ${DEFAULT_SCHEMA}.notifications SET is_read = TRUE WHERE id = $1 AND user_email = $2 RETURNING id`,
      [notificationId, userEmail]
    );

    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    return res.json({ success: true });
  } catch (e) {
    console.error("PUT /admin/notifications/:id/read error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// PUT /admin/notifications/read-all - Mark all notifications as read
router.put("/notifications/read-all", requireAdmin, async (req, res) => {
  try {
    const userEmail = getPrimaryEmail(req);
    if (!userEmail) return res.json({ success: true, count: 0 });

    const r = await req.db.query(
      `UPDATE ${DEFAULT_SCHEMA}.notifications SET is_read = TRUE WHERE user_email = $1 AND is_read = FALSE`,
      [userEmail]
    );

    return res.json({ success: true, count: r.rowCount });
  } catch (e) {
    console.error("PUT /admin/notifications/read-all error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ==================== CANDIDATE FLAGS ====================
// GET /admin/candidate-flags - List all flags
router.get("/candidate-flags", requireAdmin, async (req, res) => {
  try {
    const r = await req.db.query(
      `SELECT id, name, color, description, is_active, created_at
       FROM ${DEFAULT_SCHEMA}.candidate_flags
       ORDER BY name`
    );
    return res.json(r.rows);
  } catch (e) {
    console.error("GET /admin/candidate-flags error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// POST /admin/candidate-flags - Create flag
router.post("/candidate-flags", requireAdmin, async (req, res) => {
  try {
    const { name, color, description, is_active } = req.body || {};
    if (!name) return res.status(400).json({ error: "name_required" });

    const r = await req.db.query(
      `INSERT INTO ${DEFAULT_SCHEMA}.candidate_flags (name, color, description, is_active)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, color, description, is_active, created_at`,
      [name, color || "#808080", description || null, is_active !== false]
    );

    return res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error("POST /admin/candidate-flags error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// PUT /admin/candidate-flags/:id - Update flag
router.put("/candidate-flags/:id", requireAdmin, async (req, res) => {
  try {
    const flagId = parseInt(req.params.id, 10);
    const { name, color, description, is_active } = req.body || {};

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      params.push(name);
    }
    if (color !== undefined) {
      updates.push(`color = $${paramIndex++}`);
      params.push(color);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      params.push(description);
    }
    if (is_active !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      params.push(is_active);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "no_updates_provided" });
    }

    params.push(flagId);
    const r = await req.db.query(
      `UPDATE ${DEFAULT_SCHEMA}.candidate_flags SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
      params
    );

    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    return res.json(r.rows[0]);
  } catch (e) {
    console.error("PUT /admin/candidate-flags/:id error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// DELETE /admin/candidate-flags/:id - Delete flag
router.delete("/candidate-flags/:id", requireAdmin, async (req, res) => {
  try {
    const flagId = parseInt(req.params.id, 10);
    await req.db.query(`DELETE FROM ${DEFAULT_SCHEMA}.candidate_flags WHERE id = $1`, [flagId]);
    return res.json({ success: true });
  } catch (e) {
    console.error("DELETE /admin/candidate-flags/:id error:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ==================== BULK DELETE OPERATIONS ====================
// DELETE /admin/candidates/all - Delete all candidates
router.delete("/candidates/all", requireAdmin, async (req, res) => {
  const pplTable = `${DEFAULT_SCHEMA}.candidates`;
  const appTable = `${DEFAULT_SCHEMA}.applications`;
  const stageTable = `${DEFAULT_SCHEMA}.application_stages`;
  const skillsTable = `${DEFAULT_SCHEMA}.candidate_skills`;

  try {
    await req.db.query("BEGIN");
    const before = await Promise.all([
      req.db.query(`SELECT COUNT(*)::int AS n FROM ${stageTable}`),
      req.db.query(`SELECT COUNT(*)::int AS n FROM ${appTable}`),
      req.db.query(`SELECT COUNT(*)::int AS n FROM ${skillsTable}`),
      req.db.query(`SELECT COUNT(*)::int AS n FROM ${pplTable}`),
    ]);
    await req.db.query(`DELETE FROM ${pplTable}`);
    const after = await Promise.all([
      req.db.query(`SELECT COUNT(*)::int AS n FROM ${stageTable}`),
      req.db.query(`SELECT COUNT(*)::int AS n FROM ${appTable}`),
      req.db.query(`SELECT COUNT(*)::int AS n FROM ${skillsTable}`),
      req.db.query(`SELECT COUNT(*)::int AS n FROM ${pplTable}`),
    ]);
    await req.db.query("COMMIT");

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
    return res.status(500).json({ success: false, error: "internal_error", message: e?.message });
  }
});

// DELETE /admin/applications/all - Delete all applications
router.delete("/applications/all", requireAdmin, async (req, res) => {
  const appTable = `${DEFAULT_SCHEMA}.applications`;
  const stageTable = `${DEFAULT_SCHEMA}.application_stages`;

  try {
    await req.db.query("BEGIN");
    const before = await Promise.all([
      req.db.query(`SELECT COUNT(*)::int AS n FROM ${stageTable}`),
      req.db.query(`SELECT COUNT(*)::int AS n FROM ${appTable}`),
    ]);
    await req.db.query(`DELETE FROM ${appTable}`);
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
    return res.status(500).json({ success: false, error: "internal_error", message: e?.message });
  }
});

// ==================== USER MANAGEMENT ====================
// GET /admin/users - List all users
router.get("/users", requireAdmin, async (req, res) => {
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
    return res.status(500).json({ error: "internal_error", message: e?.message });
  }
});

// POST /admin/users - Create user
router.post("/users", requireAdmin, async (req, res) => {
  const { username, email, password, role_id, is_active = true } = req.body;

  if (!username) return res.status(400).json({ error: "username_required" });
  if (!role_id) return res.status(400).json({ error: "role_id_required" });

  try {
    let password_hash = null;
    if (password) {
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = crypto.scryptSync(password, salt, 64).toString("hex");
      password_hash = `scrypt:${salt}:${hash}`;
    }

    const result = await req.db.query(
      `INSERT INTO ${DEFAULT_SCHEMA}.users (username, email, password_hash, role_id, is_active, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING user_id, username, email, role_id, is_active, created_at`,
      [username, email || null, password_hash, role_id, is_active]
    );

    return res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error("[admin-create-user] Error:", e);
    if (e.code === "23505") {
      return res.status(409).json({ error: "username_or_email_exists", message: "Username or email already exists" });
    }
    return res.status(500).json({ error: "internal_error", message: e?.message });
  }
});

// PUT /admin/users/:userId - Update user
router.put("/users/:userId", requireAdmin, async (req, res) => {
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
      `UPDATE ${DEFAULT_SCHEMA}.users SET ${updates.join(", ")} WHERE user_id = $${paramIndex} RETURNING user_id, username, email, role_id, is_active, updated_at`,
      values
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "user_not_found" });
    return res.json(result.rows[0]);
  } catch (e) {
    console.error("[admin-update-user] Error:", e);
    if (e.code === "23505") {
      return res.status(409).json({ error: "username_or_email_exists", message: "Username or email already exists" });
    }
    return res.status(500).json({ error: "internal_error", message: e?.message });
  }
});

// DELETE /admin/users/:userId - Delete user
router.delete("/users/:userId", requireAdmin, async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await req.db.query(
      `DELETE FROM ${DEFAULT_SCHEMA}.users WHERE user_id = $1 RETURNING user_id, username`,
      [userId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "user_not_found" });
    return res.json({ success: true, deleted: result.rows[0] });
  } catch (e) {
    console.error("[admin-delete-user] Error:", e);
    return res.status(500).json({ error: "internal_error", message: e?.message });
  }
});

// PATCH /admin/users/:userId/toggle-active - Toggle user active status
router.patch("/users/:userId/toggle-active", requireAdmin, async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await req.db.query(
      `UPDATE ${DEFAULT_SCHEMA}.users SET is_active = NOT is_active, updated_at = NOW() WHERE user_id = $1 RETURNING user_id, username, is_active`,
      [userId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "user_not_found" });
    return res.json(result.rows[0]);
  } catch (e) {
    console.error("[admin-toggle-user-status] Error:", e);
    return res.status(500).json({ error: "internal_error", message: e?.message });
  }
});

// POST /admin/users/:userId/set-password - Set user password
router.post("/users/:userId/set-password", requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const { password } = req.body;

  if (!password || password.length < 6) {
    return res.status(400).json({ error: "invalid_password", message: "Password must be at least 6 characters" });
  }

  try {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    const password_hash = `scrypt:${salt}:${hash}`;

    const result = await req.db.query(
      `UPDATE ${DEFAULT_SCHEMA}.users SET password_hash = $1, updated_at = NOW() WHERE user_id = $2 RETURNING user_id, username`,
      [password_hash, userId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "user_not_found" });
    return res.json({ success: true });
  } catch (e) {
    console.error("[admin-set-user-password] Error:", e);
    return res.status(500).json({ error: "internal_error", message: e?.message });
  }
});

// ==================== ROLE MANAGEMENT ====================
// GET /admin/roles - List all roles
router.get("/roles", requireAdmin, async (req, res) => {
  try {
    const result = await req.db.query(`
      SELECT id, name, description, permissions, is_system, created_at, updated_at
      FROM ${DEFAULT_SCHEMA}.roles
      ORDER BY is_system DESC, name ASC
    `);
    return res.json(result.rows);
  } catch (e) {
    console.error("[admin-list-roles] Error:", e);
    return res.status(500).json({ error: "internal_error", message: e?.message });
  }
});

// POST /admin/roles - Create role
router.post("/roles", requireAdmin, async (req, res) => {
  const { name, description, permissions } = req.body;

  if (!name) return res.status(400).json({ error: "name_required" });

  try {
    const result = await req.db.query(
      `INSERT INTO ${DEFAULT_SCHEMA}.roles (name, description, permissions, is_system, created_at)
       VALUES ($1, $2, $3, FALSE, NOW())
       RETURNING id, name, description, permissions, is_system, created_at`,
      [name, description || null, permissions || {}]
    );

    return res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error("[admin-create-role] Error:", e);
    if (e.code === "23505") {
      return res.status(409).json({ error: "role_exists", message: "Role name already exists" });
    }
    return res.status(500).json({ error: "internal_error", message: e?.message });
  }
});

// PUT /admin/roles/:roleId - Update role
router.put("/roles/:roleId", requireAdmin, async (req, res) => {
  const { roleId } = req.params;
  const { name, description, permissions } = req.body;

  try {
    // Check if it's a system role
    const checkResult = await req.db.query(
      `SELECT is_system FROM ${DEFAULT_SCHEMA}.roles WHERE id = $1`,
      [roleId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: "role_not_found" });
    }

    if (checkResult.rows[0].is_system) {
      return res.status(403).json({ error: "cannot_modify_system_role" });
    }

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(description);
    }
    if (permissions !== undefined) {
      updates.push(`permissions = $${paramIndex++}`);
      values.push(permissions);
    }

    updates.push(`updated_at = NOW()`);
    values.push(roleId);

    const result = await req.db.query(
      `UPDATE ${DEFAULT_SCHEMA}.roles SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    return res.json(result.rows[0]);
  } catch (e) {
    console.error("[admin-update-role] Error:", e);
    if (e.code === "23505") {
      return res.status(409).json({ error: "role_exists", message: "Role name already exists" });
    }
    return res.status(500).json({ error: "internal_error", message: e?.message });
  }
});

// DELETE /admin/roles/:roleId - Delete role
router.delete("/roles/:roleId", requireAdmin, async (req, res) => {
  const { roleId } = req.params;

  try {
    // Check if it's a system role
    const checkResult = await req.db.query(
      `SELECT is_system FROM ${DEFAULT_SCHEMA}.roles WHERE id = $1`,
      [roleId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: "role_not_found" });
    }

    if (checkResult.rows[0].is_system) {
      return res.status(403).json({ error: "cannot_delete_system_role" });
    }

    // Check if role is in use
    const usersCheck = await req.db.query(
      `SELECT COUNT(*) as count FROM ${DEFAULT_SCHEMA}.users WHERE role_id = $1`,
      [roleId]
    );

    if (parseInt(usersCheck.rows[0].count) > 0) {
      return res.status(400).json({ error: "role_in_use", message: "Cannot delete role that is assigned to users" });
    }

    await req.db.query(`DELETE FROM ${DEFAULT_SCHEMA}.roles WHERE id = $1`, [roleId]);
    return res.json({ success: true });
  } catch (e) {
    console.error("[admin-delete-role] Error:", e);
    return res.status(500).json({ error: "internal_error", message: e?.message });
  }
});

// ==================== API KEY MANAGEMENT ====================
// Note: API keys are stored in the master database, not tenant database

// GET /admin/api-keys - List API keys (prefix only for security)
router.get("/api-keys", requireAdmin, async (req, res) => {
  try {
    if (!req.tenantMode || !req.tenantId) {
      return res.status(400).json({ error: "tenant_required", message: "API keys require tenant context" });
    }

    const masterDb = dbManager.getMasterDb();
    const result = await masterDb.query(
      `SELECT id, api_key_prefix, name, description, allowed_domains, rate_limit_per_minute,
              is_active, last_used_at, created_at
       FROM tenant_api_keys
       WHERE tenant_id = $1 AND revoked_at IS NULL
       ORDER BY created_at DESC`,
      [req.tenantId]
    );

    return res.json(result.rows);
  } catch (e) {
    console.error("[admin-list-api-keys] Error:", e);
    return res.status(500).json({ error: "internal_error", message: e?.message });
  }
});

// POST /admin/api-keys - Generate new API key (full key shown only once!)
router.post("/api-keys", requireAdmin, async (req, res) => {
  try {
    if (!req.tenantMode || !req.tenantId) {
      return res.status(400).json({ error: "tenant_required", message: "API keys require tenant context" });
    }

    const { name, description, allowed_domains, rate_limit_per_minute } = req.body || {};
    const { apiKey, apiKeyPrefix } = generateApiKey();

    const masterDb = dbManager.getMasterDb();
    const result = await masterDb.query(
      `INSERT INTO tenant_api_keys (tenant_id, api_key, api_key_prefix, name, description, allowed_domains, rate_limit_per_minute)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, api_key_prefix, name, description, allowed_domains, rate_limit_per_minute, is_active, created_at`,
      [
        req.tenantId,
        apiKey,
        apiKeyPrefix,
        name || "Default Key",
        description || null,
        allowed_domains || null,
        rate_limit_per_minute || 100,
      ]
    );

    // Return the full API key ONLY on creation - it won't be shown again
    return res.status(201).json({
      ...result.rows[0],
      api_key: apiKey, // Full key shown only once!
      warning: "Save this API key now. It will not be shown again.",
    });
  } catch (e) {
    console.error("[admin-create-api-key] Error:", e);
    return res.status(500).json({ error: "internal_error", message: e?.message });
  }
});

// PUT /admin/api-keys/:id - Update API key metadata
router.put("/api-keys/:id", requireAdmin, async (req, res) => {
  try {
    if (!req.tenantMode || !req.tenantId) {
      return res.status(400).json({ error: "tenant_required", message: "API keys require tenant context" });
    }

    const keyId = parseInt(req.params.id, 10);
    const { name, description, allowed_domains, rate_limit_per_minute, is_active } = req.body || {};

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      params.push(name);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      params.push(description);
    }
    if (allowed_domains !== undefined) {
      updates.push(`allowed_domains = $${paramIndex++}`);
      params.push(allowed_domains);
    }
    if (rate_limit_per_minute !== undefined) {
      updates.push(`rate_limit_per_minute = $${paramIndex++}`);
      params.push(rate_limit_per_minute);
    }
    if (is_active !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      params.push(is_active);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "no_updates_provided" });
    }

    params.push(keyId, req.tenantId);

    const masterDb = dbManager.getMasterDb();
    const result = await masterDb.query(
      `UPDATE tenant_api_keys SET ${updates.join(", ")}
       WHERE id = $${paramIndex} AND tenant_id = $${paramIndex + 1} AND revoked_at IS NULL
       RETURNING id, api_key_prefix, name, description, allowed_domains, rate_limit_per_minute, is_active, created_at`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "api_key_not_found" });
    }

    return res.json(result.rows[0]);
  } catch (e) {
    console.error("[admin-update-api-key] Error:", e);
    return res.status(500).json({ error: "internal_error", message: e?.message });
  }
});

// DELETE /admin/api-keys/:id - Revoke API key (soft delete)
router.delete("/api-keys/:id", requireAdmin, async (req, res) => {
  try {
    if (!req.tenantMode || !req.tenantId) {
      return res.status(400).json({ error: "tenant_required", message: "API keys require tenant context" });
    }

    const keyId = parseInt(req.params.id, 10);

    const masterDb = dbManager.getMasterDb();
    const result = await masterDb.query(
      `UPDATE tenant_api_keys SET revoked_at = NOW(), is_active = false
       WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
       RETURNING id, api_key_prefix`,
      [keyId, req.tenantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "api_key_not_found" });
    }

    return res.json({ success: true, revoked: result.rows[0] });
  } catch (e) {
    console.error("[admin-revoke-api-key] Error:", e);
    return res.status(500).json({ error: "internal_error", message: e?.message });
  }
});

// ==================== APPLICATION QUESTIONS MANAGEMENT ====================
// Note: Tenant default questions are stored in master database

// Default questions to seed for new tenants
const DEFAULT_QUESTIONS = [
  {
    key: "values_resonates",
    type: "textarea",
    label: "Our values include Push the Boundaries, Own It, Work with Gratitude, Embrace Technology, and Respect. Which resonates most with you and why?",
    required: true,
    order: 1,
  },
  {
    key: "motivation",
    type: "radio",
    label: "What motivates you most at work?",
    options: [
      { value: "solving_problems", label: "Solving problems" },
      { value: "helping_people", label: "Helping people" },
      { value: "achieving_results", label: "Achieving measurable results" },
      { value: "learning", label: "Learning new things" },
    ],
    required: true,
    order: 2,
  },
  {
    key: "onsite_available",
    type: "yes_no",
    label: "Are you available to work in office Monday–Friday 8:00am–4:30pm?",
    required: true,
    order: 3,
  },
  {
    key: "termination_history",
    type: "radio",
    label: "Have you ever been terminated or asked to resign?",
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
      { value: "prefer_not", label: "Prefer not to say" },
    ],
    required: false,
    order: 4,
  },
  {
    key: "references_available",
    type: "yes_no",
    label: "Can you provide professional references upon request?",
    required: true,
    order: 5,
  },
  {
    key: "work_authorization",
    type: "yes_no",
    label: "Are you authorized to work in the United States without sponsorship?",
    required: true,
    order: 6,
  },
  {
    key: "expected_salary_range",
    type: "text",
    label: "What is your expected salary range?",
    placeholder: "e.g., $50,000 - $60,000",
    required: false,
    order: 7,
  },
];

// GET /admin/questions - List tenant default questions
router.get("/questions", requireAdmin, async (req, res) => {
  try {
    if (!req.tenantMode || !req.tenantId) {
      return res.status(400).json({ error: "tenant_required", message: "Questions require tenant context" });
    }

    const masterDb = dbManager.getMasterDb();
    const result = await masterDb.query(
      `SELECT id, question_key, question_type, label, helper_text, placeholder,
              options, is_required, min_length, max_length, display_order, is_active, created_at
       FROM tenant_application_questions
       WHERE tenant_id = $1
       ORDER BY display_order ASC, created_at ASC`,
      [req.tenantId]
    );

    return res.json(result.rows);
  } catch (e) {
    console.error("[admin-list-questions] Error:", e);
    return res.status(500).json({ error: "internal_error", message: e?.message });
  }
});

// POST /admin/questions - Create new question
router.post("/questions", requireAdmin, async (req, res) => {
  try {
    if (!req.tenantMode || !req.tenantId) {
      return res.status(400).json({ error: "tenant_required", message: "Questions require tenant context" });
    }

    const {
      question_key,
      question_type,
      label,
      helper_text,
      placeholder,
      options,
      is_required,
      min_length,
      max_length,
      display_order,
    } = req.body || {};

    if (!question_key || !question_type || !label) {
      return res.status(400).json({ error: "missing_required_fields", message: "question_key, question_type, and label are required" });
    }

    // Validate question_type
    const validTypes = ["text", "textarea", "radio", "checkbox", "yes_no", "dropdown", "file"];
    if (!validTypes.includes(question_type)) {
      return res.status(400).json({ error: "invalid_question_type", message: `Valid types: ${validTypes.join(", ")}` });
    }

    const masterDb = dbManager.getMasterDb();

    // Get max display_order if not provided
    let order = display_order;
    if (order === undefined || order === null) {
      const maxResult = await masterDb.query(
        `SELECT COALESCE(MAX(display_order), 0) + 1 as next_order FROM tenant_application_questions WHERE tenant_id = $1`,
        [req.tenantId]
      );
      order = maxResult.rows[0].next_order;
    }

    const result = await masterDb.query(
      `INSERT INTO tenant_application_questions
        (tenant_id, question_key, question_type, label, helper_text, placeholder, options, is_required, min_length, max_length, display_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, question_key, question_type, label, helper_text, placeholder, options, is_required, min_length, max_length, display_order, is_active, created_at`,
      [
        req.tenantId,
        question_key,
        question_type,
        label,
        helper_text || null,
        placeholder || null,
        JSON.stringify(options || []),
        is_required || false,
        min_length || null,
        max_length || null,
        order,
      ]
    );

    return res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error("[admin-create-question] Error:", e);
    if (e.code === "23505") {
      return res.status(409).json({ error: "duplicate_question_key", message: "A question with this key already exists" });
    }
    return res.status(500).json({ error: "internal_error", message: e?.message });
  }
});

// PUT /admin/questions/:id - Update question
router.put("/questions/:id", requireAdmin, async (req, res) => {
  try {
    if (!req.tenantMode || !req.tenantId) {
      return res.status(400).json({ error: "tenant_required", message: "Questions require tenant context" });
    }

    const questionId = parseInt(req.params.id, 10);
    const {
      question_key,
      question_type,
      label,
      helper_text,
      placeholder,
      options,
      is_required,
      min_length,
      max_length,
      display_order,
      is_active,
    } = req.body || {};

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (question_key !== undefined) {
      updates.push(`question_key = $${paramIndex++}`);
      params.push(question_key);
    }
    if (question_type !== undefined) {
      const validTypes = ["text", "textarea", "radio", "checkbox", "yes_no", "dropdown", "file"];
      if (!validTypes.includes(question_type)) {
        return res.status(400).json({ error: "invalid_question_type", message: `Valid types: ${validTypes.join(", ")}` });
      }
      updates.push(`question_type = $${paramIndex++}`);
      params.push(question_type);
    }
    if (label !== undefined) {
      updates.push(`label = $${paramIndex++}`);
      params.push(label);
    }
    if (helper_text !== undefined) {
      updates.push(`helper_text = $${paramIndex++}`);
      params.push(helper_text);
    }
    if (placeholder !== undefined) {
      updates.push(`placeholder = $${paramIndex++}`);
      params.push(placeholder);
    }
    if (options !== undefined) {
      updates.push(`options = $${paramIndex++}`);
      params.push(JSON.stringify(options));
    }
    if (is_required !== undefined) {
      updates.push(`is_required = $${paramIndex++}`);
      params.push(is_required);
    }
    if (min_length !== undefined) {
      updates.push(`min_length = $${paramIndex++}`);
      params.push(min_length);
    }
    if (max_length !== undefined) {
      updates.push(`max_length = $${paramIndex++}`);
      params.push(max_length);
    }
    if (display_order !== undefined) {
      updates.push(`display_order = $${paramIndex++}`);
      params.push(display_order);
    }
    if (is_active !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      params.push(is_active);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "no_updates_provided" });
    }

    updates.push(`updated_at = NOW()`);
    params.push(questionId, req.tenantId);

    const masterDb = dbManager.getMasterDb();
    const result = await masterDb.query(
      `UPDATE tenant_application_questions SET ${updates.join(", ")}
       WHERE id = $${paramIndex} AND tenant_id = $${paramIndex + 1}
       RETURNING id, question_key, question_type, label, helper_text, placeholder, options, is_required, min_length, max_length, display_order, is_active, created_at, updated_at`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "question_not_found" });
    }

    return res.json(result.rows[0]);
  } catch (e) {
    console.error("[admin-update-question] Error:", e);
    if (e.code === "23505") {
      return res.status(409).json({ error: "duplicate_question_key", message: "A question with this key already exists" });
    }
    return res.status(500).json({ error: "internal_error", message: e?.message });
  }
});

// DELETE /admin/questions/:id - Delete question
router.delete("/questions/:id", requireAdmin, async (req, res) => {
  try {
    if (!req.tenantMode || !req.tenantId) {
      return res.status(400).json({ error: "tenant_required", message: "Questions require tenant context" });
    }

    const questionId = parseInt(req.params.id, 10);

    const masterDb = dbManager.getMasterDb();
    const result = await masterDb.query(
      `DELETE FROM tenant_application_questions WHERE id = $1 AND tenant_id = $2 RETURNING id, question_key`,
      [questionId, req.tenantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "question_not_found" });
    }

    return res.json({ success: true, deleted: result.rows[0] });
  } catch (e) {
    console.error("[admin-delete-question] Error:", e);
    return res.status(500).json({ error: "internal_error", message: e?.message });
  }
});

// POST /admin/questions/reorder - Update display order for multiple questions
router.post("/questions/reorder", requireAdmin, async (req, res) => {
  try {
    if (!req.tenantMode || !req.tenantId) {
      return res.status(400).json({ error: "tenant_required", message: "Questions require tenant context" });
    }

    const { orders } = req.body || {};
    // orders should be array of { id, display_order }

    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ error: "invalid_orders", message: "orders must be an array of { id, display_order }" });
    }

    const masterDb = dbManager.getMasterDb();

    // Update each question's display_order
    await masterDb.query("BEGIN");
    try {
      for (const item of orders) {
        await masterDb.query(
          `UPDATE tenant_application_questions SET display_order = $1, updated_at = NOW()
           WHERE id = $2 AND tenant_id = $3`,
          [item.display_order, item.id, req.tenantId]
        );
      }
      await masterDb.query("COMMIT");
    } catch (err) {
      await masterDb.query("ROLLBACK");
      throw err;
    }

    // Return updated list
    const result = await masterDb.query(
      `SELECT id, question_key, question_type, label, helper_text, placeholder,
              options, is_required, min_length, max_length, display_order, is_active, created_at
       FROM tenant_application_questions
       WHERE tenant_id = $1
       ORDER BY display_order ASC, created_at ASC`,
      [req.tenantId]
    );

    return res.json(result.rows);
  } catch (e) {
    console.error("[admin-reorder-questions] Error:", e);
    return res.status(500).json({ error: "internal_error", message: e?.message });
  }
});

// POST /admin/questions/seed-defaults - Seed default questions for tenant
router.post("/questions/seed-defaults", requireAdmin, async (req, res) => {
  try {
    if (!req.tenantMode || !req.tenantId) {
      return res.status(400).json({ error: "tenant_required", message: "Questions require tenant context" });
    }

    const masterDb = dbManager.getMasterDb();

    // Check if tenant already has questions
    const existing = await masterDb.query(
      `SELECT COUNT(*) as count FROM tenant_application_questions WHERE tenant_id = $1`,
      [req.tenantId]
    );

    const existingCount = parseInt(existing.rows[0].count, 10);

    // Insert default questions
    const inserted = [];
    for (const q of DEFAULT_QUESTIONS) {
      try {
        const result = await masterDb.query(
          `INSERT INTO tenant_application_questions
            (tenant_id, question_key, question_type, label, helper_text, placeholder, options, is_required, display_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (tenant_id, question_key) DO NOTHING
           RETURNING id, question_key`,
          [
            req.tenantId,
            q.key,
            q.type,
            q.label,
            q.helper_text || null,
            q.placeholder || null,
            JSON.stringify(q.options || []),
            q.required || false,
            existingCount + q.order, // Offset order if there are existing questions
          ]
        );
        if (result.rows.length > 0) {
          inserted.push(result.rows[0]);
        }
      } catch (err) {
        console.error(`[admin-seed-questions] Error inserting ${q.key}:`, err.message);
      }
    }

    // Return all questions
    const result = await masterDb.query(
      `SELECT id, question_key, question_type, label, helper_text, placeholder,
              options, is_required, min_length, max_length, display_order, is_active, created_at
       FROM tenant_application_questions
       WHERE tenant_id = $1
       ORDER BY display_order ASC, created_at ASC`,
      [req.tenantId]
    );

    return res.json({
      success: true,
      inserted_count: inserted.length,
      total_count: result.rows.length,
      questions: result.rows,
    });
  } catch (e) {
    console.error("[admin-seed-questions] Error:", e);
    return res.status(500).json({ error: "internal_error", message: e?.message });
  }
});

module.exports = router;
