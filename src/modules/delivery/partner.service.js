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

function incrementLetterSeries(series) {
  let a = series.charCodeAt(0);
  let b = series.charCodeAt(1);
  if (b < 90) return String.fromCharCode(a) + String.fromCharCode(b + 1);
  if (a < 90) return String.fromCharCode(a + 1) + "A";
  return "AA";
}

async function allocateEmployeeId(conn, restaurantId) {
  const [existing] = await conn.execute(
    "SELECT letter_series, next_number FROM partner_employee_id_counters WHERE restaurant_id = ? FOR UPDATE",
    [restaurantId]
  );

  let letterSeries = "AA";
  let nextNumber = 1;

  if (existing[0]) {
    letterSeries = existing[0].letter_series;
    nextNumber = Number(existing[0].next_number);
  } else {
    await conn.execute(
      "INSERT INTO partner_employee_id_counters (restaurant_id, letter_series, next_number) VALUES (?, 'AA', 1)",
      [restaurantId]
    );
  }

  const employeeId = `FAR-R${restaurantId}-${letterSeries}-${String(nextNumber).padStart(4, "0")}`;
  let updatedSeries = letterSeries;
  let updatedNumber = nextNumber + 1;
  if (updatedNumber > 9999) {
    updatedNumber = 1;
    updatedSeries = incrementLetterSeries(letterSeries);
  }

  await conn.execute(
    "UPDATE partner_employee_id_counters SET letter_series = ?, next_number = ? WHERE restaurant_id = ?",
    [updatedSeries, updatedNumber, restaurantId]
  );

  return employeeId;
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

/**
 * Ensure a restaurant assignable-partner profile exists for a staff Delivery Person
 * (or any delivery user with login). Required fields use staff placeholders when
 * KYC docs were not collected via Subscriptions → Delivery Partners.
 */
async function ensureRestaurantDeliveryPartnerProfile(
  conn,
  { tenantId, restaurantId, userId, phone = null, isActive = true }
) {
  if (!tenantId || !restaurantId || !userId) return null;

  const [[existing]] = await conn.execute(
    `SELECT id, delivery_partner_id, is_active
     FROM restaurant_delivery_partner_profiles
     WHERE restaurant_id = ? AND user_id = ?
     LIMIT 1`,
    [restaurantId, userId]
  );

  const deliveryPartnerId = await ensureDeliveryPartnerRow(conn, tenantId, userId);

  if (existing) {
    const fields = ["delivery_partner_id = ?"];
    const values = [deliveryPartnerId];
    if (phone) {
      fields.push("phone = COALESCE(NULLIF(phone, ''), ?)");
      values.push(phone);
    }
    fields.push("is_active = ?");
    values.push(isActive ? 1 : 0);
    values.push(existing.id);
    await conn.execute(
      `UPDATE restaurant_delivery_partner_profiles SET ${fields.join(", ")} WHERE id = ?`,
      values
    );
    return existing.id;
  }

  const employeeId = await allocateEmployeeId(conn, restaurantId);
  const placeholderAadhaar = `9${String(userId).padStart(11, "0")}`.slice(0, 12);
  const [result] = await conn.execute(
    `INSERT INTO restaurant_delivery_partner_profiles
      (tenant_id, restaurant_id, user_id, delivery_partner_id, employee_id, phone, address,
       aadhaar_number, aadhaar_front_url, aadhaar_back_url, profile_pic_url, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      tenantId,
      restaurantId,
      userId,
      deliveryPartnerId,
      employeeId,
      phone || null,
      "Registered via Staff (Delivery Person)",
      placeholderAadhaar,
      "staff://not-provided",
      "staff://not-provided",
      isActive ? 1 : 0,
    ]
  );
  return result.insertId;
}

/**
 * Sync Staff → Delivery Person accounts into restaurant_delivery_partner_profiles
 * so owners can Assign-to-partner from Orders without re-registering under Subscriptions.
 */
async function syncRestaurantDeliveryStaffPartners(connOrPool, restaurantId) {
  const rid = Number(restaurantId);
  if (!rid) return { synced: 0 };

  const run = async (conn) => {
    const [staffRows] = await conn.execute(
      `SELECT rs.id, rs.tenant_id, rs.restaurant_id, rs.user_id, rs.phone, rs.is_active
       FROM restaurant_staff rs
       INNER JOIN users u ON u.id = rs.user_id
       WHERE rs.restaurant_id = ?
         AND rs.staff_role = 'DELIVERY_PERSON'
         AND rs.user_id IS NOT NULL
         AND rs.has_app_login = 1
         AND u.role = 'DELIVERY_PARTNER'`,
      [rid]
    );

    let synced = 0;
    for (const row of staffRows) {
      if (!row.tenant_id) continue;
      await ensureRestaurantDeliveryPartnerProfile(conn, {
        tenantId: Number(row.tenant_id),
        restaurantId: Number(row.restaurant_id),
        userId: Number(row.user_id),
        phone: row.phone,
        isActive: Boolean(row.is_active),
      });
      synced += 1;
    }
    return { synced };
  };

  // Prefer an explicit transaction when caller passed a pool (FOR UPDATE on employee ids).
  if (typeof connOrPool.getConnection === "function") {
    const conn = await connOrPool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await run(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  return run(connOrPool);
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
  allocateEmployeeId,
  ensureDeliveryPartnerRow,
  ensureRestaurantDeliveryPartnerProfile,
  syncRestaurantDeliveryStaffPartners,
  ensureProfileDeliveryPartnerId,
  getPartnerIdForUser,
  resolvePartnerIdForSubscriber,
  provisionSubscriberDelivery,
  syncPartnerSubscriberDeliveries,
};
