/**
 * API Key Authentication Middleware
 *
 * Validates API keys for public endpoints (job board integrations).
 * API keys are tenant-specific and stored in the master database.
 *
 * Usage:
 *   // Require API key
 *   app.get('/public/jobs', requireApiKey, handler);
 *
 *   // Optional API key (enhances response if provided)
 *   app.get('/public/something', optionalApiKey, handler);
 */

const dbManager = require('../dbManager');

/**
 * Validate an API key and return tenant info
 * @param {string} apiKey - The API key to validate
 * @returns {Promise<object|null>} - Tenant info or null if invalid
 */
async function validateApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') {
    return null;
  }

  if (!dbManager.isInitialized()) {
    console.error('[ApiKeyAuth] dbManager not initialized');
    return null;
  }

  try {
    const result = await dbManager.getMasterDb().query(
      `SELECT
        ak.id AS api_key_id,
        ak.tenant_id,
        ak.name AS key_name,
        ak.allowed_domains,
        ak.rate_limit_per_minute,
        t.company_name,
        t.subdomain,
        t.db_name,
        t.primary_color,
        t.secondary_color,
        t.logo_url,
        t.is_active AS tenant_active
       FROM tenant_api_keys ak
       JOIN tenants t ON t.id = ak.tenant_id
       WHERE ak.api_key = $1
         AND ak.is_active = true
         AND ak.revoked_at IS NULL
         AND t.is_active = true`,
      [apiKey]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];

    // Update last_used_at (fire and forget)
    dbManager.getMasterDb().query(
      'UPDATE tenant_api_keys SET last_used_at = NOW() WHERE id = $1',
      [row.api_key_id]
    ).catch(() => {});

    return {
      apiKeyId: row.api_key_id,
      tenantId: row.tenant_id,
      keyName: row.key_name,
      allowedDomains: row.allowed_domains || [],
      rateLimitPerMinute: row.rate_limit_per_minute,
      tenant: {
        id: row.tenant_id,
        companyName: row.company_name,
        subdomain: row.subdomain,
        dbName: row.db_name,
        primaryColor: row.primary_color,
        secondaryColor: row.secondary_color,
        logoUrl: row.logo_url,
      },
    };
  } catch (err) {
    console.error('[ApiKeyAuth] Error validating API key:', err.message);
    return null;
  }
}

/**
 * Check if the request origin is allowed for this API key
 * @param {string[]} allowedDomains - List of allowed domains
 * @param {string} origin - Request origin
 * @returns {boolean} - True if allowed
 */
function isOriginAllowed(allowedDomains, origin) {
  // If no domains specified, allow all
  if (!allowedDomains || allowedDomains.length === 0) {
    return true;
  }

  if (!origin) {
    // No origin header (e.g., server-to-server) - allow
    return true;
  }

  try {
    const originHost = new URL(origin).hostname.toLowerCase();
    return allowedDomains.some(domain => {
      const d = domain.toLowerCase().trim();
      // Exact match or wildcard subdomain match
      return originHost === d || originHost.endsWith('.' + d);
    });
  } catch {
    return false;
  }
}

/**
 * Extract API key from request
 * Checks X-API-Key header, then Authorization Bearer token, then query param
 * @param {object} req - Express request
 * @returns {string|null} - API key or null
 */
function extractApiKey(req) {
  // 1. X-API-Key header (preferred)
  const headerKey = req.headers['x-api-key'];
  if (headerKey) {
    return headerKey;
  }

  // 2. Authorization: Bearer <key>
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // 3. Query parameter (less secure, for debugging)
  if (req.query && req.query.api_key) {
    return req.query.api_key;
  }

  return null;
}

/**
 * Middleware: Require valid API key
 * Blocks request if API key is missing or invalid
 */
async function requireApiKey(req, res, next) {
  const apiKey = extractApiKey(req);

  if (!apiKey) {
    return res.status(401).json({
      error: 'api_key_required',
      message: 'API key is required. Include X-API-Key header.',
    });
  }

  const keyInfo = await validateApiKey(apiKey);

  if (!keyInfo) {
    return res.status(401).json({
      error: 'invalid_api_key',
      message: 'Invalid or revoked API key.',
    });
  }

  // Check origin restriction
  const origin = req.headers['origin'];
  if (!isOriginAllowed(keyInfo.allowedDomains, origin)) {
    return res.status(403).json({
      error: 'origin_not_allowed',
      message: 'This API key is not authorized for this domain.',
    });
  }

  // Attach key info to request
  req.apiKey = keyInfo;
  req.tenantId = keyInfo.tenantId;
  req.tenantFromApiKey = keyInfo.tenant;

  // Try to get tenant database pool
  try {
    const tenantDb = await dbManager.getTenantDb(keyInfo.tenantId);
    if (tenantDb) {
      req.db = tenantDb;
    }
  } catch (err) {
    console.error('[ApiKeyAuth] Error getting tenant DB:', err.message);
  }

  return next();
}

/**
 * Middleware: Optional API key
 * Enhances request with tenant info if API key provided, but doesn't block
 */
async function optionalApiKey(req, res, next) {
  const apiKey = extractApiKey(req);

  if (apiKey) {
    const keyInfo = await validateApiKey(apiKey);
    if (keyInfo) {
      req.apiKey = keyInfo;
      req.tenantId = keyInfo.tenantId;
      req.tenantFromApiKey = keyInfo.tenant;

      // Try to get tenant database pool
      try {
        const tenantDb = await dbManager.getTenantDb(keyInfo.tenantId);
        if (tenantDb) {
          req.db = tenantDb;
        }
      } catch (err) {
        console.error('[ApiKeyAuth] Error getting tenant DB:', err.message);
      }
    }
  }

  return next();
}

/**
 * Generate a new API key
 * @returns {object} - { apiKey, apiKeyPrefix }
 */
function generateApiKey() {
  const crypto = require('crypto');
  const randomPart = crypto.randomBytes(28).toString('hex'); // 56 chars
  const apiKey = `pk_live_${randomPart}`; // 64 chars total
  const apiKeyPrefix = apiKey.substring(0, 12); // "pk_live_xxxx"

  return { apiKey, apiKeyPrefix };
}

module.exports = {
  validateApiKey,
  extractApiKey,
  isOriginAllowed,
  requireApiKey,
  optionalApiKey,
  generateApiKey,
};
