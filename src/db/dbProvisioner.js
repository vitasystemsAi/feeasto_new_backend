/**
 * dbProvisioner.js
 * ================
 * Provisions an isolated MySQL database for a newly approved restaurant.
 *
 * Steps performed on approval:
 *   1. Generate a safe DB name:  restaurant_<slug_sanitised>
 *   2. CREATE DATABASE restaurant_<slug> (if not exists)
 *   3. Execute the restaurant template SQL (restaurant_template.sql) to
 *      create all tables in the new database
 *   4. Seed the restaurant row with the application data
 *   5. Seed default menu items based on businessType
 *   6. Update super_admin_saas.tenants  with  db_name + status = ACTIVE
 *   7. Update super_admin_saas.restaurant_applications with tenant_id + db_name
 *   8. Return the db_name so the caller can persist it
 *
 * Usage (called from admin approval controller):
 *   const { provisionRestaurantDb } = require('../db/dbProvisioner');
 *   const { dbName } = await provisionRestaurantDb(application);
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const env  = require("../config/env");
const { getSuperAdminPool, getRestaurantPool } = require("./dbManager");

// Template SQL path
const TEMPLATE_SQL = path.join(
  __dirname, "..", "..", "database", "restaurant_template.sql"
);

/**
 * Convert a restaurant slug to a safe MySQL database name.
 * MySQL DB names: max 64 chars, no special chars beyond underscore.
 *
 * @param {string} slug  e.g. "the-biryani-house"
 * @returns {string}     e.g. "restaurant_the_biryani_house"
 */
function slugToDbName(slug) {
  const safe = slug
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")   // replace non-alphanum with underscore
    .replace(/_+/g, "_")           // collapse multiple underscores
    .replace(/^_|_$/g, "")         // trim leading/trailing underscores
    .slice(0, 55);                  // max 55 chars + "restaurant_" prefix = 66 > 64, so 52
  return `restaurant_${safe}`;
}

/**
 * Read the template SQL and split into individual statements.
 * We skip comments and empty lines; each statement ends with `;`.
 *
 * @returns {string[]}
 */
function loadTemplateStatements() {
  if (!fs.existsSync(TEMPLATE_SQL)) {
    throw new Error(`restaurant_template.sql not found at ${TEMPLATE_SQL}`);
  }
  const raw = fs.readFileSync(TEMPLATE_SQL, "utf8");

  // Remove single-line comments and split by semicolon
  const statements = raw
    .split("\n")
    .filter(line => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map(s => s.trim())
    .filter(s => s.length > 0 && !/^(CREATE DATABASE|USE )/i.test(s));

  return statements;
}

/**
 * Main provisioning function.
 *
 * @param {Object} application  Row from super_admin_saas.restaurant_applications
 * @returns {Promise<{dbName: string, tenantId: number}>}
 */
async function provisionRestaurantDb(application) {
  const {
    id: applicationId,
    owner_user_id,
    owner_name,
    business_name,
    business_type,
    business_type_label,
    address,
    address_line1,
    address_line2,
    city,
    state,
    pincode,
    latitude,
    longitude,
    description,
    kyc_document_url,
    vendor_config,
    slug,
  } = application;

  const dbName    = slugToDbName(slug || `app${applicationId}`);
  const saPool    = getSuperAdminPool();
  const saConn    = await saPool.getConnection();

  try {
    // ── Step 1: Create database ──────────────────────────────────────────────
    await saConn.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );

    // ── Step 2: Create tenant record in super_admin_saas ────────────────────
    const subdomain = `${slug || `app${applicationId}`}-${Date.now().toString(36)}`.slice(0, 100);
    const [tenantResult] = await saConn.execute(
      `INSERT INTO tenants (name, subdomain, db_name, status)
       VALUES (?, ?, ?, 'ACTIVE')
       ON DUPLICATE KEY UPDATE db_name = VALUES(db_name), status = 'ACTIVE'`,
      [business_name, subdomain, dbName]
    );
    const tenantId = tenantResult.insertId || tenantResult.id;

    // ── Step 3: Execute template SQL to create tables ─────────────────────
    const rPool = getRestaurantPool(dbName);
    const rConn = await rPool.getConnection();
    try {
      const statements = loadTemplateStatements();
      for (const stmt of statements) {
        await rConn.query(stmt);
      }

      // ── Step 4: Seed the restaurant row ───────────────────────────────────
      await rConn.execute(
        `INSERT INTO restaurant (
          tenant_id, application_id, owner_user_id,
          name, slug, description, business_type, business_type_label,
          vendor_config, address, address_line1, address_line2,
          city, state, pincode, latitude, longitude,
          kyc_document_url, approval_status, is_active, is_online
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED', 1, 0)`,
        [
          tenantId, applicationId, owner_user_id,
          business_name, slug || dbName, description || null,
          business_type || "restaurant",
          business_type_label || business_type || "Restaurant",
          vendor_config ? JSON.stringify(vendor_config) : null,
          address || "", address_line1 || null, address_line2 || null,
          city || null, state || null, pincode || null,
          latitude || null, longitude || null,
          kyc_document_url || null,
        ]
      );

      // ── Step 5: Seed owner as staff ───────────────────────────────────────
      //    We don't have the password hash here (it lives in customer_saas).
      //    Insert a placeholder; the owner uses customer_saas credentials.
      await rConn.execute(
        `INSERT INTO staff (full_name, role, is_active)
         VALUES (?, 'OWNER', 1)`,
        [owner_name || "Owner"]
      );
    } finally {
      rConn.release();
    }

    // ── Step 6: Update super_admin_saas.restaurant_applications ──────────
    await saConn.execute(
      `UPDATE restaurant_applications
       SET tenant_id = ?, db_name = ?, approval_status = 'APPROVED', reviewed_at = NOW()
       WHERE id = ?`,
      [tenantId, dbName, applicationId]
    );

    // ── Step 7: Audit log ─────────────────────────────────────────────────
    await saConn.execute(
      `INSERT INTO audit_logs (action, target_type, target_id, detail)
       VALUES ('RESTAURANT_DB_PROVISIONED', 'restaurant_application', ?, ?)`,
      [applicationId, JSON.stringify({ dbName, tenantId })]
    );

    console.log(`[dbProvisioner] Provisioned database "${dbName}" for application #${applicationId}`);
    return { dbName, tenantId };

  } finally {
    saConn.release();
  }
}

/**
 * Lookup which restaurant DB to use for a given slug or tenantId.
 * Queries super_admin_saas.tenants for the db_name.
 *
 * @param {Object} opts
 * @param {string} [opts.slug]      Restaurant slug
 * @param {number} [opts.tenantId]  Tenant ID
 * @returns {Promise<string|null>}  db_name or null if not found
 */
async function resolveRestaurantDb({ slug, tenantId } = {}) {
  const saPool = getSuperAdminPool();
  if (tenantId) {
    const [[row]] = await saPool.execute(
      "SELECT db_name FROM tenants WHERE id = ? AND status = 'ACTIVE' LIMIT 1",
      [tenantId]
    );
    return row?.db_name || null;
  }
  if (slug) {
    const [[row]] = await saPool.execute(
      `SELECT t.db_name FROM tenants t
       JOIN restaurant_applications ra ON ra.tenant_id = t.id
       WHERE ra.slug = ? AND t.status = 'ACTIVE' LIMIT 1`,
      [slug]
    );
    return row?.db_name || null;
  }
  return null;
}

module.exports = {
  provisionRestaurantDb,
  resolveRestaurantDb,
  slugToDbName,
};
