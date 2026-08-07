const ORDER_STATES = [
  "PLACED",
  "ACCEPTED",
  "PREPARING",
  "READY",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
];

const OWNER_DELIVERY_ACTIONS = {
  PLACED: [{ status: "ACCEPTED", label: "Accept" }],
  ACCEPTED: [{ status: "READY", label: "Ready" }],
  PREPARING: [{ status: "READY", label: "Ready" }],
  READY: [],
  OUT_FOR_DELIVERY: [],
  DELIVERED: [],
  CANCELLED: [],
};

const OWNER_DINE_IN_ACTIONS = {
  PLACED: [{ status: "ACCEPTED", label: "Accept" }],
  ACCEPTED: [{ status: "PREPARING", label: "Start cooking" }],
  PREPARING: [{ status: "READY", label: "Mark ready" }],
  READY: [],
  DELIVERED: [],
  CANCELLED: [],
};

const OWNER_TAKEAWAY_ACTIONS = {
  PLACED: [{ status: "ACCEPTED", label: "Accept" }],
  ACCEPTED: [{ status: "READY", label: "Ready" }],
  PREPARING: [{ status: "READY", label: "Ready" }],
  READY: [{ status: "DELIVERED", label: "Picked up" }],
  DELIVERED: [],
  CANCELLED: [],
};

function ownerUsesPartnerAssignFlow(orderType) {
  return String(orderType || "").toUpperCase() === "DELIVERY";
}

function normalizeTime(t) {
  if (!t) return "12:00";
  const s = String(t).trim().slice(0, 5);
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return "12:00";
  return `${String(Number(m[1])).padStart(2, "0")}:${m[2]}`;
}

const ORDER_TIMEOUT_CUSTOMER_MESSAGE =
  "The restaurant did not accept your order within time. Your order was automatically cancelled.";

const TIME_UP_CANCELLED_LABEL = "Time-up cancelled";

function normalizeTimeoutCancellationReason(reason) {
  const r = String(reason || "").trim();
  if (!r) return r;
  if (
    /within\s*6\s*minute/i.test(r) ||
    /declined due to timeout at the restaurant/i.test(r) ||
    /did not accept your order within time/i.test(r) ||
    /automatically cancelled/i.test(r)
  ) {
    return ORDER_TIMEOUT_CUSTOMER_MESSAGE;
  }
  return r;
}

function isTimeUpCancellation(cancellationReason, cancelledBy, extras = {}) {
  if (extras?.declinedByTimeout || extras?.autoCancelled) return true;
  const r = String(cancellationReason || "").trim();
  if (r) {
    return (
      /did not accept your order within time/i.test(r) ||
      /automatically cancelled/i.test(r) ||
      /within\s*6\s*minute/i.test(r) ||
      /declined due to timeout/i.test(r)
    );
  }
  const who = String(cancelledBy || "").toUpperCase();
  return who === "SYSTEM" || who === "AUTO";
}

function customerCancelledLabel(cancelledBy, cancellationReason, extras = {}) {
  const reason = normalizeTimeoutCancellationReason(cancellationReason);
  const who = String(cancelledBy || "").toUpperCase();
  if (who === "SYSTEM" || who === "AUTO") {
    return reason || ORDER_TIMEOUT_CUSTOMER_MESSAGE;
  }
  if (who === "OWNER" || who === "RESTAURANT") {
    if (isTimeUpCancellation(cancellationReason, cancelledBy, extras)) {
      return reason || ORDER_TIMEOUT_CUSTOMER_MESSAGE;
    }
    return "Cancelled by restaurant";
  }
  if (who === "CUSTOMER") {
    return "Cancelled by you";
  }
  return reason || String(cancellationReason || "").trim() || "Cancelled";
}

function getOwnerDisplayStatusLabel(orderStatus, cancelledBy, cancellationReason, extras = {}) {
  const o = String(orderStatus || "").toUpperCase();
  if (o === "CANCELLED") {
    return "Cancelled";
  }
  return getOwnerOrderStatusLabel(orderStatus);
}

/** Customer-facing label (4-step flow: placed → accepted → ready → delivered). */
function getCustomerOrderStatus(orderStatus, deliveryStatus, cancelledBy, cancellationReason, extras = {}) {
  const o = String(orderStatus || "PLACED").toUpperCase();
  const d = String(deliveryStatus || "").toUpperCase();

  if (o === "CANCELLED" || d === "REJECTED") {
    return {
      key: "CANCELLED",
      label: customerCancelledLabel(cancelledBy, cancellationReason, extras),
      phase: "done",
    };
  }
  if (o === "DELIVERED" || d === "DELIVERED") {
    return { key: "DELIVERED", label: "Delivered", phase: "done" };
  }
  if (o === "OUT_FOR_DELIVERY" || d === "PICKED_UP") {
    return { key: "OUT_FOR_DELIVERY", label: "On the way", phase: "transit" };
  }
  if (o === "READY") {
    return { key: "READY", label: "Ready", phase: "kitchen" };
  }
  if (o === "PREPARING") {
    return { key: "PREPARING", label: "Preparing your food", phase: "kitchen" };
  }
  if (o === "ACCEPTED") {
    return { key: "ACCEPTED", label: "Accepted", phase: "kitchen" };
  }
  return { key: "PLACED", label: "Order placed", phase: "new" };
}

function getOwnerOrderStatusLabel(orderStatus) {
  const o = String(orderStatus || "").toUpperCase();
  const map = {
    PLACED: "New order",
    ACCEPTED: "Accepted",
    PREPARING: "Accepted",
    READY: "Ready",
    OUT_FOR_DELIVERY: "Assigned to partner",
    DELIVERED: "Delivered",
    CANCELLED: "Cancelled",
  };
  return map[o] || o;
}

const CUSTOMER_CANCEL_WINDOW_MS = 0;

function getOwnerNextActions(orderStatus, orderType, options = {}) {
  const type = String(orderType || "").toUpperCase();
  const key = String(orderStatus || "").toUpperCase();
  const hasPartner = Boolean(options.hasDeliveryPartner);

  if (ownerUsesPartnerAssignFlow(type)) {
    return OWNER_DELIVERY_ACTIONS[key] || [];
  }

  if (type === "TAKEAWAY") {
    return OWNER_TAKEAWAY_ACTIONS[key] || [];
  }
  if (type === "DINE_IN") {
    return OWNER_DINE_IN_ACTIONS[key] || [];
  }

  return OWNER_DELIVERY_ACTIONS[key] || [];
}

/**
 * Customer cancel: only while PLACED (awaiting restaurant accept).
 * Once the restaurant accepts, cancel is no longer allowed.
 */
function canCustomerCancelOrder(order) {
  const status = String(order?.status || "").toUpperCase();
  return status === "PLACED";
}

function customerCancelDeadlineIso(_order) {
  return null;
}

function buildStatusPayload(orderStatus, deliveryStatus, cancelledBy, cancellationReason, extras = {}) {
  const customer = getCustomerOrderStatus(
    orderStatus,
    deliveryStatus,
    cancelledBy,
    cancellationReason,
    extras
  );
  return {
    orderStatus,
    deliveryStatus: deliveryStatus || null,
    cancelled_by: cancelledBy || null,
    cancellation_reason: cancellationReason || null,
    customerStatus: customer.label,
    customerStatusKey: customer.key,
    ownerStatusLabel: getOwnerDisplayStatusLabel(
      orderStatus,
      cancelledBy,
      cancellationReason,
      extras
    ),
  };
}

module.exports = {
  ORDER_STATES,
  OWNER_DELIVERY_ACTIONS,
  ownerUsesPartnerAssignFlow,
  CUSTOMER_CANCEL_WINDOW_MS,
  normalizeTime,
  getCustomerOrderStatus,
  customerCancelledLabel,
  getOwnerOrderStatusLabel,
  getOwnerDisplayStatusLabel,
  getOwnerNextActions,
  canCustomerCancelOrder,
  customerCancelDeadlineIso,
  buildStatusPayload,
  normalizeTimeoutCancellationReason,
  ORDER_TIMEOUT_CUSTOMER_MESSAGE,
  TIME_UP_CANCELLED_LABEL,
  isTimeUpCancellation,
};
