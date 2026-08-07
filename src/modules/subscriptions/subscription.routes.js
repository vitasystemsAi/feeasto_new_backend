const express = require("express");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { z } = require("zod");
const pool = require("../../db/pool");
const auth = require("../../middlewares/auth");
const rbac = require("../../middlewares/rbac");
const tenantScope = require("../../middlewares/tenant");
const {
  ensureDeliveryPartnerRow,
  provisionSubscriberDelivery,
} = require("../delivery/partner.service");
const {
  roundMoney,
  createSubscriptionPaymentIntent,
  validateSubscriptionPayment,
  mapProviderToMethod,
} = require("./paymentGateway");
const {
  listUpcomingDeliveries,
  cancelDelivery,
  rescheduleDelivery,
  changeDeliveryItems,
} = require("./customer-delivery.service");
const { validateIndianPhone } = require("../../utils/phone");

const router = express.Router();

function todayIsoLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
const opsRoles = ["OWNER", "MANAGER"];

const uploadDir = path.join(__dirname, "..", "..", "..", "uploads", "subscriptions");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const safeBase = (path.basename(file.originalname, ext) || "file").replace(/[^a-zA-Z0-9-_]/g, "-");
    cb(null, `${Date.now()}-${safeBase}${ext}`);
  },
});
const upload = multer({ storage });

function fileUrl(req, field) {
  const file = req.files?.[field]?.[0];
  return file ? `/uploads/subscriptions/${file.filename}` : null;
}

function incrementLetterSeries(series) {
  let a = series.charCodeAt(0);
  let b = series.charCodeAt(1);
  if (b < 90) return String.fromCharCode(a) + String.fromCharCode(b + 1);
  if (a < 90) return String.fromCharCode(a + 1) + "A";
  return "AA";
}

async function assertRestaurantAccess(tenantId, restaurantId) {
  const [rows] = await pool.execute(
    "SELECT id FROM restaurants WHERE id = ? AND tenant_id = ? LIMIT 1",
    [restaurantId, tenantId]
  );
  return rows[0] || null;
}

async function allocateEmployeeId(conn, restaurantId) {
  const [existing] = await conn.execute(
    "SELECT letter_series, next_number FROM partner_employee_id_counters WHERE restaurant_id = ? FOR UPDATE",
    [restaurantId]
  );

  let letterSeries = "AA";
  let nextNumber = 1;

  if (existing[0]) {
    letterSeries = existing[0].letter_series;
    nextNumber = Number(existing[0].next_number);
  } else {
    await conn.execute(
      "INSERT INTO partner_employee_id_counters (restaurant_id, letter_series, next_number) VALUES (?, 'AA', 1)",
      [restaurantId]
    );
  }

  const employeeId = `FAR-R${restaurantId}-${letterSeries}-${String(nextNumber).padStart(4, "0")}`;
  let updatedSeries = letterSeries;
  let updatedNumber = nextNumber + 1;
  if (updatedNumber > 9999) {
    updatedNumber = 1;
    updatedSeries = incrementLetterSeries(letterSeries);
  }

  await conn.execute(
    "UPDATE partner_employee_id_counters SET letter_series = ?, next_number = ? WHERE restaurant_id = ?",
    [updatedSeries, updatedNumber, restaurantId]
  );

  return employeeId;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function mapDuplicateEntryMessage(error) {
  const msg = String(error?.sqlMessage || error?.message || "").toLowerCase();
  if (msg.includes("email") || msg.includes("users.")) {
    return "This email is already registered in the system. Use a different email or check the Users list.";
  }
  if (msg.includes("employee_id") || msg.includes("uk_partner_employee_id")) {
    return "Employee ID conflict. Please try again.";
  }
  if (msg.includes("uk_partner_restaurant_user") || msg.includes("restaurant_id")) {
    return "This user is already registered as a delivery partner for this restaurant.";
  }
  return "A duplicate record already exists. Check email and existing delivery partners.";
}

async function findUserByEmail(conn, email) {
  const normalized = normalizeEmail(email);
  const [rows] = await conn.execute(
    "SELECT id, full_name, email, role, tenant_id FROM users WHERE LOWER(TRIM(email)) = ? LIMIT 1",
    [normalized]
  );
  return rows[0] || null;
}

const planItemSchema = z.object({
  menuItemId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().positive().max(999),
});

const planSchema = z.object({
  restaurantId: z.coerce.number().int().positive(),
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional(),
  price: z.coerce.number().nonnegative(),
  cycleId: z.coerce.number().int().positive(),
  includesDailyDelivery: z.coerce.boolean().optional(),
  isActive: z.coerce.boolean().optional(),
  items: z.array(planItemSchema).optional(),
});

async function fetchPlanItemsByPlanIds(planIds) {
  if (!planIds.length) return {};
  const placeholders = planIds.map(() => "?").join(",");
  let rows;
  try {
    [rows] = await pool.execute(
      `SELECT spi.plan_id, spi.menu_item_id, spi.quantity,
              mi.name AS menu_item_name, mi.price AS unit_price, mi.is_veg, mi.is_active AS menu_is_active
       FROM subscription_plan_items spi
       INNER JOIN menu_items mi ON mi.id = spi.menu_item_id
       WHERE spi.plan_id IN (${placeholders})
       ORDER BY spi.id`,
      planIds
    );
  } catch (error) {
    if (error?.code === "ER_NO_SUCH_TABLE") return {};
    throw error;
  }
  return rows.reduce((acc, row) => {
    const pid = row.plan_id;
    if (!acc[pid]) acc[pid] = [];
    acc[pid].push({
      menu_item_id: row.menu_item_id,
      menu_item_name: row.menu_item_name,
      quantity: row.quantity,
      unit_price: row.unit_price,
      is_veg: row.is_veg,
      line_total: Number(row.quantity) * Number(row.unit_price),
    });
    return acc;
  }, {});
}

async function assertMenuItemsForRestaurant(tenantId, restaurantId, items) {
  if (!items?.length) return { ok: true, items: [] };
  const ids = [...new Set(items.map((it) => it.menuItemId))];
  const placeholders = ids.map(() => "?").join(",");
  const [rows] = await pool.execute(
    `SELECT id FROM menu_items
     WHERE id IN (${placeholders}) AND restaurant_id = ? AND tenant_id = ? AND is_active = 1`,
    [...ids, restaurantId, tenantId]
  );
  if (rows.length !== ids.length) {
    return { ok: false, message: "One or more menu items are invalid or inactive for this restaurant." };
  }
  return { ok: true, items };
}

async function syncPlanItems(conn, planId, items) {
  await conn.execute("DELETE FROM subscription_plan_items WHERE plan_id = ?", [planId]);
  if (!items?.length) return;
  for (const it of items) {
    await conn.execute(
      "INSERT INTO subscription_plan_items (plan_id, menu_item_id, quantity) VALUES (?, ?, ?)",
      [planId, it.menuItemId, it.quantity]
    );
  }
}

async function assertCycleForRestaurant(tenantId, restaurantId, cycleId) {
  const [rows] = await pool.execute(
    `SELECT id, name, value_type, value, is_active
     FROM subscription_cycles
     WHERE id = ? AND tenant_id = ? AND restaurant_id = ?`,
    [cycleId, tenantId, restaurantId]
  );
  return rows[0] || null;
}

const cycleSchema = z.object({
  restaurantId: z.coerce.number().int().positive(),
  name: z.string().min(2).max(120),
  valueType: z.enum(["DAYS", "QUANTITY"]),
  value: z.coerce.number().int().positive(),
  isActive: z.coerce.boolean().optional(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dayAssignmentSchema = z.object({
  date: isoDate,
  time: z.string().regex(/^\d{2}:\d{2}$/),
  items: z
    .array(
      z.object({
        menuItemId: z.coerce.number().int().positive(),
        quantity: z.coerce.number().int().positive().default(1),
        menuItemName: z.string().max(150).optional(),
      })
    )
    .min(1),
});

const deliveryScheduleSchema = z.object({
  ranges: z
    .array(
      z.object({
        from: isoDate,
        to: isoDate,
      })
    )
    .default([]),
  dates: z.array(isoDate).default([]),
  assignments: z.array(dayAssignmentSchema).optional(),
});

function expandScheduleDays(schedule) {
  const unique = new Set();
  for (const d of schedule.dates || []) unique.add(d);
  for (const range of schedule.ranges || []) {
    const start = new Date(`${range.from}T00:00:00`);
    const end = new Date(`${range.to}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) continue;
    const cursor = new Date(start);
    while (cursor <= end) {
      unique.add(cursor.toISOString().slice(0, 10));
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return [...unique];
}

function validateCustomSchedule(deliveryFrequency, deliverySchedule, deliveryDays) {
  if (deliveryFrequency !== "CUSTOM") return null;
  if (deliverySchedule) {
    const days = expandScheduleDays(deliverySchedule);
    if (!days.length) return "Select at least one delivery date or date range for custom schedule.";
    return null;
  }
  if (deliveryDays?.length) return null;
  return "Select at least one delivery date or date range for custom schedule.";
}

function serializeDeliveryDaysJson(deliveryFrequency, deliverySchedule, deliveryDays) {
  if (deliveryFrequency !== "CUSTOM") return null;
  if (deliverySchedule) return JSON.stringify(deliverySchedule);
  if (deliveryDays?.length) return JSON.stringify(deliveryDays);
  return null;
}

/** Plan menu item quantities are for the entire plan, not per delivery day. */
async function validatePlanAssignmentBudget(planId, assignments) {
  if (!assignments?.length) return null;
  const [planItems] = await pool.execute(
    "SELECT menu_item_id, quantity FROM subscription_plan_items WHERE plan_id = ?",
    [planId]
  );
  if (!planItems.length) {
    return "This plan has no menu items configured in Master Data.";
  }
  const caps = new Map(planItems.map((r) => [Number(r.menu_item_id), Math.max(1, Number(r.quantity) || 1)]));
  const used = new Map();
  for (const slot of assignments) {
    for (const item of slot.items || []) {
      const id = Number(item.menuItemId);
      const qty = Math.max(1, Number(item.quantity) || 1);
      if (!caps.has(id)) {
        return "Assignments may only include menu items from the selected subscription plan.";
      }
      used.set(id, (used.get(id) || 0) + qty);
    }
  }
  for (const [id, cap] of caps) {
    const total = used.get(id) || 0;
    if (total > cap) {
      return `Assigned quantity for menu item #${id} (${total}) exceeds the plan total (${cap}).`;
    }
  }
  return null;
}

// ---- Subscription plans (Master Data) -----------------------------------------

router.get("/plans", auth(), tenantScope, rbac(...opsRoles), async (req, res) => {
  const restaurantId = Number(req.query.restaurantId);
  if (!restaurantId) return res.status(400).json({ message: "restaurantId is required" });
  if (!(await assertRestaurantAccess(req.tenantId, restaurantId))) {
    return res.status(404).json({ message: "Restaurant not found" });
  }

  const [rows] = await pool.execute(
    `SELECT sp.id, sp.restaurant_id, sp.name, sp.description, sp.price, sp.cycle_id,
            sp.includes_daily_delivery, sp.is_active, sp.created_at,
            sc.name AS cycle_name, sc.value_type AS cycle_value_type, sc.value AS cycle_value, sc.is_active AS cycle_is_active
     FROM subscription_plans sp
     LEFT JOIN subscription_cycles sc ON sc.id = sp.cycle_id
     WHERE sp.tenant_id = ? AND sp.restaurant_id = ?
     ORDER BY sp.name`,
    [req.tenantId, restaurantId]
  );
  const planIds = rows.map((r) => r.id);
  const itemsByPlan = await fetchPlanItemsByPlanIds(planIds);
  const withItems = rows.map((row) => ({
    ...row,
    items: itemsByPlan[row.id] || [],
    items_count: (itemsByPlan[row.id] || []).length,
  }));
  return res.json(withItems);
});

router.post("/plans", auth(), tenantScope, rbac(...opsRoles), async (req, res) => {
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const d = parsed.data;
  if (!(await assertRestaurantAccess(req.tenantId, d.restaurantId))) {
    return res.status(404).json({ message: "Restaurant not found" });
  }
  const cycle = await assertCycleForRestaurant(req.tenantId, d.restaurantId, d.cycleId);
  if (!cycle) return res.status(400).json({ message: "Invalid cycle for this restaurant." });

  const menuCheck = await assertMenuItemsForRestaurant(req.tenantId, d.restaurantId, d.items);
  if (!menuCheck.ok) return res.status(400).json({ message: menuCheck.message });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute(
      `INSERT INTO subscription_plans
        (tenant_id, restaurant_id, name, description, price, cycle_id, includes_daily_delivery, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.tenantId,
        d.restaurantId,
        d.name,
        d.description || null,
        d.price,
        d.cycleId,
        d.includesDailyDelivery === false ? 0 : 1,
        d.isActive === false ? 0 : 1,
      ]
    );
    const planId = result.insertId;
    if (d.items?.length) {
      try {
        await syncPlanItems(conn, planId, d.items);
      } catch (syncErr) {
        if (syncErr?.code === "ER_NO_SUCH_TABLE") {
          await conn.rollback();
          return res.status(503).json({
            message: "Database migration required. Run: node scripts/apply-migration-006-plan-items.js",
          });
        }
        throw syncErr;
      }
    }
    await conn.commit();
    return res.status(201).json({ id: planId, message: "Plan created" });
  } catch (error) {
    await conn.rollback();
    if (error?.code === "ER_NO_SUCH_TABLE") {
      return res.status(503).json({
        message: "Database migration required. Run: node scripts/apply-migration-006-plan-items.js",
      });
    }
    return res.status(500).json({ message: "Failed to create plan", details: error.message });
  } finally {
    conn.release();
  }
});

router.patch("/plans/:planId", auth(), tenantScope, rbac(...opsRoles), async (req, res) => {
  const planId = Number(req.params.planId);
  const parsed = planSchema.partial().omit({ restaurantId: true }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const [existing] = await pool.execute(
    "SELECT id, restaurant_id FROM subscription_plans WHERE id = ? AND tenant_id = ?",
    [planId, req.tenantId]
  );
  if (!existing[0]) return res.status(404).json({ message: "Plan not found" });

  const d = parsed.data;
  if (d.cycleId !== undefined) {
    const cycle = await assertCycleForRestaurant(req.tenantId, existing[0].restaurant_id, d.cycleId);
    if (!cycle) return res.status(400).json({ message: "Invalid cycle for this restaurant." });
  }

  const fields = [];
  const values = [];
  if (d.name !== undefined) {
    fields.push("name = ?");
    values.push(d.name);
  }
  if (d.description !== undefined) {
    fields.push("description = ?");
    values.push(d.description || null);
  }
  if (d.price !== undefined) {
    fields.push("price = ?");
    values.push(d.price);
  }
  if (d.cycleId !== undefined) {
    fields.push("cycle_id = ?");
    values.push(d.cycleId);
  }
  if (d.includesDailyDelivery !== undefined) {
    fields.push("includes_daily_delivery = ?");
    values.push(d.includesDailyDelivery ? 1 : 0);
  }
  if (d.isActive !== undefined) {
    fields.push("is_active = ?");
    values.push(d.isActive ? 1 : 0);
  }
  if (!fields.length && d.items === undefined) {
    return res.status(400).json({ message: "No fields to update" });
  }

  if (d.items !== undefined) {
    const menuCheck = await assertMenuItemsForRestaurant(
      req.tenantId,
      existing[0].restaurant_id,
      d.items
    );
    if (!menuCheck.ok) return res.status(400).json({ message: menuCheck.message });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (fields.length) {
      values.push(planId, req.tenantId);
      await conn.execute(
        `UPDATE subscription_plans SET ${fields.join(", ")} WHERE id = ? AND tenant_id = ?`,
        values
      );
    }
    if (d.items !== undefined) {
      await syncPlanItems(conn, planId, d.items);
    }
    await conn.commit();
    return res.json({ message: "Plan updated" });
  } catch (error) {
    await conn.rollback();
    return res.status(500).json({ message: "Failed to update plan", details: error.message });
  } finally {
    conn.release();
  }
});

router.delete("/plans/:planId", auth(), tenantScope, rbac(...opsRoles), async (req, res) => {
  const planId = Number(req.params.planId);
  const [subs] = await pool.execute("SELECT id FROM subscription_subscribers WHERE plan_id = ? LIMIT 1", [planId]);
  if (subs[0]) return res.status(409).json({ message: "Plan is in use by subscribers and cannot be deleted." });

  const [result] = await pool.execute("DELETE FROM subscription_plans WHERE id = ? AND tenant_id = ?", [
    planId,
    req.tenantId,
  ]);
  if (!result.affectedRows) return res.status(404).json({ message: "Plan not found" });
  return res.json({ message: "Plan deleted" });
});

// ---- Subscription cycles (Master Data) --------------------------------------

router.get("/cycles", auth(), tenantScope, rbac(...opsRoles), async (req, res) => {
  const restaurantId = Number(req.query.restaurantId);
  if (!restaurantId) return res.status(400).json({ message: "restaurantId is required" });
  if (!(await assertRestaurantAccess(req.tenantId, restaurantId))) {
    return res.status(404).json({ message: "Restaurant not found" });
  }

  const [rows] = await pool.execute(
    `SELECT id, restaurant_id, name, value_type, value, is_active, created_at
     FROM subscription_cycles WHERE tenant_id = ? AND restaurant_id = ? ORDER BY name`,
    [req.tenantId, restaurantId]
  );
  return res.json(rows);
});

router.post("/cycles", auth(), tenantScope, rbac(...opsRoles), async (req, res) => {
  const parsed = cycleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const d = parsed.data;
  if (!(await assertRestaurantAccess(req.tenantId, d.restaurantId))) {
    return res.status(404).json({ message: "Restaurant not found" });
  }

  const [result] = await pool.execute(
    `INSERT INTO subscription_cycles (tenant_id, restaurant_id, name, value_type, value, is_active)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [req.tenantId, d.restaurantId, d.name, d.valueType, d.value, d.isActive === false ? 0 : 1]
  );
  return res.status(201).json({ id: result.insertId, message: "Cycle created" });
});

router.patch("/cycles/:cycleId", auth(), tenantScope, rbac(...opsRoles), async (req, res) => {
  const cycleId = Number(req.params.cycleId);
  const parsed = cycleSchema.partial().omit({ restaurantId: true }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const [existing] = await pool.execute(
    "SELECT id FROM subscription_cycles WHERE id = ? AND tenant_id = ?",
    [cycleId, req.tenantId]
  );
  if (!existing[0]) return res.status(404).json({ message: "Cycle not found" });

  const d = parsed.data;
  const fields = [];
  const values = [];
  if (d.name !== undefined) {
    fields.push("name = ?");
    values.push(d.name);
  }
  if (d.valueType !== undefined) {
    fields.push("value_type = ?");
    values.push(d.valueType);
  }
  if (d.value !== undefined) {
    fields.push("value = ?");
    values.push(d.value);
  }
  if (d.isActive !== undefined) {
    fields.push("is_active = ?");
    values.push(d.isActive ? 1 : 0);
  }
  if (!fields.length) return res.status(400).json({ message: "No fields to update" });

  values.push(cycleId, req.tenantId);
  await pool.execute(`UPDATE subscription_cycles SET ${fields.join(", ")} WHERE id = ? AND tenant_id = ?`, values);
  return res.json({ message: "Cycle updated" });
});

router.delete("/cycles/:cycleId", auth(), tenantScope, rbac(...opsRoles), async (req, res) => {
  const cycleId = Number(req.params.cycleId);
  const [inUse] = await pool.execute("SELECT id FROM subscription_plans WHERE cycle_id = ? LIMIT 1", [cycleId]);
  if (inUse[0]) {
    return res.status(409).json({ message: "Cycle is assigned to one or more plans and cannot be deleted." });
  }

  const [result] = await pool.execute("DELETE FROM subscription_cycles WHERE id = ? AND tenant_id = ?", [
    cycleId,
    req.tenantId,
  ]);
  if (!result.affectedRows) return res.status(404).json({ message: "Cycle not found" });
  return res.json({ message: "Cycle deleted" });
});

// ---- Delivery partners --------------------------------------------------------

router.get("/delivery-partners", auth(), rbac(...opsRoles), async (req, res) => {
  const restaurantId = Number(req.query.restaurantId);
  if (!restaurantId) return res.status(400).json({ message: "restaurantId is required" });

  const [[restaurant]] = await pool.execute(
    "SELECT id, tenant_id, owner_user_id FROM restaurants WHERE id = ? LIMIT 1",
    [restaurantId]
  );
  if (!restaurant) return res.status(404).json({ message: "Restaurant not found." });

  if (req.user.role === "OWNER") {
    if (Number(restaurant.owner_user_id) !== Number(req.user.sub)) {
      return res.status(403).json({ message: "Not your restaurant." });
    }
  } else {
    const headerTenant = req.headers["x-tenant-id"] || req.user?.tenantId || null;
    if (!headerTenant) return res.status(400).json({ message: "Missing tenant context" });
    if (restaurant.tenant_id != null && Number(restaurant.tenant_id) !== Number(headerTenant)) {
      return res.status(403).json({ message: "Restaurant not in this tenant." });
    }
  }

  const [rows] = await pool.execute(
    `SELECT p.id, p.restaurant_id, p.employee_id, p.phone, p.address, p.aadhaar_number,
            p.aadhaar_front_url, p.aadhaar_back_url, p.profile_pic_url, p.is_active, p.created_at,
            u.id AS user_id, u.full_name, u.email, r.name AS restaurant_name
     FROM restaurant_delivery_partner_profiles p
     JOIN users u ON u.id = p.user_id
     JOIN restaurants r ON r.id = p.restaurant_id
     WHERE p.restaurant_id = ?
     ORDER BY p.created_at DESC`,
    [restaurantId]
  );
  return res.json(rows);
});

router.post(
  "/delivery-partners",
  auth(),
  tenantScope,
  rbac(...opsRoles),
  upload.fields([
    { name: "aadhaarFront", maxCount: 1 },
    { name: "aadhaarBack", maxCount: 1 },
    { name: "profilePic", maxCount: 1 },
  ]),
  async (req, res) => {
    const schema = z.object({
      restaurantId: z.coerce.number().int().positive(),
      fullName: z.string().min(2),
      email: z.string().email(),
      password: z.string().min(8),
      phone: z.string().min(10).max(20).optional(),
      address: z.string().min(8),
      aadhaarNumber: z.string().regex(/^\d{12}$/, "Aadhaar must be 12 digits"),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const d = parsed.data;
    if (!(await assertRestaurantAccess(req.tenantId, d.restaurantId))) {
      return res.status(404).json({ message: "Restaurant not found" });
    }

    const aadhaarFrontUrl = fileUrl(req, "aadhaarFront");
    const aadhaarBackUrl = fileUrl(req, "aadhaarBack");
    const profilePicUrl = fileUrl(req, "profilePic");
    if (!aadhaarFrontUrl || !aadhaarBackUrl) {
      return res.status(400).json({ message: "Aadhaar front and back images are required." });
    }

    const emailNorm = normalizeEmail(d.email);
    const hash = await bcrypt.hash(d.password, 10);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const existingUser = await findUserByEmail(conn, emailNorm);

      if (existingUser) {
        if (String(existingUser.role) !== "DELIVERY_PARTNER") {
          await conn.rollback();
          return res.status(409).json({
            message: `This email is already used by a ${existingUser.role} account. Use a different email for the delivery partner.`,
          });
        }
        if (Number(existingUser.tenant_id) !== Number(req.tenantId)) {
          await conn.rollback();
          return res.status(409).json({
            message: "This email belongs to another restaurant group. Use a different email.",
          });
        }

        const [[existingProfile]] = await conn.execute(
          `SELECT id, employee_id FROM restaurant_delivery_partner_profiles
           WHERE restaurant_id = ? AND user_id = ? LIMIT 1`,
          [d.restaurantId, existingUser.id]
        );
        if (existingProfile) {
          await conn.rollback();
          return res.status(409).json({
            message: "This delivery partner is already registered for this restaurant.",
            profileId: existingProfile.id,
          });
        }

        await conn.execute(
          "UPDATE users SET full_name = ?, password_hash = ?, is_active = 1 WHERE id = ?",
          [d.fullName, hash, existingUser.id]
        );
        const userId = existingUser.id;
        const deliveryPartnerId = await ensureDeliveryPartnerRow(conn, req.tenantId, userId);
        const employeeId = await allocateEmployeeId(conn, d.restaurantId);

        const [profileResult] = await conn.execute(
          `INSERT INTO restaurant_delivery_partner_profiles
            (tenant_id, restaurant_id, user_id, delivery_partner_id, employee_id, phone, address,
             aadhaar_number, aadhaar_front_url, aadhaar_back_url, profile_pic_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            req.tenantId,
            d.restaurantId,
            userId,
            deliveryPartnerId,
            employeeId,
            d.phone || null,
            d.address,
            d.aadhaarNumber,
            aadhaarFrontUrl,
            aadhaarBackUrl,
            profilePicUrl,
          ]
        );

        await conn.commit();
        return res.status(201).json({
          id: profileResult.insertId,
          employeeId,
          userId,
          message: "Delivery partner linked to this restaurant",
        });
      }

      const [userResult] = await conn.execute(
        "INSERT INTO users (full_name, email, password_hash, role, tenant_id, is_active) VALUES (?, ?, ?, 'DELIVERY_PARTNER', ?, 1)",
        [d.fullName, emailNorm, hash, req.tenantId]
      );
      const userId = userResult.insertId;
      const deliveryPartnerId = await ensureDeliveryPartnerRow(conn, req.tenantId, userId);
      const employeeId = await allocateEmployeeId(conn, d.restaurantId);

      const [profileResult] = await conn.execute(
        `INSERT INTO restaurant_delivery_partner_profiles
          (tenant_id, restaurant_id, user_id, delivery_partner_id, employee_id, phone, address,
           aadhaar_number, aadhaar_front_url, aadhaar_back_url, profile_pic_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.tenantId,
          d.restaurantId,
          userId,
          deliveryPartnerId,
          employeeId,
          d.phone || null,
          d.address,
          d.aadhaarNumber,
          aadhaarFrontUrl,
          aadhaarBackUrl,
          profilePicUrl,
        ]
      );

      await conn.commit();
      return res.status(201).json({
        id: profileResult.insertId,
        employeeId,
        userId,
        message: "Delivery partner registered",
      });
    } catch (error) {
      await conn.rollback();
      if (error?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ message: mapDuplicateEntryMessage(error) });
      }
      return res.status(500).json({ message: "Failed to register delivery partner", details: error.message });
    } finally {
      conn.release();
    }
  }
);

router.patch(
  "/delivery-partners/:profileId",
  auth(),
  tenantScope,
  rbac(...opsRoles),
  upload.fields([
    { name: "aadhaarFront", maxCount: 1 },
    { name: "aadhaarBack", maxCount: 1 },
    { name: "profilePic", maxCount: 1 },
  ]),
  async (req, res) => {
    const profileId = Number(req.params.profileId);
    const schema = z.object({
      fullName: z.string().min(2).optional(),
      phone: z.string().min(10).max(20).optional(),
      address: z.string().min(8).optional(),
      aadhaarNumber: z.string().regex(/^\d{12}$/).optional(),
      isActive: z.coerce.boolean().optional(),
      password: z.string().min(8).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const [rows] = await pool.execute(
      "SELECT user_id FROM restaurant_delivery_partner_profiles WHERE id = ? AND tenant_id = ?",
      [profileId, req.tenantId]
    );
    if (!rows[0]) return res.status(404).json({ message: "Partner not found" });

    const d = parsed.data;
    const profileFields = [];
    const profileValues = [];
    if (d.phone !== undefined) {
      profileFields.push("phone = ?");
      profileValues.push(d.phone);
    }
    if (d.address !== undefined) {
      profileFields.push("address = ?");
      profileValues.push(d.address);
    }
    if (d.aadhaarNumber !== undefined) {
      profileFields.push("aadhaar_number = ?");
      profileValues.push(d.aadhaarNumber);
    }
    if (d.isActive !== undefined) {
      profileFields.push("is_active = ?");
      profileValues.push(d.isActive ? 1 : 0);
    }
    const front = fileUrl(req, "aadhaarFront");
    const back = fileUrl(req, "aadhaarBack");
    const pic = fileUrl(req, "profilePic");
    if (front) {
      profileFields.push("aadhaar_front_url = ?");
      profileValues.push(front);
    }
    if (back) {
      profileFields.push("aadhaar_back_url = ?");
      profileValues.push(back);
    }
    if (pic) {
      profileFields.push("profile_pic_url = ?");
      profileValues.push(pic);
    }

    if (d.fullName) {
      await pool.execute("UPDATE users SET full_name = ? WHERE id = ?", [d.fullName, rows[0].user_id]);
    }
    if (d.password) {
      const hash = await bcrypt.hash(d.password, 10);
      await pool.execute("UPDATE users SET password_hash = ? WHERE id = ?", [hash, rows[0].user_id]);
    }
    if (profileFields.length) {
      profileValues.push(profileId, req.tenantId);
      await pool.execute(
        `UPDATE restaurant_delivery_partner_profiles SET ${profileFields.join(", ")} WHERE id = ? AND tenant_id = ?`,
        profileValues
      );
    }

    return res.json({ message: "Delivery partner updated" });
  }
);

// ---- Subscribers (Users tab) --------------------------------------------------

router.get("/subscribers", auth(), tenantScope, rbac(...opsRoles), async (req, res) => {
  const restaurantId = Number(req.query.restaurantId);
  if (!restaurantId) return res.status(400).json({ message: "restaurantId is required" });

  const [rows] = await pool.execute(
    `SELECT s.id, s.restaurant_id, s.phone, s.address, s.pincode, s.alt_phone,
            s.delivery_frequency, s.delivery_days_json, s.status,
            s.delivery_partner_profile_id, s.created_at, s.updated_at,
            u.id AS user_id, u.full_name, u.email,
            pl.id AS plan_id, pl.name AS plan_name, pl.price AS plan_price,
            p.employee_id AS partner_employee_id, pu.full_name AS partner_name
     FROM subscription_subscribers s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN subscription_plans pl ON pl.id = s.plan_id
     LEFT JOIN restaurant_delivery_partner_profiles p ON p.id = s.delivery_partner_profile_id
     LEFT JOIN users pu ON pu.id = p.user_id
     WHERE s.tenant_id = ? AND s.restaurant_id = ?
     ORDER BY s.created_at DESC`,
    [req.tenantId, restaurantId]
  );
  return res.json(rows);
});

router.post("/subscribers", auth(), tenantScope, rbac(...opsRoles), async (req, res) => {
  const schema = z.object({
    restaurantId: z.coerce.number().int().positive(),
    fullName: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(8),
    phone: z.string().min(10).max(20),
    address: z.string().min(3).max(500),
    pincode: z.string().min(4).max(12),
    altPhone: z.string().min(10).max(20).optional().nullable(),
    planId: z.coerce.number().int().positive().optional(),
    deliveryPartnerProfileId: z.coerce.number().int().positive().optional().nullable(),
    deliveryFrequency: z.enum(["EVERY_DAY", "WEEKDAYS", "CUSTOM"]).default("EVERY_DAY"),
    deliveryDays: z.array(z.string()).optional(),
    deliverySchedule: deliveryScheduleSchema.optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const d = parsed.data;
  const phoneParsed = validateIndianPhone(d.phone);
  if (!phoneParsed.ok) {
    return res.status(400).json({ message: phoneParsed.message });
  }
  d.phone = phoneParsed.phone;
  if (d.altPhone) {
    const altParsed = validateIndianPhone(d.altPhone);
    if (!altParsed.ok) {
      return res.status(400).json({ message: "Enter a valid alternative mobile number." });
    }
    d.altPhone = altParsed.phone;
  }
  if (d.planId) {
    const scheduleError = validateCustomSchedule(d.deliveryFrequency, d.deliverySchedule, d.deliveryDays);
    if (scheduleError) return res.status(400).json({ message: scheduleError });
  }

  if (!(await assertRestaurantAccess(req.tenantId, d.restaurantId))) {
    return res.status(404).json({ message: "Restaurant not found" });
  }

  if (d.planId) {
    const [planRows] = await pool.execute(
      "SELECT id FROM subscription_plans WHERE id = ? AND restaurant_id = ? AND tenant_id = ? AND is_active = 1",
      [d.planId, d.restaurantId, req.tenantId]
    );
    if (!planRows[0]) return res.status(400).json({ message: "Invalid or inactive plan" });
  }

  if (d.deliveryPartnerProfileId) {
    const [partnerRows] = await pool.execute(
      "SELECT id FROM restaurant_delivery_partner_profiles WHERE id = ? AND restaurant_id = ? AND tenant_id = ? AND is_active = 1",
      [d.deliveryPartnerProfileId, d.restaurantId, req.tenantId]
    );
    if (!partnerRows[0]) return res.status(400).json({ message: "Invalid delivery partner" });
  }

  const hash = await bcrypt.hash(d.password, 10);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [userResult] = await conn.execute(
      "INSERT INTO users (full_name, email, password_hash, role, tenant_id, is_active) VALUES (?, ?, ?, 'CUSTOMER', ?, 1)",
      [d.fullName, d.email, hash, req.tenantId]
    );

    const [subResult] = await conn.execute(
      `INSERT INTO subscription_subscribers
        (tenant_id, restaurant_id, user_id, plan_id, phone, address, pincode, alt_phone,
         delivery_partner_profile_id, delivery_frequency, delivery_days_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      [
        req.tenantId,
        d.restaurantId,
        userResult.insertId,
        d.planId || null,
        d.phone,
        d.address,
        d.pincode,
        d.altPhone || null,
        d.planId ? d.deliveryPartnerProfileId || null : null,
        d.planId ? d.deliveryFrequency : "EVERY_DAY",
        d.planId
          ? serializeDeliveryDaysJson(d.deliveryFrequency, d.deliverySchedule, d.deliveryDays)
          : null,
      ]
    );

    await conn.commit();

    if (d.planId && d.deliveryPartnerProfileId) {
      try {
        await provisionSubscriberDelivery(pool, req.tenantId, subResult.insertId, todayIsoLocal(), null);
      } catch (provisionErr) {
        console.error("provisionSubscriberDelivery on create:", provisionErr.message);
      }
    }

    return res.status(201).json({ id: subResult.insertId, userId: userResult.insertId, message: "Subscriber registered" });
  } catch (error) {
    await conn.rollback();
    if (error?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "Email already registered for this restaurant." });
    }
    return res.status(500).json({ message: "Failed to create subscriber", details: error.message });
  } finally {
    conn.release();
  }
});

const subscriptionPaymentSchema = z.object({
  collectionType: z.enum(["ADVANCE", "PARTIAL", "FULL"]),
  amount: z.coerce.number().positive(),
  paymentProvider: z.enum(["RAZORPAY", "UPI", "CARD", "CASH"]),
  gatewayReference: z.string().max(120).optional(),
  gatewayOrderId: z.string().max(120).optional(),
  paymentStatus: z.enum(["PENDING", "PAID"]).default("PAID"),
});

router.post("/payment-intent", auth(), tenantScope, rbac(...opsRoles), async (req, res) => {
  const schema = z.object({
    subscriberId: z.coerce.number().int().positive(),
    planId: z.coerce.number().int().positive(),
    amount: z.coerce.number().positive(),
    collectionType: z.enum(["ADVANCE", "PARTIAL", "FULL"]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const [[sub]] = await pool.execute(
    "SELECT id, restaurant_id FROM subscription_subscribers WHERE id = ? AND tenant_id = ? LIMIT 1",
    [parsed.data.subscriberId, req.tenantId]
  );
  if (!sub) return res.status(404).json({ message: "Subscriber not found" });

  const [[plan]] = await pool.execute(
    "SELECT id, price FROM subscription_plans WHERE id = ? AND restaurant_id = ? AND tenant_id = ? AND is_active = 1",
    [parsed.data.planId, sub.restaurant_id, req.tenantId]
  );
  if (!plan) return res.status(400).json({ message: "Invalid or inactive plan" });

  const planPrice = roundMoney(plan.price);
  const payCheck = validateSubscriptionPayment({
    planPrice,
    collectionType: parsed.data.collectionType,
    amount: parsed.data.amount,
  });
  if (!payCheck.ok) return res.status(400).json({ message: payCheck.message });

  try {
    const intent = await createSubscriptionPaymentIntent({
      amountInr: payCheck.amount,
      receipt: `sub-${parsed.data.subscriberId}-plan-${parsed.data.planId}`,
      subscriberId: parsed.data.subscriberId,
      planId: parsed.data.planId,
    });
    return res.json({
      planPrice,
      amount: payCheck.amount,
      balanceDue: payCheck.balanceDue,
      intent,
    });
  } catch (err) {
    return res.status(502).json({ message: err.message || "Payment gateway error" });
  }
});

router.post("/subscribers/:subscriberId/assign-plan", auth(), tenantScope, rbac(...opsRoles), async (req, res) => {
  const subscriberId = Number(req.params.subscriberId);
  const schema = z.object({
    planId: z.coerce.number().int().positive(),
    phone: z.string().min(10).max(20).optional(),
    deliveryPartnerProfileId: z.coerce.number().int().positive(),
    deliveryFrequency: z.enum(["EVERY_DAY", "WEEKDAYS", "CUSTOM"]).default("CUSTOM"),
    deliveryDays: z.array(z.string()).optional(),
    deliverySchedule: deliveryScheduleSchema.optional(),
    status: z.enum(["ACTIVE", "PAUSED", "CANCELLED"]).default("ACTIVE"),
    notes: z.string().max(500).optional(),
    payment: subscriptionPaymentSchema.optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const d = parsed.data;
  const scheduleError = validateCustomSchedule(d.deliveryFrequency, d.deliverySchedule, d.deliveryDays);
  if (scheduleError) return res.status(400).json({ message: scheduleError });

  if (d.deliveryFrequency === "CUSTOM" && d.deliverySchedule) {
    const days = expandScheduleDays(d.deliverySchedule);
    const assignments = d.deliverySchedule.assignments || [];
    if (assignments.length) {
      const daySet = new Set(days);
      const invalid = assignments.find((a) => !daySet.has(a.date));
      if (invalid) {
        return res.status(400).json({
          message: "Menu assignments must use dates within the selected delivery date range.",
        });
      }
    }
  }

  const [[sub]] = await pool.execute(
    `SELECT s.id, s.restaurant_id, s.user_id, s.plan_id, s.phone, s.status
     FROM subscription_subscribers s
     WHERE s.id = ? AND s.tenant_id = ?
     LIMIT 1`,
    [subscriberId, req.tenantId]
  );
  if (!sub) return res.status(404).json({ message: "Subscriber not found" });

  const [planRows] = await pool.execute(
    "SELECT id, name, price FROM subscription_plans WHERE id = ? AND restaurant_id = ? AND tenant_id = ? AND is_active = 1",
    [d.planId, sub.restaurant_id, req.tenantId]
  );
  if (!planRows[0]) return res.status(400).json({ message: "Invalid or inactive plan" });

  const planPrice = roundMoney(planRows[0].price);
  if (planPrice > 0) {
    if (!d.payment) {
      return res.status(400).json({ message: "Payment details are required for paid subscription plans." });
    }
    const payCheck = validateSubscriptionPayment({
      planPrice,
      collectionType: d.payment.collectionType,
      amount: d.payment.amount,
    });
    if (!payCheck.ok) return res.status(400).json({ message: payCheck.message });
    if (d.payment.paymentProvider !== "CASH" && d.payment.paymentStatus === "PAID" && !d.payment.gatewayReference) {
      return res.status(400).json({ message: "Online payments require a gateway payment reference." });
    }
  }

  if (d.deliveryFrequency === "CUSTOM" && d.deliverySchedule?.assignments?.length) {
    const budgetError = await validatePlanAssignmentBudget(
      d.planId,
      d.deliverySchedule.assignments
    );
    if (budgetError) return res.status(400).json({ message: budgetError });
  }

  const [partnerRows] = await pool.execute(
    "SELECT id FROM restaurant_delivery_partner_profiles WHERE id = ? AND restaurant_id = ? AND tenant_id = ? AND is_active = 1",
    [d.deliveryPartnerProfileId, sub.restaurant_id, req.tenantId]
  );
  if (!partnerRows[0]) return res.status(400).json({ message: "Invalid delivery partner" });

  const newPhone = d.phone !== undefined ? d.phone : sub.phone;
  const daysJson = serializeDeliveryDaysJson(d.deliveryFrequency, d.deliverySchedule, d.deliveryDays);

  const conn = await pool.getConnection();
  let renewalId = null;
  let paymentId = null;
  try {
    await conn.beginTransaction();

    try {
      const [renewResult] = await conn.execute(
        `INSERT INTO subscription_renewals
          (tenant_id, restaurant_id, subscriber_id, previous_plan_id, new_plan_id,
           previous_status, new_status, notes, renewed_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.tenantId,
          sub.restaurant_id,
          subscriberId,
          sub.plan_id,
          d.planId,
          sub.status,
          d.status,
          d.notes || "Plan assigned",
          req.user.sub,
        ]
      );
      renewalId = renewResult.insertId;
    } catch (renewErr) {
      if (renewErr?.code !== "ER_NO_SUCH_TABLE") throw renewErr;
    }

    if (d.payment && planPrice > 0) {
      const payCheck = validateSubscriptionPayment({
        planPrice,
        collectionType: d.payment.collectionType,
        amount: d.payment.amount,
      });
      const mapped = mapProviderToMethod(d.payment.paymentProvider);
      try {
        const [payResult] = await conn.execute(
          `INSERT INTO subscription_plan_payments
            (tenant_id, restaurant_id, subscriber_id, plan_id, renewal_id,
             plan_price, collection_type, amount, balance_due,
             payment_method, payment_provider, payment_status,
             gateway_reference, gateway_order_id, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            req.tenantId,
            sub.restaurant_id,
            subscriberId,
            d.planId,
            renewalId,
            planPrice,
            d.payment.collectionType,
            payCheck.amount,
            payCheck.balanceDue,
            mapped.paymentMethod,
            mapped.paymentProvider,
            d.payment.paymentStatus,
            d.payment.gatewayReference || null,
            d.payment.gatewayOrderId || null,
            req.user.sub,
          ]
        );
        paymentId = payResult.insertId;
      } catch (payErr) {
        if (payErr?.code !== "ER_NO_SUCH_TABLE") throw payErr;
      }
    }

    await conn.execute(
      `UPDATE subscription_subscribers SET
         plan_id = ?, phone = ?, status = ?,
         delivery_partner_profile_id = ?,
         delivery_frequency = ?, delivery_days_json = ?
       WHERE id = ? AND tenant_id = ?`,
      [
        d.planId,
        newPhone,
        d.status,
        d.deliveryPartnerProfileId,
        d.deliveryFrequency,
        daysJson,
        subscriberId,
        req.tenantId,
      ]
    );

    await conn.commit();
  } catch (error) {
    await conn.rollback();
    return res.status(500).json({ message: "Failed to assign plan", details: error.message });
  } finally {
    conn.release();
  }

  try {
    await provisionSubscriberDelivery(pool, req.tenantId, subscriberId, todayIsoLocal(), null);
  } catch (provisionErr) {
    console.error("provisionSubscriberDelivery on assign:", provisionErr.message);
  }

  return res.json({
    message: "Plan assigned successfully",
    paymentId,
    planPrice,
    payment: d.payment
      ? {
          collectionType: d.payment.collectionType,
          amount: roundMoney(d.payment.amount),
          balanceDue: validateSubscriptionPayment({
            planPrice,
            collectionType: d.payment.collectionType,
            amount: d.payment.amount,
          }).balanceDue,
          paymentStatus: d.payment.paymentStatus,
        }
      : null,
  });
});

router.patch("/subscribers/:subscriberId", auth(), tenantScope, rbac(...opsRoles), async (req, res) => {
  const subscriberId = Number(req.params.subscriberId);
  const schema = z.object({
    fullName: z.string().min(2).optional(),
    phone: z.string().min(10).max(20).optional(),
    address: z.string().min(3).max(500).optional(),
    pincode: z.string().min(4).max(12).optional(),
    altPhone: z.string().max(20).nullable().optional(),
    planId: z.coerce.number().int().positive().optional(),
    deliveryPartnerProfileId: z.coerce.number().int().positive().nullable().optional(),
    deliveryFrequency: z.enum(["EVERY_DAY", "WEEKDAYS", "CUSTOM"]).optional(),
    deliveryDays: z.array(z.string()).optional(),
    deliverySchedule: deliveryScheduleSchema.optional(),
    status: z.enum(["ACTIVE", "PAUSED", "CANCELLED"]).optional(),
    password: z.string().min(8).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const d = parsed.data;

  const [existing] = await pool.execute(
    "SELECT user_id, restaurant_id, delivery_frequency, delivery_days_json FROM subscription_subscribers WHERE id = ? AND tenant_id = ?",
    [subscriberId, req.tenantId]
  );
  if (!existing[0]) return res.status(404).json({ message: "Subscriber not found" });

  const effectiveFrequency = d.deliveryFrequency ?? existing[0].delivery_frequency;
  if (effectiveFrequency === "CUSTOM") {
    if (d.deliverySchedule !== undefined || d.deliveryDays !== undefined) {
      const scheduleError = validateCustomSchedule("CUSTOM", d.deliverySchedule, d.deliveryDays);
      if (scheduleError) return res.status(400).json({ message: scheduleError });
    } else if (d.deliveryFrequency === "CUSTOM" && !existing[0].delivery_days_json) {
      return res.status(400).json({
        message: "Select at least one delivery date or date range for custom schedule.",
      });
    }
  }

  if (d.planId) {
    const [planRows] = await pool.execute(
      "SELECT id FROM subscription_plans WHERE id = ? AND restaurant_id = ? AND tenant_id = ?",
      [d.planId, existing[0].restaurant_id, req.tenantId]
    );
    if (!planRows[0]) return res.status(400).json({ message: "Invalid plan" });
  }

  if (d.deliveryPartnerProfileId) {
    const [partnerRows] = await pool.execute(
      "SELECT id FROM restaurant_delivery_partner_profiles WHERE id = ? AND restaurant_id = ? AND tenant_id = ? AND is_active = 1",
      [d.deliveryPartnerProfileId, existing[0].restaurant_id, req.tenantId]
    );
    if (!partnerRows[0]) return res.status(400).json({ message: "Invalid delivery partner" });
  }

  if (d.fullName) {
    await pool.execute("UPDATE users SET full_name = ? WHERE id = ?", [d.fullName, existing[0].user_id]);
  }
  if (d.password) {
    const hash = await bcrypt.hash(d.password, 10);
    await pool.execute("UPDATE users SET password_hash = ? WHERE id = ?", [hash, existing[0].user_id]);
  }

  const fields = [];
  const values = [];
  if (d.phone !== undefined) {
    fields.push("phone = ?");
    values.push(d.phone);
  }
  if (d.address !== undefined) {
    fields.push("address = ?");
    values.push(d.address);
  }
  if (d.pincode !== undefined) {
    fields.push("pincode = ?");
    values.push(d.pincode);
  }
  if (d.altPhone !== undefined) {
    fields.push("alt_phone = ?");
    values.push(d.altPhone);
  }
  if (d.planId !== undefined) {
    fields.push("plan_id = ?");
    values.push(d.planId);
  }
  if (d.deliveryPartnerProfileId !== undefined) {
    fields.push("delivery_partner_profile_id = ?");
    values.push(d.deliveryPartnerProfileId);
  }
  if (d.deliveryFrequency !== undefined) {
    fields.push("delivery_frequency = ?");
    values.push(d.deliveryFrequency);
    if (d.deliveryFrequency !== "CUSTOM") {
      fields.push("delivery_days_json = ?");
      values.push(null);
    }
  }
  if (d.deliverySchedule !== undefined) {
    fields.push("delivery_days_json = ?");
    values.push(serializeDeliveryDaysJson("CUSTOM", d.deliverySchedule, d.deliveryDays));
  } else if (d.deliveryDays !== undefined) {
    fields.push("delivery_days_json = ?");
    values.push(d.deliveryDays?.length ? JSON.stringify(d.deliveryDays) : null);
  }
  if (d.status !== undefined) {
    fields.push("status = ?");
    values.push(d.status);
  }

  if (fields.length) {
    values.push(subscriberId, req.tenantId);
    await pool.execute(
      `UPDATE subscription_subscribers SET ${fields.join(", ")} WHERE id = ? AND tenant_id = ?`,
      values
    );
  }

  const shouldProvision =
    d.deliveryPartnerProfileId !== undefined ||
    d.status === "ACTIVE" ||
    d.deliveryFrequency !== undefined;
  if (shouldProvision) {
    try {
      await provisionSubscriberDelivery(pool, req.tenantId, subscriberId, todayIsoLocal(), null);
    } catch (provisionErr) {
      console.error("provisionSubscriberDelivery on update:", provisionErr.message);
    }
  }

  return res.json({ message: "Subscriber updated" });
});

// ---- Subscription renewal -----------------------------------------------------

router.get("/renewals", auth(), tenantScope, rbac(...opsRoles), async (req, res) => {
  const restaurantId = Number(req.query.restaurantId);
  if (!restaurantId) return res.status(400).json({ message: "restaurantId is required" });

  try {
    const [rows] = await pool.execute(
      `SELECT r.id, r.subscriber_id, r.previous_plan_id, r.new_plan_id,
              r.previous_status, r.new_status, r.notes, r.created_at AS renewed_at,
              u.full_name AS customer_name, u.email AS customer_email,
              pp.name AS previous_plan_name, np.name AS new_plan_name, np.price AS new_plan_price,
              ru.full_name AS renewed_by_name
       FROM subscription_renewals r
       INNER JOIN subscription_subscribers s ON s.id = r.subscriber_id
       INNER JOIN users u ON u.id = s.user_id
       LEFT JOIN subscription_plans pp ON pp.id = r.previous_plan_id
       INNER JOIN subscription_plans np ON np.id = r.new_plan_id
       LEFT JOIN users ru ON ru.id = r.renewed_by_user_id
       WHERE r.tenant_id = ? AND r.restaurant_id = ?
       ORDER BY r.created_at DESC
       LIMIT 100`,
      [req.tenantId, restaurantId]
    );
    return res.json(rows);
  } catch (error) {
    if (error?.code === "ER_NO_SUCH_TABLE") {
      return res.json([]);
    }
    throw error;
  }
});

router.post("/subscribers/:subscriberId/renew", auth(), tenantScope, rbac(...opsRoles), async (req, res) => {
  const subscriberId = Number(req.params.subscriberId);
  const schema = z.object({
    planId: z.coerce.number().int().positive(),
    phone: z.string().min(10).max(20).optional(),
    deliveryPartnerProfileId: z.coerce.number().int().positive().nullable().optional(),
    deliveryFrequency: z.enum(["EVERY_DAY", "WEEKDAYS", "CUSTOM"]).optional(),
    deliveryDays: z.array(z.string()).optional(),
    deliverySchedule: deliveryScheduleSchema.optional(),
    status: z.enum(["ACTIVE", "PAUSED", "CANCELLED"]).default("ACTIVE"),
    notes: z.string().max(500).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const d = parsed.data;

  const [[sub]] = await pool.execute(
    `SELECT s.id, s.restaurant_id, s.user_id, s.plan_id, s.phone, s.status,
            s.delivery_frequency, s.delivery_days_json, s.delivery_partner_profile_id
     FROM subscription_subscribers s
     WHERE s.id = ? AND s.tenant_id = ?
     LIMIT 1`,
    [subscriberId, req.tenantId]
  );
  if (!sub) return res.status(404).json({ message: "Subscriber not found" });

  const effectiveFrequency = d.deliveryFrequency ?? sub.delivery_frequency;
  const scheduleError = validateCustomSchedule(
    effectiveFrequency,
    d.deliverySchedule,
    d.deliveryDays
  );
  if (scheduleError) return res.status(400).json({ message: scheduleError });

  const [planRows] = await pool.execute(
    "SELECT id, name FROM subscription_plans WHERE id = ? AND restaurant_id = ? AND tenant_id = ? AND is_active = 1",
    [d.planId, sub.restaurant_id, req.tenantId]
  );
  if (!planRows[0]) return res.status(400).json({ message: "Invalid or inactive plan" });

  const partnerId =
    d.deliveryPartnerProfileId !== undefined
      ? d.deliveryPartnerProfileId
      : sub.delivery_partner_profile_id;
  if (partnerId) {
    const [partnerRows] = await pool.execute(
      "SELECT id FROM restaurant_delivery_partner_profiles WHERE id = ? AND restaurant_id = ? AND tenant_id = ? AND is_active = 1",
      [partnerId, sub.restaurant_id, req.tenantId]
    );
    if (!partnerRows[0]) return res.status(400).json({ message: "Invalid delivery partner" });
  }

  const newStatus = d.status || "ACTIVE";
  const newPhone = d.phone !== undefined ? d.phone : sub.phone;
  const daysJson =
    d.deliveryFrequency !== undefined || d.deliverySchedule !== undefined || d.deliveryDays !== undefined
      ? serializeDeliveryDaysJson(
          effectiveFrequency,
          d.deliverySchedule,
          d.deliveryDays ?? (effectiveFrequency === "CUSTOM" ? JSON.parse(sub.delivery_days_json || "[]") : undefined)
        )
      : sub.delivery_days_json;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    try {
      await conn.execute(
        `INSERT INTO subscription_renewals
          (tenant_id, restaurant_id, subscriber_id, previous_plan_id, new_plan_id,
           previous_status, new_status, notes, renewed_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.tenantId,
          sub.restaurant_id,
          subscriberId,
          sub.plan_id,
          d.planId,
          sub.status,
          newStatus,
          d.notes || null,
          req.user.sub,
        ]
      );
    } catch (renewErr) {
      if (renewErr?.code !== "ER_NO_SUCH_TABLE") throw renewErr;
    }

    await conn.execute(
      `UPDATE subscription_subscribers SET
         plan_id = ?, phone = ?, status = ?,
         delivery_partner_profile_id = ?,
         delivery_frequency = ?, delivery_days_json = ?
       WHERE id = ? AND tenant_id = ?`,
      [
        d.planId,
        newPhone,
        newStatus,
        partnerId || null,
        effectiveFrequency,
        daysJson,
        subscriberId,
        req.tenantId,
      ]
    );

    await conn.commit();
  } catch (error) {
    await conn.rollback();
    return res.status(500).json({ message: "Renewal failed", details: error.message });
  } finally {
    conn.release();
  }

  if (newStatus === "ACTIVE" && partnerId) {
    try {
      await provisionSubscriberDelivery(pool, req.tenantId, subscriberId, todayIsoLocal(), null);
    } catch (provisionErr) {
      console.error("provisionSubscriberDelivery on renew:", provisionErr.message);
    }
  }

  return res.json({
    message: "Subscription renewed",
    subscriberId,
    previousPlanId: sub.plan_id,
    newPlanId: d.planId,
    status: newStatus,
  });
});

/** Logged-in customer: subscription(s) linked by restaurant owner. */
router.get("/my", auth(), rbac("CUSTOMER"), async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT s.id, s.restaurant_id, s.phone, s.delivery_frequency, s.delivery_days_json, s.status,
            s.delivery_partner_profile_id, s.created_at, s.updated_at,
            r.name AS restaurant_name, r.slug AS restaurant_slug, r.address AS restaurant_address,
            r.approval_status AS restaurant_approval_status,
            pl.id AS plan_id, pl.name AS plan_name, pl.description AS plan_description, pl.price AS plan_price,
            pl.includes_daily_delivery,
            c.name AS cycle_name, c.value_type AS cycle_value_type, c.value AS cycle_value
     FROM subscription_subscribers s
     JOIN restaurants r ON r.id = s.restaurant_id
     LEFT JOIN subscription_plans pl ON pl.id = s.plan_id
     LEFT JOIN subscription_cycles c ON c.id = pl.cycle_id
     WHERE s.user_id = ?
     ORDER BY s.created_at DESC`,
    [req.user.sub]
  );
  const planIds = [...new Set(rows.map((r) => r.plan_id).filter(Boolean))];
  const itemsByPlan = await fetchPlanItemsByPlanIds(planIds);
  const withItems = rows.map((row) => ({
    ...row,
    plan_items: itemsByPlan[row.plan_id] || [],
  }));
  return res.json(withItems);
});

const deliverySlotBodySchema = z.object({
  subscriberId: z.coerce.number().int().positive().optional(),
  date: isoDate,
  time: z.string().regex(/^\d{1,2}:\d{2}$/),
});

/** Customer: upcoming scheduled deliveries with change/cancel eligibility. */
router.get("/my/deliveries", auth(), rbac("CUSTOMER"), async (req, res) => {
  try {
    const subscriberId = req.query.subscriberId ? Number(req.query.subscriberId) : undefined;
    const result = await listUpcomingDeliveries(req.user.sub, subscriberId);
    if (result.error === "NOT_FOUND") return res.status(404).json({ message: result.message });
    if (result.error === "INACTIVE") return res.status(400).json({ message: result.message });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ message: "Failed to load deliveries", details: err.message });
  }
});

router.post("/my/deliveries/cancel", auth(), rbac("CUSTOMER"), async (req, res) => {
  const parsed = deliverySlotBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
  const { subscriberId, date, time } = parsed.data;
  try {
    const result = await cancelDelivery(req.user.sub, subscriberId, date, time);
    return res.status(result.status).json({ message: result.message });
  } catch (err) {
    return res.status(500).json({ message: "Failed to cancel delivery", details: err.message });
  }
});

router.post("/my/deliveries/reschedule", auth(), rbac("CUSTOMER"), async (req, res) => {
  const schema = deliverySlotBodySchema.extend({
    newDate: isoDate,
    newTime: z.string().regex(/^\d{1,2}:\d{2}$/),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
  const { subscriberId, date, time, newDate, newTime } = parsed.data;
  try {
    const result = await rescheduleDelivery(req.user.sub, subscriberId, date, time, newDate, newTime);
    return res.status(result.status).json({ message: result.message });
  } catch (err) {
    return res.status(500).json({ message: "Failed to reschedule delivery", details: err.message });
  }
});

router.post("/my/deliveries/change-items", auth(), rbac("CUSTOMER"), async (req, res) => {
  const schema = deliverySlotBodySchema.extend({
    items: z
      .array(
        z.object({
          menuItemId: z.coerce.number().int().positive(),
          quantity: z.coerce.number().int().positive(),
        })
      )
      .min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
  const { subscriberId, date, time, items } = parsed.data;
  try {
    const result = await changeDeliveryItems(req.user.sub, subscriberId, date, time, items);
    return res.status(result.status).json({ message: result.message });
  } catch (err) {
    return res.status(500).json({ message: "Failed to update delivery items", details: err.message });
  }
});

module.exports = router;
