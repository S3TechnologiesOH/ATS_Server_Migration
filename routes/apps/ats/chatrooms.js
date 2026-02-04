/**
 * Chatrooms Routes Module
 * Handles all /chatrooms/* endpoints for candidate collaboration
 * Includes chatroom CRUD, messages, attachments, and note integration
 */

const express = require("express");
const router = express.Router();

const {
  DEFAULT_SCHEMA,
  PEOPLE_TABLE,
  PEOPLE_PK,
  APP_TABLE,
  APP_PK,
  isAdmin,
  requireAdmin,
  getPrimaryEmail,
  qualify,
} = require("./helpers");

// ==================== HELPER FUNCTIONS ====================

/**
 * Check if user has access to a chatroom via department membership and job-level permissions
 * - If chatroom has no department, allow access
 * - If user is a department member with access_scope='all', allow access
 * - If user has access_scope='specific_jobs', check if they have access to the job
 */
async function canAccessChatroom(db, chatroomId, userEmail) {
  if (!userEmail) return false;

  const { rows } = await db.query(`
    SELECT 1 FROM ${DEFAULT_SCHEMA}.chatrooms c
    LEFT JOIN ${DEFAULT_SCHEMA}.department_members dm
      ON dm.department_id = c.department_id AND LOWER(dm.email) = LOWER($2)
    LEFT JOIN ${DEFAULT_SCHEMA}.applications a
      ON a.${APP_PK} = c.application_id
    LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl
      ON jl.job_requisition_id = a.job_requisition_id
    WHERE c.id = $1
      AND (
        -- Chatroom has no department (open access)
        c.department_id IS NULL
        OR (
          -- User is a department member
          dm.email IS NOT NULL
          AND (
            -- User has 'all' access scope
            COALESCE(dm.access_scope, 'all') = 'all'
            OR
            -- User has specific job access
            EXISTS (
              SELECT 1 FROM ${DEFAULT_SCHEMA}.department_member_job_access ja
              WHERE ja.department_id = c.department_id
                AND LOWER(ja.member_email) = LOWER($2)
                AND ja.job_listing_id = jl.job_listing_id
            )
            OR
            -- Chatroom has no associated application/job (allow access for dept members)
            c.application_id IS NULL
          )
        )
      )
    LIMIT 1
  `, [chatroomId, userEmail]);

  return rows.length > 0;
}

/**
 * Check if user is a department member
 */
async function isDepartmentMember(db, departmentId, userEmail) {
  if (!userEmail || !departmentId) return false;

  const { rows } = await db.query(`
    SELECT 1 FROM ${DEFAULT_SCHEMA}.department_members
    WHERE department_id = $1 AND LOWER(email) = LOWER($2)
    LIMIT 1
  `, [departmentId, userEmail]);

  return rows.length > 0;
}

/**
 * Extract @note:123 mentions from message content
 */
function extractNoteMentions(content) {
  if (!content || typeof content !== "string") return [];
  const regex = /@note:(\d+)/g;
  const mentions = new Set();
  let match;
  while ((match = regex.exec(content)) !== null) {
    mentions.add(parseInt(match[1], 10));
  }
  return Array.from(mentions);
}

/**
 * Save note mentions for a message
 */
async function saveNoteMentions(db, messageId, noteIds) {
  if (!noteIds || noteIds.length === 0) return;

  for (const noteId of noteIds) {
    try {
      await db.query(`
        INSERT INTO ${DEFAULT_SCHEMA}.chatroom_message_mentions (message_id, mentioned_note_id)
        VALUES ($1, $2)
        ON CONFLICT (message_id, mentioned_note_id) DO NOTHING
      `, [messageId, noteId]);
    } catch (e) {
      console.error(`Error saving note mention ${noteId}:`, e.message);
    }
  }
}

/**
 * Create a chatroom for a candidate/application
 */
async function createChatroomForCandidate(db, candidateId, applicationId, departmentId, createdBy) {
  // Get candidate and job info for display name
  const { rows: candidates } = await db.query(`
    SELECT c.first_name, c.last_name, jl.job_title, jl.department
    FROM ${PEOPLE_TABLE} c
    LEFT JOIN ${APP_TABLE} a ON a.${PEOPLE_PK} = c.${PEOPLE_PK}
    LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON jl.job_requisition_id = a.job_requisition_id
    WHERE c.${PEOPLE_PK} = $1
    ${applicationId ? `AND a.${APP_PK} = $2` : ''}
    LIMIT 1
  `, applicationId ? [candidateId, applicationId] : [candidateId]);

  if (!candidates.length) {
    throw new Error("candidate_not_found");
  }

  const candidate = candidates[0];
  const candidateName = [candidate.first_name, candidate.last_name].filter(Boolean).join(" ").trim() || "Unknown";
  const jobTitle = candidate.job_title || null;
  const displayName = jobTitle ? `${candidateName} - ${jobTitle}` : candidateName;

  // Resolve department ID if not provided
  let resolvedDeptId = departmentId;
  if (!resolvedDeptId && candidate.department) {
    const { rows: depts } = await db.query(`
      SELECT id FROM ${DEFAULT_SCHEMA}.departments WHERE LOWER(name) = LOWER($1) LIMIT 1
    `, [candidate.department]);
    if (depts.length) resolvedDeptId = depts[0].id;
  }

  // Create chatroom
  const { rows: chatrooms } = await db.query(`
    INSERT INTO ${DEFAULT_SCHEMA}.chatrooms
      (candidate_id, application_id, department_id, display_name, candidate_name, job_title, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (candidate_id, application_id) DO UPDATE SET updated_at = NOW()
    RETURNING *
  `, [candidateId, applicationId || null, resolvedDeptId || null, displayName, candidateName, jobTitle, createdBy]);

  const chatroom = chatrooms[0];

  // Auto-link resume and cover letter
  if (applicationId) {
    const { rows: apps } = await db.query(`
      SELECT resume_url, cover_letter_url FROM ${APP_TABLE} WHERE ${APP_PK} = $1
    `, [applicationId]);

    if (apps.length) {
      const app = apps[0];
      if (app.resume_url) {
        await db.query(`
          INSERT INTO ${DEFAULT_SCHEMA}.chatroom_attachments
            (chatroom_id, attachment_type, file_name, file_url, source, source_table, source_id)
          VALUES ($1, 'resume', $2, $3, 'auto', 'applications', $4)
          ON CONFLICT (chatroom_id, attachment_type, file_url) DO NOTHING
        `, [chatroom.id, app.resume_url.split('/').pop() || 'resume', app.resume_url, applicationId]);
      }
      if (app.cover_letter_url) {
        await db.query(`
          INSERT INTO ${DEFAULT_SCHEMA}.chatroom_attachments
            (chatroom_id, attachment_type, file_name, file_url, source, source_table, source_id)
          VALUES ($1, 'cover_letter', $2, $3, 'auto', 'applications', $4)
          ON CONFLICT (chatroom_id, attachment_type, file_url) DO NOTHING
        `, [chatroom.id, app.cover_letter_url.split('/').pop() || 'cover_letter', app.cover_letter_url, applicationId]);
      }
    }
  }

  return chatroom;
}

/**
 * Middleware to require chatroom access
 */
function requireChatroomAccess(req, res, next) {
  const chatroomId = parseInt(req.params.id || req.params.chatroomId, 10);
  const userEmail = getPrimaryEmail(req);

  if (!chatroomId || !Number.isFinite(chatroomId)) {
    return res.status(400).json({ error: "invalid_chatroom_id" });
  }

  // Admins always have access
  if (isAdmin(req)) {
    req.chatroomAccess = true;
    return next();
  }

  canAccessChatroom(req.db, chatroomId, userEmail)
    .then(hasAccess => {
      if (!hasAccess) {
        return res.status(403).json({ error: "chatroom_access_denied" });
      }
      req.chatroomAccess = true;
      next();
    })
    .catch(err => {
      console.error("Error checking chatroom access:", err);
      return res.status(500).json({ error: "db_error", detail: err.message });
    });
}

// ==================== CHATROOM CRUD ====================

// GET /chatrooms - List chatrooms with search and filters
router.get("/", async (req, res) => {
  try {
    const userEmail = getPrimaryEmail(req);
    const admin = isAdmin(req);
    const { department_id, search, status, limit = 50, offset = 0 } = req.query;

    let whereConditions = ["1=1"];
    let params = [];
    let paramIndex = 1;

    // Filter by department
    if (department_id) {
      whereConditions.push(`c.department_id = $${paramIndex++}`);
      params.push(parseInt(department_id, 10));
    }

    // Filter by status
    if (status && status !== "all") {
      whereConditions.push(`c.status = $${paramIndex++}`);
      params.push(status);
    } else {
      // Default to active only
      whereConditions.push(`c.status = 'active'`);
    }

    // Search by display_name or job_title
    if (search) {
      whereConditions.push(`(
        c.display_name ILIKE $${paramIndex}
        OR c.job_title ILIKE $${paramIndex}
        OR c.candidate_name ILIKE $${paramIndex}
      )`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    // Non-admins can only see chatrooms based on department membership AND job-level access
    if (!admin && userEmail) {
      whereConditions.push(`(
        c.department_id IS NULL
        OR EXISTS (
          SELECT 1 FROM ${DEFAULT_SCHEMA}.department_members dm
          LEFT JOIN ${DEFAULT_SCHEMA}.applications a ON a.${APP_PK} = c.application_id
          LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON jl.job_requisition_id = a.job_requisition_id
          WHERE dm.department_id = c.department_id
            AND LOWER(dm.email) = LOWER($${paramIndex})
            AND (
              -- User has 'all' access scope
              COALESCE(dm.access_scope, 'all') = 'all'
              OR
              -- User has specific job access
              EXISTS (
                SELECT 1 FROM ${DEFAULT_SCHEMA}.department_member_job_access ja
                WHERE ja.department_id = c.department_id
                  AND LOWER(ja.member_email) = LOWER($${paramIndex})
                  AND ja.job_listing_id = jl.job_listing_id
              )
              OR
              -- Chatroom has no associated application/job
              c.application_id IS NULL
            )
        )
      )`);
      params.push(userEmail);
      paramIndex++;
    }

    // Add pagination
    params.push(parseInt(limit, 10) || 50);
    params.push(parseInt(offset, 10) || 0);

    const query = `
      SELECT
        c.*,
        (
          SELECT COUNT(*) FROM ${DEFAULT_SCHEMA}.chatroom_messages m
          WHERE m.chatroom_id = c.id AND m.deleted_at IS NULL
        ) as actual_message_count,
        (
          SELECT json_agg(json_build_object(
            'type', ca.attachment_type,
            'file_name', ca.file_name,
            'file_url', ca.file_url
          ))
          FROM ${DEFAULT_SCHEMA}.chatroom_attachments ca
          WHERE ca.chatroom_id = c.id
        ) as attachments,
        ${userEmail ? `(
          SELECT COUNT(*) FROM ${DEFAULT_SCHEMA}.chatroom_messages m
          WHERE m.chatroom_id = c.id
            AND m.deleted_at IS NULL
            AND m.id > COALESCE(
              (SELECT last_read_message_id FROM ${DEFAULT_SCHEMA}.chatroom_participants cp
               WHERE cp.chatroom_id = c.id AND LOWER(cp.email) = LOWER('${userEmail.replace(/'/g, "''")}')),
              0
            )
        )` : '0'} as unread_count
      FROM ${DEFAULT_SCHEMA}.chatrooms c
      WHERE ${whereConditions.join(" AND ")}
      ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const { rows: chatrooms } = await req.db.query(query, params);

    // Get total count (exclude LIMIT/OFFSET params which are the last 2)
    const countQuery = `
      SELECT COUNT(*) as total
      FROM ${DEFAULT_SCHEMA}.chatrooms c
      WHERE ${whereConditions.join(" AND ")}
    `;
    const { rows: countRows } = await req.db.query(countQuery, params.slice(0, -2));
    const total = parseInt(countRows[0]?.total || 0, 10);

    return res.json({
      chatrooms: chatrooms.map(c => ({
        ...c,
        attachments: c.attachments || []
      })),
      total,
      has_more: (parseInt(offset, 10) || 0) + chatrooms.length < total
    });
  } catch (e) {
    console.error("Error listing chatrooms:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// GET /chatrooms/unread-counts - Get unread message counts for all chatrooms
router.get("/unread-counts", async (req, res) => {
  try {
    const userEmail = getPrimaryEmail(req);
    if (!userEmail) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    const { rows } = await req.db.query(`
      SELECT
        c.id as chatroom_id,
        c.department_id,
        COUNT(m.id) as unread_count
      FROM ${DEFAULT_SCHEMA}.chatrooms c
      LEFT JOIN ${DEFAULT_SCHEMA}.chatroom_participants cp
        ON cp.chatroom_id = c.id AND LOWER(cp.email) = LOWER($1)
      LEFT JOIN ${DEFAULT_SCHEMA}.chatroom_messages m
        ON m.chatroom_id = c.id
        AND m.deleted_at IS NULL
        AND m.id > COALESCE(cp.last_read_message_id, 0)
      WHERE c.status = 'active'
      GROUP BY c.id, c.department_id
      HAVING COUNT(m.id) > 0
    `, [userEmail]);

    return res.json({ unread: rows });
  } catch (e) {
    console.error("Error getting unread counts:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// GET /chatrooms/:id - Get single chatroom with attachments
router.get("/:id", requireChatroomAccess, async (req, res) => {
  try {
    const chatroomId = parseInt(req.params.id, 10);
    const userEmail = getPrimaryEmail(req);

    const { rows: chatrooms } = await req.db.query(`
      SELECT c.*
      FROM ${DEFAULT_SCHEMA}.chatrooms c
      WHERE c.id = $1
    `, [chatroomId]);

    if (!chatrooms.length) {
      return res.status(404).json({ error: "chatroom_not_found" });
    }

    const chatroom = chatrooms[0];

    // Get attachments
    const { rows: attachments } = await req.db.query(`
      SELECT id, attachment_type, file_name, file_url, source, created_at
      FROM ${DEFAULT_SCHEMA}.chatroom_attachments
      WHERE chatroom_id = $1
      ORDER BY attachment_type, created_at
    `, [chatroomId]);

    // Update participant record (mark as seen)
    if (userEmail) {
      await req.db.query(`
        INSERT INTO ${DEFAULT_SCHEMA}.chatroom_participants (chatroom_id, email, last_read_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (chatroom_id, email) DO UPDATE SET last_read_at = NOW()
      `, [chatroomId, userEmail]);
    }

    return res.json({
      ...chatroom,
      attachments
    });
  } catch (e) {
    console.error("Error getting chatroom:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// POST /chatrooms - Create chatroom for candidate
router.post("/", async (req, res) => {
  try {
    const userEmail = getPrimaryEmail(req);
    const { candidate_id, application_id, department_id } = req.body || {};

    if (!candidate_id) {
      return res.status(400).json({ error: "candidate_id_required" });
    }

    // Check if user has access to this department (if specified)
    if (department_id && !isAdmin(req)) {
      const hasAccess = await isDepartmentMember(req.db, department_id, userEmail);
      if (!hasAccess) {
        return res.status(403).json({ error: "department_access_denied" });
      }
    }

    const chatroom = await createChatroomForCandidate(
      req.db,
      candidate_id,
      application_id,
      department_id,
      userEmail
    );

    // Get attachments
    const { rows: attachments } = await req.db.query(`
      SELECT id, attachment_type, file_name, file_url, source, created_at
      FROM ${DEFAULT_SCHEMA}.chatroom_attachments
      WHERE chatroom_id = $1
    `, [chatroom.id]);

    return res.status(201).json({
      ...chatroom,
      attachments
    });
  } catch (e) {
    console.error("Error creating chatroom:", e);
    if (e.message === "candidate_not_found") {
      return res.status(404).json({ error: "candidate_not_found" });
    }
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// DELETE /admin/chatrooms/:id - Delete chatroom (admin only)
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const chatroomId = parseInt(req.params.id, 10);

    // Delete chatroom (cascades to messages, attachments, participants)
    const { rowCount } = await req.db.query(`
      DELETE FROM ${DEFAULT_SCHEMA}.chatrooms WHERE id = $1
    `, [chatroomId]);

    if (rowCount === 0) {
      return res.status(404).json({ error: "chatroom_not_found" });
    }

    return res.json({ success: true });
  } catch (e) {
    console.error("Error deleting chatroom:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ==================== MESSAGES ====================

// GET /chatrooms/:id/messages - Get messages (paginated)
router.get("/:id/messages", requireChatroomAccess, async (req, res) => {
  try {
    const chatroomId = parseInt(req.params.id, 10);
    const userEmail = getPrimaryEmail(req);
    const { limit = 50, before, after } = req.query;

    let whereConditions = ["m.chatroom_id = $1", "m.deleted_at IS NULL"];
    let params = [chatroomId];
    let paramIndex = 2;

    // Pagination by message ID
    if (before) {
      whereConditions.push(`m.id < $${paramIndex++}`);
      params.push(parseInt(before, 10));
    }
    if (after) {
      whereConditions.push(`m.id > $${paramIndex++}`);
      params.push(parseInt(after, 10));
    }

    params.push(parseInt(limit, 10) || 50);

    const { rows: messages } = await req.db.query(`
      SELECT
        m.*,
        (
          SELECT json_agg(json_build_object('note_id', mm.mentioned_note_id))
          FROM ${DEFAULT_SCHEMA}.chatroom_message_mentions mm
          WHERE mm.message_id = m.id
        ) as note_mentions
      FROM ${DEFAULT_SCHEMA}.chatroom_messages m
      WHERE ${whereConditions.join(" AND ")}
      ORDER BY m.created_at ${after ? 'ASC' : 'DESC'}
      LIMIT $${paramIndex}
    `, params);

    // Update last read message
    if (userEmail && messages.length > 0) {
      const latestMessageId = Math.max(...messages.map(m => m.id));
      await req.db.query(`
        INSERT INTO ${DEFAULT_SCHEMA}.chatroom_participants (chatroom_id, email, last_read_at, last_read_message_id)
        VALUES ($1, $2, NOW(), $3)
        ON CONFLICT (chatroom_id, email) DO UPDATE SET
          last_read_at = NOW(),
          last_read_message_id = GREATEST(chatroom_participants.last_read_message_id, EXCLUDED.last_read_message_id)
      `, [chatroomId, userEmail, latestMessageId]);
    }

    // Return in chronological order
    const sortedMessages = after ? messages : messages.reverse();

    return res.json({
      messages: sortedMessages.map(m => ({
        ...m,
        note_mentions: m.note_mentions || []
      })),
      has_more: messages.length === parseInt(limit, 10)
    });
  } catch (e) {
    console.error("Error getting messages:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// POST /chatrooms/:id/messages - Send message
router.post("/:id/messages", requireChatroomAccess, async (req, res) => {
  try {
    const chatroomId = parseInt(req.params.id, 10);
    const userEmail = getPrimaryEmail(req);
    const { content, content_type = "text" } = req.body || {};

    if (!content || !content.trim()) {
      return res.status(400).json({ error: "content_required" });
    }

    // Get user display name
    const userName = req.session?.user?.displayName || userEmail;

    // Insert message
    const { rows: messages } = await req.db.query(`
      INSERT INTO ${DEFAULT_SCHEMA}.chatroom_messages
        (chatroom_id, content, content_type, author_email, author_name)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [chatroomId, content.trim(), content_type, userEmail, userName]);

    const message = messages[0];

    // Save note mentions
    const noteMentions = extractNoteMentions(content);
    if (noteMentions.length > 0) {
      await saveNoteMentions(req.db, message.id, noteMentions);
    }

    // Update participant record
    await req.db.query(`
      INSERT INTO ${DEFAULT_SCHEMA}.chatroom_participants (chatroom_id, email, last_read_at, last_read_message_id)
      VALUES ($1, $2, NOW(), $3)
      ON CONFLICT (chatroom_id, email) DO UPDATE SET
        last_read_at = NOW(),
        last_read_message_id = EXCLUDED.last_read_message_id
    `, [chatroomId, userEmail, message.id]);

    // Emit Socket.IO event for real-time updates
    const io = req.app.get("io");
    if (io) {
      io.to(`chatroom:${chatroomId}`).emit("chatroom:message", {
        chatroom_id: chatroomId,
        message: {
          ...message,
          note_mentions: noteMentions.map(id => ({ note_id: id }))
        }
      });

      // Emit notification event for other users
      io.emit("chatroom:notification", {
        chatroom_id: chatroomId,
        message_id: message.id,
        author_email: userEmail,
        author_name: userName,
        preview: content.substring(0, 100)
      });
    }

    return res.status(201).json({
      ...message,
      note_mentions: noteMentions.map(id => ({ note_id: id }))
    });
  } catch (e) {
    console.error("Error sending message:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// PUT /chatrooms/:id/messages/:msgId - Edit message (author only)
router.put("/:id/messages/:msgId", requireChatroomAccess, async (req, res) => {
  try {
    const chatroomId = parseInt(req.params.id, 10);
    const messageId = parseInt(req.params.msgId, 10);
    const userEmail = getPrimaryEmail(req);
    const { content } = req.body || {};

    if (!content || !content.trim()) {
      return res.status(400).json({ error: "content_required" });
    }

    // Check if user is author or admin
    const { rows: existing } = await req.db.query(`
      SELECT author_email FROM ${DEFAULT_SCHEMA}.chatroom_messages
      WHERE id = $1 AND chatroom_id = $2 AND deleted_at IS NULL
    `, [messageId, chatroomId]);

    if (!existing.length) {
      return res.status(404).json({ error: "message_not_found" });
    }

    if (existing[0].author_email.toLowerCase() !== userEmail?.toLowerCase() && !isAdmin(req)) {
      return res.status(403).json({ error: "not_author" });
    }

    // Update message
    const { rows: messages } = await req.db.query(`
      UPDATE ${DEFAULT_SCHEMA}.chatroom_messages
      SET content = $1, edited_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [content.trim(), messageId]);

    // Update note mentions
    await req.db.query(`
      DELETE FROM ${DEFAULT_SCHEMA}.chatroom_message_mentions WHERE message_id = $1
    `, [messageId]);

    const noteMentions = extractNoteMentions(content);
    if (noteMentions.length > 0) {
      await saveNoteMentions(req.db, messageId, noteMentions);
    }

    // Emit Socket.IO event
    const io = req.app.get("io");
    if (io) {
      io.to(`chatroom:${chatroomId}`).emit("chatroom:message:edited", {
        chatroom_id: chatroomId,
        message_id: messageId,
        content: content.trim(),
        edited_at: messages[0].edited_at
      });
    }

    return res.json({
      ...messages[0],
      note_mentions: noteMentions.map(id => ({ note_id: id }))
    });
  } catch (e) {
    console.error("Error editing message:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// DELETE /chatrooms/:id/messages/:msgId - Soft-delete message (admin only)
router.delete("/:id/messages/:msgId", requireAdmin, async (req, res) => {
  try {
    const chatroomId = parseInt(req.params.id, 10);
    const messageId = parseInt(req.params.msgId, 10);
    const userEmail = getPrimaryEmail(req);

    const { rowCount } = await req.db.query(`
      UPDATE ${DEFAULT_SCHEMA}.chatroom_messages
      SET deleted_at = NOW(), deleted_by = $1
      WHERE id = $2 AND chatroom_id = $3 AND deleted_at IS NULL
    `, [userEmail, messageId, chatroomId]);

    if (rowCount === 0) {
      return res.status(404).json({ error: "message_not_found" });
    }

    // Emit Socket.IO event
    const io = req.app.get("io");
    if (io) {
      io.to(`chatroom:${chatroomId}`).emit("chatroom:message:deleted", {
        chatroom_id: chatroomId,
        message_id: messageId,
        deleted_by: userEmail
      });
    }

    return res.json({ success: true });
  } catch (e) {
    console.error("Error deleting message:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// POST /chatrooms/:id/messages/:msgId/create-note - Convert message to department note
router.post("/:id/messages/:msgId/create-note", requireChatroomAccess, async (req, res) => {
  try {
    const chatroomId = parseInt(req.params.id, 10);
    const messageId = parseInt(req.params.msgId, 10);
    const userEmail = getPrimaryEmail(req);
    const { priority, is_pinned = false } = req.body || {};

    // Get the message and chatroom info
    const { rows: messages } = await req.db.query(`
      SELECT m.*, c.department_id, c.candidate_id
      FROM ${DEFAULT_SCHEMA}.chatroom_messages m
      JOIN ${DEFAULT_SCHEMA}.chatrooms c ON c.id = m.chatroom_id
      WHERE m.id = $1 AND m.chatroom_id = $2 AND m.deleted_at IS NULL
    `, [messageId, chatroomId]);

    if (!messages.length) {
      return res.status(404).json({ error: "message_not_found" });
    }

    const message = messages[0];

    if (!message.department_id) {
      return res.status(400).json({ error: "chatroom_has_no_department" });
    }

    // Create department note from message
    const noteContent = `[From chatroom message by ${message.author_name || message.author_email}]\n\n${message.content}`;

    const { rows: notes } = await req.db.query(`
      INSERT INTO ${DEFAULT_SCHEMA}.department_notes
        (department_id, content, visibility, author_email, priority, is_pinned)
      VALUES ($1, $2, 'shared', $3, $4, $5)
      RETURNING *
    `, [message.department_id, noteContent, userEmail, priority || null, is_pinned]);

    const note = notes[0];

    // Tag the candidate to this note
    if (message.candidate_id) {
      await req.db.query(`
        INSERT INTO ${DEFAULT_SCHEMA}.note_candidate_tags (note_id, candidate_id, tagged_by)
        VALUES ($1, $2, $3)
        ON CONFLICT (note_id, candidate_id) DO NOTHING
      `, [note.id, message.candidate_id, userEmail]);
    }

    return res.status(201).json({
      success: true,
      note_id: note.id,
      note
    });
  } catch (e) {
    console.error("Error creating note from message:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ==================== ATTACHMENTS ====================

// GET /chatrooms/:id/attachments - List attachments
router.get("/:id/attachments", requireChatroomAccess, async (req, res) => {
  try {
    const chatroomId = parseInt(req.params.id, 10);

    const { rows: attachments } = await req.db.query(`
      SELECT id, attachment_type, file_name, file_url, content_type, file_size, source, created_at, created_by
      FROM ${DEFAULT_SCHEMA}.chatroom_attachments
      WHERE chatroom_id = $1
      ORDER BY attachment_type, created_at
    `, [chatroomId]);

    return res.json({ attachments });
  } catch (e) {
    console.error("Error getting attachments:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// POST /chatrooms/:id/attachments - Add manual attachment
router.post("/:id/attachments", requireChatroomAccess, async (req, res) => {
  try {
    const chatroomId = parseInt(req.params.id, 10);
    const userEmail = getPrimaryEmail(req);
    const { attachment_type, file_name, file_url, content_type, file_size } = req.body || {};

    if (!file_url) {
      return res.status(400).json({ error: "file_url_required" });
    }

    const { rows: attachments } = await req.db.query(`
      INSERT INTO ${DEFAULT_SCHEMA}.chatroom_attachments
        (chatroom_id, attachment_type, file_name, file_url, content_type, file_size, source, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7)
      ON CONFLICT (chatroom_id, attachment_type, file_url) DO UPDATE SET
        file_name = COALESCE(EXCLUDED.file_name, chatroom_attachments.file_name)
      RETURNING *
    `, [chatroomId, attachment_type || 'document', file_name, file_url, content_type, file_size, userEmail]);

    return res.status(201).json(attachments[0]);
  } catch (e) {
    console.error("Error adding attachment:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ==================== APPLICANT INFO PANEL ====================

// GET /chatrooms/:id/applicant-info - Get aggregated candidate info for sidebar panel
router.get("/:id/applicant-info", requireChatroomAccess, async (req, res) => {
  try {
    const chatroomId = parseInt(req.params.id, 10);

    // Get chatroom with candidate and application IDs
    const { rows: chatrooms } = await req.db.query(`
      SELECT c.*,
             cand.first_name, cand.last_name, cand.email, cand.phone, cand.linkedin_url,
             cand.city, cand.state, cand.country,
             a.application_date, a.resume_url, a.cover_letter_url,
             jl.job_title, jl.department as job_department
      FROM ${DEFAULT_SCHEMA}.chatrooms c
      LEFT JOIN ${PEOPLE_TABLE} cand ON cand.${PEOPLE_PK} = c.candidate_id
      LEFT JOIN ${APP_TABLE} a ON a.${APP_PK} = c.application_id
      LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON jl.job_requisition_id = a.job_requisition_id
      WHERE c.id = $1
    `, [chatroomId]);

    if (!chatrooms.length) {
      return res.status(404).json({ error: "chatroom_not_found" });
    }

    const chatroom = chatrooms[0];
    const candidateId = chatroom.candidate_id;
    const applicationId = chatroom.application_id;

    // Build candidate info
    const locationParts = [chatroom.city, chatroom.state, chatroom.country].filter(Boolean);
    const candidate = {
      id: candidateId,
      first_name: chatroom.first_name,
      last_name: chatroom.last_name,
      name: [chatroom.first_name, chatroom.last_name].filter(Boolean).join(" ") || "Unknown",
      email: chatroom.email,
      phone: chatroom.phone,
      location: locationParts.length > 0 ? locationParts.join(", ") : null,
      linkedin_url: chatroom.linkedin_url
    };

    // Build application info
    const application = applicationId ? {
      id: applicationId,
      job_title: chatroom.job_title,
      department: chatroom.job_department,
      applied_date: chatroom.application_date,
      status: null // Will be fetched below
    } : null;

    // Get latest application stage/status
    if (applicationId) {
      const { rows: stages } = await req.db.query(`
        SELECT status, updated_at
        FROM ${DEFAULT_SCHEMA}.application_stages
        WHERE application_id = $1
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1
      `, [applicationId]);
      if (stages.length) {
        application.status = stages[0].status;
        application.status_updated_at = stages[0].updated_at;
      }
    }

    // Get AI score
    let aiScore = null;
    if (candidateId) {
      const { rows: scores } = await req.db.query(`
        SELECT overall_score, experience_fit, skills_fit, culture_fit, location_fit,
               strengths, risk_flags, created_at as scored_at
        FROM ${DEFAULT_SCHEMA}.candidate_ai_scores
        WHERE candidate_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `, [candidateId]);
      if (scores.length) {
        const score = scores[0];
        aiScore = {
          overall: score.overall_score,
          experience_fit: score.experience_fit,
          skills_fit: score.skills_fit,
          culture_fit: score.culture_fit,
          location_fit: score.location_fit,
          strengths: score.strengths || [],
          weaknesses: score.risk_flags || [],
          scored_at: score.scored_at
        };
      }
    }

    // Get recent notes tagged to this candidate (last 5)
    let recentNotes = [];
    if (candidateId && chatroom.department_id) {
      const { rows: notes } = await req.db.query(`
        SELECT dn.id, SUBSTRING(dn.content, 1, 150) as preview,
               dn.author_email, dn.created_at
        FROM ${DEFAULT_SCHEMA}.note_candidate_tags nct
        JOIN ${DEFAULT_SCHEMA}.department_notes dn ON dn.id = nct.note_id
        WHERE nct.candidate_id = $1 AND dn.department_id = $2
        ORDER BY dn.created_at DESC
        LIMIT 5
      `, [candidateId, chatroom.department_id]);
      recentNotes = notes;
    }

    // Get documents (resume, cover letter)
    const documents = {
      resume_url: chatroom.resume_url || null,
      cover_letter_url: chatroom.cover_letter_url || null
    };

    // Get interview status (from application_stages with interview-related status)
    let interview = null;
    if (applicationId) {
      const { rows: interviews } = await req.db.query(`
        SELECT status, updated_at
        FROM ${DEFAULT_SCHEMA}.application_stages
        WHERE application_id = $1
          AND LOWER(status) LIKE '%interview%'
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1
      `, [applicationId]);
      if (interviews.length) {
        interview = {
          status: interviews[0].status,
          updated_at: interviews[0].updated_at
        };
      }
    }

    return res.json({
      candidate,
      application,
      aiScore,
      documents,
      recentNotes,
      interview,
      chatroom: {
        id: chatroom.id,
        display_name: chatroom.display_name,
        department_id: chatroom.department_id,
        created_at: chatroom.created_at
      }
    });
  } catch (e) {
    console.error("Error getting applicant info:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ==================== TRANSCRIPT SHARING ====================

const { generateChatroomTranscriptPDF } = require("../../../services/pdfService");
const emailService = require("../../../services/emailService");

// POST /chatrooms/:id/share/pdf - Generate transcript PDF
router.post("/:id/share/pdf", requireChatroomAccess, async (req, res) => {
  try {
    const chatroomId = parseInt(req.params.id, 10);
    const { options = {}, startDate, endDate } = req.body;

    // Get chatroom with candidate info
    const { rows: chatrooms } = await req.db.query(`
      SELECT c.*, cand.first_name, cand.last_name, cand.email as candidate_email,
             jl.job_title
      FROM ${DEFAULT_SCHEMA}.chatrooms c
      LEFT JOIN ${PEOPLE_TABLE} cand ON cand.${PEOPLE_PK} = c.candidate_id
      LEFT JOIN ${APP_TABLE} a ON a.${APP_PK} = c.application_id
      LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON jl.job_requisition_id = a.job_requisition_id
      WHERE c.id = $1
    `, [chatroomId]);

    if (!chatrooms.length) {
      return res.status(404).json({ error: "chatroom_not_found" });
    }

    const chatroom = chatrooms[0];

    // Build messages query with optional date filter
    let messagesQuery = `
      SELECT m.*
      FROM ${DEFAULT_SCHEMA}.chatroom_messages m
      WHERE m.chatroom_id = $1
    `;
    const queryParams = [chatroomId];

    if (startDate) {
      queryParams.push(startDate);
      messagesQuery += ` AND m.created_at >= $${queryParams.length}`;
    }
    if (endDate) {
      queryParams.push(endDate);
      messagesQuery += ` AND m.created_at <= $${queryParams.length}`;
    }

    messagesQuery += ` ORDER BY m.created_at ASC`;

    const { rows: messages } = await req.db.query(messagesQuery, queryParams);

    // Get tenant branding
    let branding = { companyName: "Company", primaryColor: "#2d5a27" };
    try {
      const { rows: brandingRows } = await req.db.query(`
        SELECT * FROM ${DEFAULT_SCHEMA}.tenant_branding LIMIT 1
      `);
      if (brandingRows.length) {
        branding = {
          companyName: brandingRows[0].company_name || "Company",
          logoUrl: brandingRows[0].logo_url,
          primaryColor: brandingRows[0].primary_color || "#2d5a27",
        };
      }
    } catch (e) {
      console.warn("Could not fetch branding:", e.message);
    }

    // Build candidate info for PDF
    const candidate = {
      name: [chatroom.first_name, chatroom.last_name].filter(Boolean).join(" ") || "Unknown",
      email: chatroom.candidate_email,
      job_title: chatroom.job_title,
    };

    // Generate PDF
    const pdfBuffer = await generateChatroomTranscriptPDF(
      { chatroom, candidate, messages },
      branding,
      options
    );

    // Generate filename
    const candidateName = candidate.name.replace(/[^a-zA-Z0-9]/g, "_");
    const dateStr = new Date().toISOString().split("T")[0];
    const filename = `transcript_${candidateName}_${dateStr}.pdf`;

    return res.json({
      success: true,
      pdf: pdfBuffer.toString("base64"),
      filename,
    });
  } catch (e) {
    console.error("Error generating transcript PDF:", e);
    return res.status(500).json({ error: "pdf_error", detail: e.message });
  }
});

// POST /chatrooms/:id/share/email - Email transcript
router.post("/:id/share/email", requireChatroomAccess, async (req, res) => {
  try {
    const chatroomId = parseInt(req.params.id, 10);
    const { recipients, subject, message, options = {}, startDate, endDate } = req.body;

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: "recipients_required" });
    }

    // Get chatroom with candidate info
    const { rows: chatrooms } = await req.db.query(`
      SELECT c.*, cand.first_name, cand.last_name, cand.email as candidate_email,
             jl.job_title
      FROM ${DEFAULT_SCHEMA}.chatrooms c
      LEFT JOIN ${PEOPLE_TABLE} cand ON cand.${PEOPLE_PK} = c.candidate_id
      LEFT JOIN ${APP_TABLE} a ON a.${APP_PK} = c.application_id
      LEFT JOIN ${DEFAULT_SCHEMA}.job_listings jl ON jl.job_requisition_id = a.job_requisition_id
      WHERE c.id = $1
    `, [chatroomId]);

    if (!chatrooms.length) {
      return res.status(404).json({ error: "chatroom_not_found" });
    }

    const chatroom = chatrooms[0];

    // Build messages query with optional date filter
    let messagesQuery = `
      SELECT m.*
      FROM ${DEFAULT_SCHEMA}.chatroom_messages m
      WHERE m.chatroom_id = $1
    `;
    const queryParams = [chatroomId];

    if (startDate) {
      queryParams.push(startDate);
      messagesQuery += ` AND m.created_at >= $${queryParams.length}`;
    }
    if (endDate) {
      queryParams.push(endDate);
      messagesQuery += ` AND m.created_at <= $${queryParams.length}`;
    }

    messagesQuery += ` ORDER BY m.created_at ASC`;

    const { rows: messages } = await req.db.query(messagesQuery, queryParams);

    // Get tenant branding
    let branding = { companyName: "Company", primaryColor: "#2d5a27" };
    try {
      const { rows: brandingRows } = await req.db.query(`
        SELECT * FROM ${DEFAULT_SCHEMA}.tenant_branding LIMIT 1
      `);
      if (brandingRows.length) {
        branding = {
          companyName: brandingRows[0].company_name || "Company",
          logoUrl: brandingRows[0].logo_url,
          primaryColor: brandingRows[0].primary_color || "#2d5a27",
        };
      }
    } catch (e) {
      console.warn("Could not fetch branding:", e.message);
    }

    // Build candidate info for PDF
    const candidate = {
      name: [chatroom.first_name, chatroom.last_name].filter(Boolean).join(" ") || "Unknown",
      email: chatroom.candidate_email,
      job_title: chatroom.job_title,
    };

    // Generate PDF
    const pdfBuffer = await generateChatroomTranscriptPDF(
      { chatroom, candidate, messages },
      branding,
      options
    );

    // Generate filename
    const candidateName = candidate.name.replace(/[^a-zA-Z0-9]/g, "_");
    const dateStr = new Date().toISOString().split("T")[0];
    const filename = `transcript_${candidateName}_${dateStr}.pdf`;

    // Send email with PDF attachment
    const senderEmail = getPrimaryEmail(req);
    const emailSubject = subject || `Chatroom Transcript: ${candidate.name}`;
    const emailBody = message
      ? `${message}\n\n---\nPlease find the chatroom transcript attached.`
      : `Please find the chatroom transcript for ${candidate.name} attached.\n\nThis transcript was shared from the ${branding.companyName} Applicant Tracking System.`;

    // Send to each recipient
    const sendPromises = recipients.map((recipient) =>
      emailService.sendMailWithAttachment({
        to: recipient,
        subject: emailSubject,
        html: `<p>${emailBody.replace(/\n/g, "<br>")}</p>`,
        text: emailBody,
        attachments: [{
          content: pdfBuffer,
          filename,
          contentType: "application/pdf",
        }],
      }).catch((err) => ({ error: err.message, recipient }))
    );

    const results = await Promise.all(sendPromises);
    const failures = results.filter((r) => r && r.error);

    if (failures.length === recipients.length) {
      return res.status(500).json({
        error: "email_failed",
        detail: "Failed to send to all recipients",
        failures,
      });
    }

    return res.json({
      success: true,
      sent: recipients.length - failures.length,
      failures: failures.length > 0 ? failures : undefined,
    });
  } catch (e) {
    console.error("Error emailing transcript:", e);
    return res.status(500).json({ error: "email_error", detail: e.message });
  }
});

// ==================== NOTES INTEGRATION ====================

// GET /chatrooms/:id/searchable-notes - Get notes for @mention autocomplete
router.get("/:id/searchable-notes", requireChatroomAccess, async (req, res) => {
  try {
    const chatroomId = parseInt(req.params.id, 10);
    const { search, limit = 20 } = req.query;

    // Get department_id from chatroom
    const { rows: chatrooms } = await req.db.query(`
      SELECT department_id FROM ${DEFAULT_SCHEMA}.chatrooms WHERE id = $1
    `, [chatroomId]);

    if (!chatrooms.length || !chatrooms[0].department_id) {
      return res.json({ notes: [] });
    }

    const departmentId = chatrooms[0].department_id;

    let query = `
      SELECT id, SUBSTRING(content, 1, 100) as preview, author_email, created_at
      FROM ${DEFAULT_SCHEMA}.department_notes
      WHERE department_id = $1
    `;
    let params = [departmentId];

    if (search) {
      query += ` AND content ILIKE $2`;
      params.push(`%${search}%`);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit, 10));

    const { rows: notes } = await req.db.query(query, params);

    return res.json({ notes });
  } catch (e) {
    console.error("Error searching notes:", e);
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ==================== TYPING INDICATORS (via Socket.IO) ====================
// These are handled directly in app.js Socket.IO handlers

// Export router and helper functions
module.exports = router;
module.exports.createChatroomForCandidate = createChatroomForCandidate;
module.exports.canAccessChatroom = canAccessChatroom;
module.exports.extractNoteMentions = extractNoteMentions;
