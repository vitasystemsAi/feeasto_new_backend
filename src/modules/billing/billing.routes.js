const express = require("express");
const { z } = require("zod");
const pool = require("../../db/pool");
const auth = require("../../middlewares/auth");
const rbac = require("../../middlewares/rbac");
const tenantScope = require("../../middlewares/tenant");

const router = express.Router();

async function assertRestaurantInTenant(req, restaurantId, tenantId) {
  if (req.user.role === "OWNER") {
    const [[row]] = await pool.execute(
      "SELECT id FROM restaurants WHERE id = ? AND (owner_user_id = ? OR tenant_id = ?) LIMIT 1",
      [restaurantId, req.user.sub, tenantId]
    );
    return row || null;
  }
  const [[row]] = await pool.execute("SELECT id FROM restaurants WHERE id = ? AND tenant_id = ? LIMIT 1", [
    restaurantId,
    tenantId,
  ]);
  return row || null;
}

function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

router.post("/payments", auth(), tenantScope, async (req, res) => {
  const schema = z.object({
    orderId: z.coerce.number().int().positive(),
    paymentMethod: z.enum(["COD", "ONLINE"]),
    paymentProvider: z.string().max(40).optional(),
    amount: z.coerce.number().positive(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const [[order]] = await pool.execute(
    "SELECT id FROM orders WHERE id = ? AND tenant_id = ? LIMIT 1",
    [parsed.data.orderId, req.tenantId]
  );
  if (!order) return res.status(404).json({ message: "Order not found" });

  const [result] = await pool.execute(
    "INSERT INTO payments (tenant_id, order_id, payment_method, payment_provider, amount, payment_status) VALUES (?, ?, ?, ?, ?, 'PENDING')",
    [req.tenantId, parsed.data.orderId, parsed.data.paymentMethod, parsed.data.paymentProvider || null, parsed.data.amount]
  );
  return res.status(201).json({ id: result.insertId });
});

router.patch("/payments/:paymentId/status", auth(), rbac("OWNER", "MANAGER", "ADMIN", "SUPER_ADMIN"), tenantScope, async (req, res) => {
  const schema = z.object({
    paymentStatus: z.enum(["PENDING", "PAID", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED"]),
    restaurantId: z.coerce.number().int().positive().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const paymentId = Number(req.params.paymentId);
  if (!paymentId) return res.status(400).json({ message: "Invalid payment id" });

  if (parsed.data.restaurantId) {
    const [[row]] = await pool.execute(
      `SELECT p.id FROM payments p
       INNER JOIN orders o ON o.id = p.order_id AND o.tenant_id = p.tenant_id
       WHERE p.id = ? AND p.tenant_id = ? AND o.restaurant_id = ?`,
      [paymentId, req.tenantId, parsed.data.restaurantId]
    );
    if (!row) return res.status(404).json({ message: "Payment not found for this restaurant" });
  } else {
    const [[row]] = await pool.execute("SELECT id FROM payments WHERE id = ? AND tenant_id = ?", [
      paymentId,
      req.tenantId,
    ]);
    if (!row) return res.status(404).json({ message: "Payment not found" });
  }

  const extra =
    parsed.data.paymentStatus === "REFUNDED"
      ? ", refunded_cumulative = amount"
      : parsed.data.paymentStatus === "PAID"
        ? ", refunded_cumulative = 0"
        : "";

  const [result] = await pool.execute(
    `UPDATE payments SET payment_status = ?${extra} WHERE id = ? AND tenant_id = ?`,
    [parsed.data.paymentStatus, paymentId, req.tenantId]
  );
  if (result.affectedRows === 0) return res.status(404).json({ message: "Payment not found" });
  return res.json({ ok: true });
});

/** Refund by receipt workflow: partial (selected order lines) or full remaining balance on a payment. */
router.post(
  "/payments/:paymentId/refund",
  auth(),
  rbac("OWNER", "MANAGER", "ADMIN", "SUPER_ADMIN"),
  tenantScope,
  async (req, res) => {
    const bodySchema = z.object({
      restaurantId: z.coerce.number().int().positive(),
      mode: z.enum(["FULL_REMAINING", "LINE_ITEMS"]),
      orderItemIds: z.array(z.coerce.number().int().positive()).optional().default([]),
    });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const paymentId = Number(req.params.paymentId);
    if (!paymentId) return res.status(400).json({ message: "Invalid payment id" });

    const restaurant = await assertRestaurantInTenant(req, parsed.data.restaurantId, req.tenantId);
    if (!restaurant) return res.status(404).json({ message: "Restaurant not found" });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[payment]] = await conn.execute(
        `SELECT p.id, p.order_id, p.amount, p.payment_status,
                COALESCE(p.refunded_cumulative, 0) AS refunded_cumulative
         FROM payments p
         INNER JOIN orders o ON o.id = p.order_id AND o.tenant_id = p.tenant_id
         WHERE p.id = ? AND p.tenant_id = ? AND o.restaurant_id = ?
         FOR UPDATE`,
        [paymentId, req.tenantId, parsed.data.restaurantId]
      );

      if (!payment) {
        await conn.rollback();
        return res.status(404).json({ message: "Payment not found for this restaurant" });
      }

      if (!["PAID", "PARTIALLY_REFUNDED"].includes(payment.payment_status)) {
        await conn.rollback();
        return res.status(400).json({ message: "Only PAID or PARTIALLY_REFUNDED payments can be refunded" });
      }

      const amount = roundMoney(payment.amount);
      let cumulative = roundMoney(payment.refunded_cumulative || 0);
      const maxRefundable = roundMoney(amount - cumulative);
      if (maxRefundable <= 0) {
        await conn.rollback();
        return res.status(400).json({ message: "Nothing left to refund on this payment" });
      }

      let refundAmount = maxRefundable;

      if (parsed.data.mode === "LINE_ITEMS") {
        const ids = parsed.data.orderItemIds || [];
        if (ids.length === 0) {
          await conn.rollback();
          return res.status(400).json({ message: "orderItemIds required for LINE_ITEMS mode" });
        }
        const placeholders = ids.map(() => "?").join(",");
        const [items] = await conn.execute(
          `SELECT oi.id, (oi.quantity * oi.unit_price) AS line_total
           FROM order_items oi
           WHERE oi.order_id = ? AND oi.id IN (${placeholders})`,
          [payment.order_id, ...ids]
        );
        if (items.length !== ids.length) {
          await conn.rollback();
          return res.status(400).json({ message: "One or more line items do not belong to this order" });
        }
        const selectedTotal = roundMoney(items.reduce((s, r) => s + Number(r.line_total || 0), 0));
        refundAmount = roundMoney(Math.min(selectedTotal, maxRefundable));
        if (refundAmount <= 0) {
          await conn.rollback();
          return res.status(400).json({ message: "Computed refund amount is zero" });
        }
      }

      if (refundAmount > maxRefundable + 0.0001) {
        await conn.rollback();
        return res.status(400).json({ message: "Refund exceeds remaining balance" });
      }

      cumulative = roundMoney(cumulative + refundAmount);
      const capped = roundMoney(Math.min(cumulative, amount));
      const newStatus = capped >= amount - 0.009 ? "REFUNDED" : "PARTIALLY_REFUNDED";

      await conn.execute(
        `UPDATE payments SET refunded_cumulative = ?, payment_status = ? WHERE id = ? AND tenant_id = ?`,
        [capped, newStatus, paymentId, req.tenantId]
      );

      await conn.commit();
      return res.json({
        ok: true,
        paymentId,
        refundAmount,
        refundedCumulative: capped,
        paymentStatus: newStatus,
      });
    } catch (err) {
      await conn.rollback();
      if (err?.code === "ER_BAD_FIELD_ERROR" || /refunded_cumulative/.test(String(err.message))) {
        return res.status(503).json({
          message: "Database migration required",
          details: "Run backend/database/migrations/002_payments_partial_refund.sql",
        });
      }
      throw err;
    } finally {
      conn.release();
    }
  }
);

router.get("/invoices/lookup", auth(), rbac("OWNER", "MANAGER", "ADMIN", "SUPER_ADMIN"), tenantScope, async (req, res) => {
  const qSchema = z.object({
    invoiceNumber: z.string().min(3).max(80),
    restaurantId: z.coerce.number().int().positive(),
  });
  const parsed = qSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const restaurant = await assertRestaurantInTenant(req, parsed.data.restaurantId, req.tenantId);
  if (!restaurant) return res.status(404).json({ message: "Restaurant not found" });

  const invNo = parsed.data.invoiceNumber.trim();

  const [[invoice]] = await pool.execute(
    `SELECT i.id, i.invoice_number, i.order_id, i.created_at,
            o.order_type, o.status AS order_status, o.restaurant_id
     FROM invoices i
     INNER JOIN orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id
     WHERE i.tenant_id = ? AND o.restaurant_id = ? AND i.invoice_number = ?
     LIMIT 1`,
    [req.tenantId, parsed.data.restaurantId, invNo]
  );

  if (!invoice) return res.status(404).json({ message: "Invoice not found for this restaurant" });

  const [lineItems] = await pool.execute(
    `SELECT oi.id, oi.menu_item_id, oi.quantity, oi.unit_price,
            (oi.quantity * oi.unit_price) AS line_total,
            mi.name AS item_name
     FROM order_items oi
     INNER JOIN menu_items mi ON mi.id = oi.menu_item_id
     WHERE oi.order_id = ?
     ORDER BY oi.id ASC`,
    [invoice.order_id]
  );

  let payments = [];
  try {
    const [payRows] = await pool.execute(
      `SELECT p.id, p.order_id, p.amount, p.payment_status,
              COALESCE(p.refunded_cumulative, 0) AS refunded_cumulative,
              p.payment_method, p.payment_provider, p.created_at
       FROM payments p
       WHERE p.tenant_id = ? AND p.order_id = ?
       ORDER BY p.created_at DESC, p.id DESC`,
      [req.tenantId, invoice.order_id]
    );
    payments = (payRows || []).map((p) => ({
      ...p,
      remaining_amount: roundMoney(Number(p.amount) - Number(p.refunded_cumulative || 0)),
    }));
  } catch (err) {
    if (err?.code === "ER_BAD_FIELD_ERROR") {
      const [payRows] = await pool.execute(
        `SELECT p.id, p.order_id, p.amount, p.payment_status, p.payment_method, p.payment_provider, p.created_at
         FROM payments p
         WHERE p.tenant_id = ? AND p.order_id = ?
         ORDER BY p.created_at DESC, p.id DESC`,
        [req.tenantId, invoice.order_id]
      );
      payments = (payRows || []).map((p) => ({
        ...p,
        refunded_cumulative: 0,
        remaining_amount: roundMoney(Number(p.amount)),
      }));
    } else throw err;
  }

  return res.json({
    invoice: {
      id: invoice.id,
      invoice_number: invoice.invoice_number,
      order_id: invoice.order_id,
      created_at: invoice.created_at,
    },
    order: {
      id: invoice.order_id,
      order_type: invoice.order_type,
      status: invoice.order_status,
      restaurant_id: invoice.restaurant_id,
    },
    lineItems,
    payments,
  });
});

router.post("/invoices/generate", auth(), rbac("OWNER", "MANAGER"), tenantScope, async (req, res) => {
  const schema = z.object({ orderId: z.coerce.number().int().positive() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const [[order]] = await pool.execute(
    "SELECT id FROM orders WHERE id = ? AND tenant_id = ? LIMIT 1",
    [parsed.data.orderId, req.tenantId]
  );
  if (!order) return res.status(404).json({ message: "Order not found" });

  const invoiceNumber = `INV-${Date.now()}-${parsed.data.orderId}`;
  const [result] = await pool.execute(
    "INSERT INTO invoices (tenant_id, order_id, invoice_number, pdf_url) VALUES (?, ?, ?, NULL)",
    [req.tenantId, parsed.data.orderId, invoiceNumber]
  );
  return res.status(201).json({ id: result.insertId, invoiceNumber });
});

router.get("/invoices", auth(), tenantScope, async (req, res) => {
  const schema = z.object({ orderId: z.coerce.number().int().positive().optional() });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const params = [req.tenantId];
  let where = "tenant_id = ?";
  if (parsed.data.orderId) {
    where += " AND order_id = ?";
    params.push(parsed.data.orderId);
  }

  const [rows] = await pool.execute(
    `SELECT id, order_id, invoice_number, pdf_url, created_at
     FROM invoices
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT 200`,
    params
  );
  return res.json({ items: rows });
});

module.exports = router;

