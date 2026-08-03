const express = require("express");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const pool = require("../../db/pool");
const auth = require("../../middlewares/auth");
const rbac = require("../../middlewares/rbac");

const router = express.Router();

const STAFF_ROLES = [
  "OWNER_MANAGER",
  "COOK",
  "ASSISTANT_COOK",
  "SERVER",
  "HELPER",
  "CASHIER",
  "DELIVERY_PERSON",
];

const STAFF_ROLE_META = {
  OWNER_MANAGER: { label: "Owner / Manager", description: "Full restaurant operations access", loginRole: "MANAGER" },
  COOK: { label: "Cook", description: "Kitchen display and food prep", loginRole: "MANAGER" },
  ASSISTANT_COOK: { label: "Assistant Cook", description: "Supports kitchen prep", loginRole: "MANAGER" },
  SERVER: { label: "Server", description: "Dine-in table service and Book page", loginRole: "MANAGER" },
  HELPER: { label: "Helper", description: "General floor and kitchen support", loginRole: "MANAGER" },
  CASHIER: { label: "Cashier", description: "Billing, takeaway counter, payments", loginRole: "MANAGER" },
  DELIVERY_PERSON: { label: "Delivery Person", description: "Delivery partner assignments", loginRole: "DELIVERY_PARTNER" },
};

const staffCreateSchema = z.object({
  restaurantId: z.coerce.number().int().positive(),
  fullName: z.string().min(2).max(120),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().max(20).optional().or(z.literal("")),
  staffRole: z.enum(STAFF_ROLES),
  employmentType: z.enum(["FULL_TIME", "PART_TIME", "CONTRACT", "TEMP"]).default("FULL_TIME"),
  shiftNote: z.string().max(120).optional().or(z.literal("")),
  emergencyContact: z.string().max(120).optional().or(z.literal("")),
  emergencyPhone: z.string().max(20).optional().or(z.literal("")),
  dateJoined: z.string().optional().or(z.literal("")),
  notes: z.string().max(2000).optional().or(z.literal("")),
  enableLogin: z.boolean().optional().default(false),
  loginPassword: z.string().min(8).optional(),
});

const staffUpdateSchema = z.object({
  fullName: z.string().min(2).max(120).optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().max(20).optional().or(z.literal("")),
  staffRole: z.enum(STAFF_ROLES).optional(),
  employmentType: z.enum(["FULL_TIME", "PART_TIME", "CONTRACT", "TEMP"]).optional(),
  shiftNote: z.string().max(120).optional().or(z.literal("")),
  emergencyContact: z.string().max(120).optional().or(z.literal("")),
  emergencyPhone: z.string().max(20).optional().or(z.literal("")),
  dateJoined: z.string().optional().or(z.literal("")),
  notes: z.string().max(2000).optional().or(z.literal("")),
  isActive: z.boolean().optional(),
});

const passwordSchema = z.object({
  password: z.string().min(8),
});

async function resolveOwnerRestaurant(req, restaurantId) {
  const rid = Number(restaurantId);
  if (!rid) return { error: { status: 400, message: "restaurantId is required" } };

  const [[restaurant]] = await pool.execute(
    "SELECT id, tenant_id, owner_user_id, name FROM restaurants WHERE id = ? LIMIT 1",
    [rid]
  );
  if (!restaurant) return { error: { status: 404, message: "Restaurant not found" } };

  if (req.user.role === "OWNER" && Number(restaurant.owner_user_id) !== Number(req.user.sub)) {
    return { error: { status: 403, message: "You can only manage staff for your restaurants." } };
  }

  return { restaurant, tenantId: Number(restaurant.tenant_id) };
}

function mapStaffRow(row) {
  const meta = STAFF_ROLE_META[row.staff_role] || {};
  return {
    id: row.id,
    restaurant_id: row.restaurant_id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    full_name: row.full_name,
    email: row.email,
    phone: row.phone,
    staff_role: row.staff_role,
    staff_role_label: meta.label || row.staff_role,
    employment_type: row.employment_type,
    shift_note: row.shift_note,
    emergency_contact: row.emergency_contact,
    emergency_phone: row.emergency_phone,
    date_joined: row.date_joined,
    notes: row.notes,
    has_app_login: Boolean(row.has_app_login),
    is_active: Boolean(row.is_active),
    login_email: row.login_email || null,
    login_role: row.login_role || meta.loginRole || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function loginRoleForStaffRole(staffRole) {
  return STAFF_ROLE_META[staffRole]?.loginRole || "MANAGER";
}

router.get("/roles", auth(), rbac("OWNER", "MANAGER"), (_req, res) => {
  return res.json(
    STAFF_ROLES.map((key) => ({
      key,
      label: STAFF_ROLE_META[key].label,
      description: STAFF_ROLE_META[key].description,
      loginRole: STAFF_ROLE_META[key].loginRole,
    }))
  );
});

router.get("/", auth(), rbac("OWNER", "MANAGER"), async (req, res) => {
  const restaurantId = Number(req.query.restaurantId || 0);
  const roleFilter = String(req.query.role || "").toUpperCase();
  const activeOnly = req.query.activeOnly !== "0";

  const ctx = await resolveOwnerRestaurant(req, restaurantId);
  if (ctx.error) return res.status(ctx.error.status).json({ message: ctx.error.message });

  let sql = `
    SELECT rs.*, u.email AS login_email, u.role AS login_role
    FROM restaurant_staff rs
    LEFT JOIN users u ON u.id = rs.user_id
    WHERE rs.restaurant_id = ?
  `;
  const params = [restaurantId];

  if (activeOnly) {
    sql += " AND rs.is_active = 1";
  }
  if (roleFilter && STAFF_ROLES.includes(roleFilter)) {
    sql += " AND rs.staff_role = ?";
    params.push(roleFilter);
  }
  sql += " ORDER BY rs.is_active DESC, rs.full_name ASC";

  const [rows] = await pool.execute(sql, params);
  return res.json({ items: rows.map(mapStaffRow) });
});

router.get("/:staffId", auth(), rbac("OWNER", "MANAGER"), async (req, res) => {
  const staffId = Number(req.params.staffId);
  const [[row]] = await pool.execute(
    `SELECT rs.*, u.email AS login_email, u.role AS login_role
     FROM restaurant_staff rs
     LEFT JOIN users u ON u.id = rs.user_id
     WHERE rs.id = ?
     LIMIT 1`,
    [staffId]
  );
  if (!row) return res.status(404).json({ message: "Staff member not found" });

  const ctx = await resolveOwnerRestaurant(req, row.restaurant_id);
  if (ctx.error) return res.status(ctx.error.status).json({ message: ctx.error.message });

  return res.json(mapStaffRow(row));
});

router.post("/", auth(), rbac("OWNER"), async (req, res) => {
  const parsed = staffCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const ctx = await resolveOwnerRestaurant(req, parsed.data.restaurantId);
  if (ctx.error) return res.status(ctx.error.status).json({ message: ctx.error.message });

  const email = String(parsed.data.email || "").trim().toLowerCase() || null;
  const phone = String(parsed.data.phone || "").trim() || null;
  const enableLogin = Boolean(parsed.data.enableLogin);

  if (enableLogin && !email) {
    return res.status(400).json({ message: "Email is required when enabling app login." });
  }
  if (enableLogin && !parsed.data.loginPassword) {
    return res.status(400).json({ message: "Password is required when enabling app login." });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let userId = null;
    if (enableLogin) {
      const [[existingUser]] = await conn.execute("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
      if (existingUser) {
        await conn.rollback();
        return res.status(409).json({ message: "A user with this email already exists." });
      }

      const loginRole = loginRoleForStaffRole(parsed.data.staffRole);
      const hash = await bcrypt.hash(parsed.data.loginPassword, 10);
      const [userCreated] = await conn.execute(
        "INSERT INTO users (tenant_id, full_name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)",
        [ctx.tenantId, parsed.data.fullName.trim(), email, hash, loginRole]
      );
      userId = userCreated.insertId;

      if (phone) {
        try {
          await conn.execute("UPDATE users SET phone = ? WHERE id = ?", [phone, userId]);
        } catch {
          /* optional phone column */
        }
      }
    }

    const [created] = await conn.execute(
      `INSERT INTO restaurant_staff (
        tenant_id, restaurant_id, user_id, full_name, email, phone,
        staff_role, employment_type, shift_note, emergency_contact, emergency_phone,
        date_joined, notes, has_app_login, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        ctx.tenantId,
        parsed.data.restaurantId,
        userId,
        parsed.data.fullName.trim(),
        email,
        phone,
        parsed.data.staffRole,
        parsed.data.employmentType,
        String(parsed.data.shiftNote || "").trim() || null,
        String(parsed.data.emergencyContact || "").trim() || null,
        String(parsed.data.emergencyPhone || "").trim() || null,
        parsed.data.dateJoined || null,
        String(parsed.data.notes || "").trim() || null,
        enableLogin ? 1 : 0,
      ]
    );

    await conn.commit();

    const [[row]] = await pool.execute(
      `SELECT rs.*, u.email AS login_email, u.role AS login_role
       FROM restaurant_staff rs
       LEFT JOIN users u ON u.id = rs.user_id
       WHERE rs.id = ?
       LIMIT 1`,
      [created.insertId]
    );

    return res.status(201).json(mapStaffRow(row));
  } catch (error) {
    await conn.rollback();
    return res.status(500).json({ message: "Failed to create staff profile", details: error.message });
  } finally {
    conn.release();
  }
});

router.patch("/:staffId", auth(), rbac("OWNER"), async (req, res) => {
  const staffId = Number(req.params.staffId);
  const parsed = staffUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const [[existing]] = await pool.execute("SELECT * FROM restaurant_staff WHERE id = ? LIMIT 1", [staffId]);
  if (!existing) return res.status(404).json({ message: "Staff member not found" });

  const ctx = await resolveOwnerRestaurant(req, existing.restaurant_id);
  if (ctx.error) return res.status(ctx.error.status).json({ message: ctx.error.message });

  const fields = [];
  const values = [];
  const map = {
    fullName: "full_name",
    email: "email",
    phone: "phone",
    staffRole: "staff_role",
    employmentType: "employment_type",
    shiftNote: "shift_note",
    emergencyContact: "emergency_contact",
    emergencyPhone: "emergency_phone",
    dateJoined: "date_joined",
    notes: "notes",
    isActive: "is_active",
  };

  for (const [key, col] of Object.entries(map)) {
    if (parsed.data[key] !== undefined) {
      let val = parsed.data[key];
      if (key === "email" && val) val = String(val).trim().toLowerCase();
      if (typeof val === "string") val = val.trim() || null;
      if (key === "isActive") val = val ? 1 : 0;
      fields.push(`${col} = ?`);
      values.push(val);
    }
  }

  if (!fields.length) return res.status(400).json({ message: "No fields to update" });

  values.push(staffId);
  await pool.execute(`UPDATE restaurant_staff SET ${fields.join(", ")} WHERE id = ?`, values);

  if (existing.user_id && parsed.data.fullName) {
    await pool.execute("UPDATE users SET full_name = ? WHERE id = ?", [parsed.data.fullName.trim(), existing.user_id]);
  }
  if (existing.user_id && parsed.data.isActive !== undefined) {
    await pool.execute("UPDATE users SET is_active = ? WHERE id = ?", [parsed.data.isActive ? 1 : 0, existing.user_id]);
  }

  const [[row]] = await pool.execute(
    `SELECT rs.*, u.email AS login_email, u.role AS login_role
     FROM restaurant_staff rs
     LEFT JOIN users u ON u.id = rs.user_id
     WHERE rs.id = ?
     LIMIT 1`,
    [staffId]
  );

  return res.json(mapStaffRow(row));
});

router.post("/:staffId/reset-password", auth(), rbac("OWNER"), async (req, res) => {
  const staffId = Number(req.params.staffId);
  const parsed = passwordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const [[existing]] = await pool.execute(
    "SELECT id, restaurant_id, user_id, has_app_login FROM restaurant_staff WHERE id = ? LIMIT 1",
    [staffId]
  );
  if (!existing) return res.status(404).json({ message: "Staff member not found" });
  if (!existing.user_id || !existing.has_app_login) {
    return res.status(400).json({ message: "This staff member does not have app login enabled." });
  }

  const ctx = await resolveOwnerRestaurant(req, existing.restaurant_id);
  if (ctx.error) return res.status(ctx.error.status).json({ message: ctx.error.message });

  const hash = await bcrypt.hash(parsed.data.password, 10);
  await pool.execute("UPDATE users SET password_hash = ? WHERE id = ?", [hash, existing.user_id]);

  return res.json({ ok: true, message: "Password reset successfully." });
});

router.post("/:staffId/enable-login", auth(), rbac("OWNER"), async (req, res) => {
  const staffId = Number(req.params.staffId);
  const schema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const [[existing]] = await pool.execute("SELECT * FROM restaurant_staff WHERE id = ? LIMIT 1", [staffId]);
  if (!existing) return res.status(404).json({ message: "Staff member not found" });
  if (existing.has_app_login && existing.user_id) {
    return res.status(409).json({ message: "App login is already enabled for this staff member." });
  }

  const ctx = await resolveOwnerRestaurant(req, existing.restaurant_id);
  if (ctx.error) return res.status(ctx.error.status).json({ message: ctx.error.message });

  const email = parsed.data.email.trim().toLowerCase();
  const [[dup]] = await pool.execute("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
  if (dup) return res.status(409).json({ message: "A user with this email already exists." });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const loginRole = loginRoleForStaffRole(existing.staff_role);
    const hash = await bcrypt.hash(parsed.data.password, 10);
    const [userCreated] = await conn.execute(
      "INSERT INTO users (tenant_id, full_name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)",
      [ctx.tenantId, existing.full_name, email, hash, loginRole]
    );
    await conn.execute(
      "UPDATE restaurant_staff SET user_id = ?, email = ?, has_app_login = 1 WHERE id = ?",
      [userCreated.insertId, email, staffId]
    );
    await conn.commit();
    return res.json({ ok: true, userId: userCreated.insertId });
  } catch (error) {
    await conn.rollback();
    return res.status(500).json({ message: "Failed to enable login", details: error.message });
  } finally {
    conn.release();
  }
});

router.delete("/:staffId", auth(), rbac("OWNER"), async (req, res) => {
  const staffId = Number(req.params.staffId);
  const [[existing]] = await pool.execute(
    "SELECT id, restaurant_id, user_id FROM restaurant_staff WHERE id = ? LIMIT 1",
    [staffId]
  );
  if (!existing) return res.status(404).json({ message: "Staff member not found" });

  const ctx = await resolveOwnerRestaurant(req, existing.restaurant_id);
  if (ctx.error) return res.status(ctx.error.status).json({ message: ctx.error.message });

  await pool.execute("UPDATE restaurant_staff SET is_active = 0 WHERE id = ?", [staffId]);
  if (existing.user_id) {
    await pool.execute("UPDATE users SET is_active = 0 WHERE id = ?", [existing.user_id]);
  }

  return res.json({ ok: true, message: "Staff member deactivated." });
});

module.exports = router;
