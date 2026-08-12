/**
 * auth.js — JWT authentication middleware
 *
 * Multi-DB update:
 *   - Customer/Owner JWT tokens → check revocation in customer_saas.users
 *   - Platform Admin/Super-Admin JWT tokens → check revocation in super_admin_saas.platform_users
 */

"use strict";

const jwt = require("jsonwebtoken");
const env = require("../config/env");
const { getCustomerPool, getSuperAdminPool } = require("../db/dbManager");

const PLATFORM_ROLES = new Set(["ADMIN", "SUPER_ADMIN"]);

/**
 * Check if the token was issued before the user's last password change.
 * Routes the DB query to the correct database based on the user's role.
 */
async function isTokenRevokedByPasswordChange(decoded) {
  if (!decoded?.sub || decoded.purpose === "password_reset") return false;
  try {
    const isPlatformUser = PLATFORM_ROLES.has(decoded.role);
    const pool = isPlatformUser ? getSuperAdminPool() : getCustomerPool();
    const table = isPlatformUser ? "platform_users" : "users";

    const [[row]] = await pool.execute(
      `SELECT password_updated_at FROM ${table} WHERE id = ? LIMIT 1`,
      [decoded.sub]
    );
    if (!row?.password_updated_at) return false;
    const pwdAt    = new Date(row.password_updated_at).getTime();
    const issuedAt = (decoded.iat || 0) * 1000;
    return issuedAt < pwdAt;
  } catch {
    return false;
  }
}

/**
 * auth(required?)
 *
 * Express middleware factory.
 *   auth()        → authentication required (401 if missing/invalid)
 *   auth(false)   → optional; sets req.user if valid token present
 *
 * After verification sets:
 *   req.user      – decoded JWT payload  { sub, role, tenantId, email }
 *   req.userRole  – shortcut for req.user.role
 *   req.isPlatformAdmin – true for ADMIN / SUPER_ADMIN roles
 */
function auth(required = true) {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();

    if (!token) {
      if (!required) return next();
      return res.status(401).json({ message: "Unauthorized" });
    }

    try {
      const decoded = jwt.verify(token, env.jwtSecret);

      if (await isTokenRevokedByPasswordChange(decoded)) {
        return res.status(401).json({ message: "Session expired. Please login again." });
      }

      req.user            = decoded;
      req.userRole        = decoded.role;
      req.isPlatformAdmin = PLATFORM_ROLES.has(decoded.role);
      return next();
    } catch {
      return res.status(401).json({ message: "Invalid token" });
    }
  };
}

module.exports = auth;
