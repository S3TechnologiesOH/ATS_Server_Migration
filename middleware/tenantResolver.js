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
  console.log('[TenantResolver] lookupUserTenant called with email:', email, 'oid:', microsoftOid);

  if (!dbManager.isInitialized()) {
    console.log('[TenantResolver] dbManager not initialized');
    return null;
  }

  const normalized = (email || '').toLowerCase().trim();
  if (!normalized) {
    console.log('[TenantResolver] No email provided');
    return null;
  }

  console.log('[TenantResolver] Looking up normalized email:', normalized);

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
      console.log('[TenantResolver] OID lookup returned no results, trying email lookup');
      result = await dbManager.getMasterDb().query(
        `SELECT tu.tenant_id, tu.role, tu.first_name, tu.last_name,
                t.id, t.company_name, t.subdomain, t.db_name, t.is_active
         FROM tenant_users tu
         JOIN tenants t ON t.id = tu.tenant_id
         WHERE tu.email = $1 AND tu.is_active = true AND t.is_active = true
         LIMIT 1`,
        [normalized]
      );
      console.log('[TenantResolver] Email lookup result rows:', result.rows.length);
    }

    if (result.rows.length === 0) {
      console.log('[TenantResolver] No tenant found for email:', normalized);
      return null;
    }

    const row = result.rows[0];
    console.log('[TenantResolver] Found tenant:', row.company_name, 'role:', row.role);
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
 * @param {object} req - Express request object
 * @param {string} email - User's email from Azure AD
 * @param {string} microsoftOid - Microsoft Object ID from Azure AD
 * @param {string} displayName - Display name from Azure AD
 */
async function setTenantInSession(req, email, microsoftOid = null, displayName = null) {
  console.log('[TenantResolver] setTenantInSession called for email:', email);
  const tenantInfo = await lookupUserTenant(email, microsoftOid);

  console.log('[TenantResolver] tenantInfo:', tenantInfo);
  console.log('[TenantResolver] session.user exists:', !!req.session?.user);

  if (tenantInfo && req.session?.user) {
    req.session.user.tenantId = tenantInfo.tenantId;
    req.session.user.tenantSubdomain = tenantInfo.tenantSubdomain;
    req.session.user.tenantRole = tenantInfo.tenantRole;
    req.session.user.tenantName = tenantInfo.tenantName;

    console.log('[TenantResolver] Set tenant in session:', {
      tenantId: tenantInfo.tenantId,
      tenantName: tenantInfo.tenantName,
      tenantRole: tenantInfo.tenantRole,
    });

    // Update last login and sync Azure AD info (OID, name)
    dbManager.updateLastLogin(tenantInfo.tenantId, email, {
      microsoftOid,
      displayName,
    }).catch(() => {});

    return tenantInfo;
  }

  console.log('[TenantResolver] Did NOT set tenant in session. tenantInfo:', !!tenantInfo, 'session.user:', !!req.session?.user);
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
