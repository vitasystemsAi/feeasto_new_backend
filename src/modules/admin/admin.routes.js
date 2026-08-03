const express = require("express");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const pool = require("../../db/pool");
const auth = require("../../middlewares/auth");
const rbac = require("../../middlewares/rbac");
const { platformApprover } = require("../../middlewares/platformApprover");

const router = express.Router();

const userCreateSchema = z.object({
  fullName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["CUSTOMER", "OWNER", "MANAGER", "DELIVERY_PARTNER", "ADMIN", "SUPER_ADMIN"]),
  tenantId: z.number().int().nullable().optional(),
  isActive: z.boolean().optional(),
});

const userUpdateSchema = z.object({
  fullName: z.string().min(2).optional(),
  email: z.string().email().optional(),
  role: z.enum(["CUSTOMER", "OWNER", "MANAGER", "DELIVERY_PARTNER", "ADMIN", "SUPER_ADMIN"]).optional(),
  tenantId: z.number().int().nullable().optional(),
  isActive: z.boolean().optional(),
});

const userPasswordSchema = z.object({
  password: z.string().min(8),
});

const restaurantCreateSchema = z.object({
  name: z.string().min(2),
  address: z.string().min(5),
  description: z.string().optional(),
  ownerUserId: z.number().int(),
  tenantId: z.number().int().nullable().optional(),
  approvalStatus: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
});

const restaurantUpdateSchema = z.object({
  name: z.string().min(2).optional(),
  address: z.string().min(5).optional(),
  description: z.string().optional(),
  ownerUserId: z.number().int().optional(),
  tenantId: z.number().int().nullable().optional(),
  approvalStatus: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
});

function makeSlug(value) {
  const base = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `${base || "restaurant"}-${Date.now().toString().slice(-6)}`;
}

function isSuperAdmin(req) {
  return req.user?.role === "SUPER_ADMIN";
}

function forbidAdminManagingSuperAdmin(req, targetRole) {
  return !isSuperAdmin(req) && String(targetRole || "").toUpperCase() === "SUPER_ADMIN";
}

router.get("/overview", auth(), rbac("ADMIN", "SUPER_ADMIN"), async (_req, res) => {
  const [[restaurants]] = await pool.execute("SELECT COUNT(*) AS totalRestaurants FROM restaurants");
  const [[customers]] = await pool.execute("SELECT COUNT(*) AS totalCustomers FROM users WHERE role = 'CUSTOMER'");
  const [[owners]] = await pool.execute("SELECT COUNT(*) AS totalOwners FROM users WHERE role = 'OWNER'");
  const [[orders]] = await pool.execute("SELECT COUNT(*) AS totalOrders FROM orders");

  return res.json({
    totalRestaurants: Number(restaurants.totalRestaurants || 0),
    totalCustomers: Number(customers.totalCustomers || 0),
    totalOwners: Number(owners.totalOwners || 0),
    totalOrders: Number(orders.totalOrders || 0),
  });
});

router.get("/restaurants", auth(), rbac("ADMIN", "SUPER_ADMIN"), platformApprover(), async (_req, res) => {
  const [rows] = await pool.execute(
    `SELECT r.id, r.name, r.slug, r.description, r.address, r.approval_status, r.rating, r.created_at, r.kyc_document_url,
            u.full_name AS owner_name, u.email AS owner_email
     FROM restaurants r
     LEFT JOIN users u ON u.id = r.owner_user_id
     ORDER BY r.id DESC`
  );
  return res.json(rows);
});

router.get("/customers", auth(), rbac("ADMIN", "SUPER_ADMIN"), async (_req, res) => {
  const [rows] = await pool.execute(
    "SELECT id, full_name, email, role, created_at FROM users WHERE role = 'CUSTOMER' ORDER BY id DESC"
  );
  return res.json(rows);
});

router.get(
  "/restaurants/:restaurantId/document/:docKey",
  auth(),
  rbac("ADMIN", "SUPER_ADMIN"),
  platformApprover(),
  async (req, res) => {
    const restaurantId = Number(req.params.restaurantId);
    const allowedKeys = [
      "companyRegistrationCertificate",
      "tradeLicense",
      "fssaiLicense",
      "gstRegistration",
    ];
    if (!allowedKeys.includes(req.params.docKey)) {
      return res.status(400).json({ message: "Invalid document key" });
    }

    const [[row]] = await pool.execute(
      "SELECT kyc_document_url FROM restaurants WHERE id = ? LIMIT 1",
      [restaurantId]
    );
    if (!row) return res.status(404).json({ message: "Restaurant not found" });

    let kycData = null;
    try {
      kycData = JSON.parse(row.kyc_document_url || "{}");
    } catch {
      return res.status(400).json({ message: "Invalid KYC data format" });
    }

    const relativePath = kycData?.documents?.[req.params.docKey];
    if (!relativePath) return res.status(404).json({ message: "Document not uploaded" });

    const uploadsRoot = path.join(__dirname, "..", "..", "..", "uploads");
    const normalized = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(uploadsRoot, path.basename(normalized));
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: "Document file not found" });

    return res.sendFile(filePath);
  }
);

router.get("/super/users", auth(), rbac("ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const role = req.query.role ? String(req.query.role).toUpperCase() : "";
  if (forbidAdminManagingSuperAdmin(req, role)) {
    return res.status(403).json({ message: "Admins cannot view super admin accounts." });
  }
  const params = [];
  const whereParts = [];
  if (role) {
    whereParts.push("u.role = ?");
    params.push(role);
  }
  if (!isSuperAdmin(req)) {
    whereParts.push("u.role <> 'SUPER_ADMIN'");
  }
  const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
  const [rows] = await pool.execute(
    `SELECT u.id, u.full_name, u.email, u.role, u.tenant_id, u.is_active, u.created_at,
            t.name AS tenant_name
     FROM users u
     LEFT JOIN tenants t ON t.id = u.tenant_id
     ${where}
     ORDER BY u.id DESC`,
    params
  );
  return res.json(rows);
});

router.post("/super/users", auth(), rbac("ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const parsed = userCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
  const { fullName, email, password, role, tenantId = null, isActive = true } = parsed.data;
  if (forbidAdminManagingSuperAdmin(req, role)) {
    return res.status(403).json({ message: "Admins cannot create super admin users." });
  }
  const hash = await bcrypt.hash(password, 10);
  try {
    const [result] = await pool.execute(
      "INSERT INTO users (full_name, email, password_hash, role, tenant_id, is_active) VALUES (?, ?, ?, ?, ?, ?)",
      [fullName, email.toLowerCase(), hash, role, tenantId, isActive ? 1 : 0]
    );
    return res.status(201).json({ id: Number(result.insertId), message: "User created" });
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "Email already exists." });
    }
    return res.status(500).json({ message: "Failed to create user.", details: error.message });
  }
});

router.patch("/super/users/:userId", auth(), rbac("ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const userId = Number(req.params.userId);
  if (!userId) return res.status(400).json({ message: "Invalid user id" });
  const parsed = userUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
  const [[existing]] = await pool.execute("SELECT id, role FROM users WHERE id = ? LIMIT 1", [userId]);
  if (!existing) return res.status(404).json({ message: "User not found" });
  if (forbidAdminManagingSuperAdmin(req, existing.role) || forbidAdminManagingSuperAdmin(req, parsed.data.role)) {
    return res.status(403).json({ message: "Admins cannot modify super admin users." });
  }
  const updates = [];
  const values = [];
  if (parsed.data.fullName !== undefined) {
    updates.push("full_name = ?");
    values.push(parsed.data.fullName);
  }
  if (parsed.data.email !== undefined) {
    updates.push("email = ?");
    values.push(parsed.data.email.toLowerCase());
  }
  if (parsed.data.role !== undefined) {
    updates.push("role = ?");
    values.push(parsed.data.role);
  }
  if (parsed.data.tenantId !== undefined) {
    updates.push("tenant_id = ?");
    values.push(parsed.data.tenantId);
  }
  if (parsed.data.isActive !== undefined) {
    updates.push("is_active = ?");
    values.push(parsed.data.isActive ? 1 : 0);
  }
  if (!updates.length) return res.status(400).json({ message: "No fields to update." });
  values.push(userId);
  try {
    const [result] = await pool.execute(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, values);
    if (!result.affectedRows) return res.status(404).json({ message: "User not found" });
    return res.json({ message: "User updated" });
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "Email already exists." });
    }
    return res.status(500).json({ message: "Failed to update user.", details: error.message });
  }
});

router.patch("/super/users/:userId/password", auth(), rbac("ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const userId = Number(req.params.userId);
  if (!userId) return res.status(400).json({ message: "Invalid user id" });
  const parsed = userPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
  const [[existing]] = await pool.execute("SELECT id, role FROM users WHERE id = ? LIMIT 1", [userId]);
  if (!existing) return res.status(404).json({ message: "User not found" });
  if (forbidAdminManagingSuperAdmin(req, existing.role)) {
    return res.status(403).json({ message: "Admins cannot reset super admin passwords." });
  }
  const hash = await bcrypt.hash(parsed.data.password, 10);
  const [result] = await pool.execute("UPDATE users SET password_hash = ? WHERE id = ?", [hash, userId]);
  if (!result.affectedRows) return res.status(404).json({ message: "User not found" });
  return res.json({ message: "Password reset successful" });
});

router.delete("/super/users/:userId", auth(), rbac("ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const userId = Number(req.params.userId);
  if (!userId) return res.status(400).json({ message: "Invalid user id" });
  const [[existing]] = await pool.execute("SELECT id, role FROM users WHERE id = ? LIMIT 1", [userId]);
  if (!existing) return res.status(404).json({ message: "User not found" });
  if (forbidAdminManagingSuperAdmin(req, existing.role)) {
    return res.status(403).json({ message: "Admins cannot delete super admin users." });
  }
  try {
    const [result] = await pool.execute("DELETE FROM users WHERE id = ?", [userId]);
    if (!result.affectedRows) return res.status(404).json({ message: "User not found" });
    return res.json({ message: "User deleted" });
  } catch (error) {
    return res.status(409).json({
      message: "User cannot be deleted because it is linked to existing records. Set user as inactive instead.",
      details: error.message,
    });
  }
});

router.get("/super/restaurants", auth(), rbac("ADMIN", "SUPER_ADMIN"), async (_req, res) => {
  const [rows] = await pool.execute(
    `SELECT r.id, r.name, r.slug, r.description, r.address, r.approval_status, r.tenant_id, r.owner_user_id, r.created_at,
            t.name AS tenant_name, u.full_name AS owner_name, u.email AS owner_email
     FROM restaurants r
     LEFT JOIN tenants t ON t.id = r.tenant_id
     LEFT JOIN users u ON u.id = r.owner_user_id
     ORDER BY r.id DESC`
  );
  return res.json(rows);
});

router.post("/super/restaurants", auth(), rbac("ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const parsed = restaurantCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
  const { name, address, description = "", ownerUserId, tenantId = null, approvalStatus = "PENDING" } = parsed.data;
  try {
    const [result] = await pool.execute(
      "INSERT INTO restaurants (tenant_id, owner_user_id, name, slug, description, address, kyc_document_url, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [tenantId, ownerUserId, name, makeSlug(name), description, address, "{}", approvalStatus]
    );
    return res.status(201).json({ id: Number(result.insertId), message: "Restaurant created" });
  } catch (error) {
    return res.status(500).json({ message: "Failed to create restaurant.", details: error.message });
  }
});

router.patch("/super/restaurants/:restaurantId", auth(), rbac("ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const restaurantId = Number(req.params.restaurantId);
  if (!restaurantId) return res.status(400).json({ message: "Invalid restaurant id" });
  const parsed = restaurantUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
  const updates = [];
  const values = [];
  if (parsed.data.name !== undefined) {
    updates.push("name = ?");
    values.push(parsed.data.name);
  }
  if (parsed.data.address !== undefined) {
    updates.push("address = ?");
    values.push(parsed.data.address);
  }
  if (parsed.data.description !== undefined) {
    updates.push("description = ?");
    values.push(parsed.data.description);
  }
  if (parsed.data.ownerUserId !== undefined) {
    updates.push("owner_user_id = ?");
    values.push(parsed.data.ownerUserId);
  }
  if (parsed.data.tenantId !== undefined) {
    updates.push("tenant_id = ?");
    values.push(parsed.data.tenantId);
  }
  if (parsed.data.approvalStatus !== undefined) {
    updates.push("approval_status = ?");
    values.push(parsed.data.approvalStatus);
  }
  if (!updates.length) return res.status(400).json({ message: "No fields to update." });
  values.push(restaurantId);
  const [result] = await pool.execute(`UPDATE restaurants SET ${updates.join(", ")} WHERE id = ?`, values);
  if (!result.affectedRows) return res.status(404).json({ message: "Restaurant not found" });
  return res.json({ message: "Restaurant updated" });
});

router.delete("/super/restaurants/:restaurantId", auth(), rbac("ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const restaurantId = Number(req.params.restaurantId);
  if (!restaurantId) return res.status(400).json({ message: "Invalid restaurant id" });
  try {
    const [result] = await pool.execute("DELETE FROM restaurants WHERE id = ?", [restaurantId]);
    if (!result.affectedRows) return res.status(404).json({ message: "Restaurant not found" });
    return res.json({ message: "Restaurant deleted" });
  } catch (error) {
    return res.status(409).json({
      message: "Restaurant cannot be deleted because it is linked to existing records.",
      details: error.message,
    });
  }
});

router.get("/super/delivery-partners", auth(), rbac("ADMIN", "SUPER_ADMIN"), async (_req, res) => {
  const [rows] = await pool.execute(
    `SELECT p.id AS profile_id, p.employee_id, p.phone, p.is_active, p.restaurant_id, p.tenant_id, p.delivery_partner_id,
            u.id AS user_id, u.full_name, u.email, u.is_active AS user_is_active, r.name AS restaurant_name
     FROM restaurant_delivery_partner_profiles p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN restaurants r ON r.id = p.restaurant_id
     ORDER BY p.id DESC`
  );
  return res.json(rows);
});

router.patch("/super/delivery-partners/:profileId", auth(), rbac("ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const profileId = Number(req.params.profileId);
  if (!profileId) return res.status(400).json({ message: "Invalid profile id" });
  const schema = z.object({
    fullName: z.string().min(2).optional(),
    email: z.string().email().optional(),
    phone: z.string().min(7).max(20).optional(),
    isActive: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
  const [[profile]] = await pool.execute(
    "SELECT id, user_id FROM restaurant_delivery_partner_profiles WHERE id = ? LIMIT 1",
    [profileId]
  );
  if (!profile) return res.status(404).json({ message: "Delivery partner profile not found" });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const userUpdates = [];
    const userValues = [];
    if (parsed.data.fullName !== undefined) {
      userUpdates.push("full_name = ?");
      userValues.push(parsed.data.fullName);
    }
    if (parsed.data.email !== undefined) {
      userUpdates.push("email = ?");
      userValues.push(parsed.data.email.toLowerCase());
    }
    if (parsed.data.isActive !== undefined) {
      userUpdates.push("is_active = ?");
      userValues.push(parsed.data.isActive ? 1 : 0);
    }
    if (userUpdates.length) {
      userValues.push(profile.user_id);
      await conn.execute(`UPDATE users SET ${userUpdates.join(", ")} WHERE id = ?`, userValues);
    }
    const profileUpdates = [];
    const profileValues = [];
    if (parsed.data.phone !== undefined) {
      profileUpdates.push("phone = ?");
      profileValues.push(parsed.data.phone);
    }
    if (parsed.data.isActive !== undefined) {
      profileUpdates.push("is_active = ?");
      profileValues.push(parsed.data.isActive ? 1 : 0);
    }
    if (profileUpdates.length) {
      profileValues.push(profileId);
      await conn.execute(
        `UPDATE restaurant_delivery_partner_profiles SET ${profileUpdates.join(", ")} WHERE id = ?`,
        profileValues
      );
    }
    await conn.commit();
    return res.json({ message: "Delivery partner updated" });
  } catch (error) {
    await conn.rollback();
    return res.status(500).json({ message: "Failed to update delivery partner.", details: error.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
