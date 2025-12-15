const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg"); // retained for legacy default usage (optional)
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const os = require("os");
const mime = require("mime-types");
const { ConfidentialClientApplication } = require("@azure/msal-node");
const axios = require("axios");
const swaggerUi = require("swagger-ui-express");
const jwt = require("jsonwebtoken");
const jwksRsa = require("jwks-rsa");
const { buildSpec, buildSpecForApp } = require("./swagger");
// Optional hardening (uncomment if installed):
// const helmet = require('helmet');
// const morgan = require('morgan');

require("dotenv").config(); // Load environment variables from .env early

// --- Environment Variable Validation ---
function validateEnvironment() {
  const errors = [];
  const warnings = [];

  // Required variables (critical - app cannot function without these)k
  const required = {
    SESSION_SECRET: process.env.SESSION_SECRET,
    DB_HOST: process.env.DB_HOST,
    DB_PORT: process.env.DB_PORT,
    DB_NAME: process.env.DB_NAME,
    DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD || process.env.POSTGRES_PASSWORD,
  };

  // Required for Azure AD authentication (if auth is enabled)
  const authRequired = {
    AZURE_AD_TENANT_ID: process.env.AZURE_AD_TENANT_ID,
    AZURE_AD_CLIENT_ID: process.env.AZURE_AD_CLIENT_ID,
    AZURE_AD_CLIENT_SECRET: process.env.AZURE_AD_CLIENT_SECRET,
  };

  // Check required variables
  Object.entries(required).forEach(([key, value]) => {
    if (!value || value.trim() === "") {
      errors.push(`${key} is required but not set`);
    }
  });

  // Check auth variables (warn if incomplete set)
  const authVarsSet = Object.values(authRequired).filter(
    (v) => v && v.trim()
  ).length;
  if (authVarsSet > 0 && authVarsSet < Object.keys(authRequired).length) {
    warnings.push(
      "Azure AD authentication is partially configured. Set all AZURE_AD_* variables or none."
    );
    Object.entries(authRequired).forEach(([key, value]) => {
      if (!value || value.trim() === "") {
        warnings.push(`  - ${key} is missing`);
      }
    });
  }

  // Check ATS database variables (if different from main DB)
  if (process.env.ATS_DB_HOST || process.env.ATS_DB_NAME) {
    const atsDbVars = {
      ATS_DB_HOST: process.env.ATS_DB_HOST,
      ATS_DB_PORT: process.env.ATS_DB_PORT,
      ATS_DB_NAME: process.env.ATS_DB_NAME,
      ATS_DB_USER: process.env.ATS_DB_USER,
      ATS_DB_PASSWORD:
        process.env.ATS_DB_PASSWORD || process.env.POSTGRES_PASSWORD,
    };
    Object.entries(atsDbVars).forEach(([key, value]) => {
      if (!value || value.trim() === "") {
        errors.push(`${key} is required when using separate ATS database`);
      }
    });
  }

  // Validate numeric values
  if (process.env.DB_PORT && isNaN(parseInt(process.env.DB_PORT))) {
    errors.push("DB_PORT must be a valid number");
  }
  if (process.env.ATS_DB_PORT && isNaN(parseInt(process.env.ATS_DB_PORT))) {
    errors.push("ATS_DB_PORT must be a valid number");
  }
  if (process.env.MAX_UPLOAD_MB && isNaN(parseInt(process.env.MAX_UPLOAD_MB))) {
    warnings.push("MAX_UPLOAD_MB is not a valid number, using default (25)");
  }

  // Check OAuth bearer token validation (if enabled)
  if (process.env.REQUIRE_BEARER_FOR_PUBLIC_APPLY === "1") {
    if (!process.env.OAUTH_TENANT_ID || !process.env.OAUTH_API_AUDIENCE) {
      errors.push(
        "REQUIRE_BEARER_FOR_PUBLIC_APPLY=1 requires OAUTH_TENANT_ID and OAUTH_API_AUDIENCE"
      );
    }
  }

  // Recommended but optional variables
  const recommended = {
    FILES_SIGNING_SECRET: process.env.FILES_SIGNING_SECRET,
    NODE_ENV: process.env.NODE_ENV,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };

  Object.entries(recommended).forEach(([key, value]) => {
    if (!value || value.trim() === "") {
      if (key === "FILES_SIGNING_SECRET") {
        warnings.push(
          `${key} not set, falling back to SESSION_SECRET (not recommended for production)`
        );
      } else if (key === "NODE_ENV") {
        warnings.push(`${key} not set, defaulting to development mode`);
      } else {
        warnings.push(`${key} not set, related features may be disabled`);
      }
    }
  });

  // Report results
  if (errors.length > 0) {
    console.error("\n❌ Environment validation failed:");
    errors.forEach((err) => console.error(`   • ${err}`));
    console.error(
      "\nSet these variables in your .env file or deployment environment.\n"
    );
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn("\n⚠️  Environment validation warnings:");
    warnings.forEach((warn) => console.warn(`   • ${warn}`));
    console.warn("");
  }

  console.log("✅ Environment validation passed");
}

// Run validation before app initialization
validateEnvironment();

const app = express();
const port = process.env.PORT || 3000;
// Central flag to control verbose backend debug noise (exclude application intake logging which lives in ats.js)
const VERBOSE_APP_DEBUG = 0;

// --- Configuration (env driven) ---
const {
  SESSION_SECRET = process.env.SESSION_SECRET,
  AZURE_AD_TENANT_ID,
  AZURE_AD_CLIENT_ID,
  AZURE_AD_CLIENT_SECRET,
  AZURE_AD_REDIRECT_URI = process.env.AZURE_AD_REDIRECT_URI ||
    "https://ats.s3protection.com/api/auth/callback",
  // Azure OAuth for service-to-service (client credentials) used by public site
  OAUTH_TENANT_ID = process.env.OAUTH_TENANT_ID,
  OAUTH_API_AUDIENCE = process.env.OAUTH_API_AUDIENCE,
  OAUTH_REQUIRED_ROLE = process.env.OAUTH_REQUIRED_ROLE,
  CW_CLIENT_ID,
  CW_CLIENT_SECRET,
  CW_REDIRECT_URI,
  CW_SCOPE = "company",
  FILES_ROOT = process.env.FILES_ROOT || "/app/app/uploads",
  FILES_PUBLIC_URL = process.env.FILES_PUBLIC_URL ||
    "https://ats.s3protection.com/api/files",
  MAX_UPLOAD_MB = process.env.MAX_UPLOAD_MB || "25",
  FILES_SIGNING_SECRET = process.env.FILES_SIGNING_SECRET ||
    process.env.SESSION_SECRET,
} = process.env;

// Log a short fingerprint to verify consistency across replicas (does not reveal the secret)
try {
  const fp = crypto
    .createHash("sha256")
    .update(String(FILES_SIGNING_SECRET || ""))
    .digest("hex")
    .slice(0, 8);
  if (!FILES_SIGNING_SECRET) {
    console.warn(
      "[Files] FILES_SIGNING_SECRET not set; falling back to SESSION_SECRET. Ensure all replicas share the same value."
    );
  }
  if (VERBOSE_APP_DEBUG)
    console.log(
      `[Files] Signing secret fingerprint: ${fp}; Public URL: ${FILES_PUBLIC_URL}`
    );
} catch {}

// --- Multi-app database pools ---
// Comma-separated app IDs in APPS env (e.g. "ats").
// If not provided, auto-discover from routes/apps/*.js and default to include 'ats'.
let APP_IDS = null;
if (process.env.APPS && process.env.APPS.trim()) {
  APP_IDS = process.env.APPS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
} else {
  try {
    const appsDir = path.join(__dirname, "routes", "apps");
    const files = fs.existsSync(appsDir) ? fs.readdirSync(appsDir) : [];
    const discovered = files
      .filter((f) => f.toLowerCase().endsWith(".js"))
      .map((f) => f.replace(/\.js$/i, ""));
    const base = ["ats"];
    APP_IDS = Array.from(new Set([...(discovered || []), ...base])).filter(
      Boolean
    );
  } catch {
    APP_IDS = ["ats"];
  }
}
const DEFAULT_APP = process.env.DEFAULT_APP || APP_IDS[0];
const { initPools, shutdownPools } = require("./multiTenant");
const pools = initPools(APP_IDS);

// Schema management is now handled by node-pg-migrate
// See migrations/ directory

function attachAppDb(appId, req) {
  req.appId = appId;
  req.db = pools[appId];
  if (VERBOSE_APP_DEBUG)
    console.log(
      `[DB_DEBUG] Request ${req.method} ${
        req.url
      } -> App: ${appId}, Pool exists: ${!!pools[appId]}`
    );

  // Add database query debugging wrapper
  if (req.db && req.db.query) {
    const originalQuery = req.db.query;
    req.db.query = async function (sql, params) {
      const startTime = Date.now();
      if (VERBOSE_APP_DEBUG)
        console.log(
          `[DB_QUERY] App: ${appId}, SQL: ${sql.substring(0, 200)}${
            sql.length > 200 ? "..." : ""
          }`,
          params || []
        );
      try {
        const result = await originalQuery.call(this, sql, params);
        const duration = Date.now() - startTime;
        if (VERBOSE_APP_DEBUG) {
          console.log(
            `[DB_RESULT] App: ${appId}, Rows: ${
              result.rows?.length || 0
            }, Duration: ${duration}ms`
          );
          if (result.rows && result.rows.length > 0) {
            console.log(
              `[DB_SAMPLE] First row:`,
              JSON.stringify(result.rows[0]).substring(0, 300)
            );
          }
        }
        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        // Always log DB errors
        console.log(
          `[DB_ERROR] App: ${appId}, Error: ${error.message}, Duration: ${duration}ms`
        );
        throw error;
      }
    };
  }
}

// Legacy single default pool reference (for old routes that still use 'pool')
const pool = pools[DEFAULT_APP];

// --- Middleware ---
app.set("trust proxy", 1); // if behind reverse proxy (needed for secure cookies)
app.use(express.json());
// Support application/x-www-form-urlencoded for proxies that submit forms
app.use(express.urlencoded({ extended: true }));
// app.use(helmet());
// app.use(morgan('combined'));

// Session BEFORE passport
// If the renderer is loaded from file:// (Electron) or a different origin, SameSite=lax blocks the cookie.
// Set env CROSS_SITE_SESSION=1 to relax to SameSite=None (requires HTTPS/secure cookie) so XHRs include session.
const CROSS_SITE = process.env.CROSS_SITE_SESSION === "1";
app.use(
  session({
    store: new pgSession({
      pool: pool, // Use the default app pool for session storage
      tableName: "session", // Table name (will be created automatically)
      createTableIfMissing: true,
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: "sid",
    cookie: {
      httpOnly: true,
      secure: CROSS_SITE ? true : process.env.NODE_ENV === "production",
      sameSite: CROSS_SITE ? "none" : "lax",
      maxAge: 1000 * 60 * 60 * 4, // 4h
    },
  })
);

// Swagger will be configured after ensureAuthenticated is defined below

// --- File upload/download helpers ---
const MAX_UPLOAD_BYTES =
  Math.max(1, parseInt(MAX_UPLOAD_MB, 10) || 25) * 1024 * 1024;
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

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

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

// Signed URL helpers for public file access
function signData(data) {
  const h = crypto.createHmac("sha256", FILES_SIGNING_SECRET || "");
  h.update(data);
  return h.digest("hex");
}
function buildSignedUrl(key, ttlSeconds = 300) {
  const exp = Math.floor(Date.now() / 1000) + Math.max(1, ttlSeconds);
  const base = `key=${encodeURIComponent(key)}&exp=${exp}`;
  const sig = signData(base);
  const pub = FILES_PUBLIC_URL.replace(/\/files\/?$/, "");
  // Expose via /files-signed for validation
  const origin = pub || "";
  return `${origin}/files-signed?${base}&sig=${sig}`;
}
function verifySignedParams(key, exp, sig) {
  if (!key || !exp || !sig) return false;
  const now = Math.floor(Date.now() / 1000);
  const expNum = parseInt(exp, 10);
  if (!Number.isFinite(expNum) || expNum < now) return false;
  const base = `key=${encodeURIComponent(key)}&exp=${expNum}`;
  const expected = signData(base);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// --- MSAL Configuration ---
const msalConfig = {
  auth: {
    clientId: AZURE_AD_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${AZURE_AD_TENANT_ID}`,
    clientSecret: AZURE_AD_CLIENT_SECRET,
  },
  system: { loggerOptions: { loggerCallback: () => {} } },
};

const msalClient = new ConfidentialClientApplication(msalConfig);
const OIDC_SCOPES = ["openid", "profile", "email"];

function buildAuthUrl(req, res, next) {
  // If already authenticated, redirect directly to success page
  // Use /api prefix because Traefik strips it - browser needs full path
  if (req.session?.user) {
    return res.redirect("/api/auth/success");
  }

  const state = crypto.randomBytes(16).toString("hex");
  const nonce = crypto.randomBytes(16).toString("hex");
  req.session.authState = state;
  req.session.authNonce = nonce;
  const authCodeUrlParameters = {
    scopes: OIDC_SCOPES,
    redirectUri: AZURE_AD_REDIRECT_URI,
    state,
    nonce,
    responseMode: "query",
  };
  msalClient
    .getAuthCodeUrl(authCodeUrlParameters)
    .then((url) => res.redirect(url))
    .catch((err) => next(err));
}

async function handleAuthRedirect(req, res, next) {
  const { code, state } = req.query;
  if (!code) return res.status(400).json({ error: "missing_code" });
  if (!state || state !== req.session.authState)
    return res.status(400).json({ error: "invalid_state" });
  try {
    const tokenReq = {
      code,
      scopes: OIDC_SCOPES,
      redirectUri: AZURE_AD_REDIRECT_URI,
    };
    const response = await msalClient.acquireTokenByCode(tokenReq);
    // Basic claims extraction
    const idTokenClaims = response.idTokenClaims || {};
    req.session.user = {
      id: idTokenClaims.oid || idTokenClaims.sub,
      displayName: idTokenClaims.name,
      emails:
        idTokenClaims.emails ||
        (idTokenClaims.preferred_username
          ? [idTokenClaims.preferred_username]
          : []),
      tenantId: idTokenClaims.tid,
      claims: idTokenClaims,
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
    };
    delete req.session.authState;
    delete req.session.authNonce;
    // Use /api prefix because Traefik strips it - browser needs full path
    res.redirect("/api/auth/success");
  } catch (err) {
    next(err);
  }
}

// ---- Azure AD Bearer token verification (client credentials) ----
// JWKS client caches signing keys
const jwksClient = OAUTH_TENANT_ID
  ? jwksRsa({
      jwksUri: `https://login.microsoftonline.com/${OAUTH_TENANT_ID}/discovery/v2.0/keys`,
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 10 * 60 * 1000,
      rateLimit: true,
      jwksRequestsPerMinute: 30,
    })
  : null;

async function getSigningKey(header, callback) {
  try {
    if (!jwksClient) return callback(new Error("jwks_client_unconfigured"));
    const key = await jwksClient.getSigningKey(header.kid);
    const signingKey = key.getPublicKey();
    callback(null, signingKey);
  } catch (err) {
    callback(err);
  }
}

function verifyBearerToken(token) {
  return new Promise((resolve, reject) => {
    if (!OAUTH_TENANT_ID || !OAUTH_API_AUDIENCE)
      return reject(new Error("oauth_env_missing"));
    const expectedIssuers = [
      `https://login.microsoftonline.com/${OAUTH_TENANT_ID}/v2.0`,
      `https://sts.windows.net/${OAUTH_TENANT_ID}/`,
    ];
    const options = {
      audience: OAUTH_API_AUDIENCE,
      issuer: expectedIssuers,
      algorithms: ["RS256"],
    };
    jwt.verify(token, getSigningKey, options, (err, decoded) => {
      if (err) return reject(err);
      try {
        if (OAUTH_REQUIRED_ROLE) {
          const roles = decoded.roles || decoded.role || [];
          const hasRole = Array.isArray(roles)
            ? roles.includes(OAUTH_REQUIRED_ROLE)
            : String(roles) === OAUTH_REQUIRED_ROLE;
          if (!hasRole) {
            const e = new Error("missing_required_role");
            e.code = "forbidden";
            e.claims = { roles };
            return reject(e);
          }
        }
        return resolve(decoded);
      } catch (e) {
        return reject(e);
      }
    });
  });
}

function ensureAuthenticated(req, res, next) {
  // Always allow CORS preflight
  if (req.method === "OPTIONS") return next();
  // Explicitly allow any public endpoints (defense-in-depth). These are mounted under /:appId/api/:appId/public/*
  // Example: /ats/api/ats/public/applications
  if (req.path.startsWith("/public/")) {
    if (process.env.AUTH_DEBUG === "1")
      console.log("[AUTH_DEBUG] Public bypass", { path: req.path });
    return next();
  }
  // Allow unauthenticated access to candidate score endpoint: /candidates/:id/score
  if (/\/candidates\/\d+\/score\/?$/.test(req.path)) return next();
  // Allow unauthenticated read of job listings (GET .../jobs or .../jobs/public) even when mounted with prefixes like /ats/api/ats
  if (
    req.method === "GET" &&
    (/\/jobs\/?$/.test(req.path) || /\/jobs\/public\/?$/.test(req.path))
  ) {
    if (process.env.AUTH_DEBUG === "1")
      console.log("[AUTH_DEBUG] Public jobs access", { path: req.path });
    return next();
  }
  // Allow ATS client-credential Bearer tokens for specific POST endpoints
  const isAts = req.appId === "ats";
  const isPost = req.method === "POST";
  const isAppsSubmit = /^\/(public\/)?applications\/?$/.test(req.path);
  const isAttachmentsPost =
    /^\/applications\/\d+\/attachments(\/upload)?\/?$/.test(req.path);
  const isResumeCoverUpload =
    /^\/applications\/\d+\/upload\/(resume|cover-letter)\/?$/.test(req.path);
  if (
    isAts &&
    isPost &&
    (isAppsSubmit || isAttachmentsPost || isResumeCoverUpload)
  ) {
    const auth = req.headers?.authorization || req.headers?.Authorization;
    if (auth && /^Bearer\s+/i.test(auth)) {
      const token = auth.replace(/^Bearer\s+/i, "").trim();
      if (process.env.AUTH_DEBUG === "1") {
        console.log("[AUTH_DEBUG] Bearer present for ATS submission", {
          path: req.path,
          method: req.method,
          hasToken: true,
          audience: OAUTH_API_AUDIENCE,
          requiredRole: OAUTH_REQUIRED_ROLE || null,
        });
      }
      return verifyBearerToken(token)
        .then((decoded) => {
          req.azureBearer = decoded;
          return next();
        })
        .catch((err) => {
          const code = err.code === "forbidden" ? 403 : 401;
          // Relaxed behavior: allow public application submission to proceed even if bearer verification fails.
          if (isAppsSubmit && req.path.startsWith("/public/")) {
            console.warn(
              "[AUTH_WARN] Skipping bearer validation failure for public application submission:",
              err.message
            );
            return next();
          }
          const payload = {
            error: code === 403 ? "forbidden" : "invalid_token",
          };
          if (process.env.AUTH_DEBUG === "1") payload.detail = err.message;
          return res.status(code).json(payload);
        });
    }
    // No bearer token supplied.
    if (isAppsSubmit) {
      if (process.env.REQUIRE_BEARER_FOR_PUBLIC_APPLY === "1") {
        if (process.env.AUTH_DEBUG === "1")
          console.log(
            "[AUTH_DEBUG] Missing bearer and REQUIRE_BEARER_FOR_PUBLIC_APPLY=1; rejecting"
          );
        return res.status(401).json({ error: "unauthorized" });
      }
      if (process.env.AUTH_DEBUG === "1")
        console.log(
          "[AUTH_DEBUG] Public ATS application submission allowed (no bearer)"
        );
      return next();
    }
  }

  // Fallback to session-based auth
  if (req.session?.user) return next();
  if (process.env.AUTH_DEBUG === "1") {
    console.log("[AUTH_DEBUG] 401", {
      path: req.path,
      method: req.method,
      hasSession: !!req.session,
      hasUser: !!(req.session && req.session.user),
      cookieHeader: req.headers.cookie || null,
      sameSite:
        (req.session?.cookie && req.session.cookie.sameSite) || "unknown",
    });
  }
  return res.status(401).json({ error: "unauthorized" });
}

// Resolve appId from param (for routes mounted as /:appId/...)
function resolveApp(req, res, next) {
  // 1) Preferred: explicit route param
  let effective =
    req.params.appId && APP_IDS.includes(req.params.appId)
      ? req.params.appId
      : null;

  // 2) If missing (e.g., mounted with literal '/ats/...'), try to infer from baseUrl/originalUrl
  if (!effective) {
    const candidates = [];
    if (req.baseUrl) candidates.push(req.baseUrl);
    if (req.originalUrl) candidates.push(req.originalUrl);
    for (const src of candidates) {
      const parts = String(src).split("/").filter(Boolean);
      // Look for first segment that matches a known app id
      const match = parts.find((p) => APP_IDS.includes(p));
      if (match) {
        effective = match;
        break;
      }
    }
  }

  // 3) Fallback to default app
  if (!effective) effective = DEFAULT_APP;

  if (VERBOSE_APP_DEBUG)
    console.log(
      `[RESOLVE_APP] URL: ${req.url}, Original URL: ${
        req.originalUrl
      }, param: ${
        req.params.appId
      }, effective: ${effective}, APP_IDS: ${APP_IDS.join(",")}`
    );
  attachAppDb(effective, req);
  return next();
}

// --- Routes ---
// --- Swagger Docs (mounted early but after auth helper) ---
const swaggerSpec = buildSpec();
if (process.env.SWAGGER_SERVER_URL) {
  swaggerSpec.servers = [{ url: process.env.SWAGGER_SERVER_URL }];
}
const swaggerRouter = express.Router();
swaggerRouter.use("/", swaggerUi.serve);
swaggerRouter.get("/", swaggerUi.setup(swaggerSpec));
swaggerRouter.get("/openapi.json", (req, res) => res.json(swaggerSpec));
app.use("/docs", ensureAuthenticated, swaggerRouter);
app.use("/openapi.json", ensureAuthenticated, (req, res) =>
  res.json(swaggerSpec)
);

const atsSpec = buildSpecForApp("ats");
if (process.env.SWAGGER_SERVER_URL)
  atsSpec.servers = [{ url: process.env.SWAGGER_SERVER_URL }];
const atsSwaggerRouter = express.Router();
atsSwaggerRouter.use("/", swaggerUi.serve);
atsSwaggerRouter.get("/", swaggerUi.setup(atsSpec));
atsSwaggerRouter.get("/openapi.json", (req, res) => res.json(atsSpec));
app.use("/ats/docs", ensureAuthenticated, atsSwaggerRouter);
app.use("/ats/openapi.json", ensureAuthenticated, (req, res) =>
  res.json(atsSpec)
);

/**
 * @openapi
 * /:
 *   get:
 *     summary: API root
 *     responses:
 *       200:
 *         description: Root response
 */
app.get("/", (req, res) => {
  const user = req.session.user;
  res.json({
    message: "Express + PostgreSQL API",
    authenticated: !!user,
    user: user
      ? { id: user.id, displayName: user.displayName, emails: user.emails }
      : null,
    timestamp: new Date().toISOString(),
  });
});

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Health check for default app
 *     responses:
 *       200:
 *         description: OK
 */
app.get("/health", async (req, res) => {
  const db = pool; // default app health
  try {
    const result = await db.query(
      "SELECT NOW() AS now, current_database() AS db"
    );
    res.status(200).json({
      status: "OK",
      app: DEFAULT_APP,
      database: "Connected",
      database_name: result.rows[0].db,
      timestamp: result.rows[0].now,
    });
  } catch (err) {
    res.status(500).json({
      status: "ERROR",
      app: DEFAULT_APP,
      database: "Disconnected",
      database_name: null,
      error: err.message,
    });
  }
});

// Per-app health
/**
 * @openapi
 * /{appId}/health:
 *   get:
 *     summary: Per-app health check
 *     parameters:
 *       - in: path
 *         name: appId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: OK
 */
app.get("/:appId/health", resolveApp, async (req, res) => {
  try {
    const result = await req.db.query(
      "SELECT NOW() AS now, current_database() AS db"
    );
    res.status(200).json({
      status: "OK",
      app: req.appId,
      database: "Connected",
      database_name: result.rows[0].db,
      timestamp: result.rows[0].now,
    });
  } catch (err) {
    res.status(500).json({
      status: "ERROR",
      app: req.appId,
      database: "Disconnected",
      database_name: null,
      error: err.message,
    });
  }
});

// Login initiation
/**
 * @openapi
 * /auth/login:
 *   get:
 *     summary: Start Azure AD login
 *     responses:
 *       302:
 *         description: Redirect to Azure AD
 */
app.get("/auth/login", buildAuthUrl);

// Callback (single definition)
/**
 * @openapi
 * /auth/callback:
 *   get:
 *     summary: Azure AD redirect URI
 *     responses:
 *       200:
 *         description: Login complete
 */
app.get("/auth/callback", handleAuthRedirect);

/**
 * @openapi
 * /auth/success:
 *   get:
 *     summary: Login success details
 *     security:
 *       - SessionCookie: []
 *     responses:
 *       200:
 *         description: Current user
 */
app.get("/auth/success", ensureAuthenticated, (req, res) => {
  const { user } = req.session;
  // Return HTML page that notifies parent window and closes popup
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Sign-in Successful</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100vh;
          margin: 0;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }
        .container {
          background: white;
          padding: 3rem;
          border-radius: 12px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.1);
          text-align: center;
          max-width: 400px;
        }
        .checkmark {
          font-size: 4rem;
          color: #10b981;
          margin-bottom: 1rem;
        }
        h1 {
          color: #1f2937;
          margin: 0 0 0.5rem 0;
          font-size: 1.5rem;
        }
        p {
          color: #6b7280;
          margin: 0;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="checkmark">✓</div>
        <h1>Sign-in Successful!</h1>
        <p>You can close this window now.</p>
      </div>
      <script>
        // Send success message to parent window (opener)
        if (window.opener) {
          window.opener.postMessage({
            type: 'amd-auth-success',
            user: ${JSON.stringify({
              id: user.id,
              displayName: user.displayName,
              emails: user.emails,
            })}
          }, '*');
        }
        // Auto-close after a short delay
        setTimeout(() => {
          window.close();
        }, 1500);
      </script>
    </body>
    </html>
  `);
});

app.get("/auth/failure", (req, res) => {
  res.status(401).json({ error: "login_failed" });
});

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     summary: Logout and clear session
 *     responses:
 *       200:
 *         description: Logged out
 */
app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    // Clear cookie with same options as session config to ensure it's properly removed
    const CROSS_SITE = process.env.CROSS_SITE_SESSION === "1";
    res.clearCookie("sid", {
      httpOnly: true,
      secure: CROSS_SITE ? true : process.env.NODE_ENV === "production",
      sameSite: CROSS_SITE ? "none" : "lax",
      path: "/",
    });
    res.json({ status: "logged_out" });
  });
});

// Protected API (legacy default app)
/**
 * @openapi
 * /api/user:
 *   get:
 *     summary: Current user (default app)
 *     security:
 *       - SessionCookie: []
 *     responses:
 *       200: { description: OK }
 */
app.get("/api/user", ensureAuthenticated, (req, res) => {
  const { user } = req.session;
  res.json({
    app: DEFAULT_APP,
    id: user.id,
    displayName: user.displayName,
    emails: user.emails || [],
  });
});

// Multi-app API router
const multiApi = express.Router({ mergeParams: true });
multiApi.use(resolveApp, ensureAuthenticated);

/**
 * @openapi
 * /{appId}/api/user:
 *   get:
 *     summary: Current user (per app)
 *     parameters:
 *       - in: path
 *         name: appId
 *         required: true
 *         schema: { type: string }
 *     security:
 *       - SessionCookie: []
 *     responses:
 *       200: { description: OK }
 */
multiApi.get("/user", (req, res) => {
  const { user } = req.session;
  res.json({
    app: req.appId,
    id: user.id,
    displayName: user.displayName,
    emails: user.emails || [],
  });
});

multiApi.get("/time", async (req, res) => {
  try {
    const r = await req.db.query("SELECT NOW()");
    res.json({ app: req.appId, now: r.rows[0].now });
  } catch (e) {
    res
      .status(500)
      .json({ error: "db_error", detail: e.message, app: req.appId });
  }
});

// Example placeholder entity list per app (expects a table common across DBs)
multiApi.get("/items", async (req, res) => {
  try {
    const r = await req.db.query(
      "SELECT id, name FROM items ORDER BY name LIMIT 100"
    );
    res.json({ app: req.appId, data: r.rows });
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// --- Per-app specific route modules (mounted FIRST to take precedence) ---
// Pattern: /:appId/api/<app-specific>/*
// Each module should export a router; file name must match appId.
const appRoutesDir = path.join(__dirname, "routes", "apps");

// Authentication middleware that skips public routes
function ensureAuthenticatedExceptPublic(req, res, next) {
  // Skip authentication for public routes
  if (req.path.startsWith("/public/")) {
    return next();
  }
  return ensureAuthenticated(req, res, next);
}

if (fs.existsSync(appRoutesDir)) {
  APP_IDS.forEach((aid) => {
    // Check for modular structure first (e.g., ats/index.js), then fallback to single file (e.g., ats.js)
    const modularDir = path.join(appRoutesDir, aid);
    const modularFile = path.join(modularDir, "index.js");
    const legacyFile = path.join(appRoutesDir, `${aid}.js`);

    let file = null;
    if (fs.existsSync(modularFile)) {
      file = modularFile;
    } else if (fs.existsSync(legacyFile)) {
      file = legacyFile;
    }

    if (file) {
      try {
        const rtr = require(file);
        app.use(
          `/${aid}/api/${aid}`,
          resolveApp,
          ensureAuthenticatedExceptPublic,
          rtr
        );
        if (VERBOSE_APP_DEBUG)
          console.log(`Mounted routes for app '${aid}' from ${file}`);
        // If ATS modular routes, initialize with dependencies (MSAL client, etc.)
        if (aid === "ats" && typeof rtr.initRouters === "function") {
          try {
            rtr.initRouters({
              graphMsal: msalClient,
            });
            if (VERBOSE_APP_DEBUG)
              console.log(`Initialized ATS routers with MSAL client`);
          } catch (initErr) {
            console.error(`Failed to initialize ATS routers:`, initErr.message);
          }
        }
        // If ATS, start AI scoring backfill after mount
        if (aid === "ats" && typeof rtr.startBackfill === "function") {
          try {
            rtr.startBackfill(aid, pools[aid]);
          } catch {}
        }
      } catch (e) {
        console.error(`Failed mounting routes for app '${aid}':`, e.message);
      }
    }
  });
}

// --- General multi-app API (mounted after specific routes to avoid conflicts) ---
app.use("/:appId/api", multiApi);

// Example stricter protected route
/**
 * @openapi
 * /api/secure/ping:
 *   get:
 *     summary: Secure ping
 *     security:
 *       - SessionCookie: []
 *     responses:
 *       200:
 *         description: Pong
 */
app.get("/api/secure/ping", ensureAuthenticated, (req, res) => {
  res.json({ pong: true, userId: req.session.user.id });
});

// ---------- File Upload/Download ----------
// POST /files/upload  (multipart/form-data; field: file; optional: storage_key, type, appId, disposition)
app.post(
  "/files/upload",
  ensureAuthenticated,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "file_required" });

      const originalName = safeFileName(req.file.originalname || "file");
      const today = new Date().toISOString().slice(0, 10);

      let { storage_key, type, disposition } = req.body || {};
      type =
        type && ["attachments", "avatars"].includes(type)
          ? type
          : "attachments";

      if (!storage_key) {
        const uuid = crypto.randomUUID();
        storage_key = `${type}/${today}/${uuid}-${originalName}`;
      }

      // Compute safe path and ensure parent dir exists
      const absPath = safeJoin(FILES_ROOT, storage_key);
      await ensureDir(path.dirname(absPath));

      // Compute sha256 from file stream
      const hash = crypto.createHash("sha256");
      const stream = fs.createReadStream(req.file.path);
      await new Promise((resolve, reject) => {
        stream.on("error", reject);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", resolve);
      });
      const sha256 = hash.digest("hex");

      // Move file to final destination
      // Try rename first (fastest if same FS), fallback to copy+unlink
      try {
        await fs.promises.rename(req.file.path, absPath);
      } catch (e) {
        if (e.code === "EXDEV") {
          await fs.promises.copyFile(req.file.path, absPath);
          await fs.promises.unlink(req.file.path);
        } else {
          throw e;
        }
      }

      const size = req.file.size;
      const contentType =
        req.file.mimetype ||
        mime.lookup(originalName) ||
        "application/octet-stream";

      const publicUrl = `${FILES_PUBLIC_URL.replace(/\/$/, "")}/${storage_key}`;
      res.status(201).json({
        storage_key,
        public_url: publicUrl,
        file_name: originalName,
        content_type: contentType,
        byte_size: size,
        sha256_hex: sha256,
        disposition: disposition || "inline",
      });
    } catch (e) {
      // Attempt cleanup
      if (req.file && req.file.path) {
        await fs.promises.unlink(req.file.path).catch(() => {});
      }
      if (e.message === "bad_path")
        return res.status(400).json({ error: "invalid_storage_key" });
      res.status(500).json({ error: "upload_failed", detail: e.message });
    }
  }
);

// GET /files (query: key=...) OR /files/*
function getKeyFromReq(req) {
  return req.query.key || (req.params && req.params[0]);
}

async function streamFile(res, absPath, fileName, asAttachment) {
  const stat = await fs.promises.stat(absPath);
  const ctype = mime.lookup(fileName) || "application/octet-stream";
  res.setHeader("Content-Type", ctype);
  res.setHeader("Content-Length", stat.size);
  const disposition = asAttachment ? "attachment" : "inline";
  res.setHeader(
    "Content-Disposition",
    `${disposition}; filename="${fileName}"`
  );
  fs.createReadStream(absPath).pipe(res);
}

app.get("/files", ensureAuthenticated, async (req, res) => {
  try {
    const key = getKeyFromReq(req);
    if (!key) return res.status(400).json({ error: "key_required" });
    const abs = safeJoin(FILES_ROOT, key);
    const name = path.basename(key);
    await streamFile(res, abs, name, req.query.download === "1");
  } catch (e) {
    const code = e.code === "ENOENT" ? 404 : 500;
    res.status(code).json({ error: "read_failed", detail: e.message });
  }
});

app.get("/files/*", ensureAuthenticated, async (req, res) => {
  try {
    const key = getKeyFromReq(req);
    if (!key) return res.status(400).json({ error: "key_required" });
    const abs = safeJoin(FILES_ROOT, key);
    const name = path.basename(key);
    await streamFile(res, abs, name, req.query.download === "1");
  } catch (e) {
    const code = e.code === "ENOENT" ? 404 : 500;
    res.status(code).json({ error: "read_failed", detail: e.message });
  }
});

// --- Interview Reminders Routes ---
try {
  const interviewRemindersRouter = require("./routes/interviewReminders")(
    pools
  );
  app.use("/api/interview-reminders", interviewRemindersRouter);
  console.log(
    "[InterviewReminder] ✓ Routes registered at /api/interview-reminders"
  );
} catch (error) {
  console.error("[InterviewReminder] ✗ Failed to load routes:", error.message);
}

// --- Initialize Interview Reminder Scheduler ---
let reminderScheduler = null;
try {
  const InterviewReminderScheduler = require("./services/interviewReminderScheduler");
  reminderScheduler = new InterviewReminderScheduler(pools, msalClient);

  // Start the scheduler after a short delay to allow server to fully initialize
  setTimeout(() => {
    try {
      reminderScheduler.start();
    } catch (error) {
      console.error(
        "[InterviewReminder] Failed to start scheduler:",
        error.message
      );
    }
  }, 10000); // 10 second delay
} catch (error) {
  console.error(
    "[InterviewReminder] Failed to initialize scheduler:",
    error.message
  );
  console.log("[InterviewReminder] Interview reminders will be disabled");
}

// Optional: Manual trigger endpoint for testing/debugging
app.post(
  "/api/interview-reminders/trigger",
  ensureAuthenticated,
  async (req, res) => {
    try {
      if (!reminderScheduler) {
        return res.status(503).json({
          success: false,
          error:
            "Interview reminder system not initialized. Check SMTP configuration.",
        });
      }
      await reminderScheduler.triggerManualCheck();
      res.json({ success: true, message: "Manual check triggered" });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// --- Electron App Updates Static Files ---
const UPDATES_DIR = path.join(__dirname, "updates");
try {
  if (!fs.existsSync(UPDATES_DIR)) {
    fs.mkdirSync(UPDATES_DIR, { recursive: true });
    console.log("[Updates] Created updates directory at:", UPDATES_DIR);
  }
  // Serve updates with no-cache headers for latest.yml to prevent stale update info
  app.use(
    "/updates",
    (req, res, next) => {
      // Disable caching for latest.yml to ensure clients always get fresh update info
      if (req.path === "/latest.yml") {
        res.setHeader(
          "Cache-Control",
          "no-store, no-cache, must-revalidate, proxy-revalidate"
        );
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
      next();
    },
    express.static(UPDATES_DIR)
  );
  console.log("[Updates] ✓ Serving app updates from /updates at:", UPDATES_DIR);
} catch (error) {
  console.error(
    "[Updates] ✗ Failed to setup updates directory:",
    error.message
  );
}

// --- Error handler (last) ---
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "server_error", detail: err.message });
});

// --- Socket.IO Setup ---
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Configure this based on your security needs
    methods: ["GET", "POST"],
  },
});

// Store io instance globally for use in routes
app.set("io", io);

io.on("connection", (socket) => {
  if (VERBOSE_APP_DEBUG) console.log("Client connected:", socket.id);

  socket.on("disconnect", () => {
    if (VERBOSE_APP_DEBUG) console.log("Client disconnected:", socket.id);
  });
});

// --- Start ---
server.listen(port, "0.0.0.0", () => {
  // Keep a single concise startup line (not gated)
  console.log(`Server listening on port ${port}`);
});

// --- Graceful shutdown ---
process.on("SIGINT", async () => {
  if (VERBOSE_APP_DEBUG) console.log("Shutting down gracefully...");
  // Stop reminder scheduler
  if (reminderScheduler) {
    reminderScheduler.stop();
  }
  const { shutdownPools } = require("./multiTenant");
  await shutdownPools(pools).catch(() => {});
  process.exit(0);
});

// Public, time-limited signed access (no session required)
// Issue a signed URL (requires current session), useful for converting stored /files URLs to public short-lived links
app.get("/files/sign", ensureAuthenticated, async (req, res) => {
  try {
    let { url, key, ttl } = req.query;
    ttl = parseInt(ttl, 10);
    const ttlSeconds = Number.isFinite(ttl) && ttl > 0 ? ttl : 300;

    // Auto-fix legacy URLs with old domain patterns
    if (url) {
      const originalUrl = url;
      // Fix api.s3protection.com -> ats.s3protection.com/api
      if (url.includes("api.s3protection.com")) {
        url = url.replace(/https?:\/\/api\.s3protection\.com\/?/, "https://ats.s3protection.com/api/");
      }
      // Fix any double slashes that might occur (except after https:)
      url = url.replace(/([^:])\/+/g, "$1/");
      if (url !== originalUrl) {
        console.log(`[files/sign] Auto-fixed URL: ${originalUrl} -> ${url}`);
      }
    }

    if (!key) {
      if (!url) return res.status(400).json({ error: "key_or_url_required" });
      // Derive key from full URL by stripping the FILES_PUBLIC_URL prefix
      const prefix = (FILES_PUBLIC_URL || "").replace(/\/$/, "") + "/";
      if (String(url).startsWith(prefix)) {
        key = String(url).slice(prefix.length);
      } else {
        // Fallback: try to interpret as already-relative
        key = String(url).replace(/^https?:\/\/[^/]+\//, "");
        if (key.startsWith("files/")) key = key.slice("files/".length);
        // Also handle /api/files/ prefix from the new URL structure
        if (key.startsWith("api/files/")) key = key.slice("api/files/".length);
      }
    }
    if (!key) return res.status(400).json({ error: "invalid_key" });
    const signed = buildSignedUrl(key, ttlSeconds);
    res.json({ ok: true, url: signed, key });
  } catch (e) {
    res.status(500).json({ error: "sign_failed", detail: e.message });
  }
});

app.get("/files-signed", async (req, res) => {
  try {
    const key = req.query.key;
    const exp = req.query.exp;
    const sig = req.query.sig;
    if (!verifySignedParams(key, exp, sig))
      return res.status(401).json({ error: "unauthorized" });
    const abs = safeJoin(FILES_ROOT, key);
    const name = path.basename(key);
    await streamFile(res, abs, name, req.query.download === "1");
  } catch (e) {
    const code = e.code === "ENOENT" ? 404 : 500;
    res.status(code).json({ error: "read_failed", detail: e.message });
  }
});
app.get("/files-signed/*", async (req, res) => {
  try {
    const key = getKeyFromReq(req);
    const exp = req.query.exp;
    const sig = req.query.sig;
    if (!verifySignedParams(key, exp, sig))
      return res.status(401).json({ error: "unauthorized" });
    const abs = safeJoin(FILES_ROOT, key);
    const name = path.basename(key);
    await streamFile(res, abs, name, req.query.download === "1");
  } catch (e) {
    const code = e.code === "ENOENT" ? 404 : 500;
    res.status(code).json({ error: "read_failed", detail: e.message });
  }
});
