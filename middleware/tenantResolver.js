/**
 * Tenant Resolution Middleware (User-Based)
 *
 * Simplified multi-tenancy based on user's tenant membership:
 * - After login, user's tenant is looked up from tenant_users table
 * - Tenant info is stored in session
 * - All requests use the tenant from session
 *
 * No DNS/subdomain configuration needed - single domain for all tenants.
 *
 * Usage:
 *   // After authentication:
 *   app.use(resolveTenantFromSession);
 */

const dbManager = require('../dbManager');

/**
 * Look up user's tenant after authentication
 * Called once after successful login to set tenant in session
 * Returns tenant info or null if user has no tenant access
 */
async function lookupUserTenant(email, microsoftOid = null) {
  if (!dbManager.isInitialized()) {
    return null;
  }

  const normalized = (email || '').toLowerCase().trim();
  if (!normalized) {
    return null;
  }

  try {
    // Find user's tenant membership
    let result;

    // Try Microsoft OID first if available
    if (microsoftOid) {
      result = await dbManager.getMasterDb().query(
        `SELECT tu.tenant_id, tu.role, tu.first_name, tu.last_name,
                t.id, t.company_name, t.subdomain, t.db_name, t.is_active
         FROM tenant_users tu
         JOIN tenants t ON t.id = tu.tenant_id
         WHERE tu.microsoft_oid = $1 AND tu.is_active = true AND t.is_active = true
         LIMIT 1`,
        [microsoftOid]
      );
    }

    // Fall back to email lookup
    if (!result || result.rows.length === 0) {
      result = await dbManager.getMasterDb().query(
        `SELECT tu.tenant_id, tu.role, tu.first_name, tu.last_name,
                t.id, t.company_name, t.subdomain, t.db_name, t.is_active
         FROM tenant_users tu
         JOIN tenants t ON t.id = tu.tenant_id
         WHERE tu.email = $1 AND tu.is_active = true AND t.is_active = true
         LIMIT 1`,
        [normalized]
      );
    }

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      tenantId: row.tenant_id,
      tenantRole: row.role,
      tenantName: row.company_name,
      tenantSubdomain: row.subdomain,
      tenantDbName: row.db_name,
      userFirstName: row.first_name,
      userLastName: row.last_name,
    };
  } catch (err) {
    console.error('[TenantResolver] Error looking up user tenant:', err.message);
    return null;
  }
}

/**
 * Main tenant resolution middleware
 * Reads tenant from session (set during login)
 */
async function resolveTenantFromSession(req, res, next) {
  // Skip if dbManager not initialized
  if (!dbManager.isInitialized()) {
    req.tenant = null;
    req.tenantMode = false;
    return next();
  }

  // Check if user has tenant in session
  const user = req.session?.user;
  if (!user || !user.tenantId) {
    req.tenant = null;
    req.tenantMode = false;
    return next();
  }

  try {
    // Get tenant config (from cache or DB)
    const tenant = await dbManager.getTenantBySubdomain(user.tenantSubdomain);

    if (!tenant) {
      // Tenant no longer exists or inactive - clear session tenant
      delete user.tenantId;
      delete user.tenantSubdomain;
      delete user.tenantRole;
      req.tenant = null;
      req.tenantMode = false;
      return next();
    }

    // Attach tenant info to request
    req.tenant = tenant;
    req.tenantId = tenant.id;
    req.tenantMode = true;
    req.tenantRole = user.tenantRole;

    // Get tenant database pool
    req.db = await dbManager.getTenantDb(tenant.id);
    req.appId = 'ats';

    return next();
  } catch (err) {
    console.error('[TenantResolver] Error:', err.message);
    // Don't fail the request - fall back to legacy mode
    req.tenant = null;
    req.tenantMode = false;
    return next();
  }
}

/**
 * Set tenant in session after successful authentication
 * Call this after user logs in successfully
 */
async function setTenantInSession(req, email, microsoftOid = null) {
  const tenantInfo = await lookupUserTenant(email, microsoftOid);

  if (tenantInfo && req.session?.user) {
    req.session.user.tenantId = tenantInfo.tenantId;
    req.session.user.tenantSubdomain = tenantInfo.tenantSubdomain;
    req.session.user.tenantRole = tenantInfo.tenantRole;
    req.session.user.tenantName = tenantInfo.tenantName;

    // Update last login
    dbManager.updateLastLogin(tenantInfo.tenantId, email).catch(() => {});

    return tenantInfo;
  }

  return null;
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

/**
 * Check if user has access to current tenant
 * Use this for routes that need to verify tenant membership
 */
function requireTenantAccess(req, res, next) {
  if (!req.tenantMode) {
    return next(); // Legacy mode - no tenant check needed
  }

  if (!req.session?.user?.tenantId) {
    return res.status(403).json({
      error: 'access_denied',
      message: 'You do not have access to this organization.',
    });
  }

  return next();
}

module.exports = {
  lookupUserTenant,
  resolveTenantFromSession,
  setTenantInSession,
  requireTenantAdmin,
  requireTenantAccess,
};
