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
  return getOwnerOrderStatusLabel(orderStatus, extras.deliveryStatus || extras.delivery_status);
}

/** Customer-facing live tracking status (delivery-first 5-step progress). */
function getCustomerOrderStatus(orderStatus, deliveryStatus, cancelledBy, cancellationReason, extras = {}) {
  const o = String(orderStatus || "PLACED").toUpperCase();
  const d = String(deliveryStatus || "").toUpperCase();
  const restaurantHandoff = Boolean(extras.restaurantHandoffAt || extras.restaurant_handoff_at);
  const partnerPickup = Boolean(extras.partnerPickupAt || extras.partner_pickup_at);
  const bothHandoffs = restaurantHandoff && partnerPickup;

  if (o === "CANCELLED" || d === "REJECTED") {
    return {
      key: "CANCELLED",
      label: customerCancelledLabel(cancelledBy, cancellationReason, extras),
      description: "This order was cancelled.",
      progress: 0,
      tone: "red",
      phase: "done",
      icon: "cancelled",
    };
  }

  if (o === "DELIVERED" || d === "DELIVERED") {
    return {
      key: "DELIVERED",
      label: "Order Delivered Successfully",
      description: "Enjoy your meal! Thank you for ordering with us.",
      progress: 100,
      tone: "emerald",
      phase: "done",
      icon: "delivered",
    };
  }

  /* On the way only after dual handoff, or legacy OUT_FOR_DELIVERY / PICKED_UP. */
  if (
    o === "OUT_FOR_DELIVERY" ||
    d === "PICKED_UP" ||
    (bothHandoffs && ["ACCEPTED", "PICKED_UP"].includes(d))
  ) {
    return {
      key: "OUT_FOR_DELIVERY",
      label: "Your Order is On the Way",
      description: "Your order has been picked up and is on its way to your location.",
      progress: 85,
      tone: "green",
      phase: "transit",
      icon: "on_the_way",
    };
  }

  if (d === "ACCEPTED") {
    return {
      key: "PARTNER_EN_ROUTE",
      label: "Delivery Partner is Going to Pick Up Your Order",
      description:
        "Your delivery partner has accepted the order and is heading to the restaurant.",
      progress: 60,
      tone: "purple",
      phase: "pickup",
      icon: "partner_pickup",
      waitingForHandoff: !bothHandoffs,
      restaurantHandoffConfirmed: restaurantHandoff,
      partnerPickupConfirmed: partnerPickup,
    };
  }

  if (o === "READY") {
    const waitingPartner = !d || d === "ASSIGNED";
    return {
      key: "READY",
      label: "Your Food is Ready",
      description: waitingPartner
        ? d === "ASSIGNED"
          ? "Waiting for your delivery partner to accept the delivery."
          : "Your food has been prepared successfully. Waiting for a delivery partner to accept the delivery."
        : "Your food has been prepared successfully.",
      progress: 45,
      tone: "blue",
      phase: "kitchen",
      icon: "ready",
      waitingForPartner: waitingPartner,
    };
  }

  if (o === "PREPARING" || o === "ACCEPTED") {
    return {
      key: "PREPARING",
      label: "Order is Being Prepared",
      description: "Your order has been accepted by the restaurant and is now being prepared.",
      progress: 25,
      tone: "orange",
      phase: "kitchen",
      icon: "preparing",
    };
  }

  return {
    key: "PLACED",
    label: "Order Placed",
    description: "We've received your order. Waiting for the restaurant to accept it.",
    progress: 8,
    tone: "slate",
    phase: "new",
    icon: "placed",
  };
}

function getOwnerOrderStatusLabel(orderStatus, deliveryStatus) {
  const o = String(orderStatus || "").toUpperCase();
  const d = String(deliveryStatus || "").toUpperCase();
  if (o === "OUT_FOR_DELIVERY" || d === "PICKED_UP") return "On the way";
  if (o === "READY" && d === "ACCEPTED") return "Partner en route to restaurant";
  if (o === "READY" && d === "ASSIGNED") return "Waiting partner accept";
  const map = {
    PLACED: "New order",
    ACCEPTED: "Accepted",
    PREPARING: "Accepted",
    READY: "Ready",
    OUT_FOR_DELIVERY: "On the way",
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
    { ...extras, deliveryStatus }
  );
  return {
    orderStatus,
    deliveryStatus: deliveryStatus || null,
    cancelled_by: cancelledBy || null,
    cancellation_reason: cancellationReason || null,
    customerStatus: customer.label,
    customerStatusKey: customer.key,
    customerStatusDescription: customer.description,
    customerProgress: customer.progress,
    customerTone: customer.tone,
    customerIcon: customer.icon,
    ownerStatusLabel: getOwnerDisplayStatusLabel(
      orderStatus,
      cancelledBy,
      cancellationReason,
      { ...extras, deliveryStatus }
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
