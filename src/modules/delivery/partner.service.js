/**
 * Delivery partner resolution and subscription → delivery provisioning.
 */

function parseScheduleDates(raw) {
  if (!raw) return [];
  try {
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(data)) {
      return data.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    }
    if (data && typeof data === "object") {
      const dates = new Set();
      for (const iso of data.dates || []) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) dates.add(iso);
      }
      for (const range of data.ranges || []) {
        if (!range?.from || !range?.to) continue;
        const start = new Date(range.from);
        const end = new Date(range.to);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) continue;
        const cursor = new Date(start);
        while (cursor <= end) {
          const y = cursor.getFullYear();
          const m = String(cursor.getMonth() + 1).padStart(2, "0");
          const d = String(cursor.getDate()).padStart(2, "0");
          dates.add(`${y}-${m}-${d}`);
          cursor.setDate(cursor.getDate() + 1);
        }
      }
      return [...dates];
    }
  } catch {
    /* ignore */
  }
  return [];
}

function parseScheduleObject(raw) {
  if (!raw) return null;
  try {
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch {
    /* ignore */
  }
  return null;
}

function getAssignmentsForDate(daysJson, isoDate) {
  const data = parseScheduleObject(daysJson);
  if (!data?.assignments?.length) return [];
  return data.assignments.filter((a) => a?.date === isoDate && Array.isArray(a.items) && a.items.length);
}

function assignmentDatesFromJson(daysJson) {
  const data = parseScheduleObject(daysJson);
  if (!data?.assignments?.length) return [];
  return [...new Set(data.assignments.map((a) => a?.date).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))];
}

function isDeliveryScheduledForDate(frequency, daysJson, isoDate) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return false;
  const freq = String(frequency || "EVERY_DAY").toUpperCase();
  if (freq === "EVERY_DAY") return true;
  const d = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(d.getTime())) return false;
  const dow = d.getDay();
  if (freq === "WEEKDAYS") return dow >= 1 && dow <= 5;
  if (freq === "CUSTOM") {
    const dates = new Set(parseScheduleDates(daysJson));
    for (const ad of assignmentDatesFromJson(daysJson)) dates.add(ad);
    return dates.has(isoDate);
  }
  return false;
}

function normalizeSlotTime(t) {
  if (!t) return "12:00";
  const s = String(t).trim().slice(0, 5);
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return "12:00";
  return `${String(Number(m[1])).padStart(2, "0")}:${m[2]}`;
}

async function ensureDeliveryPartnerRow(conn, tenantId, userId) {
  const [existing] = await conn.execute(
    "SELECT id FROM delivery_partners WHERE tenant_id = ? AND user_id = ? LIMIT 1",
    [tenantId, userId]
  );
  if (existing[0]) return existing[0].id;
  const [result] = await conn.execute(
    "INSERT INTO delivery_partners (tenant_id, user_id, is_available) VALUES (?, ?, 1)",
    [tenantId, userId]
  );
  return result.insertId;
}

async function ensureProfileDeliveryPartnerId(conn, tenantId, profileId) {
  const [[profile]] = await conn.execute(
    `SELECT id, user_id, delivery_partner_id
     FROM restaurant_delivery_partner_profiles
     WHERE id = ? AND tenant_id = ? LIMIT 1`,
    [profileId, tenantId]
  );
  if (!profile) return null;
  if (profile.delivery_partner_id) return profile.delivery_partner_id;
  const dpId = await ensureDeliveryPartnerRow(conn, tenantId, profile.user_id);
  await conn.execute(
    "UPDATE restaurant_delivery_partner_profiles SET delivery_partner_id = ? WHERE id = ?",
    [dpId, profileId]
  );
  return dpId;
}

async function getPartnerIdForUser(conn, tenantId, userId) {
  const db = conn;
  const [rows] = await db.execute(
    "SELECT id FROM delivery_partners WHERE tenant_id = ? AND user_id = ? LIMIT 1",
    [tenantId, userId]
  );
  if (rows[0]) return rows[0].id;

  const [profiles] = await db.execute(
    `SELECT id, delivery_partner_id FROM restaurant_delivery_partner_profiles
     WHERE tenant_id = ? AND user_id = ? AND is_active = 1`,
    [tenantId, userId]
  );
  if (!profiles.length) return null;

  for (const profile of profiles) {
    if (profile.delivery_partner_id) return profile.delivery_partner_id;
    const dpId = await ensureDeliveryPartnerRow(db, tenantId, userId);
    await db.execute(
      "UPDATE restaurant_delivery_partner_profiles SET delivery_partner_id = ? WHERE id = ?",
      [dpId, profile.id]
    );
    return dpId;
  }
  return null;
}

async function resolvePartnerIdForSubscriber(conn, tenantId, customerUserId, restaurantId) {
  const [[sub]] = await conn.execute(
    `SELECT s.delivery_partner_profile_id, p.user_id AS profile_user_id, p.delivery_partner_id AS profile_dp_id
     FROM subscription_subscribers s
     LEFT JOIN restaurant_delivery_partner_profiles p ON p.id = s.delivery_partner_profile_id
     WHERE s.user_id = ? AND s.restaurant_id = ? AND s.status = 'ACTIVE'
     LIMIT 1`,
    [customerUserId, restaurantId]
  );
  if (!sub?.delivery_partner_profile_id) return null;
  if (sub.profile_dp_id) return sub.profile_dp_id;
  if (sub.profile_user_id) {
    return ensureProfileDeliveryPartnerId(conn, tenantId, sub.delivery_partner_profile_id);
  }
  return null;
}

async function hasDeliveryForSubscriberSlot(conn, tenantId, customerUserId, restaurantId, isoDate, slotTime) {
  const time = normalizeSlotTime(slotTime);
  try {
    const [rows] = await conn.execute(
      `SELECT d.id
       FROM deliveries d
       INNER JOIN orders o ON o.id = d.order_id
       WHERE d.tenant_id = ? AND o.customer_user_id = ? AND o.restaurant_id = ?
         AND o.order_type = 'DELIVERY'
         AND COALESCE(o.scheduled_delivery_date, DATE(o.created_at)) = ?
         AND COALESCE(o.scheduled_delivery_time, '12:00') = ?
       LIMIT 1`,
      [tenantId, customerUserId, restaurantId, isoDate, time]
    );
    return Boolean(rows[0]);
  } catch (err) {
    if (err?.code !== "ER_BAD_FIELD_ERROR") throw err;
    const [rows] = await conn.execute(
      `SELECT d.id
       FROM deliveries d
       INNER JOIN orders o ON o.id = d.order_id
       WHERE d.tenant_id = ? AND o.customer_user_id = ? AND o.restaurant_id = ?
         AND o.order_type = 'DELIVERY' AND DATE(o.created_at) = ?
       LIMIT 1`,
      [tenantId, customerUserId, restaurantId, isoDate]
    );
    return Boolean(rows[0]);
  }
}

async function insertDeliveryOrder(conn, tenantId, restaurantId, userId, isoDate, slotTime) {
  const time = normalizeSlotTime(slotTime);
  try {
    const [created] = await conn.execute(
      `INSERT INTO orders
        (tenant_id, restaurant_id, customer_user_id, table_id, order_type, status,
         scheduled_delivery_date, scheduled_delivery_time)
       VALUES (?, ?, ?, NULL, 'DELIVERY', 'PLACED', ?, ?)`,
      [tenantId, restaurantId, userId, isoDate, time]
    );
    return created.insertId;
  } catch (error) {
    if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
    const [created] = await conn.execute(
      "INSERT INTO orders (tenant_id, restaurant_id, customer_user_id, order_type, status) VALUES (?, ?, ?, 'DELIVERY', 'PLACED')",
      [tenantId, restaurantId, userId]
    );
    return created.insertId;
  }
}

async function provisionSubscriberDelivery(conn, tenantId, subscriberId, isoDate, io) {
  const [[sub]] = await conn.execute(
    `SELECT s.id, s.user_id, s.restaurant_id, s.plan_id, s.status, s.delivery_frequency, s.delivery_days_json,
            s.delivery_partner_profile_id
     FROM subscription_subscribers s
     WHERE s.id = ? AND s.tenant_id = ?
     LIMIT 1`,
    [subscriberId, tenantId]
  );
  if (!sub || sub.status !== "ACTIVE" || !sub.delivery_partner_profile_id) {
    return { skipped: true, reason: "inactive_or_no_partner" };
  }
  if (!isDeliveryScheduledForDate(sub.delivery_frequency, sub.delivery_days_json, isoDate)) {
    return { skipped: true, reason: "not_scheduled_for_date" };
  }

  const partnerId = await ensureProfileDeliveryPartnerId(conn, tenantId, sub.delivery_partner_profile_id);
  if (!partnerId) return { skipped: true, reason: "no_partner" };

  const assignmentSlots = getAssignmentsForDate(sub.delivery_days_json, isoDate);
  const slotsToFulfill =
    assignmentSlots.length > 0
      ? assignmentSlots
      : [{ date: isoDate, time: "12:00", items: null }];

  const createdOrders = [];

  for (const slot of slotsToFulfill) {
    const slotTime = normalizeSlotTime(slot.time);
    if (await hasDeliveryForSubscriberSlot(conn, tenantId, sub.user_id, sub.restaurant_id, isoDate, slotTime)) {
      continue;
    }

    let menuRows = [];
    if (slot.items?.length) {
      const ids = slot.items.map((i) => Number(i.menuItemId)).filter(Boolean);
      if (ids.length) {
        const placeholders = ids.map(() => "?").join(",");
        const [rows] = await conn.execute(
          `SELECT id, price FROM menu_items WHERE id IN (${placeholders}) AND restaurant_id = ? AND is_active = 1`,
          [...ids, sub.restaurant_id]
        );
        const priceById = Object.fromEntries(rows.map((r) => [r.id, r.price]));
        menuRows = slot.items
          .map((i) => ({
            id: Number(i.menuItemId),
            quantity: Math.max(1, Number(i.quantity) || 1),
            price: priceById[Number(i.menuItemId)],
          }))
          .filter((r) => r.price != null);
      }
    }

    if (!menuRows.length && sub.plan_id) {
      const [fromPlan] = await conn.execute(
        `SELECT spi.menu_item_id AS id, spi.quantity, mi.price
         FROM subscription_plan_items spi
         INNER JOIN menu_items mi ON mi.id = spi.menu_item_id
         WHERE spi.plan_id = ? AND mi.is_active = 1`,
        [sub.plan_id]
      );
      menuRows = fromPlan;
    }

    if (!menuRows.length) {
      let fallback;
      [fallback] = await conn.execute(
        `SELECT id, price, 1 AS quantity FROM menu_items
         WHERE restaurant_id = ? AND is_active = 1 AND is_available = 1
         ORDER BY id ASC LIMIT 1`,
        [sub.restaurant_id]
      );
      if (!fallback[0]) {
        [fallback] = await conn.execute(
          `SELECT id, price, 1 AS quantity FROM menu_items
           WHERE restaurant_id = ? AND is_active = 1
           ORDER BY id ASC LIMIT 1`,
          [sub.restaurant_id]
        );
      }
      menuRows = fallback;
    }
    if (!menuRows.length) {
      return { skipped: true, reason: "no_menu_items" };
    }

    const orderId = await insertDeliveryOrder(
      conn,
      tenantId,
      sub.restaurant_id,
      sub.user_id,
      isoDate,
      slotTime
    );
    for (const item of menuRows) {
      const qty = Math.max(1, Number(item.quantity) || 1);
      await conn.execute(
        "INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price) VALUES (?, ?, ?, ?)",
        [orderId, item.id, qty, item.price]
      );
    }

    const [deliveryResult] = await conn.execute(
      "INSERT INTO deliveries (tenant_id, order_id, delivery_partner_id, status, eta_minutes) VALUES (?, ?, ?, 'ASSIGNED', 30)",
      [tenantId, orderId, partnerId]
    );

    if (io) {
      io.to(`tenant:${tenantId}`).emit("delivery:assigned", {
        deliveryId: deliveryResult.insertId,
        orderId,
        deliveryPartnerId: partnerId,
      });
      io.to(`tenant:${tenantId}`).emit("order:created", { orderId, status: "PLACED" });
    }

    createdOrders.push({
      orderId,
      deliveryId: deliveryResult.insertId,
      time: slotTime,
      date: isoDate,
    });
  }

  if (!createdOrders.length) {
    return { skipped: true, reason: "already_exists" };
  }
  return { created: true, orders: createdOrders };
}

async function syncPartnerSubscriberDeliveries(conn, tenantId, partnerId, isoDate, io) {
  const [subscribers] = await conn.execute(
    `SELECT s.id
     FROM subscription_subscribers s
     INNER JOIN restaurant_delivery_partner_profiles p ON p.id = s.delivery_partner_profile_id
     WHERE s.tenant_id = ? AND s.status = 'ACTIVE' AND p.delivery_partner_id = ?`,
    [tenantId, partnerId]
  );
  const results = [];
  for (const row of subscribers) {
    const r = await provisionSubscriberDelivery(conn, tenantId, row.id, isoDate, io);
    results.push({ subscriberId: row.id, ...r });
  }
  return results;
}

module.exports = {
  isDeliveryScheduledForDate,
  ensureDeliveryPartnerRow,
  ensureProfileDeliveryPartnerId,
  getPartnerIdForUser,
  resolvePartnerIdForSubscriber,
  provisionSubscriberDelivery,
  syncPartnerSubscriberDeliveries,
};
