/**
 * vendorApproval.js
 * =================
 * Super-admin controller for the restaurant / vendor approval workflow.
 *
 * All reads/writes go to super_admin_saas via getSuperAdminPool().
 * On approval, calls dbProvisioner.provisionRestaurantDb() to create
 * the isolated per-restaurant database.
 *
 * Routes (mounted in admin.routes.js):
 *   GET    /api/v1/admin/applications           → list pending / all applications
 *   GET    /api/v1/admin/applications/:id       → single application detail
 *   POST   /api/v1/admin/applications           → super-admin manually creates application (on behalf of vendor)
 *   PATCH  /api/v1/admin/applications/:id/approve  → approve → provision DB
 *   PATCH  /api/v1/admin/applications/:id/reject   → reject with reason
 *   GET    /api/v1/admin/tenants                → list all tenants / approved restaurants
 */

"use strict";

const express  = require("express");
const { z }    = require("zod");
const auth     = require("../../middlewares/auth");
const rbac     = require("../../middlewares/rbac");
const { getSuperAdminPool }       = require("../../db/dbManager");
const { provisionRestaurantDb }   = require("../../db/dbProvisioner");

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function saPool() { return getSuperAdminPool(); }

function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .slice(0, 80);
}

function uniqueSlug(name) {
  const base = generateSlug(name);
  const suffix = Date.now().toString(36).slice(-4);
  return `${base}-${suffix}`;
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const createApplicationSchema = z.object({
  ownerUserId:       z.number().int().positive(),
  ownerName:         z.string().min(2),
  ownerEmail:        z.string().email(),
  ownerPhone:        z.string().optional(),
  businessName:      z.string().min(2),
  businessType:      z.string().optional().default("restaurant"),
  businessTypeLabel: z.string().optional(),
  address:           z.string().min(5),
  city:              z.string().optional(),
  state:             z.string().optional(),
  pincode:           z.string().optional(),
  latitude:          z.number().optional(),
  longitude:         z.number().optional(),
  description:       z.string().optional(),
  kycDocumentUrl:    z.string().optional(),
  vendorConfig:      z.record(z.any()).optional(),
});

const rejectSchema = z.object({
  reason: z.string().min(5),
});

// ── Routes ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/applications
 * Query params: status=PENDING|APPROVED|REJECTED|ALL (default PENDING), page, limit
 */
router.get(
  "/applications",
  auth(), rbac(["ADMIN", "SUPER_ADMIN"]),
  async (req, res) => {
    const status = (req.query.status || "PENDING").toUpperCase();
    const page   = Math.max(1, Number(req.query.page  || 1));
    const limit  = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const offset = (page - 1) * limit;

    try {
      const whereClause = status === "ALL" ? "" : "WHERE approval_status = ?";
      const params      = status === "ALL" ? [] : [status];

      const [[{ total }]] = await saPool().execute(
        `SELECT COUNT(*) AS total FROM restaurant_applications ${whereClause}`,
        params
      );

      const [rows] = await saPool().execute(
        `SELECT id, owner_user_id, owner_name, owner_email, owner_phone,
                business_name, business_type, business_type_label,
                address, city, state, pincode, description,
                approval_status, rejection_reason,
                reviewed_by_user_id, reviewed_at,
                tenant_id, db_name, slug, submitted_at
         FROM restaurant_applications
         ${whereClause}
         ORDER BY submitted_at DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      return res.json({
        applications: rows,
        pagination: { total: Number(total), page, limit, pages: Math.ceil(Number(total) / limit) },
      });
    } catch (err) {
      console.error("[vendorApproval] list:", err);
      return res.status(500).json({ message: "Failed to fetch applications" });
    }
  }
);

/**
 * GET /api/v1/admin/applications/:id
 */
router.get(
  "/applications/:id",
  auth(), rbac(["ADMIN", "SUPER_ADMIN"]),
  async (req, res) => {
    const id = Number(req.params.id);
    try {
      const [[row]] = await saPool().execute(
        "SELECT * FROM restaurant_applications WHERE id = ? LIMIT 1",
        [id]
      );
      if (!row) return res.status(404).json({ message: "Application not found" });
      return res.json({ application: row });
    } catch (err) {
      console.error("[vendorApproval] detail:", err);
      return res.status(500).json({ message: "Failed to fetch application" });
    }
  }
);

/**
 * POST /api/v1/admin/applications
 * Super-admin submits an application on behalf of a vendor.
 */
router.post(
  "/applications",
  auth(), rbac(["ADMIN", "SUPER_ADMIN"]),
  async (req, res) => {
    const parsed = createApplicationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Validation error", errors: parsed.error.flatten() });
    }
    const d = parsed.data;
    const slug = uniqueSlug(d.businessName);

    try {
      const [result] = await saPool().execute(
        `INSERT INTO restaurant_applications
           (owner_user_id, owner_name, owner_email, owner_phone,
            business_name, business_type, business_type_label,
            address, city, state, pincode, latitude, longitude,
            description, kyc_document_url, vendor_config, slug)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          d.ownerUserId, d.ownerName, d.ownerEmail, d.ownerPhone || null,
          d.businessName, d.businessType, d.businessTypeLabel || d.businessType,
          d.address, d.city || null, d.state || null, d.pincode || null,
          d.latitude || null, d.longitude || null,
          d.description || null,
          d.kycDocumentUrl ? JSON.stringify(d.kycDocumentUrl) : null,
          d.vendorConfig   ? JSON.stringify(d.vendorConfig)   : null,
          slug,
        ]
      );
      return res.status(201).json({ id: result.insertId, slug, message: "Application submitted" });
    } catch (err) {
      console.error("[vendorApproval] create:", err);
      return res.status(500).json({ message: "Failed to create application" });
    }
  }
);

/**
 * PATCH /api/v1/admin/applications/:id/approve
 * Approves the application AND provisions an isolated restaurant database.
 */
router.patch(
  "/applications/:id/approve",
  auth(), rbac(["ADMIN", "SUPER_ADMIN"]),
  async (req, res) => {
    const id = Number(req.params.id);
    try {
      // Fetch application
      const [[application]] = await saPool().execute(
        "SELECT * FROM restaurant_applications WHERE id = ? LIMIT 1",
        [id]
      );
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }
      if (application.approval_status !== "PENDING") {
        return res.status(400).json({
          message: `Application is already ${application.approval_status.toLowerCase()}`,
        });
      }

      // Provision the isolated restaurant database
      const { dbName, tenantId } = await provisionRestaurantDb(application);

      // Update the reviewed_by in audit
      await saPool().execute(
        `UPDATE restaurant_applications
         SET approval_status = 'APPROVED', reviewed_by_user_id = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [req.user.sub, id]
      );

      // Audit log
      await saPool().execute(
        `INSERT INTO audit_logs (actor_id, actor_email, action, target_type, target_id, detail)
         VALUES (?, ?, 'RESTAURANT_APPROVED', 'restaurant_application', ?, ?)`,
        [
          req.user.sub, req.user.email,
          id,
          JSON.stringify({ dbName, tenantId, businessName: application.business_name }),
        ]
      );

      return res.json({
        message: "Restaurant approved and database provisioned",
        tenantId,
        dbName,
        applicationId: id,
      });
    } catch (err) {
      console.error("[vendorApproval] approve:", err);
      return res.status(500).json({ message: "Failed to approve application: " + err.message });
    }
  }
);

/**
 * PATCH /api/v1/admin/applications/:id/reject
 */
router.patch(
  "/applications/:id/reject",
  auth(), rbac(["ADMIN", "SUPER_ADMIN"]),
  async (req, res) => {
    const id     = Number(req.params.id);
    const parsed = rejectSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Rejection reason is required (min 5 chars)" });
    }
    const { reason } = parsed.data;

    try {
      const [[application]] = await saPool().execute(
        "SELECT id, approval_status, business_name FROM restaurant_applications WHERE id = ? LIMIT 1",
        [id]
      );
      if (!application) return res.status(404).json({ message: "Application not found" });
      if (application.approval_status !== "PENDING") {
        return res.status(400).json({ message: `Application is already ${application.approval_status.toLowerCase()}` });
      }

      await saPool().execute(
        `UPDATE restaurant_applications
         SET approval_status = 'REJECTED', rejection_reason = ?,
             reviewed_by_user_id = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [reason, req.user.sub, id]
      );

      await saPool().execute(
        `INSERT INTO audit_logs (actor_id, actor_email, action, target_type, target_id, detail)
         VALUES (?, ?, 'RESTAURANT_REJECTED', 'restaurant_application', ?, ?)`,
        [req.user.sub, req.user.email, id, JSON.stringify({ reason, businessName: application.business_name })]
      );

      return res.json({ message: "Application rejected", applicationId: id });
    } catch (err) {
      console.error("[vendorApproval] reject:", err);
      return res.status(500).json({ message: "Failed to reject application" });
    }
  }
);

/**
 * GET /api/v1/admin/tenants
 * List all approved tenants / restaurants.
 */
router.get(
  "/tenants",
  auth(), rbac(["ADMIN", "SUPER_ADMIN"]),
  async (req, res) => {
    try {
      const [rows] = await saPool().execute(
        `SELECT t.id, t.name, t.subdomain, t.db_name, t.status, t.created_at,
                ra.business_type, ra.city, ra.owner_email
         FROM tenants t
         LEFT JOIN restaurant_applications ra ON ra.tenant_id = t.id
         ORDER BY t.created_at DESC`
      );
      return res.json({ tenants: rows });
    } catch (err) {
      console.error("[vendorApproval] tenants:", err);
      return res.status(500).json({ message: "Failed to fetch tenants" });
    }
  }
);

module.exports = router;
