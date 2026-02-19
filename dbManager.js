/**
 * Database Manager for Multi-Tenant Architecture
 *
 * Handles connections to:
 * - Master database (ats-master): Contains tenants and tenant_users tables
 * - Tenant databases (ats-tenant-*): Per-tenant application data
 *
 * Usage:
 *   const dbManager = require('./dbManager');
 *   await dbManager.initialize();
 *   const masterDb = dbManager.getMasterDb();
 *   const tenantDb = await dbManager.getTenantDb(tenantId);
 */

const { Pool } = require('pg');

class DbManager {
  constructor() {
    this.masterPool = null;
    this.tenantPools = new Map(); // Map<tenantId, Pool>
    this.tenantConfigs = new Map(); // Cache: Map<tenantId, tenantConfig>
    this.subdomainMap = new Map(); // Cache: Map<subdomain, tenantId>
    this.poolCreationLocks = new Map(); // Prevent race conditions
    this.failedPools = new Map(); // Cache: Map<tenantId, {error, timestamp}> - avoid retrying failed pools
    this.initialized = false;
  }

  /**
   * Initialize the master database connection
   * Called once at application startup
   */
  async initialize() {
    if (this.initialized) {
      console.log('[DbManager] Already initialized');
      return;
    }

    const masterConfig = {
      host: process.env.MASTER_DB_HOST || process.env.DB_HOST || 'postgres-db',
      port: parseInt(process.env.MASTER_DB_PORT || process.env.DB_PORT || '5432', 10),
      database: process.env.MASTER_DB_NAME || 'ats-master',
      user: process.env.MASTER_DB_USER || process.env.DB_USER,
      password: process.env.MASTER_DB_PASSWORD || process.env.DB_PASSWORD,
      max: parseInt(process.env.MASTER_DB_POOL_MAX || '5', 10),
      idleTimeoutMillis: 30000,
    };

    this.masterPool = new Pool(masterConfig);

    // Verify connection
    try {
      const client = await this.masterPool.connect();
      console.log(`[DbManager] Master database connected (${masterConfig.database})`);
      client.release();
    } catch (err) {
      console.error('[DbManager] Master database connection failed:', err.message);
      throw err;
    }

    // Pre-load active tenant configs into cache
    await this._preloadTenantCache();
    this.initialized = true;
  }

  /**
   * Check if the manager is initialized
   */
  isInitialized() {
    return this.initialized;
  }

  /**
   * Get all cached tenant configurations
   */
  getAllTenantConfigs() {
    return Array.from(this.tenantConfigs.values());
  }

  /**
   * Get the master database pool
   */
  getMasterDb() {
    if (!this.masterPool) {
      throw new Error('DbManager not initialized. Call initialize() first.');
    }
    return this.masterPool;
  }

  /**
   * Lookup tenant by subdomain or custom domain
   * Returns tenant config or null if not found/inactive
   */
  async getTenantBySubdomain(subdomain) {
    const normalized = (subdomain || '').toLowerCase().trim();

    // Check cache first
    if (this.subdomainMap.has(normalized)) {
      const tenantId = this.subdomainMap.get(normalized);
      return this.tenantConfigs.get(tenantId);
    }

    // Query master database - check both subdomain and custom_domain
    const result = await this.masterPool.query(
      `SELECT id, company_name, subdomain, custom_domain, db_name, db_host, db_port,
              auth_type, microsoft_client_id, microsoft_tenant_id, email_domains,
              allow_auto_provision, max_seats, subscription_tier, logo_url,
              primary_color, secondary_color, is_active
       FROM tenants
       WHERE (subdomain = $1 OR custom_domain = $1) AND is_active = true`,
      [normalized]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const tenant = result.rows[0];
    // Map db_name to database_name for compatibility
    tenant.database_name = tenant.db_name;
    tenant.name = tenant.company_name;

    // Update cache
    this.tenantConfigs.set(tenant.id, tenant);
    this.subdomainMap.set(normalized, tenant.id);
    if (tenant.custom_domain) {
      this.subdomainMap.set(tenant.custom_domain.toLowerCase(), tenant.id);
    }

    return tenant;
  }

  /**
   * Check if a user is allowed to access a tenant
   * Returns user record or null if not allowed
   */
  async checkUserAccess(tenantId, email, microsoftOid = null) {
    const normalized = (email || '').toLowerCase().trim();

    // First try to find by microsoft_oid if provided (faster)
    if (microsoftOid) {
      const oidResult = await this.masterPool.query(
        `SELECT id, email, first_name, last_name, role, microsoft_oid, is_active
         FROM tenant_users
         WHERE tenant_id = $1 AND microsoft_oid = $2 AND is_active = true`,
        [tenantId, microsoftOid]
      );
      if (oidResult.rows.length > 0) {
        return oidResult.rows[0];
      }
    }

    // Fall back to email lookup
    const result = await this.masterPool.query(
      `SELECT id, email, first_name, last_name, role, microsoft_oid, is_active
       FROM tenant_users
       WHERE tenant_id = $1 AND email = $2 AND is_active = true`,
      [tenantId, normalized]
    );

    return result.rows.length > 0 ? result.rows[0] : null;
  }

  /**
   * Get or create a database pool for a tenant
   */
  async getTenantDb(tenantId) {
    // Return cached pool if exists
    if (this.tenantPools.has(tenantId)) {
      return this.tenantPools.get(tenantId);
    }

    // Check if pool creation previously failed (avoid retrying for 5 minutes)
    const RETRY_DELAY = 5 * 60 * 1000; // 5 minutes
    const failedEntry = this.failedPools.get(tenantId);
    if (failedEntry && Date.now() - failedEntry.timestamp < RETRY_DELAY) {
      // Return null instead of throwing - let caller fall back gracefully
      return null;
    }

    // Prevent race conditions during pool creation
    if (this.poolCreationLocks.has(tenantId)) {
      await this.poolCreationLocks.get(tenantId);
      // After waiting, check if pool was created or failed
      const pool = this.tenantPools.get(tenantId);
      if (pool) return pool;
      // Pool creation failed, return null for graceful fallback
      return null;
    }

    // Create lock promise
    let resolveLock;
    const lockPromise = new Promise((resolve) => {
      resolveLock = resolve;
    });
    this.poolCreationLocks.set(tenantId, lockPromise);

    try {
      // Get tenant config
      let tenantConfig = this.tenantConfigs.get(tenantId);
      if (!tenantConfig) {
        const result = await this.masterPool.query(
          `SELECT * FROM tenants WHERE id = $1 AND is_active = true`,
          [tenantId]
        );
        if (result.rows.length === 0) {
          console.warn(`[DbManager] Tenant ${tenantId} not found or inactive`);
          this.failedPools.set(tenantId, { error: 'not_found', timestamp: Date.now() });
          return null;
        }
        tenantConfig = result.rows[0];
        this.tenantConfigs.set(tenantId, tenantConfig);
      }

      // Build pool config - use tenant-specific host/port if set, otherwise defaults
      const poolConfig = {
        host: tenantConfig.db_host || process.env.DB_HOST || 'postgres-db',
        port: tenantConfig.db_port || parseInt(process.env.DB_PORT || '5432', 10),
        database: tenantConfig.database_name || tenantConfig.db_name,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        max: parseInt(process.env.TENANT_DB_POOL_MAX || '10', 10),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000, // Don't wait forever for bad hosts
      };

      const pool = new Pool(poolConfig);

      // Verify connection
      const client = await pool.connect();
      console.log(
        `[DbManager] Tenant pool created: ${tenantConfig.subdomain} (${poolConfig.database})`
      );
      client.release();

      // Clear any previous failure cache
      this.failedPools.delete(tenantId);
      this.tenantPools.set(tenantId, pool);
      return pool;
    } catch (err) {
      // Cache the failure so we don't spam retries
      console.warn(`[DbManager] Tenant pool ${tenantId} creation failed: ${err.message}`);
      this.failedPools.set(tenantId, { error: err.message, timestamp: Date.now() });
      return null;
    } finally {
      this.poolCreationLocks.delete(tenantId);
      resolveLock();
    }
  }

  /**
   * Log tenant access attempt
   */
  async logAccess(tenantId, email, action, req, details = {}) {
    try {
      await this.masterPool.query(
        `INSERT INTO tenant_access_log (tenant_id, user_email, action, ip_address, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          tenantId,
          email,
          action,
          req.ip || req.connection?.remoteAddress,
          JSON.stringify(details),
        ]
      );
    } catch (err) {
      // Don't fail the request if logging fails
      console.error('[DbManager] Failed to log access:', err.message);
    }
  }

  /**
   * Update user's last login timestamp and sync Azure AD info
   * @param {number} tenantId - Tenant ID
   * @param {string} email - User's email
   * @param {object} options - Optional Azure AD info to sync
   * @param {string} options.microsoftOid - Microsoft Object ID
   * @param {string} options.displayName - Display name from Azure AD
   */
  async updateLastLogin(tenantId, email, options = {}) {
    try {
      const { microsoftOid, displayName } = options;
      const normalizedEmail = email.toLowerCase();

      // Build dynamic update query based on what info we have
      const updates = ['last_login = NOW()', 'updated_at = NOW()'];
      const values = [tenantId, normalizedEmail];
      let paramIndex = 3;

      // Update microsoft_oid if provided and not already set
      if (microsoftOid) {
        updates.push(`microsoft_oid = COALESCE(microsoft_oid, $${paramIndex})`);
        values.push(microsoftOid);
        paramIndex++;
      }

      // Parse and update name from displayName if provided
      if (displayName) {
        const nameParts = displayName.trim().split(' ');
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || '';

        if (firstName) {
          updates.push(`first_name = COALESCE(NULLIF(first_name, ''), $${paramIndex})`);
          values.push(firstName);
          paramIndex++;
        }
        if (lastName) {
          updates.push(`last_name = COALESCE(NULLIF(last_name, ''), $${paramIndex})`);
          values.push(lastName);
          paramIndex++;
        }
      }

      const query = `
        UPDATE tenant_users
        SET ${updates.join(', ')}
        WHERE tenant_id = $1 AND email = $2
      `;

      await this.masterPool.query(query, values);
      console.log('[DbManager] Updated user info for:', normalizedEmail);
    } catch (err) {
      console.error('[DbManager] Failed to update last login:', err.message);
    }
  }

  /**
   * Get all users for a tenant (for admin panel)
   */
  async getTenantUsers(tenantId) {
    const result = await this.masterPool.query(
      `SELECT id, email, first_name, last_name, role, is_active, last_login, created_at
       FROM tenant_users
       WHERE tenant_id = $1
       ORDER BY email`,
      [tenantId]
    );
    return result.rows;
  }

  /**
   * Add a user to a tenant's allowlist
   */
  async addTenantUser(tenantId, email, role = 'user', invitedById = null, firstName = null, lastName = null, microsoftOid = null) {
    const normalized = email.toLowerCase().trim();

    // Check seat limit
    const tenant = this.tenantConfigs.get(tenantId);
    if (tenant) {
      const countResult = await this.masterPool.query(
        `SELECT COUNT(*) as count FROM tenant_users WHERE tenant_id = $1 AND is_active = true`,
        [tenantId]
      );
      const currentSeats = parseInt(countResult.rows[0].count, 10);
      if (currentSeats >= (tenant.max_seats || 5)) {
        throw new Error('Seat limit reached. Please upgrade your plan.');
      }
    }

    const result = await this.masterPool.query(
      `INSERT INTO tenant_users (tenant_id, email, first_name, last_name, role, is_active, invited_by, invited_at, microsoft_oid)
       VALUES ($1, $2, $3, $4, $5, true, $6, NOW(), $7)
       ON CONFLICT (tenant_id, email) DO UPDATE SET
         role = EXCLUDED.role,
         first_name = COALESCE(EXCLUDED.first_name, tenant_users.first_name),
         last_name = COALESCE(EXCLUDED.last_name, tenant_users.last_name),
         microsoft_oid = COALESCE(EXCLUDED.microsoft_oid, tenant_users.microsoft_oid),
         is_active = CASE WHEN tenant_users.is_active = false THEN true ELSE tenant_users.is_active END,
         invited_by = EXCLUDED.invited_by,
         invited_at = NOW()
       RETURNING *`,
      [tenantId, normalized, firstName, lastName, role, invitedById, microsoftOid]
    );
    return result.rows[0];
  }

  /**
   * Deactivate a user from a tenant
   */
  async deactivateTenantUser(tenantId, userId) {
    const result = await this.masterPool.query(
      `UPDATE tenant_users SET is_active = false WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId, userId]
    );
    return result.rows[0];
  }

  /**
   * Pre-load tenant configurations into cache
   */
  async _preloadTenantCache() {
    try {
      const result = await this.masterPool.query(
        `SELECT id, company_name, subdomain, custom_domain, db_name, db_host, db_port,
                auth_type, microsoft_client_id, microsoft_tenant_id, email_domains,
                allow_auto_provision, max_seats, subscription_tier, is_active
         FROM tenants WHERE is_active = true`
      );

      for (const tenant of result.rows) {
        // Add compatibility mappings
        tenant.database_name = tenant.db_name;
        tenant.name = tenant.company_name;

        this.tenantConfigs.set(tenant.id, tenant);
        this.subdomainMap.set(tenant.subdomain.toLowerCase(), tenant.id);
        if (tenant.custom_domain) {
          this.subdomainMap.set(tenant.custom_domain.toLowerCase(), tenant.id);
        }
      }

      console.log(`[DbManager] Pre-loaded ${result.rows.length} tenant configurations`);
    } catch (err) {
      console.error('[DbManager] Failed to pre-load tenant cache:', err.message);
    }
  }

  /**
   * Refresh tenant cache (call periodically or on demand)
   */
  async refreshTenantCache() {
    this.tenantConfigs.clear();
    this.subdomainMap.clear();
    await this._preloadTenantCache();
  }

  /**
   * Graceful shutdown - close all pools
   */
  async shutdown() {
    console.log('[DbManager] Shutting down...');

    const closePromises = [];

    for (const [tenantId, pool] of this.tenantPools) {
      closePromises.push(
        pool
          .end()
          .catch((err) => console.error(`Failed to close tenant pool ${tenantId}:`, err.message))
      );
    }

    if (this.masterPool) {
      closePromises.push(
        this.masterPool.end().catch((err) => console.error('Failed to close master pool:', err.message))
      );
    }

    await Promise.all(closePromises);
    this.initialized = false;
    console.log('[DbManager] All pools closed');
  }
}

// Singleton instance
const dbManager = new DbManager();

module.exports = dbManager;
