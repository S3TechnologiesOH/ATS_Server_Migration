/**
 * Centralized Configuration Module
 *
 * All environment variables and their defaults are defined here.
 * Import this module instead of reading process.env directly.
 *
 * Usage:
 *   const config = require('./config');
 *   console.log(config.db.host);
 */

require('dotenv').config();

// =============================================================================
// Server Configuration
// =============================================================================
const server = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  sessionSecret: process.env.SESSION_SECRET,
  crossSiteSession: process.env.CROSS_SITE_SESSION === '1',
};

// =============================================================================
// Database Configuration
// =============================================================================
const db = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  name: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD || process.env.POSTGRES_PASSWORD,
  schema: process.env.DB_SCHEMA || 'public',
};

// ATS-specific database (if separate from main)
const atsDb = {
  host: process.env.ATS_DB_HOST || db.host,
  port: parseInt(process.env.ATS_DB_PORT || process.env.DB_PORT || '5432', 10),
  name: process.env.ATS_DB_NAME || db.name,
  user: process.env.ATS_DB_USER || db.user,
  password: process.env.ATS_DB_PASSWORD || db.password,
};

// =============================================================================
// Azure AD / Microsoft Authentication
// =============================================================================
const azureAd = {
  tenantId: process.env.AZURE_AD_TENANT_ID,
  clientId: process.env.AZURE_AD_CLIENT_ID,
  clientSecret: process.env.AZURE_AD_CLIENT_SECRET,
  redirectUri: process.env.AZURE_AD_REDIRECT_URI ||
    'https://ats.s3protection.com/api/auth/callback',
};

// Microsoft Graph API (delegated auth)
const graph = {
  redirectUri: process.env.GRAPH_REDIRECT_URI ||
    'https://ats.s3protection.com/api/ats/api/ats/graph/callback',
  pushEnabled: process.env.GRAPH_PUSH_ENABLED === '1',
  notifyMailbox: process.env.GRAPH_NOTIFY_MAILBOX,
};

// OAuth for service-to-service (client credentials)
const oauth = {
  tenantId: process.env.OAUTH_TENANT_ID,
  apiAudience: process.env.OAUTH_API_AUDIENCE,
  requiredRole: process.env.OAUTH_REQUIRED_ROLE,
  requireBearerForPublicApply: process.env.REQUIRE_BEARER_FOR_PUBLIC_APPLY === '1',
};

// =============================================================================
// File Storage Configuration
// =============================================================================
const files = {
  root: process.env.FILES_ROOT || '/app/app/uploads',
  publicUrl: process.env.FILES_PUBLIC_URL ||
    'https://ats.s3protection.com/api/files',
  maxUploadMb: parseInt(process.env.MAX_UPLOAD_MB || '512', 10),
  signingSecret: process.env.FILES_SIGNING_SECRET || process.env.SESSION_SECRET,
};

// =============================================================================
// API Configuration
// =============================================================================
const api = {
  baseUrl: process.env.API_BASE_URL || 'https://ats.s3protection.com',
  swaggerServerUrl: process.env.SWAGGER_SERVER_URL,
  publicAppAllowedOrigin: process.env.PUBLIC_APP_ALLOWED_ORIGIN ||
    'https://careers.mys3tech.com',
};

// =============================================================================
// External Services - AI
// =============================================================================
const ai = {
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  googleApiKey: process.env.GOOGLE_API_KEY,
};

// =============================================================================
// External Services - Email
// =============================================================================
const email = {
  from: process.env.EMAIL_FROM || 'noreply@s3protection.com',
  // Mailgun
  mailgunApiKey: process.env.MAILGUN_API_KEY,
  mailgunDomain: process.env.MAILGUN_DOMAIN,
  mailgunApiUrl: process.env.MAILGUN_API_URL || 'https://api.mailgun.net',
  // SMTP fallback
  smtpHost: process.env.SMTP_HOST || 'smtp.gmail.com',
  smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
  smtpSecure: process.env.SMTP_SECURE === 'true',
  smtpUser: process.env.SMTP_USER,
  smtpPassword: process.env.SMTP_PASSWORD,
};

// =============================================================================
// External Services - LinkedIn
// =============================================================================
const linkedin = {
  clientId: process.env.LINKEDIN_CLIENT_ID,
  clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
};

// =============================================================================
// ATS Table Configuration
// =============================================================================
const atsTables = {
  peopleTable: process.env.ATS_PEOPLE_TABLE || 'candidates',
  peoplePk: process.env.ATS_PEOPLE_PK || 'candidate_id',
  applicationsTable: process.env.ATS_APPLICATIONS_TABLE || 'applications',
  applicationsPk: process.env.ATS_APPLICATIONS_PK || 'application_id',
  attachmentsTable: process.env.ATS_ATTACHMENTS_TABLE || 'application_attachment',
};

// =============================================================================
// Multi-App Configuration
// =============================================================================
const apps = {
  ids: (process.env.APPS && process.env.APPS.trim())
    ? process.env.APPS.split(',').map(s => s.trim()).filter(Boolean)
    : ['ats'],
  defaultApp: process.env.DEFAULT_APP || 'ats',
};

// =============================================================================
// Debug Flags
// =============================================================================
const debug = {
  auth: process.env.AUTH_DEBUG === '1',
  admin: process.env.ADMIN_DEBUG === '1',
  search: process.env.DEBUG_SEARCH === '1',
  uploads: process.env.DEBUG_UPLOADS === '1',
  candidates: process.env.DEBUG_CANDIDATES === '1',
};

// =============================================================================
// Scheduler Configuration
// =============================================================================
const scheduler = {
  reminderHoursBefore: parseInt(process.env.REMINDER_HOURS_BEFORE || '24', 10),
  reminderCheckCron: process.env.REMINDER_CHECK_CRON || '0 */1 * * *',
};

// =============================================================================
// Reports Configuration
// =============================================================================
const reports = {
  cacheTtlSeconds: parseInt(process.env.REPORT_TTL_SECONDS || '900', 10),
};

// =============================================================================
// Admin Configuration
// =============================================================================
const admin = {
  emails: (process.env.ADMIN_EMAILS || 'nancy.larker@gmail.com')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean),
};

// =============================================================================
// Export
// =============================================================================
module.exports = {
  server,
  db,
  atsDb,
  azureAd,
  graph,
  oauth,
  files,
  api,
  ai,
  email,
  linkedin,
  atsTables,
  apps,
  debug,
  scheduler,
  reports,
  admin,
  // Convenience: check if we're in production
  isProduction: server.nodeEnv === 'production',
  isDevelopment: server.nodeEnv === 'development',
};
