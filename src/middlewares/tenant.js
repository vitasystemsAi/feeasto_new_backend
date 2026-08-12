/**
 * tenant.js — Tenant + restaurant-DB scope middleware
 *
 * Multi-DB architecture:
 *   - Reads tenantId from JWT / header as before
 *   - ADDITIONALLY resolves the per-restaurant DB name and attaches it to req:
 *       req.tenantId      – numeric tenant ID (from super_admin_saas.tenants)
 *       req.restaurantDb  – e.g. "restaurant_abc123"  (pool available via getRestaurantPool)
 *       req.restaurantPool – the mysql2 Pool for this restaurant's database
 *
 * For SUPER_ADMIN / ADMIN requests that don't belong to a single restaurant,
 * req.restaurantDb and req.restaurantPool are left null.
 */

"use strict";

const { getSuperAdminPool, getRestaurantPool } = require("../db/dbManager");
const { resolveRestaurantDb }                  = require("../db/dbProvisioner");

const PLATFORM_ROLES = new Set(["ADMIN", "SUPER_ADMIN"]);

async function tenantScope(req, res, next) {
  // ── 1. Determine tenantId ──────────────────────────────────────────────────
  let tenantId = req.headers["x-tenant-id"] || req.user?.tenantId || null;
  req.tenantId = tenantId ? Number(tenantId) : null;

  // ── 2. Try to heal OWNER missing tenantId via restaurantId param ───────────
  if (!req.tenantId && req.user?.role === "OWNER") {
    const restaurantId = Number(req.query?.restaurantId || req.body?.restaurantId);
    if (Number.isFinite(restaurantId) && restaurantId > 0) {
      try {
        // Look up tenant_id from super_admin_saas.restaurant_applications
        const saPool = getSuperAdminPool();
        const [[appRow]] = await saPool.execute(
          `SELECT tenant_id FROM restaurant_applications
           WHERE id = ? AND approval_status = 'APPROVED' LIMIT 1`,
          [restaurantId]
        );
        if (appRow?.tenant_id) req.tenantId = Number(appRow.tenant_id);
      } catch { /* fall through */ }
    }
  }

  // ── 3. Guard: non-platform roles MUST have a tenantId ─────────────────────
  if (!req.tenantId && !PLATFORM_ROLES.has(req.user?.role)) {
    return res.status(400).json({ message: "Missing tenant context" });
  }

  // ── 4. Resolve restaurant DB name ─────────────────────────────────────────
  req.restaurantDb   = null;
  req.restaurantPool = null;

  if (req.tenantId) {
    try {
      const dbName = await resolveRestaurantDb({ tenantId: req.tenantId });
      if (dbName) {
        req.restaurantDb   = dbName;
        req.restaurantPool = getRestaurantPool(dbName);
      }
    } catch (e) {
      console.warn("[tenant middleware] Could not resolve restaurant DB:", e.message);
    }
  }

  return next();
}

module.exports = tenantScope;
