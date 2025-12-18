/**
 * Shared helpers and utilities for ATS routes
 * Extracted from monolithic ats.js for better maintainability
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const mime = require("mime-types");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const ExcelJS = require("exceljs");

// Centralized configuration
const config = require("../../../config");

// --- JSON Repair (optional dependency) ---
let jsonrepairFn = null;
try {
  const jr = require("jsonrepair");
  if (typeof jr === "function") jsonrepairFn = jr;
  else if (jr && typeof jr.jsonrepair === "function")
    jsonrepairFn = jr.jsonrepair;
} catch {}

// --- OpenAI Client ---
let _openaiClient = null;

function getOpenAIClient() {
  if (!config.ai.openaiApiKey) {
    throw new Error("openai_not_configured");
  }
  if (!_openaiClient) {
    try {
      const OpenAI = require("openai");
      _openaiClient = new OpenAI({ apiKey: config.ai.openaiApiKey });
    } catch (e) {
      throw new Error("openai_sdk_not_installed");
    }
  }
  return _openaiClient;
}

// --- Database Schema Constants ---
const DEFAULT_SCHEMA = config.db.schema;
const qualify = (name) =>
  name.includes(".") ? name : `${DEFAULT_SCHEMA}.${name}`;

const PEOPLE_TABLE_NAME = config.atsTables.peopleTable;
const PEOPLE_TABLE = qualify(PEOPLE_TABLE_NAME);
const PEOPLE_PK = config.atsTables.peoplePk;

const APP_TABLE_NAME = config.atsTables.applicationsTable;
const APP_TABLE = qualify(APP_TABLE_NAME);
const APP_PK = config.atsTables.applicationsPk;

const ATS_ATTACHMENTS_TABLE = config.atsTables.attachmentsTable;

// --- File Storage Config ---
const FILES_ROOT = config.files.root;
const FILES_PUBLIC_URL = config.files.publicUrl;
const MAX_UPLOAD_MB = config.files.maxUploadMb;
const MAX_UPLOAD_BYTES = Math.max(1, MAX_UPLOAD_MB) * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// --- Admin Config ---
const ADMIN_EMAILS = config.admin.emails;

// --- File Helpers ---
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

// --- Admin Helpers ---
function isAdmin(req) {
  try {
    const user = req.session?.user || {};
    const emails = Array.isArray(user.emails) ? user.emails : [];
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

// --- User Helpers ---
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

function sanitizeOwnerKey(value) {
  return String(value || "anonymous")
    .toLowerCase()
    .replace(/[^a-z0-9@._-]/g, "_");
}

// --- Mention Helpers ---
function extractMentions(text) {
  if (!text || typeof text !== "string") return [];
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
      await db.query(
        `INSERT INTO ${DEFAULT_SCHEMA}.${mentionTable}(${referenceField}, mentioned_email, mentioned_by) VALUES ($1, $2, $3) ON CONFLICT (${referenceField}, mentioned_email) DO NOTHING`,
        [referenceId, email, mentionedBy]
      );
      await db.query(
        `INSERT INTO ${DEFAULT_SCHEMA}.notifications(user_email, type, reference_type, reference_id, message) VALUES ($1, $2, $3, $4, $5)`,
        [email, `${type}_mention`, type, referenceId, message]
      );
    } catch (e) {
      console.error(`Error saving mention for ${email}:`, e.message);
    }
  }
}

async function deleteMentions(db, type, referenceId) {
  const mentionTable = type === "note" ? "note_mentions" : "idea_mentions";
  const referenceField = type === "note" ? "note_id" : "idea_id";

  await db.query(
    `DELETE FROM ${DEFAULT_SCHEMA}.${mentionTable} WHERE ${referenceField} = $1`,
    [referenceId]
  );
}

async function fetchMentions(db, type, referenceId) {
  const mentionTable = type === "note" ? "note_mentions" : "idea_mentions";
  const referenceField = type === "note" ? "note_id" : "idea_id";

  const result = await db.query(
    `SELECT mentioned_email, mentioned_by, created_at FROM ${DEFAULT_SCHEMA}.${mentionTable} WHERE ${referenceField} = $1`,
    [referenceId]
  );
  return result.rows;
}

// --- Resume Text Extraction ---
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
    return buf ? buf.toString("utf8") : "";
  } catch {
    return "";
  }
}

// --- Database Helpers ---
async function getTableColumns(db, tableName) {
  try {
    const schema = tableName.includes(".")
      ? tableName.split(".")[0]
      : DEFAULT_SCHEMA;
    const tbl = tableName.includes(".")
      ? tableName.split(".")[1]
      : tableName;
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      [schema, tbl]
    );
    return new Set((rows || []).map((r) => r.column_name));
  } catch {
    return new Set();
  }
}

async function ensureAdminTables(db) {
  try {
    await db.query(`SET search_path TO ${DEFAULT_SCHEMA}`);

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

module.exports = {
  // OpenAI
  getOpenAIClient,
  jsonrepairFn,
  OPENAI_API_KEY,

  // Database constants
  DEFAULT_SCHEMA,
  qualify,
  PEOPLE_TABLE_NAME,
  PEOPLE_TABLE,
  PEOPLE_PK,
  APP_TABLE_NAME,
  APP_TABLE,
  APP_PK,
  ATS_ATTACHMENTS_TABLE,

  // File storage
  FILES_ROOT,
  FILES_PUBLIC_URL,
  MAX_UPLOAD_MB,
  MAX_UPLOAD_BYTES,
  upload,

  // Admin
  ADMIN_EMAILS,
  isAdmin,
  requireAdmin,

  // File helpers
  ensureDir,
  safeFileName,
  safeJoin,
  slugify,
  pickExt,

  // User helpers
  getPrimaryEmail,
  sanitizeOwnerKey,

  // Mention helpers
  extractMentions,
  saveMentions,
  deleteMentions,
  fetchMentions,

  // Text extraction
  extractTextFromBuffer,

  // Database helpers
  getTableColumns,
  ensureAdminTables,
};
