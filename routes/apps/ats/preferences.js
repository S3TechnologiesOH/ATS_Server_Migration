/**
 * Preferences Routes Module
 * Handles all /preferences/* endpoints for user preferences
 */

const express = require("express");
const router = express.Router();

const {
  DEFAULT_SCHEMA,
  getPrimaryEmail,
} = require("./helpers");

// Helper to qualify table names
const qualify = (name) =>
  name.includes(".") ? name : `${DEFAULT_SCHEMA}.${name}`;

// ==================== PREFERENCES ====================
// GET /preferences - Get user preferences
router.get("/", async (req, res) => {
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

// PUT /preferences - Update user preferences (full replace)
router.put("/", async (req, res) => {
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

// PATCH /preferences/:section - Update specific preference section
router.patch("/:section", async (req, res) => {
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

module.exports = router;
