const pool = require("../../db/pool");
const { getCustomerOrderStatus } = require("../../utils/orderStatus");
const { provisionSubscriberDelivery } = require("../delivery/partner.service");
const {
  buildUpcomingSlots,
  canModifySlot,
  normalizeSlotTime,
  slotKey,
  updateAssignmentInSchedule,
  addCancelledSlot,
  rescheduleAssignment,
  LOCKED_ORDER_STATUSES,
  parseScheduleObject,
  todayIsoLocal,
  isSlotCancelled,
} = require("../../utils/subscriberSchedule.util");

function toIsoDateString(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(value).trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

function addDaysIso(iso, days) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function fetchSubscriberForCustomer(userId, subscriberId) {
  const params = [userId];
  let sql = `SELECT s.id, s.tenant_id, s.restaurant_id, s.user_id, s.plan_id, s.status,
                    s.delivery_frequency, s.delivery_days_json, s.delivery_partner_profile_id
             FROM subscription_subscribers s
             WHERE s.user_id = ?`;
  if (subscriberId) {
    sql += " AND s.id = ?";
    params.push(subscriberId);
  }
  sql += " ORDER BY s.created_at DESC LIMIT 1";
  const [rows] = await pool.execute(sql, params);
  return rows[0] || null;
}

async function fetchPlanItems(planId) {
  if (!planId) return [];
  const [rows] = await pool.execute(
    `SELECT spi.menu_item_id, spi.quantity, mi.name AS menu_item_name
     FROM subscription_plan_items spi
     INNER JOIN menu_items mi ON mi.id = spi.menu_item_id
     WHERE spi.plan_id = ?`,
    [planId]
  );
  return rows;
}

async function fetchDeliveryOrdersInRange(tenantId, userId, restaurantId, fromDate, toDate) {
  try {
    const [rows] = await pool.execute(
      `SELECT o.id, o.status, o.scheduled_delivery_date, o.scheduled_delivery_time,
              d.status AS delivery_status, d.id AS delivery_id
       FROM orders o
       LEFT JOIN deliveries d ON d.order_id = o.id AND d.tenant_id = o.tenant_id
       WHERE o.customer_user_id = ? AND o.restaurant_id = ?
         AND o.order_type = 'DELIVERY'
         AND (o.tenant_id = ? OR o.tenant_id IS NULL OR o.tenant_id = 0)
         AND COALESCE(o.scheduled_delivery_date, DATE(o.created_at)) >= ?
         AND COALESCE(o.scheduled_delivery_date, DATE(o.created_at)) <= ?
       ORDER BY COALESCE(o.scheduled_delivery_date, DATE(o.created_at)) ASC,
                COALESCE(o.scheduled_delivery_time, '12:00') ASC`,
      [userId, restaurantId, tenantId, fromDate, toDate]
    );
    const itemsByOrder = {};
    if (rows.length) {
      const placeholders = rows.map(() => "?").join(",");
      const [items] = await pool.execute(
        `SELECT oi.order_id, oi.menu_item_id, oi.quantity, oi.unit_price, mi.name AS menu_item_name
         FROM order_items oi
         INNER JOIN menu_items mi ON mi.id = oi.menu_item_id
         WHERE oi.order_id IN (${placeholders})`,
        rows.map((r) => r.id)
      );
      for (const it of items) {
        if (!itemsByOrder[it.order_id]) itemsByOrder[it.order_id] = [];
        itemsByOrder[it.order_id].push(it);
      }
    }
    return rows.map((row) => ({
      ...row,
      slot_time: normalizeSlotTime(row.scheduled_delivery_time),
      slot_date: toIsoDateString(row.scheduled_delivery_date),
      items: itemsByOrder[row.id] || [],
    }));
  } catch (err) {
    if (err?.code === "ER_BAD_FIELD_ERROR") {
      const [rows] = await pool.execute(
        `SELECT o.id, o.status, DATE(o.created_at) AS slot_date, d.status AS delivery_status
         FROM orders o
         LEFT JOIN deliveries d ON d.order_id = o.id
         WHERE o.customer_user_id = ? AND o.restaurant_id = ?
           AND o.order_type = 'DELIVERY'
           AND (o.tenant_id = ? OR o.tenant_id IS NULL OR o.tenant_id = 0)
           AND DATE(o.created_at) >= ? AND DATE(o.created_at) <= ?`,
        [userId, restaurantId, tenantId, fromDate, toDate]
      );
      return rows.map((r) => ({ ...r, slot_time: "12:00", items: [] }));
    }
    throw err;
  }
}

async function findOrderForSlot(tenantId, userId, restaurantId, date, time) {
  const t = normalizeSlotTime(time);
  const orders = await fetchDeliveryOrdersInRange(tenantId, userId, restaurantId, date, date);
  const match = orders.find(
    (o) =>
      (o.slot_date || "").slice(0, 10) === date &&
      normalizeSlotTime(o.slot_time || o.scheduled_delivery_time) === t
  );
  if (!match) return null;
  return {
    id: match.id,
    status: match.status,
    scheduled_delivery_date: match.scheduled_delivery_date,
    scheduled_delivery_time: match.scheduled_delivery_time,
    delivery_status: match.delivery_status,
    delivery_id: match.delivery_id,
    items: match.items,
  };
}

function mapOrderItems(items) {
  return (items || []).map((it) => ({
    id: it.id,
    menuItemId: it.menu_item_id,
    menuItemName: it.menu_item_name,
    quantity: it.quantity,
    unitPrice: it.unit_price,
    lineTotal: Number(it.quantity) * Number(it.unit_price),
  }));
}

function enrichSlotWithPolicy(slot, order, schedule) {
  const cancelled = isSlotCancelled(schedule, slot.date, slot.time);
  const status = order ? String(order.status || "").toUpperCase() : cancelled ? "CANCELLED" : null;
  const deliveryStatus = order?.delivery_status || null;
  const customer = cancelled
    ? getCustomerOrderStatus("CANCELLED", deliveryStatus)
    : order
      ? getCustomerOrderStatus(status, deliveryStatus)
      : { key: "SCHEDULED", label: "Scheduled", phase: "new" };
  const locked = status && LOCKED_ORDER_STATUSES.has(status);
  const modifiable = !cancelled && canModifySlot(slot.date, slot.time) && !locked;
  const hoursLeft = Math.max(
    0,
    (new Date(`${slot.date}T${normalizeSlotTime(slot.time)}:00`).getTime() - Date.now()) / 3600000
  );

  const statusSteps = [
    { key: "PLACED", label: "Placed" },
    { key: "ACCEPTED", label: "Accepted" },
    { key: "PREPARING", label: "Preparing" },
    { key: "READY", label: "Ready" },
    { key: "OUT_FOR_DELIVERY", label: "On the way" },
    { key: "DELIVERED", label: "Delivered" },
  ];
  const activeIdx = statusSteps.findIndex((s) => s.key === customer.key);

  return {
    slotKey: slotKey(slot.date, slot.time),
    date: slot.date,
    time: slot.time,
    items: slot.items,
    scheduleStatus: cancelled
      ? "CANCELLED"
      : order
        ? customer.key
        : "SCHEDULED",
    customerStatus: cancelled ? "Cancelled" : order ? customer.label : "Scheduled",
    customerStatusKey: cancelled ? "CANCELLED" : order ? customer.key : "SCHEDULED",
    deliveryStatus,
    statusSteps: statusSteps.map((step, idx) => ({
      ...step,
      state: cancelled
        ? "skipped"
        : customer.key === "CANCELLED"
          ? "skipped"
          : idx < activeIdx
            ? "done"
            : idx === activeIdx
              ? "current"
              : "upcoming",
    })),
    order: order
      ? {
          id: order.id,
          status: order.status,
          deliveryId: order.delivery_id,
          items: mapOrderItems(order.items),
        }
      : null,
    canChangeItems: modifiable,
    canReschedule: modifiable,
    canCancel: modifiable,
    hoursUntilDelivery: Math.round(hoursLeft * 10) / 10,
    cutoffMessage: modifiable
      ? null
      : cancelled
        ? "This delivery was cancelled."
        : locked
          ? `This delivery is ${String(status).toLowerCase().replace(/_/g, " ")} and can no longer be changed.`
          : "Changes and cancellation are closed within 3 hours of delivery time.",
  };
}

async function ensureProvisionedAhead(sub) {
  if (sub.status !== "ACTIVE" || !sub.delivery_partner_profile_id) return;
  const today = todayIsoLocal();
  for (let i = 0; i < 14; i += 1) {
    const iso = addDaysIso(today, i);
    try {
      await provisionSubscriberDelivery(pool, sub.tenant_id, sub.id, iso, null);
    } catch (err) {
      console.error("ensureProvisionedAhead:", err.message);
    }
  }
}

function mergeSlotsWithOrders(slots, orders, planItems, schedule) {
  const byKey = new Map();
  for (const slot of slots) {
    byKey.set(slotKey(slot.date, slot.time), { ...slot });
  }
  for (const order of orders) {
    const date = order.slot_date;
    if (!date) continue;
    const time = normalizeSlotTime(order.slot_time);
    const key = slotKey(date, time);
    if (isSlotCancelled(schedule, date, time) && String(order.status).toUpperCase() !== "CANCELLED") {
      continue;
    }
    if (!byKey.has(key)) {
      const items =
        order.items?.length > 0
          ? order.items.map((it) => ({
              menuItemId: Number(it.menu_item_id),
              menuItemName: it.menu_item_name,
              quantity: Number(it.quantity),
            }))
          : [];
      if (items.length || planItems.length) {
        byKey.set(key, {
          date,
          time,
          items:
            items.length > 0
              ? items
              : planItems.map((p) => ({
                  menuItemId: Number(p.menu_item_id),
                  menuItemName: p.menu_item_name,
                  quantity: Math.max(1, Number(p.quantity) || 1),
                })),
        });
      }
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      new Date(`${a.date}T${a.time}:00`).getTime() - new Date(`${b.date}T${b.time}:00`).getTime()
  );
}

async function listUpcomingDeliveries(userId, subscriberId, options = {}) {
  const sub = await fetchSubscriberForCustomer(userId, subscriberId);
  if (!sub) return { error: "NOT_FOUND", message: "Subscription not found." };
  if (sub.status !== "ACTIVE") {
    return { error: "INACTIVE", message: "Subscription must be active to manage deliveries." };
  }

  if (options.provision !== false) {
    await ensureProvisionedAhead(sub);
  }

  const planItems = await fetchPlanItems(sub.plan_id);
  const schedule = parseScheduleObject(sub.delivery_days_json);
  const today = todayIsoLocal();
  const toDate = addDaysIso(today, options.daysAhead ?? 28);

  let slots = buildUpcomingSlots(sub, planItems, options.daysAhead ?? 28);
  const orders = await fetchDeliveryOrdersInRange(
    sub.tenant_id,
    sub.user_id,
    sub.restaurant_id,
    today,
    toDate
  );
  slots = mergeSlotsWithOrders(slots, orders, planItems, schedule);

  const orderByKey = new Map();
  for (const o of orders) {
    if (o.slot_date) {
      orderByKey.set(slotKey(o.slot_date, normalizeSlotTime(o.slot_time)), o);
    }
  }

  const enriched = [];
  for (const slot of slots) {
    const key = slotKey(slot.date, slot.time);
    const rawOrder = orderByKey.get(key);
    const order = rawOrder
      ? {
          id: rawOrder.id,
          status: rawOrder.status,
          delivery_status: rawOrder.delivery_status,
          delivery_id: rawOrder.delivery_id,
          items: rawOrder.items,
        }
      : await findOrderForSlot(sub.tenant_id, sub.user_id, sub.restaurant_id, slot.date, slot.time);
    enriched.push(enrichSlotWithPolicy(slot, order, schedule));
  }

  const pastOrders = await fetchDeliveryOrdersInRange(
    sub.tenant_id,
    sub.user_id,
    sub.restaurant_id,
    addDaysIso(today, -30),
    addDaysIso(today, -1)
  );

  return {
    subscriberId: sub.id,
    restaurantId: sub.restaurant_id,
    cutoffHours: 3,
    deliveries: enriched.map((row) => ({
      ...row,
      date: toIsoDateString(row.date) || row.date,
    })),
    recentHistory: pastOrders
      .map((o) => {
        const customer = getCustomerOrderStatus(o.status, o.delivery_status);
        return {
          orderId: o.id,
          date: toIsoDateString(o.slot_date),
          time: normalizeSlotTime(o.slot_time),
          status: o.status,
          customerStatus: customer.label,
          customerStatusKey: customer.key,
          items: mapOrderItems(o.items),
        };
      })
      .reverse()
      .slice(0, 10),
  };
}

async function assertSlotModifiable(sub, date, time) {
  if (sub.status !== "ACTIVE") {
    return { ok: false, status: 400, message: "Subscription is not active." };
  }
  const schedule = parseScheduleObject(sub.delivery_days_json);
  if (isSlotCancelled(schedule, date, time)) {
    return { ok: false, status: 400, message: "This delivery is already cancelled." };
  }
  if (!canModifySlot(date, time)) {
    return {
      ok: false,
      status: 403,
      message: "Changes are not allowed within 3 hours of the scheduled delivery time.",
    };
  }
  const order = await findOrderForSlot(sub.tenant_id, sub.user_id, sub.restaurant_id, date, time);
  if (order && LOCKED_ORDER_STATUSES.has(String(order.status).toUpperCase())) {
    return {
      ok: false,
      status: 403,
      message: `This delivery cannot be changed (order status: ${order.status}).`,
    };
  }
  return { ok: true, order };
}

async function validateItemsForPlan(planId, restaurantId, tenantId, items) {
  const planItems = await fetchPlanItems(planId);
  const caps = new Map(planItems.map((r) => [Number(r.menu_item_id), Math.max(1, Number(r.quantity) || 1)]));
  const used = new Map();
  const normalized = [];
  for (const it of items) {
    const id = Number(it.menuItemId);
    const qty = Math.max(1, Number(it.quantity) || 1);
    if (!caps.has(id)) {
      return { ok: false, message: "Items must be from your subscription plan menu." };
    }
    used.set(id, (used.get(id) || 0) + qty);
    normalized.push({ menuItemId: id, quantity: qty });
  }
  for (const [id, cap] of caps) {
    if ((used.get(id) || 0) > cap) {
      const name = planItems.find((p) => Number(p.menu_item_id) === id)?.menu_item_name || `Item #${id}`;
      return { ok: false, message: `${name}: quantity exceeds your plan allowance (${cap} total per cycle).` };
    }
  }
  const placeholders = normalized.map(() => "?").join(",");
  const [rows] = await pool.execute(
    `SELECT id FROM menu_items WHERE id IN (${placeholders}) AND restaurant_id = ? AND tenant_id = ? AND is_active = 1`,
    [...normalized.map((i) => i.menuItemId), restaurantId, tenantId]
  );
  if (rows.length !== normalized.length) {
    return { ok: false, message: "One or more menu items are invalid." };
  }
  return { ok: true, items: normalized, planItems };
}

async function cancelDelivery(userId, subscriberId, date, time) {
  const sub = await fetchSubscriberForCustomer(userId, subscriberId);
  if (!sub) return { status: 404, message: "Subscription not found." };
  const check = await assertSlotModifiable(sub, date, time);
  if (!check.ok) return { status: check.status, message: check.message };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const daysJson = addCancelledSlot(sub.delivery_days_json, date, time);
    await conn.execute("UPDATE subscription_subscribers SET delivery_days_json = ? WHERE id = ?", [
      daysJson,
      sub.id,
    ]);

    if (check.order) {
      await conn.execute("UPDATE orders SET status = 'CANCELLED' WHERE id = ? AND tenant_id = ?", [
        check.order.id,
        sub.tenant_id,
      ]);
      try {
        await conn.execute(
          "UPDATE deliveries SET status = 'REJECTED' WHERE order_id = ? AND tenant_id = ?",
          [check.order.id, sub.tenant_id]
        );
      } catch {
        /* optional */
      }
    }

    await conn.commit();
    return { status: 200, message: "Delivery cancelled successfully." };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function rescheduleDelivery(userId, subscriberId, date, time, newDate, newTime) {
  const sub = await fetchSubscriberForCustomer(userId, subscriberId);
  if (!sub) return { status: 404, message: "Subscription not found." };
  const check = await assertSlotModifiable(sub, date, time);
  if (!check.ok) return { status: check.status, message: check.message };
  if (!canModifySlot(newDate, newTime)) {
    return { status: 403, message: "New delivery time must be at least 3 hours from now." };
  }

  const schedule = parseScheduleObject(sub.delivery_days_json);
  const idx = (schedule.assignments || []).findIndex(
    (a) => a.date === date && normalizeSlotTime(a.time) === normalizeSlotTime(time)
  );
  const existingItems =
    idx >= 0
      ? schedule.assignments[idx].items
      : buildUpcomingSlots(sub, await fetchPlanItems(sub.plan_id)).find(
          (s) => slotKey(s.date, s.time) === slotKey(date, time)
        )?.items || [];

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let daysJson = rescheduleAssignment(sub.delivery_days_json, date, time, newDate, newTime);
    if (idx < 0 && existingItems.length) {
      daysJson = updateAssignmentInSchedule(daysJson, newDate, newTime, (row) => ({
        ...row,
        items: existingItems.map((i) => ({
          menuItemId: i.menuItemId,
          quantity: i.quantity,
          menuItemName: i.menuItemName,
        })),
      }));
    }
    await conn.execute("UPDATE subscription_subscribers SET delivery_days_json = ? WHERE id = ?", [
      daysJson,
      sub.id,
    ]);

    if (check.order) {
      try {
        await conn.execute(
          `UPDATE orders SET scheduled_delivery_date = ?, scheduled_delivery_time = ?
           WHERE id = ? AND tenant_id = ?`,
          [newDate, normalizeSlotTime(newTime), check.order.id, sub.tenant_id]
        );
      } catch (err) {
        if (err?.code !== "ER_BAD_FIELD_ERROR") throw err;
      }
    }

    await conn.commit();
    return { status: 200, message: "Delivery rescheduled successfully." };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function changeDeliveryItems(userId, subscriberId, date, time, items) {
  const sub = await fetchSubscriberForCustomer(userId, subscriberId);
  if (!sub) return { status: 404, message: "Subscription not found." };
  const check = await assertSlotModifiable(sub, date, time);
  if (!check.ok) return { status: check.status, message: check.message };

  const validated = await validateItemsForPlan(sub.plan_id, sub.restaurant_id, sub.tenant_id, items);
  if (!validated.ok) return { status: 400, message: validated.message };

  const nameById = new Map(
    validated.planItems.map((p) => [Number(p.menu_item_id), p.menu_item_name])
  );
  const assignmentItems = validated.items.map((i) => ({
    menuItemId: i.menuItemId,
    quantity: i.quantity,
    menuItemName: nameById.get(i.menuItemId),
  }));

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const daysJson = updateAssignmentInSchedule(sub.delivery_days_json, date, time, (row) => ({
      ...row,
      date,
      time: normalizeSlotTime(time),
      items: assignmentItems,
    }));
    await conn.execute("UPDATE subscription_subscribers SET delivery_days_json = ? WHERE id = ?", [
      daysJson,
      sub.id,
    ]);

    if (check.order) {
      await conn.execute("DELETE FROM order_items WHERE order_id = ?", [check.order.id]);
      for (const it of validated.items) {
        await conn.execute(
          "INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price) SELECT ?, id, ?, price FROM menu_items WHERE id = ?",
          [check.order.id, it.quantity, it.menuItemId]
        );
      }
    }

    await conn.commit();
    return { status: 200, message: "Delivery items updated successfully." };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  listUpcomingDeliveries,
  cancelDelivery,
  rescheduleDelivery,
  changeDeliveryItems,
};
