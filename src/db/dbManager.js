/**
 * dbManager.js
 * ============
 * Multi-database connection manager for the Feesto platform.
 *
 * Three database tiers:
 *   1. super_admin_saas  – platform control plane (approval, tenants, admins)
 *   2. customer_saas     – all customer / owner accounts
 *   3. restaurant_<slug> – one isolated DB per approved restaurant/vendor
 *
 * Usage:
 *   const { getSuperAdminPool, getCustomerPool, getRestaurantPool } = require('./dbManager');
 *
 *   // Fixed databases
 *   const pool = getSuperAdminPool();
 *   const cPool = getCustomerPool();
 *
 *   // Per-restaurant (cached by dbName)
 *   const rPool = getRestaurantPool('restaurant_abc123');
 */

"use strict";

const mysql = require("mysql2/promise");
const env   = require("../config/env");

// ─── Pool cache ──────────────────────────────────────────────────────────────
/** @type {import('mysql2/promise').Pool} */
let _superAdminPool = null;

/** @type {import('mysql2/promise').Pool} */
let _customerPool = null;

/** @type {Map<string, import('mysql2/promise').Pool>} */
const _restaurantPools = new Map();

// ─── Base connection options (shared) ────────────────────────────────────────
function baseOptions(database) {
  return {
    host:             env.mysqlHost,
    port:             env.mysqlPort,
    user:             env.mysqlUser,
    password:         env.mysqlPassword,
    database,
    waitForConnections: true,
    connectionLimit:  10,
    queueLimit:       0,
    charset:          "utf8mb4",
  };
}

// ─── 1. Super-admin pool ──────────────────────────────────────────────────────
/**
 * Returns the pool for the platform control-plane database (super_admin_saas).
 * Lazy-created and cached for the process lifetime.
 * @returns {import('mysql2/promise').Pool}
 */
function getSuperAdminPool() {
  if (!_superAdminPool) {
    _superAdminPool = mysql.createPool(baseOptions("super_admin_saas"));
  }
  return _superAdminPool;
}

// ─── 2. Customer pool ─────────────────────────────────────────────────────────
/**
 * Returns the pool for the shared customer database (customer_saas).
 * @returns {import('mysql2/promise').Pool}
 */
function getCustomerPool() {
  if (!_customerPool) {
    _customerPool = mysql.createPool(baseOptions("customer_saas"));
  }
  return _customerPool;
}

// ─── 3. Per-restaurant pool ───────────────────────────────────────────────────
/**
 * Returns (or creates) a connection pool for a specific restaurant database.
 *
 * @param {string} dbName - The restaurant database name, e.g. "restaurant_abc123"
 * @returns {import('mysql2/promise').Pool}
 * @throws {Error} if dbName is falsy or does not match expected pattern
 */
function getRestaurantPool(dbName) {
  if (!dbName || typeof dbName !== "string") {
    throw new Error("getRestaurantPool: dbName is required");
  }
  // Safety: only allow names that follow our naming convention
  if (!/^restaurant_[a-z0-9_]+$/.test(dbName)) {
    throw new Error(`getRestaurantPool: invalid dbName "${dbName}"`);
  }
  if (!_restaurantPools.has(dbName)) {
    const pool = mysql.createPool(baseOptions(dbName));
    _restaurantPools.set(dbName, pool);
  }
  return _restaurantPools.get(dbName);
}

// ─── 4. Graceful shutdown ─────────────────────────────────────────────────────
/**
 * Close all connection pools. Call on SIGTERM/SIGINT.
 */
async function closeAll() {
  const tasks = [];
  if (_superAdminPool) tasks.push(_superAdminPool.end());
  if (_customerPool)   tasks.push(_customerPool.end());
  for (const pool of _restaurantPools.values()) tasks.push(pool.end());
  await Promise.allSettled(tasks);
}

// ─── 5. Health-check helper ───────────────────────────────────────────────────
/**
 * Ping all currently open pools and return a status map.
 * @returns {Promise<{super_admin_saas: boolean, customer_saas: boolean, restaurants: Object}>}
 */
async function healthCheck() {
  async function ping(pool, label) {
    try {
      await pool.query("SELECT 1");
      return true;
    } catch (e) {
      console.error(`[dbManager] health-check failed for ${label}:`, e.message);
      return false;
    }
  }

  const result = {
    super_admin_saas: _superAdminPool ? await ping(_superAdminPool, "super_admin_saas") : "not-initialised",
    customer_saas:    _customerPool   ? await ping(_customerPool, "customer_saas")   : "not-initialised",
    restaurants:      {},
  };

  for (const [dbName, pool] of _restaurantPools.entries()) {
    result.restaurants[dbName] = await ping(pool, dbName);
  }

  return result;
}

// ─── Legacy compatibility shim ────────────────────────────────────────────────
/**
 * The old codebase used a single `pool` imported from `./pool`.
 * This shim returns the super_admin_saas pool so that existing code
 * that hasn't been migrated yet continues to work during the transition.
 *
 * @deprecated Prefer explicit getSuperAdminPool() / getCustomerPool() / getRestaurantPool()
 */
const legacyPool = new Proxy({}, {
  get(_, prop) {
    return getSuperAdminPool()[prop];
  }
});

module.exports = {
  getSuperAdminPool,
  getCustomerPool,
  getRestaurantPool,
  closeAll,
  healthCheck,
  /** @deprecated use getSuperAdminPool() instead */
  legacyPool,
};
