/**
 * pool.js — LEGACY SHIM
 * =====================
 * The original codebase imported a single mysql2 pool from this file.
 * All new code should import from dbManager.js instead.
 *
 * This shim proxies every method call to the **restaurant_saas** pool so that
 * existing modules that haven't been migrated yet continue to work against
 * the original shared database.
 *
 * During the migration:
 *   - Modules that deal with restaurant data → use getRestaurantPool(dbName)
 *   - Modules that deal with customers       → use getCustomerPool()
 *   - Modules that deal with admin/platform  → use getSuperAdminPool()
 *
 * @deprecated  Import { getSuperAdminPool, getCustomerPool, getRestaurantPool }
 *              from './dbManager' instead.
 */

"use strict";

const mysql = require("mysql2/promise");
const env   = require("../config/env");

// Legacy pool always connects to restaurant_saas (the original shared DB).
let _legacyPool = null;

function getLegacyPool() {
  if (!_legacyPool) {
    _legacyPool = mysql.createPool({
      host:             env.mysqlHost,
      port:             env.mysqlPort,
      user:             env.mysqlUser,
      password:         env.mysqlPassword,
      database:         env.mysqlDatabase, // restaurant_saas
      waitForConnections: true,
      connectionLimit:  10,
      queueLimit:       0,
      charset:          "utf8mb4",
    });
  }
  return _legacyPool;
}

const pool = new Proxy(
  {},
  {
    get(_, prop) {
      const target = getLegacyPool();
      const value  = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  }
);

module.exports = pool;
