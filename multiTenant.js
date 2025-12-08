// Multi-tenant database pool manager
// Each appId gets its own pg Pool using env var prefixes: <APPID>_DB_HOST, _DB_PORT, _DB_NAME, _DB_USER, _DB_PASSWORD
// Fallback to base DB_* values when a specific one is missing.

const { Pool } = require('pg');

function buildPoolConfig(appId) {
  const prefix = appId.toUpperCase();
  const env = process.env;
  return {
    host: env[`${prefix}_DB_HOST`] || env.DB_HOST || 'postgres-db',
    port: parseInt(env[`${prefix}_DB_PORT`] || env.DB_PORT || '5432', 10),
    database: env[`${prefix}_DB_NAME`] || env.DB_NAME,
    user: env[`${prefix}_DB_USER`] || env.DB_USER,
    password: env[`${prefix}_DB_PASSWORD`] || env.DB_PASSWORD,
    max: parseInt(env[`${prefix}_DB_POOL_MAX`] || env.DB_POOL_MAX || '10', 10),
    idleTimeoutMillis: parseInt(env[`${prefix}_DB_IDLE_TIMEOUT_MS`] || env.DB_IDLE_TIMEOUT_MS || '30000', 10),
  };
}

function initPools(appIds) {
  const pools = {};
  for (const id of appIds) {
    const cfg = buildPoolConfig(id);
    pools[id] = new Pool(cfg);
    pools[id].connect()
      .then(client => { console.log(`✅ DB connected for app '${id}' (${cfg.database})`); client.release(); })
      .catch(e => console.error(`❌ DB connection failed for app '${id}':`, e.message));
  }
  return pools;
}

async function shutdownPools(pools) {
  await Promise.all(Object.values(pools).map(p => p.end().catch(() => {})));
}

module.exports = { initPools, shutdownPools };
