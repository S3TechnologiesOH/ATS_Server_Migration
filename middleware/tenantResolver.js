/**
 * Tenant Resolution Middleware
 *
 * Handles subdomain-based multi-tenancy:
 * - Extracts subdomain from req.hostname
 * - Looks up tenant in master database
 * - Validates user against tenant allowlist
 * - Attaches tenant database pool to req.db
 *
 * Usage:
 *   app.use(resolveTenant);
 *   // Later, after authentication:
 *   app.use(verifyTenantAccess);
 */

const dbManager = require('../dbManager');

// Base domain from environment (defaults to ats.s3protection.com)
const BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN || 'ats.s3protection.com';

// Domains that should skip tenant resolution (main domain, localhost)
const SKIP_DOMAINS = new Set([
  BASE_DOMAIN, // Main domain (no subdomain)
  'localhost',
  '127.0.0.1',
]);

/**
 * Extract subdomain from hostname
 * Examples:
 *   mys3tech.ats.s3protection.com -> 'mys3tech'
 *   ats.s3protection.com -> null (main domain)
 *   localhost:3000 -> null
 *   mys3tech.localhost -> 'mys3tech' (for local dev)
 */
function extractSubdomain(hostname) {
  // Remove port if present
  const host = hostname.split(':')[0].toLowerCase();

  // Skip if it's a known skip domain
  if (SKIP_DOMAINS.has(host)) {
    return null;
  }

  const parts = host.split('.');

  // Pattern: subdomain.{BASE_DOMAIN} (e.g., subdomain.ats.s3protection.com)
  const baseParts = BASE_DOMAIN.split('.');
  if (parts.length > baseParts.length && parts.slice(-baseParts.length).join('.') === BASE_DOMAIN) {
    return parts[0];
  }

  // For local development: subdomain.localhost
  if (parts.length >= 2 && parts[parts.length - 1] === 'localhost') {
    return parts[0];
  }

  // For local development: subdomain.local
  if (parts.length >= 2 && parts[parts.length - 1] === 'local') {
    return parts[0];
  }

  return null;
}

/**
 * Main tenant resolution middleware
 * Runs early in the middleware chain, after session setup
 */
async function resolveTenant(req, res, next) {
  // Skip if dbManager not initialized (shouldn't happen in normal flow)
  if (!dbManager.isInitialized()) {
    req.tenant = null;
    req.tenantMode = false;
    return next();
  }

  try {
    const subdomain = extractSubdomain(req.hostname);

    // No subdomain = main application (legacy/backward compatibility mode)
    if (!subdomain) {
      req.tenant = null;
      req.tenantMode = false;
      // req.db will be set by the legacy resolveApp middleware
      return next();
    }

    // Look up tenant
    const tenant = await dbManager.getTenantBySubdomain(subdomain);

    if (!tenant) {
      return res.status(404).json({
        error: 'tenant_not_found',
        message: `Organization '${subdomain}' not found or is not active.`,
        subdomain,
      });
    }

    // Attach tenant info to request
    req.tenant = tenant;
    req.tenantId = tenant.id;
    req.tenantMode = true;
    req.subdomain = subdomain;

    // Get tenant database pool
    req.db = await dbManager.getTenantDb(tenant.id);
    req.appId = 'ats'; // Tenant databases are ATS databases

    return next();
  } catch (err) {
    console.error('[TenantResolver] Error:', err.message);
    return res.status(500).json({
      error: 'tenant_resolution_failed',
      message: 'Failed to resolve organization. Please try again.',
    });
  }
}

/**
 * Middleware to verify user is in tenant allowlist
 * Should run AFTER authentication (ensureAuthenticated)
 */
async function verifyTenantAccess(req, res, next) {
  // Skip if not in tenant mode
  if (!req.tenantMode || !req.tenant) {
    return next();
  }

  // Skip for public routes
  if (req.path.startsWith('/public/')) {
    return next();
  }

  // Skip for health checks
  if (req.path === '/health' || req.path === '/health/db') {
    return next();
  }

  // Must have authenticated user
  const user = req.session?.user;
  if (!user) {
    // ensureAuthenticated will handle this case
    return next();
  }

  // Security check: If user's session has a different tenant ID, verify they have access
  // This prevents session reuse across tenants
  if (user.appTenantId && user.appTenantId !== req.tenant.id) {
    // User logged in to a different tenant - need to verify access to this tenant
    // Clear cached tenant info since they're accessing a different tenant
    delete user.appTenantId;
    delete user.appTenantSubdomain;
    delete user.appTenantRole;
  }

  // Get user email from various possible sources (normalized to lowercase)
  const email = (
    user.emails?.[0] ||
    user.claims?.preferred_username ||
    user.claims?.email ||
    user.claims?.upn ||
    ''
  ).toLowerCase().trim();

  if (!email) {
    await dbManager.logAccess(req.tenant.id, null, 'access_denied', req, {
      reason: 'no_email',
    });
    return res.status(403).json({
      error: 'access_denied',
      message: 'Unable to verify user identity.',
    });
  }

  // Get Microsoft OID if available for faster lookup
  const microsoftOid = user.id || user.claims?.oid || user.claims?.sub;

  // Check if user is in tenant allowlist
  const tenantUser = await dbManager.checkUserAccess(req.tenant.id, email, microsoftOid);

  if (!tenantUser) {
    await dbManager.logAccess(req.tenant.id, email, 'access_denied', req, {
      reason: 'not_in_allowlist',
    });
    return res.status(403).json({
      error: 'access_denied',
      message: `You do not have access to ${req.tenant.name}. Please contact your administrator.`,
      tenant: req.tenant.name,
      subdomain: req.subdomain,
    });
  }

  // Attach tenant user info to request
  req.tenantUser = tenantUser;
  req.tenantRole = tenantUser.role;

  // Update last login (don't await - fire and forget)
  dbManager.updateLastLogin(req.tenant.id, email).catch(() => {});

  return next();
}

/**
 * Save subdomain to session before Azure AD redirect
 * Allows restoration after OAuth callback
 */
function saveSubdomainToSession(req, res, next) {
  const subdomain = extractSubdomain(req.hostname);
  if (subdomain && req.session) {
    req.session.pendingSubdomain = subdomain;
  }
  next();
}

/**
 * Restore subdomain context after OAuth callback
 * Used when callback comes to main domain but user started on subdomain
 */
function restoreSubdomainFromSession(req) {
  if (req.session?.pendingSubdomain) {
    return req.session.pendingSubdomain;
  }
  return null;
}

/**
 * Build redirect URL back to tenant subdomain
 */
function buildTenantRedirectUrl(subdomain, path = '/auth/success') {
  return `https://${subdomain}.${BASE_DOMAIN}${path}`;
}

/**
 * Middleware to require tenant admin role
 */
function requireTenantAdmin(req, res, next) {
  if (!req.tenantMode) {
    return next(); // Let legacy admin check handle it
  }

  if (req.tenantRole !== 'admin') {
    return res.status(403).json({
      error: 'forbidden',
      message: 'This action requires tenant administrator privileges.',
    });
  }

  return next();
}

module.exports = {
  extractSubdomain,
  resolveTenant,
  verifyTenantAccess,
  saveSubdomainToSession,
  restoreSubdomainFromSession,
  buildTenantRedirectUrl,
  requireTenantAdmin,
};
