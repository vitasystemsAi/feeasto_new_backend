const express = require("express");
const { z } = require("zod");
const pool = require("../../db/pool");
const auth = require("../../middlewares/auth");
const rbac = require("../../middlewares/rbac");
const tenantScope = require("../../middlewares/tenant");
const { validateIndianPhone } = require("../../utils/phone");

const router = express.Router();

router.get("/", auth(), rbac("OWNER", "MANAGER", "ADMIN", "SUPER_ADMIN"), tenantScope, async (req, res) => {
  const schema = z.object({ restaurantId: z.coerce.number().int().positive() });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  // Mark expired bookings as completed + release tables.
  try {
    await pool.execute(
      "UPDATE reservations SET status = 'COMPLETED' WHERE tenant_id = ? AND restaurant_id = ? AND status = 'BOOKED' AND end_time < NOW()",
      [req.tenantId, parsed.data.restaurantId]
    );
    await pool.execute(
      "UPDATE restaurant_tables SET status = 'AVAILABLE', reserved_from = NULL, reserved_to = NULL WHERE tenant_id = ? AND restaurant_id = ? AND status = 'BOOKED' AND reserved_to IS NOT NULL AND reserved_to < NOW()",
      [req.tenantId, parsed.data.restaurantId]
    );
  } catch (error) {
    if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
  }

  let rows;
  try {
    [rows] = await pool.execute(
      `SELECT r.id, r.table_id, r.customer_user_id, r.customer_name, r.mobile_number, r.party_size, r.notes, r.start_time, r.end_time, r.status
       FROM reservations r
       WHERE r.tenant_id = ? AND r.restaurant_id = ?
       ORDER BY r.start_time DESC
       LIMIT 200`,
      [req.tenantId, parsed.data.restaurantId]
    );
  } catch (error) {
    if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
    [rows] = await pool.execute(
      `SELECT r.id, r.table_id, r.customer_user_id, r.start_time, r.end_time, r.status
       FROM reservations r
       WHERE r.tenant_id = ? AND r.restaurant_id = ?
       ORDER BY r.start_time DESC
       LIMIT 200`,
      [req.tenantId, parsed.data.restaurantId]
    );
    rows = rows.map((r) => ({ ...r, customer_name: null, mobile_number: null, party_size: null, notes: null }));
  }
  return res.json({ items: rows });
});

router.post("/", auth(), rbac("CUSTOMER", "OWNER", "MANAGER", "ADMIN", "SUPER_ADMIN"), tenantScope, async (req, res) => {
  const schema = z.object({
    restaurantId: z.coerce.number().int().positive(),
    tableId: z.coerce.number().int().positive(),
    customerName: z.string().min(2).max(120),
    mobileNumber: z.string().min(7).max(20),
    partySize: z.coerce.number().int().positive().max(50).default(2),
    notes: z.string().max(500).optional(),
    startTime: z.string().min(10),
    endTime: z.string().min(10),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const phoneParsed = validateIndianPhone(parsed.data.mobileNumber);
  if (!phoneParsed.ok) {
    return res.status(400).json({ message: phoneParsed.message });
  }

  const startTime = new Date(parsed.data.startTime);
  const endTime = new Date(parsed.data.endTime);
  if (!(startTime instanceof Date) || Number.isNaN(startTime.valueOf())) {
    return res.status(400).json({ message: "Invalid startTime" });
  }
  if (!(endTime instanceof Date) || Number.isNaN(endTime.valueOf())) {
    return res.status(400).json({ message: "Invalid endTime" });
  }
  if (endTime <= startTime) return res.status(400).json({ message: "endTime must be after startTime" });

  const [[table]] = await pool.execute(
    "SELECT id, status FROM restaurant_tables WHERE id = ? AND tenant_id = ? AND restaurant_id = ? LIMIT 1",
    [parsed.data.tableId, req.tenantId, parsed.data.restaurantId]
  );
  if (!table) return res.status(404).json({ message: "Table not found" });

  const [[overlap]] = await pool.execute(
    `SELECT id
     FROM reservations
     WHERE tenant_id = ?
       AND restaurant_id = ?
       AND table_id = ?
       AND status = 'BOOKED'
       AND NOT (end_time <= ? OR start_time >= ?)
     LIMIT 1`,
    [req.tenantId, parsed.data.restaurantId, parsed.data.tableId, startTime, endTime]
  );
  if (overlap) return res.status(409).json({ message: "Table is already reserved for this time slot" });

  let result;
  try {
    [result] = await pool.execute(
      "INSERT INTO reservations (tenant_id, restaurant_id, table_id, customer_user_id, customer_name, mobile_number, party_size, notes, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BOOKED')",
      [
        req.tenantId,
        parsed.data.restaurantId,
        parsed.data.tableId,
        req.user.sub,
        parsed.data.customerName,
        phoneParsed.phone,
        parsed.data.partySize,
        parsed.data.notes || null,
        startTime,
        endTime,
      ]
    );
  } catch (error) {
    if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
    [result] = await pool.execute(
      "INSERT INTO reservations (tenant_id, restaurant_id, table_id, customer_user_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, ?, 'BOOKED')",
      [req.tenantId, parsed.data.restaurantId, parsed.data.tableId, req.user.sub, startTime, endTime]
    );
  }
  try {
    await pool.execute(
      "UPDATE restaurant_tables SET status = 'BOOKED', reserved_from = ?, reserved_to = ? WHERE id = ? AND tenant_id = ?",
      [startTime, endTime, parsed.data.tableId, req.tenantId]
    );
  } catch (error) {
    if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
    await pool.execute("UPDATE restaurant_tables SET status = 'BOOKED' WHERE id = ? AND tenant_id = ?", [
      parsed.data.tableId,
      req.tenantId,
    ]);
  }
  return res.status(201).json({ id: result.insertId });
});

router.post("/:reservationId/cancel", auth(), tenantScope, async (req, res) => {
  const reservationId = Number(req.params.reservationId);
  const [[reservation]] = await pool.execute(
    "SELECT id, table_id, customer_user_id, status FROM reservations WHERE id = ? AND tenant_id = ? LIMIT 1",
    [reservationId, req.tenantId]
  );
  if (!reservation) return res.status(404).json({ message: "Reservation not found" });
  if (reservation.status !== "BOOKED") return res.status(400).json({ message: "Only booked reservations can be cancelled" });

  const isOwnerOrManager = ["OWNER", "MANAGER", "ADMIN", "SUPER_ADMIN"].includes(req.user.role);
  const isCustomerOwner = req.user.role === "CUSTOMER" && Number(reservation.customer_user_id) === Number(req.user.sub);
  if (!isOwnerOrManager && !isCustomerOwner) return res.status(403).json({ message: "Forbidden" });

  await pool.execute("UPDATE reservations SET status = 'CANCELLED' WHERE id = ? AND tenant_id = ?", [
    reservationId,
    req.tenantId,
  ]);
  await pool.execute("UPDATE restaurant_tables SET status = 'AVAILABLE' WHERE id = ? AND tenant_id = ?", [
    reservation.table_id,
    req.tenantId,
  ]);
  return res.json({ ok: true });
});

module.exports = router;

