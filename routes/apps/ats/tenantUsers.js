/**
 * Tenant User Management Routes
 *
 * CRUD endpoints for managing the tenant_users allowlist in the master database.
 * All routes require tenant admin privileges.
 *
 * Routes:
 *   GET    /tenant-users          - List all tenant users with seat info
 *   POST   /tenant-users          - Invite/add a user by email
 *   PUT    /tenant-users/:userId  - Update a user (role, name, active)
 *   DELETE /tenant-users/:userId  - Deactivate a user (soft delete)
 */

const express = require("express");
const router = express.Router();
const dbManager = require("../../../dbManager");
const { requireTenantAdmin } = require("../../../middleware/tenantResolver");
const { getPrimaryEmail } = require("./helpers");

// All routes require tenant admin
router.use(requireTenantAdmin);

// GET / - List all tenant users with seat info
router.get("/", async (req, res) => {
  try {
    if (!req.tenantMode || !req.tenantId) {
      return res.status(400).json({ error: "tenant_required" });
    }
    const users = await dbManager.getTenantUsers(req.tenantId);
    const allTenants = dbManager.getAllTenantConfigs();
    const tenantConfig = allTenants.find((t) => t.id === req.tenantId);
    const activeCount = users.filter((u) => u.is_active).length;
    const maxSeats = tenantConfig?.max_seats || 5;

    return res.json({
      users,
      total: users.length,
      active_count: activeCount,
      max_seats: maxSeats,
      seats_remaining: maxSeats - activeCount,
    });
  } catch (e) {
    console.error("[tenant-users] List error:", e.message);
    return res.status(500).json({ error: "internal_error", message: e.message });
  }
});

// POST / - Invite/add a user by email
router.post("/", async (req, res) => {
  try {
    if (!req.tenantMode || !req.tenantId) {
      return res.status(400).json({ error: "tenant_required" });
    }

    const { email, role, first_name, last_name } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: "email_required" });
    }

    const normalizedEmail = email.toLowerCase().trim();
    if (!normalizedEmail.includes("@")) {
      return res.status(400).json({ error: "invalid_email" });
    }

    // Look up inviter's tenant_user id
    const inviterEmail = getPrimaryEmail(req);
    let invitedBy = null;
    if (inviterEmail) {
      const inviterResult = await dbManager.getMasterDb().query(
        `SELECT id FROM tenant_users WHERE tenant_id = $1 AND email = $2`,
        [req.tenantId, inviterEmail]
      );
      invitedBy = inviterResult.rows[0]?.id || null;
    }

    const newUser = await dbManager.addTenantUser(
      req.tenantId,
      normalizedEmail,
      role || "user",
      invitedBy,
      first_name || null,
      last_name || null
    );

    return res.status(201).json(newUser);
  } catch (e) {
    console.error("[tenant-users] Add error:", e.message);
    if (e.message.includes("Seat limit")) {
      return res
        .status(409)
        .json({ error: "seat_limit_reached", message: e.message });
    }
    return res.status(500).json({ error: "internal_error", message: e.message });
  }
});

// PUT /:userId - Update a tenant user
router.put("/:userId", async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (isNaN(userId)) {
      return res.status(400).json({ error: "invalid_user_id" });
    }

    const { role, first_name, last_name, is_active } = req.body || {};

    const updates = [];
    const params = [];
    let idx = 1;

    if (role !== undefined) {
      updates.push(`role = $${idx++}`);
      params.push(role);
    }
    if (first_name !== undefined) {
      updates.push(`first_name = $${idx++}`);
      params.push(first_name);
    }
    if (last_name !== undefined) {
      updates.push(`last_name = $${idx++}`);
      params.push(last_name);
    }
    if (is_active !== undefined) {
      updates.push(`is_active = $${idx++}`);
      params.push(is_active);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "no_updates" });
    }

    params.push(userId, req.tenantId);
    const result = await dbManager.getMasterDb().query(
      `UPDATE tenant_users SET ${updates.join(", ")}, updated_at = NOW()
       WHERE id = $${idx} AND tenant_id = $${idx + 1}
       RETURNING *`,
      params
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "user_not_found" });
    }
    return res.json(result.rows[0]);
  } catch (e) {
    console.error("[tenant-users] Update error:", e.message);
    return res.status(500).json({ error: "internal_error", message: e.message });
  }
});

// DELETE /:userId - Deactivate a tenant user (soft delete)
router.delete("/:userId", async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (isNaN(userId)) {
      return res.status(400).json({ error: "invalid_user_id" });
    }

    // Prevent self-deactivation
    const currentEmail = getPrimaryEmail(req);
    if (currentEmail) {
      const targetUser = await dbManager.getMasterDb().query(
        `SELECT email FROM tenant_users WHERE id = $1 AND tenant_id = $2`,
        [userId, req.tenantId]
      );
      if (targetUser.rows[0]?.email === currentEmail) {
        return res
          .status(400)
          .json({ error: "cannot_deactivate_self" });
      }
    }

    const result = await dbManager.deactivateTenantUser(req.tenantId, userId);
    if (!result) {
      return res.status(404).json({ error: "user_not_found" });
    }
    return res.json({ success: true, deactivated: result });
  } catch (e) {
    console.error("[tenant-users] Deactivate error:", e.message);
    return res.status(500).json({ error: "internal_error", message: e.message });
  }
});

module.exports = router;
