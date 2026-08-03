const express = require("express");
const { z } = require("zod");
const pool = require("../../db/pool");
const auth = require("../../middlewares/auth");
const rbac = require("../../middlewares/rbac");
const tenantScope = require("../../middlewares/tenant");

const router = express.Router();

const querySchema = z.object({
  restaurantId: z.coerce.number().int().positive(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  paymentMethod: z.enum(["COD", "ONLINE", "ALL"]).optional().default("ALL"),
  orderType: z.enum(["DELIVERY", "DINE_IN", "TAKEAWAY", "ALL"]).optional().default("ALL"),
  transactionType: z
    .enum(["ALL", "ORDER", "SUBSCRIPTION", "REFUND", "GROCERY", "EXPENSE"])
    .optional()
    .default("ALL"),
  logLimit: z.coerce.number().int().positive().max(500).optional().default(200),
});

function buildPaymentFilters(parsed, params, dateColumn = "p.created_at") {
  let where = "p.tenant_id = ? AND o.restaurant_id = ?";
  params.push(parsed.restaurantId); // params must start with [tenantId] from caller

  if (parsed.from) {
    where += ` AND DATE(${dateColumn}) >= ?`;
    params.push(parsed.from);
  }
  if (parsed.to) {
    where += ` AND DATE(${dateColumn}) <= ?`;
    params.push(parsed.to);
  }
  if (parsed.paymentMethod !== "ALL") {
    where += " AND p.payment_method = ?";
    params.push(parsed.paymentMethod);
  }
  if (parsed.orderType !== "ALL") {
    where += " AND o.order_type = ?";
    params.push(parsed.orderType);
  }
  return where;
}

async function loadRestaurantRow(req, restaurantId, tenantId) {
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

router.get("/revenue", auth(), tenantScope, rbac("OWNER", "MANAGER", "ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const tenantId = req.tenantId;
  const { restaurantId, logLimit } = parsed.data;
  // MySQL prepared statements reject LIMIT ? (ER_WRONG_ARGUMENTS); use a bounded literal like inventory routes.
  const lim = Math.min(500, Math.max(1, Number(logLimit) || 200));

  const restaurant = await loadRestaurantRow(req, restaurantId, tenantId);
  if (!restaurant) return res.status(404).json({ message: "Restaurant not found" });

  const baseParams = [tenantId];
  const paidWhere = `${buildPaymentFilters(parsed.data, baseParams)} AND p.payment_status IN ('PAID','PARTIALLY_REFUNDED')`;
  const refundParams = [tenantId];
  const refundWhere = `${buildPaymentFilters(parsed.data, refundParams)} AND (
    p.payment_status = 'REFUNDED'
    OR (p.payment_status = 'PARTIALLY_REFUNDED' AND COALESCE(p.refunded_cumulative, 0) > 0)
  )`;

  const [[salesRow]] = await pool.execute(
    `SELECT COALESCE(SUM(p.amount), 0) AS total
     FROM payments p
     INNER JOIN orders o ON o.id = p.order_id AND o.tenant_id = p.tenant_id
     WHERE ${paidWhere}`,
    baseParams
  );

  const [[refundsRow]] = await pool.execute(
    `SELECT COALESCE(SUM(
       CASE
         WHEN p.payment_status = 'REFUNDED' THEN p.amount
         WHEN p.payment_status = 'PARTIALLY_REFUNDED' THEN COALESCE(p.refunded_cumulative, 0)
         ELSE 0
       END
     ), 0) AS total
     FROM payments p
     INNER JOIN orders o ON o.id = p.order_id AND o.tenant_id = p.tenant_id
     WHERE ${refundWhere}`,
    refundParams
  );

  const purchaseParams = [tenantId, restaurantId];
  let purchaseWhere = "e.tenant_id = ? AND e.restaurant_id = ?";
  if (parsed.data.from) {
    purchaseWhere += " AND DATE(e.created_at) >= ?";
    purchaseParams.push(parsed.data.from);
  }
  if (parsed.data.to) {
    purchaseWhere += " AND DATE(e.created_at) <= ?";
    purchaseParams.push(parsed.data.to);
  }

  const [[purchasesRow]] = await pool.execute(
    `SELECT COALESCE(SUM(e.pack_quantity * e.rate), 0) AS total
     FROM inventory_stock_entries e
     WHERE ${purchaseWhere}`,
    purchaseParams
  );

  let expensesTotal = 0;
  let expenseLog = [];
  try {
    const expParams = [tenantId, restaurantId];
    let expWhere = "x.tenant_id = ? AND x.restaurant_id = ?";
    if (parsed.data.from) {
      expWhere += " AND DATE(x.spent_at) >= ?";
      expParams.push(parsed.data.from);
    }
    if (parsed.data.to) {
      expWhere += " AND DATE(x.spent_at) <= ?";
      expParams.push(parsed.data.to);
    }
    const [[expSum]] = await pool.execute(
      `SELECT COALESCE(SUM(x.amount), 0) AS total FROM restaurant_expenses x WHERE ${expWhere}`,
      expParams
    );
    expensesTotal = Number(expSum?.total || 0);

    const [expRows] = await pool.execute(
      `SELECT x.id, x.category, x.amount, x.note, x.spent_at, x.created_at
       FROM restaurant_expenses x
       WHERE ${expWhere}
       ORDER BY x.spent_at DESC, x.id DESC
       LIMIT ${lim}`,
      expParams
    );
    expenseLog = expRows;
  } catch (err) {
    if (err?.code !== "ER_NO_SUCH_TABLE") throw err;
  }

  let subscriptionTotal = 0;
  let subscriptionLog = [];
  try {
    const subParams = [tenantId, restaurantId];
    let subWhere = "sp.tenant_id = ? AND sp.restaurant_id = ? AND sp.payment_status = 'PAID'";
    if (parsed.data.from) {
      subWhere += " AND DATE(sp.created_at) >= ?";
      subParams.push(parsed.data.from);
    }
    if (parsed.data.to) {
      subWhere += " AND DATE(sp.created_at) <= ?";
      subParams.push(parsed.data.to);
    }
    if (parsed.data.paymentMethod !== "ALL") {
      subWhere += " AND sp.payment_method = ?";
      subParams.push(parsed.data.paymentMethod);
    }

    const [[subSum]] = await pool.execute(
      `SELECT COALESCE(SUM(sp.amount), 0) AS total FROM subscription_plan_payments sp WHERE ${subWhere}`,
      subParams
    );
    subscriptionTotal = Number(subSum?.total || 0);

    const [subRows] = await pool.execute(
      `SELECT sp.id, sp.subscriber_id, sp.plan_id, sp.amount, sp.plan_price, sp.collection_type,
              sp.balance_due, sp.payment_method, sp.payment_provider, sp.payment_status, sp.created_at,
              pl.name AS plan_name, u.full_name AS customer_name
       FROM subscription_plan_payments sp
       INNER JOIN subscription_plans pl ON pl.id = sp.plan_id
       INNER JOIN subscription_subscribers ss ON ss.id = sp.subscriber_id
       INNER JOIN users u ON u.id = ss.user_id
       WHERE ${subWhere}
       ORDER BY sp.created_at DESC, sp.id DESC
       LIMIT ${lim}`,
      subParams
    );
    subscriptionLog = subRows;
  } catch (err) {
    if (err?.code !== "ER_NO_SUCH_TABLE") throw err;
  }

  let salesTotal = Number(salesRow?.total || 0);
  let refundsTotal = Number(refundsRow?.total || 0);
  let purchasesTotal = Number(purchasesRow?.total || 0);
  let subTotal = subscriptionTotal;
  let expTotal = expensesTotal;

  const txScope = parsed.data.transactionType;
  if (txScope === "ORDER") {
    subTotal = 0;
    refundsTotal = 0;
    purchasesTotal = 0;
    expTotal = 0;
  } else if (txScope === "SUBSCRIPTION") {
    salesTotal = 0;
    refundsTotal = 0;
    purchasesTotal = 0;
    expTotal = 0;
  } else if (txScope === "REFUND") {
    salesTotal = 0;
    subTotal = 0;
    purchasesTotal = 0;
    expTotal = 0;
  } else if (txScope === "GROCERY") {
    salesTotal = 0;
    subTotal = 0;
    refundsTotal = 0;
    expTotal = 0;
  } else if (txScope === "EXPENSE") {
    salesTotal = 0;
    subTotal = 0;
    refundsTotal = 0;
    purchasesTotal = 0;
  }

  subscriptionTotal = subTotal;
  expensesTotal = expTotal;
  const grossInflow = salesTotal + subscriptionTotal;
  const netSales = grossInflow - refundsTotal;
  const profit = netSales - purchasesTotal - expensesTotal;

  const breakdown = [
    { key: "ORDER", name: "Order payments", value: salesTotal, direction: "IN" },
    { key: "SUBSCRIPTION", name: "Subscription payments", value: subscriptionTotal, direction: "IN" },
    { key: "REFUND", name: "Refunds", value: refundsTotal, direction: "OUT" },
    { key: "GROCERY", name: "Grocery purchases", value: purchasesTotal, direction: "OUT" },
    { key: "EXPENSE", name: "Operating expenses", value: expensesTotal, direction: "OUT" },
  ].filter((row) => row.value > 0.005);

  const salesLogParams = [tenantId];
  const salesLogWhere = `${buildPaymentFilters(parsed.data, salesLogParams)} AND p.payment_status IN ('PAID','PARTIALLY_REFUNDED')`;
  const [salesLog] = await pool.execute(
    `SELECT p.id, p.order_id, p.amount, COALESCE(p.refunded_cumulative, 0) AS refunded_cumulative,
            p.payment_method, p.payment_provider, p.payment_status, p.created_at,
            o.order_type, o.status AS order_status
     FROM payments p
     INNER JOIN orders o ON o.id = p.order_id AND o.tenant_id = p.tenant_id
     WHERE ${salesLogWhere}
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT ${lim}`,
    salesLogParams
  );

  const refundLogParams = [tenantId];
  const refundLogWhere = `${buildPaymentFilters(parsed.data, refundLogParams)} AND (
    p.payment_status = 'REFUNDED'
    OR (p.payment_status = 'PARTIALLY_REFUNDED' AND COALESCE(p.refunded_cumulative, 0) > 0)
  )`;
  const [refundLog] = await pool.execute(
    `SELECT p.id, p.order_id, p.amount, COALESCE(p.refunded_cumulative, 0) AS refunded_cumulative,
            p.payment_method, p.payment_provider, p.payment_status, p.created_at,
            o.order_type, o.status AS order_status,
            (CASE
              WHEN p.payment_status = 'REFUNDED' THEN p.amount
              ELSE COALESCE(p.refunded_cumulative, 0)
            END) AS refund_display_amount
     FROM payments p
     INNER JOIN orders o ON o.id = p.order_id AND o.tenant_id = p.tenant_id
     WHERE ${refundLogWhere}
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT ${lim}`,
    refundLogParams
  );

  const [purchaseLog] = await pool.execute(
    `SELECT e.id, e.inventory_item_id, e.pack_quantity, e.pack_unit, e.rate, (e.pack_quantity * e.rate) AS line_total,
            e.notes, e.created_at, i.name AS item_name
     FROM inventory_stock_entries e
     INNER JOIN inventory_items i ON i.id = e.inventory_item_id
     WHERE ${purchaseWhere}
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT ${lim}`,
    purchaseParams
  );

  const transactions = [];
  for (const row of salesLog) {
    transactions.push({
      id: `order-${row.id}`,
      source: "ORDER",
      direction: "IN",
      amount: Number(row.amount),
      occurred_at: row.created_at,
      reference: `Order #${row.order_id}`,
      method: row.payment_method,
      provider: row.payment_provider || null,
      status: row.payment_status,
      order_type: row.order_type,
      order_status: row.order_status,
      order_id: row.order_id,
    });
  }
  for (const row of refundLog) {
    transactions.push({
      id: `refund-${row.id}`,
      source: "REFUND",
      direction: "OUT",
      amount: Number(row.refund_display_amount ?? row.amount),
      occurred_at: row.created_at,
      reference: `Refund · Order #${row.order_id}`,
      method: row.payment_method,
      provider: row.payment_provider || null,
      status: row.payment_status,
      order_type: row.order_type,
      order_id: row.order_id,
    });
  }
  for (const row of subscriptionLog) {
    transactions.push({
      id: `subscription-${row.id}`,
      source: "SUBSCRIPTION",
      direction: "IN",
      amount: Number(row.amount),
      occurred_at: row.created_at,
      reference: row.plan_name ? `Plan · ${row.plan_name}` : `Subscriber #${row.subscriber_id}`,
      method: row.payment_method,
      provider: row.payment_provider || null,
      status: row.payment_status,
      customer_name: row.customer_name,
      collection_type: row.collection_type,
      subscriber_id: row.subscriber_id,
    });
  }
  for (const row of purchaseLog) {
    transactions.push({
      id: `grocery-${row.id}`,
      source: "GROCERY",
      direction: "OUT",
      amount: Number(row.line_total),
      occurred_at: row.created_at,
      reference: row.item_name || `Stock #${row.inventory_item_id}`,
      method: "INVENTORY",
      status: "RECORDED",
      notes: row.notes,
    });
  }
  for (const row of expenseLog) {
    transactions.push({
      id: `expense-${row.id}`,
      source: "EXPENSE",
      direction: "OUT",
      amount: Number(row.amount),
      occurred_at: row.spent_at || row.created_at,
      reference: row.category,
      method: "EXPENSE",
      status: "RECORDED",
      note: row.note,
    });
  }

  transactions.sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));

  const txType = parsed.data.transactionType;
  const filteredTransactions =
    txType === "ALL" ? transactions : transactions.filter((t) => t.source === txType);

  return res.json({
    summary: {
      salesTotal,
      subscriptionTotal,
      grossInflow,
      refundsTotal,
      purchasesTotal,
      expensesTotal,
      netSales,
      profit,
      transactionCount: filteredTransactions.length,
    },
    breakdown,
    transactions: filteredTransactions.slice(0, lim),
    salesLog,
    refundLog,
    subscriptionLog,
    purchaseLog,
    expenseLog,
  });
});

router.get("/refunds", auth(), tenantScope, rbac("OWNER", "MANAGER", "ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const tenantId = req.tenantId;
  const { restaurantId, logLimit } = parsed.data;
  const lim = Math.min(500, Math.max(1, Number(logLimit) || 200));

  const restaurant = await loadRestaurantRow(req, restaurantId, tenantId);
  if (!restaurant) return res.status(404).json({ message: "Restaurant not found" });

  const refundParams = [tenantId];
  const refundWhere = `${buildPaymentFilters(parsed.data, refundParams)} AND (
    p.payment_status = 'REFUNDED'
    OR (p.payment_status = 'PARTIALLY_REFUNDED' AND COALESCE(p.refunded_cumulative, 0) > 0)
  )`;

  const [[refundAgg]] = await pool.execute(
    `SELECT COALESCE(SUM(
       CASE
         WHEN p.payment_status = 'REFUNDED' THEN p.amount
         WHEN p.payment_status = 'PARTIALLY_REFUNDED' THEN COALESCE(p.refunded_cumulative, 0)
         ELSE 0
       END
     ), 0) AS total, COUNT(*) AS cnt
     FROM payments p
     INNER JOIN orders o ON o.id = p.order_id AND o.tenant_id = p.tenant_id
     WHERE ${refundWhere}`,
    refundParams
  );

  const [refundLog] = await pool.execute(
    `SELECT p.id, p.order_id, p.amount, COALESCE(p.refunded_cumulative, 0) AS refunded_cumulative,
            p.payment_method, p.payment_provider, p.payment_status, p.created_at,
            o.order_type, o.status AS order_status,
            (CASE
              WHEN p.payment_status = 'REFUNDED' THEN p.amount
              ELSE COALESCE(p.refunded_cumulative, 0)
            END) AS refund_display_amount
     FROM payments p
     INNER JOIN orders o ON o.id = p.order_id AND o.tenant_id = p.tenant_id
     WHERE ${refundWhere}
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT ${lim}`,
    refundParams
  );

  const paidParams = [tenantId];
  const paidWhere = `${buildPaymentFilters(parsed.data, paidParams)} AND p.payment_status IN ('PAID','PARTIALLY_REFUNDED')
    AND (p.amount - COALESCE(p.refunded_cumulative, 0)) > 0.005`;
  const [refundablePayments] = await pool.execute(
    `SELECT p.id, p.order_id, p.amount, COALESCE(p.refunded_cumulative, 0) AS refunded_cumulative,
            (p.amount - COALESCE(p.refunded_cumulative, 0)) AS remaining_amount,
            p.payment_method, p.payment_provider, p.payment_status, p.created_at,
            o.order_type, o.status AS order_status
     FROM payments p
     INNER JOIN orders o ON o.id = p.order_id AND o.tenant_id = p.tenant_id
     WHERE ${paidWhere}
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT ${lim}`,
    paidParams
  );

  return res.json({
    summary: {
      refundsTotal: Number(refundAgg?.total || 0),
      refundCount: Number(refundAgg?.cnt || 0),
    },
    refundLog,
    refundablePayments,
  });
});

router.post(
  "/revenue/expenses",
  auth(),
  tenantScope,
  rbac("OWNER", "MANAGER", "ADMIN", "SUPER_ADMIN"),
  async (req, res) => {
    const schema = z.object({
      restaurantId: z.coerce.number().int().positive(),
      category: z.string().min(1).max(80),
      amount: z.coerce.number().positive(),
      note: z.string().max(500).optional().nullable(),
      spentAt: z.string().max(40).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const expRestaurant = await loadRestaurantRow(req, parsed.data.restaurantId, req.tenantId);
    if (!expRestaurant) return res.status(404).json({ message: "Restaurant not found" });

    const spentAt = parsed.data.spentAt ? new Date(parsed.data.spentAt) : new Date();
    if (Number.isNaN(spentAt.getTime())) return res.status(400).json({ message: "Invalid spentAt" });

    try {
      const [result] = await pool.execute(
        `INSERT INTO restaurant_expenses (tenant_id, restaurant_id, category, amount, note, spent_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          req.tenantId,
          parsed.data.restaurantId,
          parsed.data.category,
          parsed.data.amount,
          parsed.data.note || null,
          spentAt,
        ]
      );
      return res.status(201).json({ id: result.insertId });
    } catch (err) {
      if (err?.code === "ER_NO_SUCH_TABLE") {
        return res.status(503).json({
          message: "Operating expenses table is not installed. Run the latest database schema update.",
        });
      }
      throw err;
    }
  }
);

module.exports = router;
