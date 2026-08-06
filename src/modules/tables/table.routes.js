const express = require("express");
const { z } = require("zod");
const pool = require("../../db/pool");
const auth = require("../../middlewares/auth");
const rbac = require("../../middlewares/rbac");
const tenantScope = require("../../middlewares/tenant");
const env = require("../../config/env");
const { ensureTableHasQrToken, generateQrToken } = require("./ensureTableQrSchema");

function normalizeStatus(status) {
  const upper = String(status || "").toUpperCase();
  if (upper === "RESERVED") return "BOOKED";
  if (upper === "AVAILABLE") return "AVAILABLE";
  if (upper === "OCCUPIED") return "OCCUPIED";
  if (upper === "BOOKED") return "BOOKED";
  return upper;
}

function tableRoutes(io) {
  const router = express.Router();

  router.get("/", auth(), tenantScope, async (req, res) => {
    const schema = z.object({ restaurantId: z.coerce.number().int().positive() });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    // Auto-release expired reserved tables.
    try {
      await pool.execute(
        "UPDATE restaurant_tables SET status = 'AVAILABLE', reserved_from = NULL, reserved_to = NULL WHERE tenant_id = ? AND restaurant_id = ? AND status = 'BOOKED' AND reserved_to IS NOT NULL AND reserved_to < NOW()",
        [req.tenantId, parsed.data.restaurantId]
      );
    } catch (error) {
      // reserved_to columns may not exist yet; ignore in that case.
      if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
    }

    let rows;
    try {
      [rows] = await pool.execute(
        "SELECT id, table_number, capacity, status, qr_token, reserved_from, reserved_to FROM restaurant_tables WHERE tenant_id = ? AND restaurant_id = ? ORDER BY table_number ASC",
        [req.tenantId, parsed.data.restaurantId]
      );
    } catch (error) {
      if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
      try {
        [rows] = await pool.execute(
          "SELECT id, table_number, capacity, status, reserved_from, reserved_to FROM restaurant_tables WHERE tenant_id = ? AND restaurant_id = ? ORDER BY table_number ASC",
          [req.tenantId, parsed.data.restaurantId]
        );
        rows = rows.map((r) => ({ ...r, qr_token: null }));
      } catch (error2) {
        if (error2?.code !== "ER_BAD_FIELD_ERROR") throw error2;
        [rows] = await pool.execute(
          "SELECT id, table_number, capacity, status FROM restaurant_tables WHERE tenant_id = ? AND restaurant_id = ? ORDER BY table_number ASC",
          [req.tenantId, parsed.data.restaurantId]
        );
        rows = rows.map((r) => ({ ...r, reserved_from: null, reserved_to: null, qr_token: null }));
      }
    }

    const frontendBase = String(env.frontendUrl || "").replace(/\/$/, "");
    const items = [];
    for (const row of rows) {
      let qrToken = row.qr_token;
      if (!qrToken) {
        try {
          qrToken = await ensureTableHasQrToken(row.id);
        } catch {
          qrToken = null;
        }
      }
      items.push({
        ...row,
        qr_token: qrToken,
        qr_url: qrToken ? `${frontendBase}/t/${qrToken}` : null,
      });
    }
    return res.json({ items });
  });

  router.post("/", auth(), rbac("OWNER", "MANAGER"), tenantScope, async (req, res) => {
    const schema = z.object({
      restaurantId: z.coerce.number().int().positive(),
      tableNumber: z.string().min(1).max(20),
      capacity: z.coerce.number().int().positive(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const qrToken = generateQrToken();
    let result;
    try {
      [result] = await pool.execute(
        "INSERT INTO restaurant_tables (tenant_id, restaurant_id, table_number, capacity, status, qr_token) VALUES (?, ?, ?, ?, 'AVAILABLE', ?)",
        [req.tenantId, parsed.data.restaurantId, parsed.data.tableNumber, parsed.data.capacity, qrToken]
      );
    } catch (error) {
      if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
      [result] = await pool.execute(
        "INSERT INTO restaurant_tables (tenant_id, restaurant_id, table_number, capacity, status) VALUES (?, ?, ?, ?, 'AVAILABLE')",
        [req.tenantId, parsed.data.restaurantId, parsed.data.tableNumber, parsed.data.capacity]
      );
    }
    io.to(`tenant:${req.tenantId}`).emit("table:updated", { tableId: result.insertId, action: "CREATED" });
    const frontendBase = String(env.frontendUrl || "").replace(/\/$/, "");
    return res.status(201).json({
      id: result.insertId,
      qr_token: qrToken,
      qr_url: `${frontendBase}/t/${qrToken}`,
    });
  });

  router.get("/:tableId/qr", auth(), rbac("OWNER", "MANAGER"), tenantScope, async (req, res) => {
    const tableId = Number(req.params.tableId);
    if (!tableId) return res.status(400).json({ message: "Invalid table id" });

    const [[row]] = await pool.execute(
      "SELECT id, table_number, restaurant_id, qr_token FROM restaurant_tables WHERE id = ? AND tenant_id = ? LIMIT 1",
      [tableId, req.tenantId]
    );
    if (!row) return res.status(404).json({ message: "Table not found" });

    let qrToken = row.qr_token;
    if (!qrToken) {
      qrToken = await ensureTableHasQrToken(tableId);
    }
    if (!qrToken) return res.status(500).json({ message: "Could not allocate QR token" });

    const frontendBase = String(env.frontendUrl || "").replace(/\/$/, "");
    return res.json({
      tableId: row.id,
      tableNumber: row.table_number,
      restaurantId: row.restaurant_id,
      qrToken,
      qrUrl: `${frontendBase}/t/${qrToken}`,
    });
  });

  router.post("/:tableId/qr/regenerate", auth(), rbac("OWNER", "MANAGER"), tenantScope, async (req, res) => {
    const tableId = Number(req.params.tableId);
    if (!tableId) return res.status(400).json({ message: "Invalid table id" });

    const [[row]] = await pool.execute(
      "SELECT id, table_number FROM restaurant_tables WHERE id = ? AND tenant_id = ? LIMIT 1",
      [tableId, req.tenantId]
    );
    if (!row) return res.status(404).json({ message: "Table not found" });

    let qrToken = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const next = generateQrToken();
      try {
        await pool.execute("UPDATE restaurant_tables SET qr_token = ? WHERE id = ? AND tenant_id = ?", [
          next,
          tableId,
          req.tenantId,
        ]);
        qrToken = next;
        break;
      } catch (error) {
        if (error?.code !== "ER_DUP_ENTRY") throw error;
      }
    }
    if (!qrToken) return res.status(500).json({ message: "Could not regenerate QR token" });

    const frontendBase = String(env.frontendUrl || "").replace(/\/$/, "");
    io.to(`tenant:${req.tenantId}`).emit("table:updated", { tableId, action: "QR_REGENERATED" });
    return res.json({
      tableId,
      tableNumber: row.table_number,
      qrToken,
      qrUrl: `${frontendBase}/t/${qrToken}`,
    });
  });

  router.patch("/:tableId", auth(), rbac("OWNER", "MANAGER"), tenantScope, async (req, res) => {
    const schema = z.object({
      tableNumber: z.string().min(1).max(20).optional(),
      capacity: z.coerce.number().int().positive().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const tableId = Number(req.params.tableId);
    const fields = [];
    const values = [];

    if (parsed.data.tableNumber !== undefined) {
      fields.push("table_number = ?");
      values.push(parsed.data.tableNumber);
    }
    if (parsed.data.capacity !== undefined) {
      fields.push("capacity = ?");
      values.push(parsed.data.capacity);
    }
    if (fields.length === 0) return res.status(400).json({ message: "No updates provided" });

    values.push(tableId, req.tenantId);
    await pool.execute(`UPDATE restaurant_tables SET ${fields.join(", ")} WHERE id = ? AND tenant_id = ?`, values);
    io.to(`tenant:${req.tenantId}`).emit("table:updated", { tableId, action: "UPDATED" });
    return res.json({ ok: true });
  });

  router.post("/:tableId/book", auth(), rbac("OWNER", "MANAGER"), tenantScope, async (req, res) => {
    const schema = z.object({
      reservedFrom: z.string().min(10),
      reservedTo: z.string().min(10),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const tableId = Number(req.params.tableId);
    const reservedFrom = new Date(parsed.data.reservedFrom);
    const reservedTo = new Date(parsed.data.reservedTo);

    try {
      await pool.execute(
        "UPDATE restaurant_tables SET status = 'BOOKED', reserved_from = ?, reserved_to = ? WHERE id = ? AND tenant_id = ?",
        [reservedFrom, reservedTo, tableId, req.tenantId]
      );
    } catch (error) {
      if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
      await pool.execute("UPDATE restaurant_tables SET status = 'BOOKED' WHERE id = ? AND tenant_id = ?", [
        tableId,
        req.tenantId,
      ]);
    }
    io.to(`tenant:${req.tenantId}`).emit("table:updated", { tableId, action: "BOOKED" });
    return res.json({ ok: true });
  });

  router.post("/:tableId/occupy", auth(), rbac("OWNER", "MANAGER"), tenantScope, async (req, res) => {
    const tableId = Number(req.params.tableId);
    try {
      await pool.execute(
        "UPDATE restaurant_tables SET status = 'OCCUPIED', reserved_from = NULL, reserved_to = NULL WHERE id = ? AND tenant_id = ?",
        [tableId, req.tenantId]
      );
    } catch (error) {
      if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
      await pool.execute("UPDATE restaurant_tables SET status = 'OCCUPIED' WHERE id = ? AND tenant_id = ?", [
        tableId,
        req.tenantId,
      ]);
    }
    io.to(`tenant:${req.tenantId}`).emit("table:updated", { tableId, action: "OCCUPIED" });
    return res.json({ ok: true });
  });

  /** Free an occupied table and cancel any in-progress dine-in orders (no payment). */
  router.post("/:tableId/cancel-session", auth(), rbac("OWNER", "MANAGER"), tenantScope, async (req, res) => {
    const bodySchema = z.object({
      restaurantId: z.coerce.number().int().positive(),
    });
    const parsedBody = bodySchema.safeParse(req.body);
    if (!parsedBody.success) return res.status(400).json({ errors: parsedBody.error.issues });

    const tableId = Number(req.params.tableId);
    const restaurantId = parsedBody.data.restaurantId;
    if (!tableId) return res.status(400).json({ message: "Invalid table id" });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[tableRow]] = await conn.execute(
        "SELECT id, status FROM restaurant_tables WHERE id = ? AND tenant_id = ? AND restaurant_id = ? LIMIT 1",
        [tableId, req.tenantId, restaurantId]
      );
      if (!tableRow) {
        await conn.rollback();
        return res.status(404).json({ message: "Table not found for this restaurant" });
      }

      let orderRows;
      try {
        [orderRows] = await conn.execute(
          `SELECT id FROM orders
           WHERE tenant_id = ? AND restaurant_id = ? AND table_id = ?
             AND order_type = 'DINE_IN'
             AND status IN ('PLACED','ACCEPTED','PREPARING')`,
          [req.tenantId, restaurantId, tableId]
        );
      } catch (error) {
        if (error?.code === "ER_BAD_FIELD_ERROR") {
          await conn.rollback();
          return res.status(409).json({
            message: "Table-wise dine-in orders require the orders.table_id column. Please run latest database migration.",
            code: "TABLE_ORDER_SCHEMA_REQUIRED",
          });
        }
        throw error;
      }

      for (const row of orderRows) {
        await conn.execute("UPDATE orders SET status = 'CANCELLED' WHERE id = ? AND tenant_id = ?", [
          row.id,
          req.tenantId,
        ]);
        io.to(`tenant:${req.tenantId}`).emit("order:status-updated", { orderId: row.id, status: "CANCELLED" });
      }

      try {
        await conn.execute(
          "UPDATE restaurant_tables SET status = 'AVAILABLE', reserved_from = NULL, reserved_to = NULL WHERE id = ? AND tenant_id = ?",
          [tableId, req.tenantId]
        );
      } catch (error) {
        if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
        await conn.execute("UPDATE restaurant_tables SET status = 'AVAILABLE' WHERE id = ? AND tenant_id = ?", [
          tableId,
          req.tenantId,
        ]);
      }

      await conn.commit();
      io.to(`tenant:${req.tenantId}`).emit("table:updated", { tableId, action: "CANCEL_SESSION", status: "AVAILABLE" });
      return res.json({ ok: true, cancelledOrderIds: orderRows.map((r) => r.id) });
    } catch (error) {
      await conn.rollback();
      return res.status(500).json({ message: "Failed to cancel table session", details: error.message });
    } finally {
      conn.release();
    }
  });

  router.patch("/:tableId/status", auth(), rbac("OWNER", "MANAGER"), tenantScope, async (req, res) => {
    const schema = z.object({
      status: z.enum(["AVAILABLE", "BOOKED", "OCCUPIED", "RESERVED"]),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const tableId = Number(req.params.tableId);
    const normalized = normalizeStatus(parsed.data.status);
    try {
      await pool.execute(
        "UPDATE restaurant_tables SET status = ?, reserved_from = CASE WHEN ? = 'AVAILABLE' THEN NULL ELSE reserved_from END, reserved_to = CASE WHEN ? = 'AVAILABLE' THEN NULL ELSE reserved_to END WHERE id = ? AND tenant_id = ?",
        [normalized, normalized, normalized, tableId, req.tenantId]
      );
    } catch (error) {
      if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
      await pool.execute("UPDATE restaurant_tables SET status = ? WHERE id = ? AND tenant_id = ?", [
        normalized,
        tableId,
        req.tenantId,
      ]);
    }
    io.to(`tenant:${req.tenantId}`).emit("table:updated", { tableId, action: "STATUS", status: normalized });
    return res.json({ ok: true });
  });

  router.delete("/:tableId", auth(), rbac("OWNER", "MANAGER"), tenantScope, async (req, res) => {
    const tableId = Number(req.params.tableId);
    await pool.execute("DELETE FROM restaurant_tables WHERE id = ? AND tenant_id = ?", [tableId, req.tenantId]);
    io.to(`tenant:${req.tenantId}`).emit("table:updated", { tableId, action: "DELETED" });
    return res.json({ ok: true });
  });

  return router;
}

module.exports = tableRoutes;

