const express = require("express");
const { z } = require("zod");
const pool = require("../../db/pool");
const auth = require("../../middlewares/auth");
const rbac = require("../../middlewares/rbac");
const tenantScope = require("../../middlewares/tenant");
const { assignDeliveryForOrder } = require("../delivery/delivery.routes");
const {
  roundMoney,
  razorpayConfigured,
  createRazorpayOrder,
} = require("../subscriptions/paymentGateway");
const {
  ORDER_STATES,
  buildStatusPayload,
  getOwnerNextActions,
  canCustomerCancelOrder,
  customerCancelDeadlineIso,
  normalizeTimeoutCancellationReason,
} = require("../../utils/orderStatus");
const {
  OWNER_ACCEPT_DEADLINE_MINUTES,
  AUTO_CANCEL_REASON,
  autoCancelPlacedOrder,
  registerEnsureColumns,
} = require("../../services/ownerAcceptTimeout");

registerEnsureColumns(ensureCancelledByColumn, ensureCancellationReasonColumn);
const {
  resolveRestaurantTenantId,
  todayIsoLocal,
  nowSlotTimeLocal,
} = require("../../utils/restaurantTenant");
const { evaluateCustomerRestaurantRadius, parseCoord } = require("../../utils/geo");
const { normalizeIndianPhone } = require("../../utils/phone");
const {
  customerOrderItemsSchema,
  computeCustomerCartTotal,
  parseCustomizationJson,
} = require("../../utils/orderLinePricing");

async function resolveDeliveryContactPhone(conn, userId, bodyPhone) {
  const fromBody = normalizeIndianPhone(bodyPhone);
  if (fromBody) return fromBody;
  try {
    const [[addr]] = await conn.execute(
      `SELECT contact_phone FROM customer_saved_addresses
       WHERE user_id = ? AND contact_phone IS NOT NULL AND contact_phone != ''
       ORDER BY is_default DESC, id DESC LIMIT 1`,
      [userId]
    );
    if (addr?.contact_phone) {
      return normalizeIndianPhone(addr.contact_phone) || String(addr.contact_phone).trim();
    }
  } catch {
    /* optional table/column */
  }
  try {
    const [[userRow]] = await conn.execute("SELECT phone FROM users WHERE id = ? LIMIT 1", [userId]);
    if (userRow?.phone) {
      return normalizeIndianPhone(userRow.phone) || String(userRow.phone).trim();
    }
  } catch {
    /* optional column */
  }
  return null;
}

async function resolveCustomerOrderCoords(pool, userId, { customerLat, customerLng, deliveryLatitude, deliveryLongitude }) {
  let cLat = parseCoord(customerLat);
  let cLng = parseCoord(customerLng);
  if (cLat == null || cLng == null) {
    cLat = parseCoord(deliveryLatitude);
    cLng = parseCoord(deliveryLongitude);
  }
  if (cLat == null || cLng == null) {
    try {
      const [[userRow]] = await pool.execute(
        "SELECT home_latitude, home_longitude FROM users WHERE id = ? LIMIT 1",
        [userId]
      );
      cLat = parseCoord(userRow?.home_latitude);
      cLng = parseCoord(userRow?.home_longitude);
    } catch {
      /* optional columns */
    }
  }
  return { customerLat: cLat, customerLng: cLng };
}

function isCustomerOrderClientError(error) {
  const msg = String(error?.message || "");
  if (!msg || error?.code) return false;
  return /not available|out of stock|price mismatch|greater than zero|menu item #/i.test(msg);
}

function respondCustomerOrderError(res, error, fallback = "Order failed") {
  const message = error?.message || fallback;
  const status = isCustomerOrderClientError(error) ? 400 : 500;
  return res.status(status).json({
    message,
    ...(status === 500 ? { details: message } : {}),
  });
}

function respondCustomerRadiusBlocked(res, check) {
  const status = check.reason === "LOCATION_REQUIRED" ? 400 : 403;
  return res.status(status).json({
    message: check.message,
    code: check.reason,
    distance_km: check.distance_km,
    order_radius_km: check.order_radius_km,
  });
}

let hasAcceptedAtColumnCache = null;
let hasCancelledByColumnCache = null;
let hasCancellationReasonColumnCache = null;

async function ensureCancelledByColumn() {
  if (hasCancelledByColumnCache === true) return true;
  const [rows] = await pool.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'cancelled_by' LIMIT 1`
  );
  if (rows.length > 0) {
    hasCancelledByColumnCache = true;
    return true;
  }
  try {
    await pool.execute(
      "ALTER TABLE orders ADD COLUMN cancelled_by VARCHAR(20) NULL DEFAULT NULL AFTER accepted_at"
    );
    hasCancelledByColumnCache = true;
    return true;
  } catch (error) {
    if (error?.code === "ER_DUP_FIELDNAME") {
      hasCancelledByColumnCache = true;
      return true;
    }
    return false;
  }
}

async function ensureCancellationReasonColumn() {
  if (hasCancellationReasonColumnCache === true) return true;
  const [rows] = await pool.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'cancellation_reason' LIMIT 1`
  );
  if (rows.length > 0) {
    hasCancellationReasonColumnCache = true;
    return true;
  }
  try {
    await pool.execute(
      "ALTER TABLE orders ADD COLUMN cancellation_reason VARCHAR(500) NULL DEFAULT NULL AFTER cancelled_by"
    );
    hasCancellationReasonColumnCache = true;
    return true;
  } catch (error) {
    if (error?.code === "ER_DUP_FIELDNAME") {
      hasCancellationReasonColumnCache = true;
      return true;
    }
    return false;
  }
}

function ownerAcceptDeadlineIso(createdAt) {
  const placed = createdAt ? new Date(createdAt) : new Date();
  if (Number.isNaN(placed.getTime())) return new Date(Date.now() + OWNER_ACCEPT_DEADLINE_MINUTES * 60_000).toISOString();
  return new Date(placed.getTime() + OWNER_ACCEPT_DEADLINE_MINUTES * 60_000).toISOString();
}

async function buildOwnerOrderAlertPayload(orderId, tenantId, restaurantId) {
  const [[order]] = await pool.execute(
    `SELECT o.id, o.order_type, o.status, o.created_at, u.full_name AS customer_name,
            o.customer_contact_phone
     FROM orders o
     LEFT JOIN users u ON u.id = o.customer_user_id
     WHERE o.id = ? LIMIT 1`,
    [orderId]
  );
  if (!order) return null;
  const itemsByOrder = await fetchOrderItems([orderId]);
  const rawItems = itemsByOrder[orderId] || [];
  const items = rawItems.map((it) => ({
    menu_item_name: it.menu_item_name,
    quantity: it.quantity,
    unit_price: it.unit_price,
  }));
  const lineTotal = roundMoney(
    items.reduce((sum, it) => sum + Number(it.quantity) * Number(it.unit_price), 0)
  );
  const itemCount = items.reduce((sum, it) => sum + Number(it.quantity), 0);
  const status = String(order.status || "").toUpperCase();
  const placedAt = order.created_at ? new Date(order.created_at).toISOString() : new Date().toISOString();
  return {
    orderId: Number(orderId),
    status,
    orderType: String(order.order_type || "").toUpperCase(),
    restaurantId: Number(restaurantId),
    tenantId: Number(tenantId),
    customerName: order.customer_name || null,
    customerPhone: order.customer_contact_phone || null,
    items: items.slice(0, 4),
    itemCount,
    lineTotal,
    placedAt,
    acceptDeadlineAt: ownerAcceptDeadlineIso(order.created_at),
    acceptDeadlineMinutes: OWNER_ACCEPT_DEADLINE_MINUTES,
    requiresOwnerAction: status === "PLACED" && items.length > 0,
  };
}

async function ensureAcceptedAtColumn() {
  if (hasAcceptedAtColumnCache === true) return true;
  const [rows] = await pool.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'accepted_at' LIMIT 1`
  );
  if (rows.length > 0) {
    hasAcceptedAtColumnCache = true;
    return true;
  }
  try {
    await pool.execute(
      "ALTER TABLE orders ADD COLUMN accepted_at DATETIME NULL DEFAULT NULL AFTER created_at"
    );
    hasAcceptedAtColumnCache = true;
    return true;
  } catch (error) {
    if (error?.code === "ER_DUP_FIELDNAME") {
      hasAcceptedAtColumnCache = true;
      return true;
    }
    return false;
  }
}

async function fetchOrderItems(orderIds) {
  if (!orderIds.length) return {};
  const placeholders = orderIds.map(() => "?").join(",");
  let items;
  try {
    [items] = await pool.execute(
      `SELECT oi.order_id, oi.menu_item_id, mi.name AS menu_item_name, oi.quantity, oi.unit_price,
              oi.customization_json
       FROM order_items oi
       INNER JOIN menu_items mi ON mi.id = oi.menu_item_id
       WHERE oi.order_id IN (${placeholders})`,
      orderIds
    );
  } catch (error) {
    if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
    [items] = await pool.execute(
      `SELECT oi.order_id, oi.menu_item_id, mi.name AS menu_item_name, oi.quantity, oi.unit_price
       FROM order_items oi
       INNER JOIN menu_items mi ON mi.id = oi.menu_item_id
       WHERE oi.order_id IN (${placeholders})`,
      orderIds
    );
  }
  return items.reduce((acc, row) => {
    if (!acc[row.order_id]) acc[row.order_id] = [];
    acc[row.order_id].push({
      menu_item_id: row.menu_item_id,
      menu_item_name: row.menu_item_name,
      quantity: row.quantity,
      unit_price: row.unit_price,
      customization: parseCustomizationJson(row.customization_json),
    });
    return acc;
  }, {});
}

function enrichOrderRow(row, itemsByOrder) {
  const items = itemsByOrder[row.id] || [];
  const statusMeta = buildStatusPayload(
    row.status,
    row.delivery_status,
    row.cancelled_by,
    row.cancellation_reason
  );
  const hasDeliveryPartner = Boolean(row.delivery_partner_profile_id);
  const paymentStatus = row.payment_status || null;
  return {
    ...row,
    items,
    line_total: items.reduce((s, it) => s + Number(it.quantity) * Number(it.unit_price), 0),
    payment_status: paymentStatus,
    is_prepaid: String(paymentStatus || "").toUpperCase() === "PAID",
    cancellation_reason:
      normalizeTimeoutCancellationReason(row.cancellation_reason) || row.cancellation_reason || null,
    customer_status: statusMeta.customerStatus,
    customer_status_key: statusMeta.customerStatusKey,
    owner_status_label: statusMeta.ownerStatusLabel,
    owner_next_actions: getOwnerNextActions(row.status, row.order_type, { hasDeliveryPartner }),
    can_cancel: canCustomerCancelOrder(row),
    cancel_deadline_at: customerCancelDeadlineIso(row),
    scheduled_display: row.scheduled_delivery_date
      ? `${row.scheduled_delivery_date}${row.scheduled_delivery_time ? ` · ${row.scheduled_delivery_time}` : ""}`
      : null,
  };
}

function mapPaymentMethod(method) {
  const normalized = String(method || "").toUpperCase();
  if (normalized === "CASH") return { paymentMethod: "COD", paymentProvider: "CASH" };
  if (normalized === "CARD") return { paymentMethod: "ONLINE", paymentProvider: "CARD" };
  if (normalized === "UPI") return { paymentMethod: "ONLINE", paymentProvider: "UPI" };
  if (normalized === "COD") return { paymentMethod: "COD", paymentProvider: "CASH" };
  return { paymentMethod: "ONLINE", paymentProvider: normalized || "MANUAL" };
}

function tableOrderSchemaRequiredResponse(res) {
  return res.status(409).json({
    message: "Table-wise dine-in orders require the orders.table_id column. Please run latest database migration.",
    code: "TABLE_ORDER_SCHEMA_REQUIRED",
  });
}

async function resolveRestaurantTenantContext(req, restaurantId) {
  const rid = Number(restaurantId);
  if (!rid) return { error: { status: 400, message: "restaurantId is required" } };

  const [[restaurant]] = await pool.execute(
    "SELECT id, tenant_id, owner_user_id FROM restaurants WHERE id = ? LIMIT 1",
    [rid]
  );
  if (!restaurant) return { error: { status: 404, message: "Restaurant not found" } };

  if (req.user.role === "OWNER") {
    if (Number(restaurant.owner_user_id) !== Number(req.user.sub)) {
      return { error: { status: 403, message: "You can only view orders for your restaurants." } };
    }
    return { tenantId: Number(restaurant.tenant_id), restaurant };
  }

  let tenantId = Number(req.headers["x-tenant-id"] || req.user?.tenantId || 0);
  if (!tenantId) tenantId = Number(restaurant.tenant_id);
  if (!tenantId) return { error: { status: 400, message: "Missing tenant context" } };
  return { tenantId, restaurant };
}

function orderRouter(io) {
  const router = express.Router();

  router.post("/dine-in/session", auth(), tenantScope, async (req, res) => {
    const schema = z.object({
      restaurantId: z.coerce.number().int().positive(),
      tableId: z.coerce.number().int().positive(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    try {
      const [[existing]] = await pool.execute(
        `SELECT id
         FROM orders
         WHERE tenant_id = ?
           AND restaurant_id = ?
           AND table_id = ?
           AND order_type = 'DINE_IN'
           AND status IN ('PLACED','ACCEPTED','PREPARING','READY')
         ORDER BY id DESC
         LIMIT 1`,
        [req.tenantId, parsed.data.restaurantId, parsed.data.tableId]
      );
      if (existing) return res.json({ orderId: existing.id, created: false });

      const [created] = await pool.execute(
        "INSERT INTO orders (tenant_id, restaurant_id, customer_user_id, table_id, order_type, status) VALUES (?, ?, ?, ?, 'DINE_IN', 'PLACED')",
        [req.tenantId, parsed.data.restaurantId, req.user.sub, parsed.data.tableId]
      );
      const orderId = created.insertId;
      io.to(`tenant:${req.tenantId}`).emit("order:created", {
        orderId,
        status: "PLACED",
        orderType: "DINE_IN",
      });
      return res.status(201).json({ orderId, created: true });
    } catch (error) {
      if (error?.code === "ER_BAD_FIELD_ERROR") {
        return tableOrderSchemaRequiredResponse(res);
      }
      return res.status(500).json({ message: "Failed to start dine-in session", details: error.message });
    }
  });

  router.post("/takeaway/session", auth(), tenantScope, async (req, res) => {
    const schema = z.object({
      restaurantId: z.coerce.number().int().positive(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    try {
      const [created] = await pool.execute(
        "INSERT INTO orders (tenant_id, restaurant_id, customer_user_id, table_id, order_type, status) VALUES (?, ?, ?, NULL, 'TAKEAWAY', 'PLACED')",
        [req.tenantId, parsed.data.restaurantId, req.user.sub]
      );
      const orderId = created.insertId;
      io.to(`tenant:${req.tenantId}`).emit("order:created", { orderId, status: "PLACED", orderType: "TAKEAWAY" });
      return res.status(201).json({ orderId, created: true });
    } catch (error) {
      if (error?.code === "ER_BAD_FIELD_ERROR") {
        const [created] = await pool.execute(
          "INSERT INTO orders (tenant_id, restaurant_id, customer_user_id, order_type, status) VALUES (?, ?, ?, 'TAKEAWAY', 'PLACED')",
          [req.tenantId, parsed.data.restaurantId, req.user.sub]
        );
        const orderId = created.insertId;
        io.to(`tenant:${req.tenantId}`).emit("order:created", { orderId, status: "PLACED", orderType: "TAKEAWAY" });
        return res.status(201).json({ orderId, created: true });
      }
      return res.status(500).json({ message: "Failed to start takeaway order", details: error.message });
    }
  });

  router.post("/takeaway/place", auth(), tenantScope, async (req, res) => {
    const schema = z.object({
      restaurantId: z.coerce.number().int().positive(),
      items: z
        .array(z.object({ menuItemId: z.coerce.number().int().positive(), quantity: z.coerce.number().int().positive() }))
        .min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      let orderId;
      try {
        const [created] = await conn.execute(
          "INSERT INTO orders (tenant_id, restaurant_id, customer_user_id, table_id, order_type, status) VALUES (?, ?, ?, NULL, 'TAKEAWAY', 'PLACED')",
          [req.tenantId, parsed.data.restaurantId, req.user.sub]
        );
        orderId = created.insertId;
      } catch (error) {
        if (error?.code === "ER_BAD_FIELD_ERROR") {
          const [created] = await conn.execute(
            "INSERT INTO orders (tenant_id, restaurant_id, customer_user_id, order_type, status) VALUES (?, ?, ?, 'TAKEAWAY', 'PLACED')",
            [req.tenantId, parsed.data.restaurantId, req.user.sub]
          );
          orderId = created.insertId;
        } else {
          throw error;
        }
      }

      for (const item of parsed.data.items) {
        await conn.execute(
          "INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price) SELECT ?, id, ?, price FROM menu_items WHERE id = ?",
          [orderId, item.quantity, item.menuItemId]
        );
      }

      await conn.commit();
      io.to(`tenant:${req.tenantId}`).emit("order:created", { orderId, status: "PLACED", orderType: "TAKEAWAY" });
      // Do not also emit order:items-added — that double-fires prep prints / looks like a bill run.
      return res.status(201).json({ orderId, created: true });
    } catch (error) {
      await conn.rollback();
      return res.status(500).json({ message: "Failed to place takeaway order", details: error.message });
    } finally {
      conn.release();
    }
  });

  async function mapTakeawayLogRows(rows) {
    if (!rows.length) return [];
    const orderIds = rows.map((r) => r.id);
    const placeholders = orderIds.map(() => "?").join(",");
    const [itemRows] = await pool.execute(
      `SELECT oi.order_id, oi.quantity, oi.unit_price
       FROM order_items oi
       WHERE oi.order_id IN (${placeholders})`,
      orderIds
    );
    const totals = itemRows.reduce((acc, row) => {
      const line = Number(row.quantity) * Number(row.unit_price);
      acc[row.order_id] = (acc[row.order_id] || 0) + line;
      return acc;
    }, {});
    const counts = itemRows.reduce((acc, row) => {
      acc[row.order_id] = (acc[row.order_id] || 0) + Number(row.quantity);
      return acc;
    }, {});

    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      created_at: row.created_at,
      item_count: counts[row.id] || 0,
      subtotal: totals[row.id] || 0,
      invoice_number: row.invoice_number || null,
      is_open: ["PLACED", "ACCEPTED", "PREPARING", "READY"].includes(String(row.status || "").toUpperCase()),
      customer_name: row.customer_name || null,
      payment_status: row.payment_status || null,
      is_prepaid: String(row.payment_status || "").toUpperCase() === "PAID",
    }));
  }

  router.get("/takeaway/open", auth(), tenantScope, async (req, res) => {
    const restaurantId = Number(req.query.restaurantId || 0);
    if (!restaurantId) return res.status(400).json({ message: "restaurantId is required" });

    const [openRows] = await pool.execute(
      `SELECT o.id, o.status, o.created_at, NULL AS invoice_number,
              u.full_name AS customer_name,
              (SELECT p.payment_status FROM payments p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) AS payment_status
       FROM orders o
       LEFT JOIN users u ON u.id = o.customer_user_id
       WHERE o.tenant_id = ?
         AND o.restaurant_id = ?
         AND o.order_type = 'TAKEAWAY'
         AND o.status IN ('PLACED','ACCEPTED','PREPARING','READY')
       ORDER BY o.id DESC
       LIMIT 40`,
      [req.tenantId, restaurantId]
    );

    const [recentRows] = await pool.execute(
      `SELECT o.id, o.status, o.created_at,
              (SELECT i.invoice_number FROM invoices i WHERE i.order_id = o.id AND i.tenant_id = o.tenant_id ORDER BY i.id DESC LIMIT 1) AS invoice_number
       FROM orders o
       WHERE o.tenant_id = ?
         AND o.restaurant_id = ?
         AND o.order_type = 'TAKEAWAY'
         AND o.status IN ('DELIVERED','CANCELLED','REJECTED')
       ORDER BY o.id DESC
       LIMIT 50`,
      [req.tenantId, restaurantId]
    );

    const items = await mapTakeawayLogRows(openRows);
    const recent = await mapTakeawayLogRows(recentRows);

    return res.json({ items, recent });
  });

  router.get("/takeaway/:orderId/active", auth(), tenantScope, async (req, res) => {
    const orderId = Number(req.params.orderId);
    const restaurantId = Number(req.query.restaurantId || 0);
    const allowCompleted = String(req.query.allowCompleted || "") === "1";
    if (!orderId || !restaurantId) return res.status(400).json({ message: "orderId and restaurantId are required" });

    const statusClause = allowCompleted
      ? "AND status IN ('PLACED','ACCEPTED','PREPARING','DELIVERED','CANCELLED','REJECTED')"
      : "AND status IN ('PLACED','ACCEPTED','PREPARING','READY')";

    const [[order]] = await pool.execute(
      `SELECT id, status, created_at
       FROM orders
       WHERE id = ?
         AND tenant_id = ?
         AND restaurant_id = ?
         AND order_type = 'TAKEAWAY'
         ${statusClause}
       LIMIT 1`,
      [orderId, req.tenantId, restaurantId]
    );
    if (!order) return res.json({ hasActiveOrder: false });

    const [items] = await pool.execute(
      `SELECT oi.id, oi.menu_item_id, mi.name, oi.quantity, oi.unit_price, (oi.quantity * oi.unit_price) AS line_total
       FROM order_items oi
       JOIN menu_items mi ON mi.id = oi.menu_item_id
       WHERE oi.order_id = ?
       ORDER BY oi.id DESC`,
      [order.id]
    );
    const subtotal = items.reduce((sum, it) => sum + Number(it.line_total || 0), 0);
    return res.json({ hasActiveOrder: true, order: { ...order, items, subtotal } });
  });

  router.post("/takeaway/:orderId/checkout", auth(), tenantScope, async (req, res) => {
    const orderId = Number(req.params.orderId);
    const schema = z.object({
      restaurantId: z.coerce.number().int().positive(),
      paymentMethod: z.enum(["CASH", "UPI", "CARD", "COD", "ONLINE"]).default("CASH"),
      paymentProvider: z.string().max(40).optional(),
      taxPercent: z.coerce.number().min(0).max(100).default(0),
      paymentMode: z.enum(["SINGLE", "SPLIT"]).default("SINGLE"),
      splitPayments: z
        .array(
          z.object({
            method: z.enum(["CASH", "UPI", "CARD"]),
            amount: z.coerce.number().positive(),
          })
        )
        .optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[order]] = await conn.execute(
        `SELECT id
         FROM orders
         WHERE id = ?
           AND tenant_id = ?
           AND restaurant_id = ?
           AND order_type = 'TAKEAWAY'
           AND status IN ('PLACED','ACCEPTED','PREPARING')
         LIMIT 1`,
        [orderId, req.tenantId, parsed.data.restaurantId]
      );
      if (!order) {
        await conn.rollback();
        return res.status(404).json({ message: "No active takeaway order found" });
      }

      const [items] = await conn.execute(
        "SELECT quantity, unit_price FROM order_items WHERE order_id = ?",
        [order.id]
      );
      const subtotal = items.reduce((sum, it) => sum + Number(it.quantity) * Number(it.unit_price), 0);
      const taxAmount = (subtotal * Number(parsed.data.taxPercent || 0)) / 100;
      const grandTotal = subtotal + taxAmount;

      if (parsed.data.paymentMode === "SPLIT") {
        const splits = parsed.data.splitPayments || [];
        if (splits.length < 2) {
          await conn.rollback();
          return res.status(400).json({ message: "At least 2 split payment rows are required" });
        }
        const splitSum = splits.reduce((sum, s) => sum + Number(s.amount), 0);
        if (Math.abs(splitSum - grandTotal) > 0.01) {
          await conn.rollback();
          return res.status(400).json({ message: "Split amounts must match grand total exactly" });
        }
        for (const split of splits) {
          const mapped = mapPaymentMethod(split.method);
          await conn.execute(
            "INSERT INTO payments (tenant_id, order_id, payment_method, payment_provider, amount, payment_status) VALUES (?, ?, ?, ?, ?, 'PAID')",
            [req.tenantId, order.id, mapped.paymentMethod, mapped.paymentProvider, Number(split.amount)]
          );
        }
      } else {
        const mapped = mapPaymentMethod(parsed.data.paymentMethod);
        await conn.execute(
          "INSERT INTO payments (tenant_id, order_id, payment_method, payment_provider, amount, payment_status) VALUES (?, ?, ?, ?, ?, 'PAID')",
          [
            req.tenantId,
            order.id,
            mapped.paymentMethod,
            parsed.data.paymentProvider || mapped.paymentProvider,
            grandTotal,
          ]
        );
      }

      const invoiceNumber = `INV-${Date.now()}-${order.id}`;
      const [invoiceResult] = await conn.execute(
        "INSERT INTO invoices (tenant_id, order_id, invoice_number, pdf_url) VALUES (?, ?, ?, NULL)",
        [req.tenantId, order.id, invoiceNumber]
      );

      await conn.execute("UPDATE orders SET status = 'DELIVERED' WHERE id = ? AND tenant_id = ?", [
        order.id,
        req.tenantId,
      ]);
      await conn.commit();

      io.to(`tenant:${req.tenantId}`).emit("order:status-updated", { orderId: order.id, status: "DELIVERED" });
      return res.json({
        ok: true,
        orderId: order.id,
        invoiceId: invoiceResult.insertId,
        invoiceNumber,
        subtotal,
        taxAmount,
        grandTotal,
      });
    } catch (error) {
      await conn.rollback();
      return res.status(500).json({ message: "Takeaway checkout failed", details: error.message });
    } finally {
      conn.release();
    }
  });

  router.post("/:orderId/items", auth(), tenantScope, async (req, res) => {
    const schema = z.object({
      items: z.array(z.object({ menuItemId: z.number().int(), quantity: z.number().int().positive() })).min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const orderId = Number(req.params.orderId);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[order]] = await conn.execute(
        "SELECT id, order_type FROM orders WHERE id = ? AND tenant_id = ? LIMIT 1",
        [orderId, req.tenantId]
      );
      if (!order) {
        await conn.rollback();
        return res.status(404).json({ message: "Order not found" });
      }

      for (const item of parsed.data.items) {
        await conn.execute(
          "INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price) SELECT ?, id, ?, price FROM menu_items WHERE id = ?",
          [orderId, item.quantity, item.menuItemId]
        );
      }

      await conn.commit();
      io.to(`tenant:${req.tenantId}`).emit("order:items-added", {
        orderId,
        orderType: String(order.order_type || "").toUpperCase() || null,
      });
      return res.status(201).json({ ok: true });
    } catch (error) {
      await conn.rollback();
      return res.status(500).json({ message: "Failed to add items", details: error.message });
    } finally {
      conn.release();
    }
  });

  router.get("/table/:tableId/active", auth(), tenantScope, async (req, res) => {
    const tableId = Number(req.params.tableId);
    const restaurantId = Number(req.query.restaurantId || 0);
    if (!tableId || !restaurantId) return res.status(400).json({ message: "tableId and restaurantId are required" });

    let order;
    try {
      const [[row]] = await pool.execute(
        `SELECT id, status, created_at
         FROM orders
         WHERE tenant_id = ?
           AND restaurant_id = ?
           AND table_id = ?
           AND order_type = 'DINE_IN'
           AND status IN ('PLACED','ACCEPTED','PREPARING','READY')
         ORDER BY id DESC
         LIMIT 1`,
        [req.tenantId, restaurantId, tableId]
      );
      order = row;
    } catch (error) {
      if (error?.code === "ER_BAD_FIELD_ERROR") return tableOrderSchemaRequiredResponse(res);
      throw error;
    }

    if (!order) return res.json({ hasActiveOrder: false });

    const [items] = await pool.execute(
      `SELECT oi.id, oi.menu_item_id, mi.name, oi.quantity, oi.unit_price, (oi.quantity * oi.unit_price) AS line_total
       FROM order_items oi
       JOIN menu_items mi ON mi.id = oi.menu_item_id
       WHERE oi.order_id = ?
       ORDER BY oi.id DESC`,
      [order.id]
    );
    const subtotal = items.reduce((sum, it) => sum + Number(it.line_total || 0), 0);
    const itemsForEnrich = items.map((it) => ({
      menu_item_id: it.menu_item_id,
      menu_item_name: it.name,
      quantity: it.quantity,
      unit_price: it.unit_price,
    }));
    const enriched = enrichOrderRow(
      {
        id: order.id,
        status: order.status,
        order_type: "DINE_IN",
        created_at: order.created_at,
        table_id: tableId,
      },
      { [order.id]: itemsForEnrich }
    );
    return res.json({
      hasActiveOrder: true,
      order: { ...enriched, items, subtotal },
    });
  });

  async function fetchKitchenOrders(req, restaurantId, { dineInOnly = false } = {}) {
    const ctx = await resolveRestaurantTenantContext(req, restaurantId);
    if (ctx.error) return { error: ctx.error };
    const tenantId = ctx.tenantId;

    const orderTypeFilter = dineInOnly
      ? "AND o.order_type = 'DINE_IN'"
      : "AND o.order_type IN ('DINE_IN','TAKEAWAY','DELIVERY')";

    let openRows;
    let servedRows;
    try {
      [openRows] = await pool.execute(
        `SELECT o.id, o.status, o.created_at, o.accepted_at, o.table_id, o.order_type,
                rt.table_number, rt.capacity
         FROM orders o
         LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
         WHERE o.tenant_id = ?
           AND o.restaurant_id = ?
           ${orderTypeFilter}
           AND o.status IN ('PLACED','ACCEPTED','PREPARING','READY')
         ORDER BY o.created_at ASC`,
        [tenantId, restaurantId]
      );
      [servedRows] = await pool.execute(
        `SELECT o.id, o.status, o.created_at, o.table_id, o.order_type, rt.table_number
         FROM orders o
         LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
         WHERE o.tenant_id = ?
           AND o.restaurant_id = ?
           ${orderTypeFilter}
           AND o.status = 'DELIVERED'
           AND DATE(o.created_at) = CURDATE()
         ORDER BY o.created_at DESC
         LIMIT 30`,
        [tenantId, restaurantId]
      );
    } catch (error) {
      if (error?.code === "ER_BAD_FIELD_ERROR") return { schemaError: true };
      throw error;
    }

    const allIds = [...openRows, ...servedRows].map((r) => r.id);
    const itemsByOrder = allIds.length ? await fetchOrderItems(allIds) : {};

    const mapRow = (row) => {
      const orderType = String(row.order_type || "DINE_IN").toUpperCase();
      const enriched = enrichOrderRow(
        { ...row, order_type: orderType, customer_user_id: null },
        itemsByOrder
      );
      return {
        ...enriched,
        order_type: orderType,
        table_id: row.table_id,
        table_number: row.table_number,
        table_capacity: row.capacity,
      };
    };

    return {
      open: openRows.map(mapRow),
      servedToday: servedRows.map(mapRow),
    };
  }

  router.get("/kitchen/dine-in", auth(), rbac("OWNER", "MANAGER", "ADMIN"), async (req, res) => {
    const restaurantId = Number(req.query.restaurantId || 0);
    try {
      const result = await fetchKitchenOrders(req, restaurantId, { dineInOnly: true });
      if (result.error) return res.status(result.error.status).json({ message: result.error.message });
      if (result.schemaError) return tableOrderSchemaRequiredResponse(res);
      return res.json({ open: result.open, servedToday: result.servedToday });
    } catch (error) {
      return res.status(500).json({ message: "Failed to load kitchen orders", details: error.message });
    }
  });

  router.get("/kitchen", auth(), rbac("OWNER", "MANAGER", "ADMIN"), async (req, res) => {
    const restaurantId = Number(req.query.restaurantId || 0);
    try {
      const result = await fetchKitchenOrders(req, restaurantId, { dineInOnly: false });
      if (result.error) return res.status(result.error.status).json({ message: result.error.message });
      if (result.schemaError) return tableOrderSchemaRequiredResponse(res);
      return res.json({ open: result.open, servedToday: result.servedToday });
    } catch (error) {
      return res.status(500).json({ message: "Failed to load kitchen orders", details: error.message });
    }
  });

  router.post("/table/:tableId/checkout", auth(), tenantScope, async (req, res) => {
    const tableId = Number(req.params.tableId);
    const schema = z.object({
      restaurantId: z.coerce.number().int().positive(),
      paymentMethod: z.enum(["CASH", "UPI", "CARD", "COD", "ONLINE"]).default("CASH"),
      paymentProvider: z.string().max(40).optional(),
      taxPercent: z.coerce.number().min(0).max(100).default(0),
      paymentMode: z.enum(["SINGLE", "SPLIT"]).default("SINGLE"),
      splitPayments: z
        .array(
          z.object({
            method: z.enum(["CASH", "UPI", "CARD"]),
            amount: z.coerce.number().positive(),
          })
        )
        .optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      let order;
      try {
        const [[row]] = await conn.execute(
          `SELECT id, status
           FROM orders
           WHERE tenant_id = ?
             AND restaurant_id = ?
             AND table_id = ?
             AND order_type = 'DINE_IN'
             AND status IN ('PLACED','ACCEPTED','PREPARING','READY')
           ORDER BY id DESC
           LIMIT 1`,
          [req.tenantId, parsed.data.restaurantId, tableId]
        );
        order = row;
      } catch (error) {
        if (error?.code === "ER_BAD_FIELD_ERROR") return tableOrderSchemaRequiredResponse(res);
        throw error;
      }
      if (!order) {
        await conn.rollback();
        return res.status(404).json({ message: "No active order found for this table" });
      }

      const [items] = await conn.execute(
        "SELECT quantity, unit_price FROM order_items WHERE order_id = ?",
        [order.id]
      );
      if (!items.length) {
        await conn.rollback();
        return res.status(422).json({ message: "Confirm items on this table before payment." });
      }
      const subtotal = items.reduce((sum, it) => sum + Number(it.quantity) * Number(it.unit_price), 0);
      const taxAmount = (subtotal * Number(parsed.data.taxPercent || 0)) / 100;
      const grandTotal = subtotal + taxAmount;

      let paymentResult;
      if (parsed.data.paymentMode === "SPLIT") {
        const splits = parsed.data.splitPayments || [];
        if (splits.length < 2) {
          await conn.rollback();
          return res.status(400).json({ message: "At least 2 split payment rows are required" });
        }
        const splitSum = splits.reduce((sum, s) => sum + Number(s.amount), 0);
        if (Math.abs(splitSum - grandTotal) > 0.01) {
          await conn.rollback();
          return res.status(400).json({ message: "Split amounts must match grand total exactly" });
        }

        for (const split of splits) {
          const mapped = mapPaymentMethod(split.method);
          await conn.execute(
            "INSERT INTO payments (tenant_id, order_id, payment_method, payment_provider, amount, payment_status) VALUES (?, ?, ?, ?, ?, 'PAID')",
            [req.tenantId, order.id, mapped.paymentMethod, mapped.paymentProvider, Number(split.amount)]
          );
        }
        paymentResult = { insertId: null };
      } else {
        const mapped = mapPaymentMethod(parsed.data.paymentMethod);
        const [singlePaymentResult] = await conn.execute(
          "INSERT INTO payments (tenant_id, order_id, payment_method, payment_provider, amount, payment_status) VALUES (?, ?, ?, ?, ?, 'PAID')",
          [req.tenantId, order.id, mapped.paymentMethod, parsed.data.paymentProvider || mapped.paymentProvider, grandTotal]
        );
        paymentResult = singlePaymentResult;
      }
      const invoiceNumber = `INV-${Date.now()}-${order.id}`;
      const [invoiceResult] = await conn.execute(
        "INSERT INTO invoices (tenant_id, order_id, invoice_number, pdf_url) VALUES (?, ?, ?, NULL)",
        [req.tenantId, order.id, invoiceNumber]
      );

      await conn.execute("UPDATE orders SET status = 'DELIVERED' WHERE id = ? AND tenant_id = ?", [order.id, req.tenantId]);
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

      io.to(`tenant:${req.tenantId}`).emit("order:status-updated", { orderId: order.id, status: "DELIVERED" });
      io.to(`tenant:${req.tenantId}`).emit("table:updated", { tableId, action: "CHECKOUT", status: "AVAILABLE" });
      return res.json({
        ok: true,
        orderId: order.id,
        paymentId: paymentResult.insertId,
        invoiceId: invoiceResult.insertId,
        invoiceNumber,
        subtotal,
        taxAmount,
        grandTotal,
      });
    } catch (error) {
      await conn.rollback();
      return res.status(500).json({ message: "Checkout failed", details: error.message });
    } finally {
      conn.release();
    }
  });

  /** Preview total + Razorpay intent for online pay (before order is created). */
  router.post("/customer/payment-intent", auth(), rbac("CUSTOMER"), async (req, res) => {
    const schema = z.object({
      restaurantId: z.coerce.number().int().positive(),
      items: customerOrderItemsSchema,
      customerLat: z.coerce.number().min(-90).max(90).optional(),
      customerLng: z.coerce.number().min(-180).max(180).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    let restaurant;
    try {
      [[restaurant]] = await pool.execute(
        `SELECT id, tenant_id, name, is_online, latitude, longitude
         FROM restaurants WHERE id = ? AND approval_status = 'APPROVED' AND is_active = 1 LIMIT 1`,
        [parsed.data.restaurantId]
      );
    } catch (error) {
      if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
      [[restaurant]] = await pool.execute(
        `SELECT id, tenant_id, name, is_online
         FROM restaurants WHERE id = ? AND approval_status = 'APPROVED' AND is_active = 1 LIMIT 1`,
        [parsed.data.restaurantId]
      );
    }
    if (!restaurant) return res.status(404).json({ message: "Restaurant not found." });
    if (restaurant.is_online === 0) {
      return res.status(403).json({ message: "This restaurant is offline and is not accepting orders." });
    }

    const coords = await resolveCustomerOrderCoords(pool, req.user.sub, parsed.data);
    const radiusCheck = evaluateCustomerRestaurantRadius(restaurant, coords.customerLat, coords.customerLng);
    if (!radiusCheck.allowed) return respondCustomerRadiusBlocked(res, radiusCheck);

    const conn = await pool.getConnection();
    try {
      const { total: amount } = await computeCustomerCartTotal(
        conn,
        parsed.data.restaurantId,
        parsed.data.items
      );
      if (amount <= 0) {
        return res.status(400).json({ message: "Order total must be greater than zero." });
      }

      if (!razorpayConfigured()) {
        return res.json({
          amount,
          currency: "INR",
          intent: {
            provider: "MOCK",
            mock: true,
            orderId: `mock_food_${Date.now()}`,
            amount: Math.round(amount * 100),
            currency: "INR",
            keyId: null,
          },
        });
      }

      const intent = await createRazorpayOrder({
        amountInr: amount,
        receipt: `food_${parsed.data.restaurantId}_${Date.now()}`,
        notes: { restaurantId: String(parsed.data.restaurantId), userId: String(req.user.sub) },
      });
      return res.json({ amount, currency: "INR", intent });
    } catch (error) {
      return res.status(400).json({ message: error.message || "Could not start payment." });
    } finally {
      conn.release();
    }
  });

  /** Customer checkout: tenant resolved from restaurant (no x-tenant-id header required). */
  router.post("/customer", auth(), rbac("CUSTOMER"), async (req, res) => {
    const schema = z.object({
      restaurantId: z.coerce.number().int().positive(),
      orderType: z.enum(["DELIVERY", "TAKEAWAY"]),
      items: customerOrderItemsSchema,
      deliveryAddress: z.string().min(5).max(500).optional(),
      deliveryContactPhone: z.string().min(10).max(20).optional(),
      deliveryLatitude: z.coerce.number().min(-90).max(90).optional(),
      deliveryLongitude: z.coerce.number().min(-180).max(180).optional(),
      customerLat: z.coerce.number().min(-90).max(90).optional(),
      customerLng: z.coerce.number().min(-180).max(180).optional(),
      paymentMethod: z.enum(["COD", "UPI", "CARD"]).default("COD"),
      gatewayOrderId: z.string().max(120).optional(),
      gatewayPaymentId: z.string().max(120).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const {
      restaurantId,
      orderType,
      items,
      deliveryAddress,
      deliveryLatitude,
      deliveryLongitude,
      paymentMethod,
      gatewayOrderId,
      gatewayPaymentId,
    } = parsed.data;

    let restaurant;
    try {
      [[restaurant]] = await pool.execute(
        `SELECT id, tenant_id, name, is_online, latitude, longitude
         FROM restaurants WHERE id = ? AND approval_status = 'APPROVED' AND is_active = 1 LIMIT 1`,
        [restaurantId]
      );
    } catch (error) {
      if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
      [[restaurant]] = await pool.execute(
        `SELECT id, tenant_id, name, is_online
         FROM restaurants WHERE id = ? AND approval_status = 'APPROVED' AND is_active = 1 LIMIT 1`,
        [restaurantId]
      );
    }
    if (!restaurant) return res.status(404).json({ message: "Restaurant not found." });
    if (restaurant.is_online === 0) {
      return res.status(403).json({
        message: "This restaurant is offline and is not accepting orders right now.",
      });
    }

    const coords = await resolveCustomerOrderCoords(pool, req.user.sub, {
      customerLat: parsed.data.customerLat,
      customerLng: parsed.data.customerLng,
      deliveryLatitude,
      deliveryLongitude,
    });
    const radiusCheck = evaluateCustomerRestaurantRadius(restaurant, coords.customerLat, coords.customerLng);
    if (!radiusCheck.allowed) return respondCustomerRadiusBlocked(res, radiusCheck);

    const conn = await pool.getConnection();
    let tenantId;
    try {
      const resolved = await resolveRestaurantTenantId(conn, restaurantId, { customerUserId: req.user.sub });
      tenantId = resolved.tenantId;
    } finally {
      conn.release();
    }
    if (!tenantId) {
      return res.status(400).json({
        message: "This restaurant is not fully set up for orders yet. Ask the owner to complete setup.",
      });
    }

    if (orderType === "DELIVERY") {
      if (!deliveryAddress?.trim()) {
        return res.status(400).json({ message: "Delivery address is required." });
      }
    }

    let deliveryContactPhone = null;
    if (orderType === "DELIVERY") {
      deliveryContactPhone = await resolveDeliveryContactPhone(pool, req.user.sub, parsed.data.deliveryContactPhone);
      if (!deliveryContactPhone) {
        return res.status(400).json({
          message:
            "A valid mobile number is required for delivery. Add it when saving your delivery address.",
        });
      }
    }

    if (orderType === "TAKEAWAY" && String(paymentMethod).toUpperCase() === "COD") {
      return res.status(400).json({
        message: "Cash on delivery is not available for takeaway. Use UPI or card.",
      });
    }

    const orderConn = await pool.getConnection();
    try {
      await orderConn.beginTransaction();
      const today = todayIsoLocal();
      const slotTime = nowSlotTimeLocal();
      let created;
      try {
        if (orderType === "DELIVERY") {
          [created] = await orderConn.execute(
            `INSERT INTO orders (tenant_id, restaurant_id, customer_user_id, table_id, order_type, status,
             scheduled_delivery_date, scheduled_delivery_time)
             VALUES (?, ?, ?, NULL, ?, 'PLACED', ?, ?)`,
            [tenantId, restaurantId, req.user.sub, orderType, today, slotTime]
          );
        } else {
          [created] = await orderConn.execute(
            "INSERT INTO orders (tenant_id, restaurant_id, customer_user_id, table_id, order_type, status) VALUES (?, ?, ?, NULL, ?, 'PLACED')",
            [tenantId, restaurantId, req.user.sub, orderType]
          );
        }
      } catch (error) {
        if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
        [created] = await orderConn.execute(
          "INSERT INTO orders (tenant_id, restaurant_id, customer_user_id, order_type, status) VALUES (?, ?, ?, ?, 'PLACED')",
          [tenantId, restaurantId, req.user.sub, orderType]
        );
      }
      const orderId = created.insertId;

      const resolvedLines = await computeCustomerCartTotal(orderConn, restaurantId, items);
      for (const line of resolvedLines.lines) {
        try {
          await orderConn.execute(
            `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, customization_json)
             VALUES (?, ?, ?, ?, ?)`,
            [orderId, line.menuItemId, line.quantity, line.unitPrice, line.customizationJson]
          );
        } catch (error) {
          if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
          await orderConn.execute(
            "INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price) VALUES (?, ?, ?, ?)",
            [orderId, line.menuItemId, line.quantity, line.unitPrice]
          );
        }
      }

      const deliveryLat =
        deliveryLatitude != null && Number.isFinite(Number(deliveryLatitude)) ? Number(deliveryLatitude) : null;
      const deliveryLng =
        deliveryLongitude != null && Number.isFinite(Number(deliveryLongitude)) ? Number(deliveryLongitude) : null;

      if (orderType === "DELIVERY" && deliveryAddress?.trim()) {
        try {
          await orderConn.execute(
            `UPDATE orders SET delivery_address = ?, delivery_latitude = ?, delivery_longitude = ?,
             customer_contact_phone = ?
             WHERE id = ?`,
            [deliveryAddress.trim(), deliveryLat, deliveryLng, deliveryContactPhone, orderId]
          );
        } catch (error) {
          if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
          try {
            await orderConn.execute(
              `UPDATE orders SET delivery_address = ?, delivery_latitude = ?, delivery_longitude = ?
               WHERE id = ?`,
              [deliveryAddress.trim(), deliveryLat, deliveryLng, orderId]
            );
            await orderConn.execute(
              "UPDATE orders SET customer_contact_phone = ? WHERE id = ?",
              [deliveryContactPhone, orderId]
            );
          } catch (inner) {
            if (inner?.code !== "ER_BAD_FIELD_ERROR") throw inner;
          }
        }
        try {
          await orderConn.execute(
            "UPDATE users SET home_address = ?, home_latitude = ?, home_longitude = ? WHERE id = ?",
            [deliveryAddress.trim(), deliveryLat, deliveryLng, req.user.sub]
          );
        } catch (error) {
          if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
        }
      }

      if (orderType === "DELIVERY") {
        await assignDeliveryForOrder(orderConn, tenantId, orderId, req.user.sub, restaurantId, io);
        try {
          await orderConn.execute(
            "UPDATE subscription_subscribers SET address = ? WHERE user_id = ? AND restaurant_id = ?",
            [deliveryAddress.trim(), req.user.sub, restaurantId]
          );
        } catch {
          /* optional */
        }
      }

      const [[sumRow]] = await orderConn.execute(
        "SELECT COALESCE(SUM(quantity * unit_price), 0) AS total FROM order_items WHERE order_id = ?",
        [orderId]
      );
      const orderTotal = roundMoney(Number(sumRow?.total || 0));
      const mapped = mapPaymentMethod(paymentMethod);
      const isCod = String(paymentMethod).toUpperCase() === "COD";
      let paymentStatus = "PENDING";

      if (isCod) {
        paymentStatus = "PENDING";
      } else if (gatewayPaymentId || !razorpayConfigured()) {
        paymentStatus = "PAID";
      } else {
        await orderConn.rollback();
        return res.status(400).json({
          message: "Online payment was not completed. Please pay with UPI or card before placing the order.",
        });
      }

      const [paymentResult] = await orderConn.execute(
        "INSERT INTO payments (tenant_id, order_id, payment_method, payment_provider, amount, payment_status) VALUES (?, ?, ?, ?, ?, ?)",
        [
          tenantId,
          orderId,
          mapped.paymentMethod,
          gatewayPaymentId ? mapped.paymentProvider : mapped.paymentProvider,
          orderTotal,
          paymentStatus,
        ]
      );

      await orderConn.commit();
      const itemsByOrder = await fetchOrderItems([orderId]);
      const placedItems = itemsByOrder[orderId] || [];
      const ownerAlert = await buildOwnerOrderAlertPayload(orderId, tenantId, restaurantId);
      if (ownerAlert?.requiresOwnerAction) {
        io.to(`tenant:${tenantId}`).emit("order:owner-alert", ownerAlert);
      }
      io.to(`tenant:${tenantId}`).emit("order:created", {
        orderId,
        status: "PLACED",
        restaurantId,
        orderType,
        requiresOwnerAction: Boolean(ownerAlert?.requiresOwnerAction),
      });
      io.to(`tenant:${tenantId}`).emit("order:items-added", { orderId, restaurantId, orderType });
      io.to(`user:${req.user.sub}`).emit("order:created", { orderId, status: "PLACED", restaurantId, orderType });
      return res.status(201).json({
        id: orderId,
        message: "Order placed successfully",
        restaurantName: restaurant.name,
        orderType,
        status: "PLACED",
        created_at: new Date().toISOString(),
        deliveryAddress: deliveryAddress || null,
        items: placedItems,
        line_total: orderTotal,
        can_cancel: true,
        cancel_deadline_at: null,
        accepted_at: null,
        payment: {
          id: paymentResult.insertId,
          method: paymentMethod,
          status: paymentStatus,
          amount: orderTotal,
          gatewayOrderId: gatewayOrderId || null,
          gatewayPaymentId: gatewayPaymentId || null,
        },
      });
    } catch (error) {
      await orderConn.rollback();
      return respondCustomerOrderError(res, error);
    } finally {
      orderConn.release();
    }
  });

  router.post("/", auth(), tenantScope, async (req, res) => {
    const schema = z.object({
      restaurantId: z.number().int(),
      orderType: z.enum(["DELIVERY", "DINE_IN", "TAKEAWAY"]),
      items: z.array(z.object({ menuItemId: z.number().int(), quantity: z.number().int().positive() })).min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    if (req.user?.role === "CUSTOMER" && parsed.data.orderType === "DELIVERY") {
      const [[sub]] = await pool.execute(
        `SELECT id FROM subscription_subscribers
         WHERE user_id = ? AND restaurant_id = ? AND status = 'ACTIVE' LIMIT 1`,
        [req.user.sub, parsed.data.restaurantId]
      );
      if (!sub) {
        return res.status(403).json({
          message: "An active subscription is required to place delivery orders for this restaurant.",
        });
      }
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      let created;
      try {
        [created] = await conn.execute(
          "INSERT INTO orders (tenant_id, restaurant_id, customer_user_id, table_id, order_type, status) VALUES (?, ?, ?, NULL, ?, 'PLACED')",
          [req.tenantId, parsed.data.restaurantId, req.user.sub, parsed.data.orderType]
        );
      } catch (error) {
        if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
        [created] = await conn.execute(
          "INSERT INTO orders (tenant_id, restaurant_id, customer_user_id, order_type, status) VALUES (?, ?, ?, ?, 'PLACED')",
          [req.tenantId, parsed.data.restaurantId, req.user.sub, parsed.data.orderType]
        );
      }
      const orderId = created.insertId;

      for (const item of parsed.data.items) {
        await conn.execute(
          "INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price) SELECT ?, id, ?, price FROM menu_items WHERE id = ?",
          [orderId, item.quantity, item.menuItemId]
        );
      }

      if (parsed.data.orderType === "DELIVERY") {
        await assignDeliveryForOrder(
          conn,
          req.tenantId,
          orderId,
          req.user.sub,
          parsed.data.restaurantId,
          io
        );
      }

      await conn.commit();
      io.to(`tenant:${req.tenantId}`).emit("order:created", { orderId, status: "PLACED" });
      return res.status(201).json({ id: orderId, message: "Order placed" });
    } catch (error) {
      await conn.rollback();
      return res.status(500).json({ message: "Order transaction failed", details: error.message });
    } finally {
      conn.release();
    }
  });

  router.patch("/:orderId/status", auth(), rbac("OWNER", "MANAGER", "ADMIN"), async (req, res) => {
    const schema = z.object({ status: z.enum(ORDER_STATES) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
    const orderId = Number(req.params.orderId);

    const [[order]] = await pool.execute(
      `SELECT o.id, o.status, o.order_type, o.customer_user_id, o.tenant_id, o.restaurant_id,
              d.status AS delivery_status, r.owner_user_id,
              p.id AS delivery_partner_profile_id
       FROM orders o
       INNER JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN deliveries d ON d.order_id = o.id
       LEFT JOIN delivery_partners dp ON dp.id = d.delivery_partner_id
       LEFT JOIN restaurant_delivery_partner_profiles p
         ON p.delivery_partner_id = dp.id AND p.restaurant_id = o.restaurant_id AND p.tenant_id = o.tenant_id
       WHERE o.id = ?
       LIMIT 1`,
      [orderId]
    );
    if (!order) return res.status(404).json({ message: "Order not found" });

    const headerTenant = req.headers["x-tenant-id"] || req.user?.tenantId || null;
    const effectiveTenant = headerTenant ? Number(headerTenant) : null;

    if (req.user.role === "OWNER") {
      if (Number(order.owner_user_id) !== Number(req.user.sub)) {
        return res.status(403).json({ message: "You can only update orders for your restaurants." });
      }
    } else if (!effectiveTenant || Number(order.tenant_id) !== effectiveTenant) {
      return res.status(404).json({ message: "Order not found" });
    }

    const tenantId = Number(order.tenant_id);
    const hasDeliveryPartner = Boolean(order.delivery_partner_profile_id);

    const orderType = String(order.order_type || "").toUpperCase();
    if (orderType === "DELIVERY" && parsed.data.status === "DELIVERED") {
      return res.status(400).json({
        message: "Delivery orders are completed by the assigned delivery partner at the customer location.",
      });
    }

    const allowed = getOwnerNextActions(order.status, order.order_type, { hasDeliveryPartner }).map(
      (a) => a.status
    );
    if (!allowed.includes(parsed.data.status)) {
      return res.status(400).json({
        message: `Cannot move order from ${order.status} to ${parsed.data.status}.`,
      });
    }

    await ensureAcceptedAtColumn();
    if (parsed.data.status === "ACCEPTED") {
      await pool.execute(
        "UPDATE orders SET status = ?, accepted_at = COALESCE(accepted_at, NOW()) WHERE id = ?",
        [parsed.data.status, orderId]
      );
    } else {
      await pool.execute("UPDATE orders SET status = ? WHERE id = ?", [parsed.data.status, orderId]);
    }

    const [[updated]] = await pool.execute(
      `SELECT o.id, o.status, o.created_at, o.accepted_at, o.order_type, d.status AS delivery_status,
              p.id AS delivery_partner_profile_id
       FROM orders o
       LEFT JOIN deliveries d ON d.order_id = o.id
       LEFT JOIN delivery_partners dp ON dp.id = d.delivery_partner_id
       LEFT JOIN restaurant_delivery_partner_profiles p
         ON p.delivery_partner_id = dp.id AND p.restaurant_id = o.restaurant_id AND p.tenant_id = o.tenant_id
       WHERE o.id = ?
       LIMIT 1`,
      [orderId]
    );

    const cancelRow = { ...order, ...updated, status: parsed.data.status };
    const payload = {
      orderId,
      status: parsed.data.status,
      accepted_at: updated?.accepted_at || null,
      ...buildStatusPayload(parsed.data.status, updated?.delivery_status || order.delivery_status),
      owner_next_actions: getOwnerNextActions(parsed.data.status, order.order_type, {
        hasDeliveryPartner: Boolean(updated?.delivery_partner_profile_id),
      }),
      can_cancel: canCustomerCancelOrder(cancelRow),
      cancel_deadline_at: customerCancelDeadlineIso(cancelRow),
    };
    io.to(`tenant:${tenantId}`).emit("order:status-updated", payload);
    io.to(`user:${order.customer_user_id}`).emit("order:status-updated", payload);

    return res.json({ message: "Order status updated", ...payload });
  });

  router.get("/restaurant/pending-owner-alerts", auth(), rbac("OWNER", "MANAGER", "ADMIN"), async (req, res) => {
    const restaurantId = Number(req.query.restaurantId || 0);
    if (!restaurantId) return res.status(400).json({ message: "restaurantId is required" });

    const [[restaurant]] = await pool.execute(
      "SELECT id, tenant_id, owner_user_id FROM restaurants WHERE id = ? LIMIT 1",
      [restaurantId]
    );
    if (!restaurant) return res.status(404).json({ message: "Restaurant not found." });

    if (req.user.role === "OWNER" && Number(restaurant.owner_user_id) !== Number(req.user.sub)) {
      return res.status(403).json({ message: "Not your restaurant." });
    }

    const [rows] = await pool.execute(
      `SELECT o.id
       FROM orders o
       WHERE o.restaurant_id = ?
         AND o.status = 'PLACED'
         AND o.order_type IN ('DELIVERY', 'TAKEAWAY')
         AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id LIMIT 1)
       ORDER BY o.id ASC`,
      [restaurantId]
    );

    const alerts = [];
    for (const row of rows) {
      const payload = await buildOwnerOrderAlertPayload(row.id, restaurant.tenant_id, restaurantId);
      if (payload?.requiresOwnerAction) alerts.push(payload);
    }
    return res.json({ items: alerts, acceptDeadlineMinutes: OWNER_ACCEPT_DEADLINE_MINUTES });
  });

  router.get("/restaurant/counts", auth(), rbac("OWNER", "MANAGER", "ADMIN"), async (req, res) => {
    const restaurantId = Number(req.query.restaurantId || 0);
    if (!restaurantId) return res.status(400).json({ message: "restaurantId is required" });

    const [[restaurant]] = await pool.execute(
      "SELECT id, tenant_id, owner_user_id FROM restaurants WHERE id = ? LIMIT 1",
      [restaurantId]
    );
    if (!restaurant) return res.status(404).json({ message: "Restaurant not found." });

    if (req.user.role === "OWNER" && Number(restaurant.owner_user_id) !== Number(req.user.sub)) {
      return res.status(403).json({ message: "Not your restaurant." });
    }

    const dateFilter = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ""))
      ? String(req.query.date)
      : null;
    const params = [restaurantId];
    let dateSql = "";
    if (dateFilter) {
      dateSql = " AND COALESCE(o.scheduled_delivery_date, DATE(o.created_at)) = ?";
      params.push(dateFilter);
    }

    const [rows] = await pool.execute(
      `SELECT o.order_type, o.status, COUNT(*) AS cnt
       FROM orders o
       WHERE o.restaurant_id = ?${dateSql}
         AND o.order_type IN ('DELIVERY', 'TAKEAWAY')
         AND o.status NOT IN ('DELIVERED', 'CANCELLED', 'REJECTED')
       GROUP BY o.order_type, o.status`,
      params
    );

    function tallyForType(orderType) {
      let newOrders = 0;
      let inProgress = 0;
      const typeKey = String(orderType).toUpperCase();
      for (const row of rows) {
        if (String(row.order_type || "").toUpperCase() !== typeKey) continue;
        const n = Number(row.cnt || 0);
        const s = String(row.status || "").toUpperCase();
        if (s === "PLACED") newOrders += n;
        else if (["ACCEPTED", "PREPARING", "READY", "OUT_FOR_DELIVERY"].includes(s)) inProgress += n;
      }
      const total = newOrders + inProgress;
      return { newOrders, inProgress, pending: newOrders, total };
    }

    const delivery = tallyForType("DELIVERY");
    const takeaway = tallyForType("TAKEAWAY");

    return res.json({
      delivery,
      takeaway,
      newOrders: delivery.newOrders + takeaway.newOrders,
      inProgress: delivery.inProgress + takeaway.inProgress,
      pending: delivery.pending + takeaway.pending,
      total: delivery.total + takeaway.total,
    });
  });

  router.get("/restaurant", auth(), rbac("OWNER", "MANAGER", "ADMIN"), async (req, res) => {
    await ensureAcceptedAtColumn();
    await ensureCancelledByColumn();
    const schema = z.object({
      restaurantId: z.coerce.number().int().positive(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      orderType: z.enum(["DELIVERY", "DINE_IN", "TAKEAWAY", "ALL"]).optional(),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const [[restaurant]] = await pool.execute(
      "SELECT id, tenant_id, owner_user_id FROM restaurants WHERE id = ? LIMIT 1",
      [parsed.data.restaurantId]
    );
    if (!restaurant) return res.status(404).json({ message: "Restaurant not found." });

    const headerTenant = req.headers["x-tenant-id"] || req.user?.tenantId || null;
    const effectiveTenant = headerTenant ? Number(headerTenant) : null;

    if (req.user.role === "OWNER") {
      if (Number(restaurant.owner_user_id) !== Number(req.user.sub)) {
        return res.status(403).json({ message: "You can only view orders for your restaurants." });
      }
    } else if (!effectiveTenant) {
      return res.status(400).json({ message: "Missing tenant context" });
    }

    const params = [parsed.data.restaurantId];
    let sql = `
      SELECT o.id, o.restaurant_id, o.customer_user_id, o.order_type, o.status, o.created_at, o.accepted_at,
             o.cancelled_by, o.cancellation_reason, o.scheduled_delivery_date, o.scheduled_delivery_time,
             u.full_name AS customer_name, u.email AS customer_email,
             COALESCE(o.customer_contact_phone, sub.phone) AS customer_phone,
             d.id AS delivery_id, d.status AS delivery_status, d.delivery_partner_id,
             p.id AS delivery_partner_profile_id,
             pu.full_name AS delivery_partner_name,
             r.name AS restaurant_name,
             (SELECT p.payment_status FROM payments p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) AS payment_status
      FROM orders o
      INNER JOIN users u ON u.id = o.customer_user_id
      INNER JOIN restaurants r ON r.id = o.restaurant_id
      LEFT JOIN deliveries d ON d.order_id = o.id
      LEFT JOIN delivery_partners dp ON dp.id = d.delivery_partner_id
      LEFT JOIN restaurant_delivery_partner_profiles p
        ON p.delivery_partner_id = dp.id AND p.restaurant_id = o.restaurant_id AND p.tenant_id = o.tenant_id
      LEFT JOIN users pu ON pu.id = p.user_id
      LEFT JOIN subscription_subscribers sub ON sub.user_id = o.customer_user_id AND sub.restaurant_id = o.restaurant_id
      WHERE o.restaurant_id = ?
    `;
    if (req.user.role !== "OWNER") {
      sql += " AND o.tenant_id = ?";
      params.push(effectiveTenant);
    }
    if (parsed.data.date) {
      sql += " AND COALESCE(o.scheduled_delivery_date, DATE(o.created_at)) = ?";
      params.push(parsed.data.date);
    }
    if (parsed.data.orderType && parsed.data.orderType !== "ALL") {
      sql += " AND o.order_type = ?";
      params.push(parsed.data.orderType);
    }
    sql += ` ORDER BY COALESCE(o.scheduled_delivery_date, DATE(o.created_at)) ASC,
              COALESCE(o.scheduled_delivery_time, '23:59') ASC, o.id ASC`;

    const [rows] = await pool.execute(sql, params);
    const itemsByOrder = await fetchOrderItems(rows.map((r) => r.id));
    return res.json(rows.map((row) => enrichOrderRow(row, itemsByOrder)));
  });

  router.get("/my", auth(), async (req, res) => {
    await ensureAcceptedAtColumn();
    await ensureCancelledByColumn();
    const dateFilter = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ""))
      ? String(req.query.date)
      : null;
    const daysAhead = Math.min(60, Math.max(0, Number(req.query.days) || 0));
    const daysBack = Math.min(365, Math.max(0, Number(req.query.daysBack) || 0));
    const params = [req.user.sub];
    let sql = `
      SELECT o.id, o.restaurant_id, o.order_type, o.status, o.created_at, o.accepted_at, o.cancelled_by,
             o.cancellation_reason,
             o.scheduled_delivery_date, o.scheduled_delivery_time,
             r.name AS restaurant_name,
             d.status AS delivery_status, d.id AS delivery_id,
             p.id AS delivery_partner_profile_id
      FROM orders o
      INNER JOIN restaurants r ON r.id = o.restaurant_id
      LEFT JOIN deliveries d ON d.order_id = o.id
      LEFT JOIN delivery_partners dp ON dp.id = d.delivery_partner_id
      LEFT JOIN restaurant_delivery_partner_profiles p
        ON p.delivery_partner_id = dp.id AND p.restaurant_id = o.restaurant_id AND p.tenant_id = o.tenant_id
      WHERE o.customer_user_id = ?
    `;
    const today = new Date();
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    if (dateFilter) {
      sql += " AND COALESCE(o.scheduled_delivery_date, DATE(o.created_at)) = ?";
      params.push(dateFilter);
    } else if (daysBack > 0) {
      const start = new Date(today);
      start.setDate(start.getDate() - daysBack);
      const fromBack = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
      sql += " AND COALESCE(o.scheduled_delivery_date, DATE(o.created_at)) >= ?";
      params.push(fromBack);
      if (daysAhead > 0) {
        const end = new Date(today);
        end.setDate(end.getDate() + daysAhead);
        const to = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
        sql += " AND COALESCE(o.scheduled_delivery_date, DATE(o.created_at)) <= ?";
        params.push(to);
      }
    } else if (daysAhead > 0) {
      const end = new Date(today);
      end.setDate(end.getDate() + daysAhead);
      const to = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
      sql += " AND COALESCE(o.scheduled_delivery_date, DATE(o.created_at)) >= ?";
      sql += " AND COALESCE(o.scheduled_delivery_date, DATE(o.created_at)) <= ?";
      params.push(todayIso, to);
    }
    const orderDir = daysBack > 0 && daysAhead <= 0 ? "DESC" : "ASC";
    sql += ` ORDER BY COALESCE(o.scheduled_delivery_date, DATE(o.created_at)) ${orderDir},
              COALESCE(o.scheduled_delivery_time, '12:00') ${orderDir}, o.id ${orderDir}`;

    const [rows] = await pool.execute(sql, params);
    const itemsByOrder = await fetchOrderItems(rows.map((r) => r.id));
    return res.json(rows.map((row) => enrichOrderRow(row, itemsByOrder)));
  });

  /** Auto-decline PLACED order when accept deadline has passed (owner UI + backup for cron). */
  router.post("/:orderId/timeout-cancel", auth(), rbac("OWNER", "MANAGER", "ADMIN"), async (req, res) => {
    const orderId = Number(req.params.orderId);
    if (!orderId) return res.status(400).json({ message: "Valid order id is required." });

    const [[order]] = await pool.execute(
      `SELECT o.id, o.status, o.customer_user_id, o.tenant_id, o.restaurant_id, o.created_at,
              r.owner_user_id
       FROM orders o
       INNER JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.id = ?
       LIMIT 1`,
      [orderId]
    );
    if (!order) return res.status(404).json({ message: "Order not found." });

    if (req.user.role === "OWNER" && Number(order.owner_user_id) !== Number(req.user.sub)) {
      return res.status(403).json({ message: "You can only manage orders for your restaurants." });
    }

    const status = String(order.status || "").toUpperCase();
    if (status === "CANCELLED") {
      return res.json({ ok: true, orderId, status: "CANCELLED", message: AUTO_CANCEL_REASON });
    }
    if (status !== "PLACED") {
      return res.status(400).json({ message: "Only pending orders can be declined by timeout." });
    }

    const deadlineMs = new Date(ownerAcceptDeadlineIso(order.created_at)).getTime();
    if (Number.isFinite(deadlineMs) && Date.now() < deadlineMs) {
      return res.status(400).json({ message: "Accept window is still open." });
    }

    const did = await autoCancelPlacedOrder(order, io);
    if (!did) {
      return res.status(409).json({ message: "Order could not be declined (it may have already been updated)." });
    }
    return res.json({
      ok: true,
      orderId,
      status: "CANCELLED",
      cancellation_reason: AUTO_CANCEL_REASON,
      message: AUTO_CANCEL_REASON,
    });
  });

  router.post("/:orderId/cancel-by-owner", auth(), rbac("OWNER", "MANAGER", "ADMIN"), async (req, res) => {
    const bodySchema = z.object({
      reason: z.string().trim().max(500).optional(),
    });
    const bodyParsed = bodySchema.safeParse(req.body ?? {});
    const rawReason = bodyParsed.success ? String(bodyParsed.data.reason || "").trim() : "";
    if (rawReason.length > 0 && rawReason.length < 3) {
      return res.status(400).json({
        message: "Please provide a short reason (at least 3 characters).",
      });
    }
    const declineReason = rawReason || null;

    const orderId = Number(req.params.orderId);
    if (!orderId) return res.status(400).json({ message: "Valid order id is required." });

    const [[order]] = await pool.execute(
      `SELECT o.id, o.status, o.customer_user_id, o.tenant_id, o.restaurant_id,
              d.status AS delivery_status, r.owner_user_id
       FROM orders o
       INNER JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN deliveries d ON d.order_id = o.id
       WHERE o.id = ?
       LIMIT 1`,
      [orderId]
    );
    if (!order) return res.status(404).json({ message: "Order not found." });

    const status = String(order.status || "").toUpperCase();
    if (status === "DELIVERED") {
      return res.status(400).json({ message: "Delivered orders cannot be cancelled." });
    }
    if (status === "CANCELLED") {
      return res.status(400).json({ message: "Order is already cancelled." });
    }

    const headerTenant = req.headers["x-tenant-id"] || req.user?.tenantId || null;
    const effectiveTenant = headerTenant ? Number(headerTenant) : null;

    if (req.user.role === "OWNER") {
      if (Number(order.owner_user_id) !== Number(req.user.sub)) {
        return res.status(403).json({ message: "You can only cancel orders for your restaurants." });
      }
    } else if (!effectiveTenant || Number(order.tenant_id) !== effectiveTenant) {
      return res.status(404).json({ message: "Order not found." });
    }

    await ensureCancelledByColumn();
    await ensureCancellationReasonColumn();
    await pool.execute(
      "UPDATE orders SET status = 'CANCELLED', cancelled_by = 'OWNER', cancellation_reason = ? WHERE id = ?",
      [declineReason, orderId]
    );
    try {
      await pool.execute(
        "UPDATE deliveries SET status = 'REJECTED' WHERE order_id = ? AND status NOT IN ('DELIVERED')",
        [orderId]
      );
    } catch {
      /* optional */
    }

    const payload = {
      orderId,
      status: "CANCELLED",
      cancelled_by: "OWNER",
      cancellation_reason: declineReason,
      ...buildStatusPayload("CANCELLED", "REJECTED", "OWNER", declineReason),
      can_cancel: false,
      cancel_deadline_at: null,
    };
    const tenantId = Number(order.tenant_id);
    io.to(`tenant:${tenantId}`).emit("order:status-updated", payload);
    if (order.customer_user_id) {
      io.to(`user:${order.customer_user_id}`).emit("order:status-updated", payload);
    }

    return res.json({ message: "Order declined.", ...payload });
  });

  router.post("/:orderId/cancel", auth(), rbac("CUSTOMER"), async (req, res) => {
    const orderId = Number(req.params.orderId);
    if (!orderId) return res.status(400).json({ message: "Valid order id is required." });

    const [[order]] = await pool.execute(
      `SELECT o.id, o.status, o.created_at, o.accepted_at, o.customer_user_id, o.tenant_id, o.restaurant_id,
              d.status AS delivery_status
       FROM orders o
       LEFT JOIN deliveries d ON d.order_id = o.id
       WHERE o.id = ? AND o.customer_user_id = ?
       LIMIT 1`,
      [orderId, req.user.sub]
    );
    if (!order) return res.status(404).json({ message: "Order not found." });

    if (!canCustomerCancelOrder(order)) {
      const status = String(order.status || "").toUpperCase();
      const message =
        status === "PLACED"
          ? "This order can no longer be cancelled."
          : "This order can no longer be cancelled. After the restaurant accepts, you have 8 minutes to cancel.";
      return res.status(400).json({ message });
    }

    await ensureCancelledByColumn();
    await pool.execute(
      "UPDATE orders SET status = 'CANCELLED', cancelled_by = 'CUSTOMER' WHERE id = ?",
      [orderId]
    );
    try {
      await pool.execute(
        "UPDATE deliveries SET status = 'REJECTED' WHERE order_id = ? AND status NOT IN ('DELIVERED')",
        [orderId]
      );
    } catch {
      /* optional */
    }

    const payload = {
      orderId,
      status: "CANCELLED",
      cancelled_by: "CUSTOMER",
      ...buildStatusPayload("CANCELLED", "REJECTED", "CUSTOMER"),
      can_cancel: false,
      cancel_deadline_at: null,
    };
    io.to(`tenant:${order.tenant_id}`).emit("order:status-updated", payload);
    io.to(`user:${req.user.sub}`).emit("order:status-updated", payload);

    return res.json({ message: "Order cancelled.", ...payload });
  });

  router.get("/:orderId/print-payload", auth(), rbac("OWNER", "MANAGER", "ADMIN"), async (req, res) => {
    const orderId = Number(req.params.orderId);
    const restaurantId = Number(req.query.restaurantId || 0);
    if (!orderId) return res.status(400).json({ message: "orderId is required" });

    let row;
    try {
      if (restaurantId) {
        const ctx = await resolveRestaurantTenantContext(req, restaurantId);
        if (ctx.error) return res.status(ctx.error.status).json({ message: ctx.error.message });
        const [[found]] = await pool.execute(
          `SELECT o.id, o.status, o.order_type, o.created_at, o.table_id, rt.table_number,
                  u.full_name AS customer_name, u.phone AS customer_phone, u.role AS customer_role,
                  (SELECT pay.payment_status FROM payments pay WHERE pay.order_id = o.id ORDER BY pay.id DESC LIMIT 1) AS payment_status,
                  (SELECT inv.invoice_number FROM invoices inv WHERE inv.order_id = o.id ORDER BY inv.id DESC LIMIT 1) AS invoice_number
           FROM orders o
           LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
           LEFT JOIN users u ON u.id = o.customer_user_id
           WHERE o.id = ? AND o.restaurant_id = ? AND o.tenant_id = ?
           LIMIT 1`,
          [orderId, restaurantId, ctx.tenantId]
        );
        row = found;
      } else {
        const [[found]] = await pool.execute(
          `SELECT o.id, o.status, o.order_type, o.created_at, o.table_id, o.restaurant_id, o.tenant_id,
                  rt.table_number, u.full_name AS customer_name, u.phone AS customer_phone, u.role AS customer_role,
                  (SELECT pay.payment_status FROM payments pay WHERE pay.order_id = o.id ORDER BY pay.id DESC LIMIT 1) AS payment_status,
                  (SELECT inv.invoice_number FROM invoices inv WHERE inv.order_id = o.id ORDER BY inv.id DESC LIMIT 1) AS invoice_number
           FROM orders o
           LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
           LEFT JOIN users u ON u.id = o.customer_user_id
           WHERE o.id = ?
           LIMIT 1`,
          [orderId]
        );
        row = found;
      }
    } catch (error) {
      if (error?.code === "ER_BAD_FIELD_ERROR") return tableOrderSchemaRequiredResponse(res);
      throw error;
    }

    if (!row) return res.status(404).json({ message: "Order not found" });

    const itemsByOrder = await fetchOrderItems([orderId]);
    const enriched = enrichOrderRow(row, itemsByOrder);
    const orderType = String(row.order_type || "").toUpperCase();
    const isPrepaid = String(row.payment_status || "").toUpperCase() === "PAID";
    const customerRole = String(row.customer_role || "").toUpperCase();
    let orderSource = "COUNTER";
    if (orderType === "DELIVERY") orderSource = "ONLINE";
    else if (orderType === "TAKEAWAY" && (isPrepaid || customerRole === "CUSTOMER")) orderSource = "ONLINE";

    const items = (enriched.items || []).map((it) => ({
      menu_item_id: it.menu_item_id,
      name: it.menu_item_name,
      menu_item_name: it.menu_item_name,
      quantity: it.quantity,
      unit_price: it.unit_price,
      line_total: Number(it.quantity) * Number(it.unit_price),
      customization: it.customization || null,
    }));

    return res.json({
      order_id: row.id,
      order_type: orderType,
      order_source: orderSource,
      status: row.status,
      table_number: row.table_number || null,
      customer_name: row.customer_name || null,
      customer_phone: row.customer_phone || null,
      token_number: String(Number(row.id) % 10000).padStart(4, "0"),
      items,
      subtotal: enriched.line_total || 0,
      created_at: row.created_at,
      is_prepaid: isPrepaid,
      payment_status: row.payment_status || null,
      invoice_number: row.invoice_number || null,
    });
  });

  router.get("/:orderId", auth(), rbac("CUSTOMER"), async (req, res) => {
    const orderId = Number(req.params.orderId);
    if (!Number.isFinite(orderId) || orderId <= 0) {
      return res.status(400).json({ message: "Valid order id is required." });
    }
    const [[row]] = await pool.execute(
      `SELECT o.id, o.restaurant_id, o.order_type, o.status, o.created_at, o.accepted_at,
              o.cancelled_by, o.cancellation_reason,
              o.scheduled_delivery_date, o.scheduled_delivery_time,
              o.delivery_address, o.delivery_latitude, o.delivery_longitude,
              r.name AS restaurant_name,
              d.status AS delivery_status, d.id AS delivery_id, d.eta_minutes,
              p.id AS delivery_partner_profile_id,
              pu.full_name AS delivery_partner_name,
              (SELECT pay.payment_status FROM payments pay WHERE pay.order_id = o.id ORDER BY pay.id DESC LIMIT 1) AS payment_status
       FROM orders o
       INNER JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN deliveries d ON d.order_id = o.id
       LEFT JOIN delivery_partners dp ON dp.id = d.delivery_partner_id
       LEFT JOIN restaurant_delivery_partner_profiles p
         ON p.delivery_partner_id = dp.id AND p.restaurant_id = o.restaurant_id AND p.tenant_id = o.tenant_id
       LEFT JOIN users pu ON pu.id = p.user_id
       WHERE o.id = ? AND o.customer_user_id = ?
       LIMIT 1`,
      [orderId, req.user.sub]
    );
    if (!row) return res.status(404).json({ message: "Order not found." });
    const itemsByOrder = await fetchOrderItems([orderId]);
    return res.json(enrichOrderRow(row, itemsByOrder));
  });

  return router;
}

module.exports = orderRouter;
