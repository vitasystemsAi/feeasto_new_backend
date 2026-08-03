const pool = require("../db/pool");
const { buildStatusPayload } = require("../utils/orderStatus");

const OWNER_ACCEPT_DEADLINE_MINUTES = 6;
/** Shown to customer when the restaurant does not accept within the deadline. */
const AUTO_CANCEL_REASON =
  "The restaurant did not accept your order within time. Your order was automatically cancelled.";

let ensureCancelledByColumn = null;
let ensureCancellationReasonColumn = null;

function registerEnsureColumns(fnCancelledBy, fnCancellationReason) {
  ensureCancelledByColumn = fnCancelledBy;
  ensureCancellationReasonColumn = fnCancellationReason;
}

async function autoCancelPlacedOrder(orderRow, io) {
  const orderId = Number(orderRow.id);
  const tenantId = Number(orderRow.tenant_id);
  const customerUserId = orderRow.customer_user_id;

  const [[fresh]] = await pool.execute(
    `SELECT id, status, customer_user_id, tenant_id
     FROM orders WHERE id = ? AND status = 'PLACED' LIMIT 1`,
    [orderId]
  );
  if (!fresh) return false;

  if (ensureCancelledByColumn) await ensureCancelledByColumn();
  if (ensureCancellationReasonColumn) await ensureCancellationReasonColumn();

  await pool.execute(
    "UPDATE orders SET status = 'CANCELLED', cancelled_by = 'OWNER', cancellation_reason = ? WHERE id = ? AND status = 'PLACED'",
    [AUTO_CANCEL_REASON, orderId]
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
    cancellation_reason: AUTO_CANCEL_REASON,
    autoCancelled: true,
    declinedByTimeout: true,
    ...buildStatusPayload("CANCELLED", "REJECTED", "OWNER", AUTO_CANCEL_REASON, {
      declinedByTimeout: true,
      autoCancelled: true,
    }),
    can_cancel: false,
    cancel_deadline_at: null,
  };

  io.to(`tenant:${tenantId}`).emit("order:status-updated", payload);
  if (customerUserId) {
    io.to(`user:${customerUserId}`).emit("order:status-updated", payload);
  }

  return true;
}

async function processExpiredPlacedOrders(io) {
  if (!io) return 0;
  const [rows] = await pool.execute(
    `SELECT o.id, o.tenant_id, o.restaurant_id, o.customer_user_id
     FROM orders o
     WHERE o.status = 'PLACED'
       AND o.order_type IN ('DELIVERY', 'TAKEAWAY')
       AND o.created_at <= DATE_SUB(NOW(), INTERVAL ? MINUTE)
       AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id LIMIT 1)`,
    [OWNER_ACCEPT_DEADLINE_MINUTES]
  );

  let cancelled = 0;
  for (const row of rows) {
    try {
      const did = await autoCancelPlacedOrder(row, io);
      if (did) cancelled += 1;
    } catch (err) {
      console.error("ownerAcceptTimeout auto-cancel:", err.message);
    }
  }
  return cancelled;
}

function startOwnerAcceptTimeoutJob(io) {
  const tick = () => {
    processExpiredPlacedOrders(io).catch((err) => {
      console.error("ownerAcceptTimeout tick:", err.message);
    });
  };
  tick();
  const interval = setInterval(tick, 5_000);
  return () => clearInterval(interval);
}

module.exports = {
  OWNER_ACCEPT_DEADLINE_MINUTES,
  AUTO_CANCEL_REASON,
  registerEnsureColumns,
  autoCancelPlacedOrder,
  processExpiredPlacedOrders,
  startOwnerAcceptTimeoutJob,
};
