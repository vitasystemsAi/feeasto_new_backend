const express = require("express");
const { z } = require("zod");
const pool = require("../../db/pool");
const auth = require("../../middlewares/auth");
const rbac = require("../../middlewares/rbac");
const tenantScope = require("../../middlewares/tenant");
const {
  getPartnerIdForUser: resolvePartnerIdForUser,
  resolvePartnerIdForSubscriber,
  syncPartnerSubscriberDeliveries,
  isDeliveryScheduledForDate,
} = require("./partner.service");
const { buildStatusPayload, getOwnerNextActions } = require("../../utils/orderStatus");
const {
  parseCoord,
  isWithinDeliveryRadius,
  isWithinRestaurantPickupRadius,
  DELIVERY_ARRIVAL_RADIUS_M,
  RESTAURANT_PICKUP_RADIUS_M,
} = require("../../utils/geo");

const ORDER_STATUS_BY_DELIVERY = {
  ACCEPTED: "ACCEPTED",
  PICKED_UP: "OUT_FOR_DELIVERY",
  DELIVERED: "DELIVERED",
};

function formatCustomerDeliveryAddress(address, pincode) {
  const parts = [address, pincode].map((p) => (p != null ? String(p).trim() : "")).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function isOrderHandedToDriver(orderStatus) {
  const o = String(orderStatus || "").toUpperCase();
  return o === "OUT_FOR_DELIVERY" || o === "DELIVERED";
}

function enrichPartnerAssignment(row) {
  const orderStatus = String(row.order_status || "").toUpperCase();
  const deliveryStatus = String(row.delivery_status || "").toUpperCase();
  const handedOff = isOrderHandedToDriver(orderStatus);
  const customerDeliveryAddress =
    row.order_delivery_address ||
    formatCustomerDeliveryAddress(row.customer_address, row.customer_pincode) ||
    row.delivery_address ||
    null;
  const navigateToCustomer = deliveryStatus === "PICKED_UP" || deliveryStatus === "DELIVERED";

  const restaurant_latitude = parseCoord(row.restaurant_latitude);
  const restaurant_longitude = parseCoord(row.restaurant_longitude);
  const order_delivery_latitude = parseCoord(row.order_delivery_latitude);
  const order_delivery_longitude = parseCoord(row.order_delivery_longitude);
  const customer_home_latitude = parseCoord(row.customer_home_latitude);
  const customer_home_longitude = parseCoord(row.customer_home_longitude);

  const customer_latitude = navigateToCustomer
    ? order_delivery_latitude ?? customer_home_latitude
    : null;
  const customer_longitude = navigateToCustomer
    ? order_delivery_longitude ?? customer_home_longitude
    : null;

  return {
    ...row,
    customer_delivery_address: customerDeliveryAddress,
    customer_contact_visible: handedOff,
    customer_name: handedOff ? row.customer_name : null,
    customer_phone: handedOff ? row.customer_phone : null,
    directions_mode: navigateToCustomer ? "customer" : "restaurant",
    restaurant_latitude,
    restaurant_longitude,
    customer_latitude,
    customer_longitude,
    can_pickup: handedOff && deliveryStatus === "ACCEPTED",
  };
}

function deliveryRouter(io) {
  const router = express.Router();

  router.post("/auto-assign/:orderId", auth(), tenantScope, rbac("MANAGER", "OWNER", "ADMIN"), async (req, res) => {
    const orderId = Number(req.params.orderId);
    const [partners] = await pool.execute(
      "SELECT id FROM delivery_partners WHERE tenant_id = ? AND is_available = 1 ORDER BY current_rating DESC LIMIT 1",
      [req.tenantId]
    );
    const partner = partners[0];
    if (!partner) return res.status(404).json({ message: "No available delivery partner" });

    const [existing] = await pool.execute("SELECT id FROM deliveries WHERE order_id = ? LIMIT 1", [orderId]);
    if (existing[0]) {
      return res.json({ message: "Delivery already assigned", deliveryId: existing[0].id });
    }

    const [result] = await pool.execute(
      "INSERT INTO deliveries (tenant_id, order_id, delivery_partner_id, status, eta_minutes) VALUES (?, ?, ?, 'ASSIGNED', 25)",
      [req.tenantId, orderId, partner.id]
    );
    if (io) {
      io.to(`tenant:${req.tenantId}`).emit("delivery:assigned", {
        deliveryId: result.insertId,
        orderId,
        deliveryPartnerId: partner.id,
      });
    }
    return res.json({ message: "Delivery auto-assigned", deliveryId: result.insertId, deliveryPartnerId: partner.id, etaMinutes: 25 });
  });

  /** Owner/manager manually assigns (or reassigns) a delivery partner for an order. */
  router.post("/assign", auth(), rbac("OWNER", "MANAGER", "ADMIN"), async (req, res) => {
    const schema = z.object({
      orderId: z.coerce.number().int().positive(),
      deliveryPartnerProfileId: z.coerce.number().int().positive(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const orderId = parsed.data.orderId;
    const profileId = parsed.data.deliveryPartnerProfileId;

    const [[order]] = await pool.execute(
      `SELECT o.id, o.restaurant_id, o.tenant_id, o.order_type, o.status, o.customer_user_id, r.owner_user_id
       FROM orders o
       INNER JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.id = ?
       LIMIT 1`,
      [orderId]
    );
    if (!order) return res.status(404).json({ message: "Order not found." });
    const orderType = String(order.order_type || "").toUpperCase();
    if (!["DELIVERY", "TAKEAWAY"].includes(orderType)) {
      return res.status(400).json({ message: "Only delivery or takeaway orders can be assigned to a partner." });
    }
    const orderStatus = String(order.status || "").toUpperCase();
    if (orderStatus !== "READY") {
      return res.status(400).json({ message: "Mark the order as Ready before assigning a delivery partner." });
    }
    if (req.user.role === "OWNER" && Number(order.owner_user_id) !== Number(req.user.sub)) {
      return res.status(403).json({ message: "You can only assign partners for your own restaurants." });
    }

    const headerTenant = req.headers["x-tenant-id"] || req.user?.tenantId || null;
    if (req.user.role !== "OWNER") {
      if (!headerTenant || Number(order.tenant_id) !== Number(headerTenant)) {
        return res.status(404).json({ message: "Order not found." });
      }
    }

    const tenantId = Number(order.tenant_id);

    const [[profile]] = await pool.execute(
      `SELECT p.id, p.delivery_partner_id, p.restaurant_id, p.is_active, p.user_id
       FROM restaurant_delivery_partner_profiles p
       WHERE p.id = ? AND p.restaurant_id = ?
       LIMIT 1`,
      [profileId, order.restaurant_id]
    );
    if (!profile || !profile.is_active) {
      return res.status(400).json({ message: "Invalid or inactive delivery partner for this restaurant." });
    }
    if (!profile.delivery_partner_id) {
      return res.status(400).json({ message: "Delivery partner record is incomplete. Re-register the partner." });
    }

    const partnerId = Number(profile.delivery_partner_id);
    const [existing] = await pool.execute("SELECT id, status FROM deliveries WHERE order_id = ? LIMIT 1", [
      orderId,
    ]);

    let deliveryId;
    if (existing[0]) {
      const current = String(existing[0].status || "").toUpperCase();
      if (current === "DELIVERED") {
        return res.status(400).json({ message: "Cannot reassign a completed delivery." });
      }
      deliveryId = existing[0].id;
      await pool.execute(
        "UPDATE deliveries SET delivery_partner_id = ?, status = 'ASSIGNED', tenant_id = ? WHERE id = ?",
        [partnerId, tenantId, deliveryId]
      );
    } else {
      const [result] = await pool.execute(
        "INSERT INTO deliveries (tenant_id, order_id, delivery_partner_id, status, eta_minutes) VALUES (?, ?, ?, 'ASSIGNED', 30)",
        [tenantId, orderId, partnerId]
      );
      deliveryId = result.insertId;
    }

    await pool.execute(
      "UPDATE orders SET status = 'OUT_FOR_DELIVERY' WHERE id = ? AND status = 'READY'",
      [orderId]
    );

    const [[partnerUser]] = await pool.execute(
      `SELECT u.full_name AS delivery_partner_name
       FROM restaurant_delivery_partner_profiles p
       INNER JOIN users u ON u.id = p.user_id
       WHERE p.id = ? LIMIT 1`,
      [profileId]
    );

    const statusPayload = buildStatusPayload("OUT_FOR_DELIVERY", "ASSIGNED");
    const ownerActions = getOwnerNextActions("OUT_FOR_DELIVERY", orderType, {
      hasDeliveryPartner: true,
    });
    const assignPayload = {
      orderId,
      status: "OUT_FOR_DELIVERY",
      deliveryPartnerProfileId: profileId,
      deliveryPartnerName: partnerUser?.delivery_partner_name || null,
      owner_next_actions: ownerActions,
      can_cancel: false,
      cancel_deadline_at: null,
      ...statusPayload,
    };

    if (io) {
      io.to(`tenant:${tenantId}`).emit("delivery:assigned", {
        deliveryId,
        orderId,
        deliveryPartnerId: partnerId,
        deliveryPartnerProfileId: profileId,
      });
      io.to(`tenant:${tenantId}`).emit("delivery:updated", {
        orderId,
        deliveryStatus: "ASSIGNED",
        deliveryPartnerProfileId: profileId,
        deliveryPartnerName: partnerUser?.delivery_partner_name || null,
      });
      io.to(`tenant:${tenantId}`).emit("order:status-updated", assignPayload);
      if (order.customer_user_id) {
        io.to(`user:${order.customer_user_id}`).emit("order:status-updated", assignPayload);
      }
      if (profile.user_id) {
        io.to(`user:${profile.user_id}`).emit("delivery:assigned", {
          deliveryId,
          orderId,
          deliveryPartnerId: partnerId,
          deliveryPartnerProfileId: profileId,
        });
      }
    }

    return res.json({
      message: "Delivery partner assigned.",
      deliveryId,
      deliveryPartnerId: partnerId,
      deliveryPartnerProfileId: profileId,
      deliveryPartnerName: partnerUser?.delivery_partner_name || null,
      orderId,
      status: "OUT_FOR_DELIVERY",
      owner_next_actions: ownerActions,
      ...statusPayload,
    });
  });

  router.patch("/:deliveryId/decision", auth(), rbac("DELIVERY_PARTNER"), async (req, res) => {
    const accepted = Boolean(req.body.accepted);
    await pool.execute("UPDATE deliveries SET status = ? WHERE id = ?", [
      accepted ? "ACCEPTED" : "REJECTED",
      Number(req.params.deliveryId),
    ]);
    return res.json({ message: accepted ? "Delivery accepted" : "Delivery rejected" });
  });

  /** List assignments for the logged-in delivery partner (date filter on order date). */
  router.get("/partner/assignments", auth(), tenantScope, rbac("DELIVERY_PARTNER"), async (req, res) => {
    const partnerId = await resolvePartnerIdForUser(pool, req.tenantId, req.user.sub);
    if (!partnerId) {
      return res.status(404).json({ message: "Delivery partner profile not found for your account." });
    }

    const dateParam = String(req.query.date || "").trim();
    const dateFilter = /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : null;

    if (dateFilter) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await syncPartnerSubscriberDeliveries(conn, req.tenantId, partnerId, dateFilter, io);
        await conn.commit();
      } catch (syncErr) {
        await conn.rollback();
        console.error("syncPartnerSubscriberDeliveries:", syncErr.message);
      } finally {
        conn.release();
      }
    }

    let sql = `
      SELECT d.id AS delivery_id, d.status AS delivery_status, d.eta_minutes, d.delivery_partner_id,
             o.id AS order_id, o.status AS order_status, o.order_type, o.created_at AS order_created_at,
             o.scheduled_delivery_date, o.scheduled_delivery_time,
             o.delivery_address AS order_delivery_address,
             o.delivery_latitude AS order_delivery_latitude,
             o.delivery_longitude AS order_delivery_longitude,
             r.id AS restaurant_id, r.name AS restaurant_name, r.address AS restaurant_address,
             r.latitude AS restaurant_latitude, r.longitude AS restaurant_longitude,
             cu.full_name AS customer_name, cu.email AS customer_email,
             cu.home_latitude AS customer_home_latitude, cu.home_longitude AS customer_home_longitude,
             COALESCE(o.customer_contact_phone, sub.phone) AS customer_phone,
             sub.address AS customer_address, sub.pincode AS customer_pincode,
             dp.current_lat AS partner_lat, dp.current_lng AS partner_lng,
             p.employee_id AS partner_employee_id
      FROM deliveries d
      INNER JOIN orders o ON o.id = d.order_id
      INNER JOIN restaurants r ON r.id = o.restaurant_id
      INNER JOIN users cu ON cu.id = o.customer_user_id
      INNER JOIN delivery_partners dp ON dp.id = d.delivery_partner_id
      LEFT JOIN restaurant_delivery_partner_profiles p ON p.user_id = dp.user_id AND p.restaurant_id = o.restaurant_id
      LEFT JOIN subscription_subscribers sub ON sub.user_id = o.customer_user_id AND sub.restaurant_id = o.restaurant_id
      WHERE d.tenant_id = ? AND d.delivery_partner_id = ?
    `;
    const params = [req.tenantId, partnerId];
    if (dateFilter) {
      sql += " AND COALESCE(o.scheduled_delivery_date, DATE(o.created_at)) = ?";
      params.push(dateFilter);
    }
    sql += " ORDER BY o.created_at DESC";

    const [rows] = await pool.execute(sql, params);

    const orderIds = rows.map((r) => r.order_id);
    let itemsByOrder = {};
    if (orderIds.length) {
      const placeholders = orderIds.map(() => "?").join(",");
      const [items] = await pool.execute(
        `SELECT oi.order_id, mi.name, oi.quantity, oi.unit_price
         FROM order_items oi
         JOIN menu_items mi ON mi.id = oi.menu_item_id
         WHERE oi.order_id IN (${placeholders})`,
        orderIds
      );
      itemsByOrder = items.reduce((acc, row) => {
        const oid = row.order_id;
        if (!acc[oid]) acc[oid] = [];
        acc[oid].push({
          name: row.name,
          quantity: row.quantity,
          unit_price: row.unit_price,
        });
        return acc;
      }, {});
    }

    const assignments = rows.map((row) => {
      const enriched = enrichPartnerAssignment(row);
      return {
        ...enriched,
        items: itemsByOrder[row.order_id] || [],
        line_total: (itemsByOrder[row.order_id] || []).reduce(
          (sum, it) => sum + Number(it.quantity) * Number(it.unit_price),
          0
        ),
      };
    });

    let subscriptionTasks = [];
    if (dateFilter) {
      const [subs] = await pool.execute(
        `SELECT s.id AS subscriber_id, s.delivery_frequency, s.delivery_days_json,
                u.full_name AS customer_name, s.phone AS customer_phone,
                r.name AS restaurant_name, r.address AS delivery_address, pl.name AS plan_name
         FROM subscription_subscribers s
         INNER JOIN users u ON u.id = s.user_id
         INNER JOIN restaurants r ON r.id = s.restaurant_id
         INNER JOIN subscription_plans pl ON pl.id = s.plan_id
         INNER JOIN restaurant_delivery_partner_profiles p ON p.id = s.delivery_partner_profile_id
         WHERE s.tenant_id = ? AND s.status = 'ACTIVE' AND p.delivery_partner_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM deliveries d
             INNER JOIN orders o ON o.id = d.order_id
             WHERE o.customer_user_id = s.user_id AND o.restaurant_id = s.restaurant_id
               AND o.order_type = 'DELIVERY'
               AND COALESCE(o.scheduled_delivery_date, DATE(o.created_at)) = ?
           )`,
        [req.tenantId, partnerId, dateFilter]
      );
      subscriptionTasks = subs
        .filter((s) => isDeliveryScheduledForDate(s.delivery_frequency, s.delivery_days_json, dateFilter))
        .map((s) => ({
          ...s,
          assignment_type: "SUBSCRIPTION",
          delivery_status: "SCHEDULED",
        }));
    }

    return res.json({ partnerId, date: dateFilter, assignments, subscriptionTasks });
  });

  router.get("/partner/assignments/:deliveryId", auth(), tenantScope, rbac("DELIVERY_PARTNER"), async (req, res) => {
    const partnerId = await resolvePartnerIdForUser(pool, req.tenantId, req.user.sub);
    if (!partnerId) return res.status(404).json({ message: "Delivery partner profile not found." });

    const deliveryId = Number(req.params.deliveryId);
    const [rows] = await pool.execute(
      `SELECT d.id AS delivery_id, d.status AS delivery_status, d.eta_minutes,
              o.id AS order_id, o.status AS order_status, o.created_at AS order_created_at,
              r.name AS restaurant_name, r.address AS restaurant_address,
              cu.full_name AS customer_name,
              COALESCE(o.customer_contact_phone, sub.phone) AS customer_phone,
              sub.address AS customer_address, sub.pincode AS customer_pincode,
              dp.current_lat AS partner_lat, dp.current_lng AS partner_lng
       FROM deliveries d
       INNER JOIN orders o ON o.id = d.order_id
       INNER JOIN restaurants r ON r.id = o.restaurant_id
       INNER JOIN users cu ON cu.id = o.customer_user_id
       INNER JOIN delivery_partners dp ON dp.id = d.delivery_partner_id
       LEFT JOIN subscription_subscribers sub ON sub.user_id = o.customer_user_id AND sub.restaurant_id = o.restaurant_id
       WHERE d.id = ? AND d.delivery_partner_id = ? AND d.tenant_id = ?
       LIMIT 1`,
      [deliveryId, partnerId, req.tenantId]
    );
    if (!rows[0]) return res.status(404).json({ message: "Assignment not found" });
    return res.json(enrichPartnerAssignment(rows[0]));
  });

  router.patch("/partner/assignments/:deliveryId/action", auth(), tenantScope, rbac("DELIVERY_PARTNER"), async (req, res) => {
    const schema = z.object({
      action: z.enum(["accept", "reject", "pickup", "delivered"]),
      lat: z.coerce.number().min(-90).max(90).optional(),
      lng: z.coerce.number().min(-180).max(180).optional(),
      confirmDeliverAnyway: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const partnerId = await resolvePartnerIdForUser(pool, req.tenantId, req.user.sub);
    if (!partnerId) return res.status(404).json({ message: "Delivery partner profile not found." });

    const deliveryId = Number(req.params.deliveryId);
    const [[row]] = await pool.execute(
      `SELECT d.id, d.status, d.order_id, o.status AS order_status, o.customer_user_id,
              o.delivery_latitude AS order_delivery_latitude, o.delivery_longitude AS order_delivery_longitude,
              cu.home_latitude AS customer_home_latitude, cu.home_longitude AS customer_home_longitude,
              r.latitude AS restaurant_latitude, r.longitude AS restaurant_longitude,
              dp.current_lat AS partner_lat, dp.current_lng AS partner_lng
       FROM deliveries d
       INNER JOIN orders o ON o.id = d.order_id
       INNER JOIN restaurants r ON r.id = o.restaurant_id
       INNER JOIN users cu ON cu.id = o.customer_user_id
       INNER JOIN delivery_partners dp ON dp.id = d.delivery_partner_id
       WHERE d.id = ? AND d.delivery_partner_id = ? AND d.tenant_id = ?
       LIMIT 1`,
      [deliveryId, partnerId, req.tenantId]
    );
    if (!row) return res.status(404).json({ message: "Assignment not found" });

    const { action, confirmDeliverAnyway } = parsed.data;
    const current = String(row.status);
    let nextDeliveryStatus = null;
    let nextOrderStatus = null;

    if (action === "accept") {
      if (!["ASSIGNED"].includes(current)) {
        return res.status(400).json({ message: `Cannot accept from status ${current}` });
      }
      nextDeliveryStatus = "ACCEPTED";
      nextOrderStatus = null;
    } else if (action === "reject") {
      if (!["ASSIGNED", "ACCEPTED"].includes(current)) {
        return res.status(400).json({ message: `Cannot reject from status ${current}` });
      }
      nextDeliveryStatus = "REJECTED";
      nextOrderStatus = "CANCELLED";
    } else if (action === "pickup") {
      if (current !== "ACCEPTED") {
        return res.status(400).json({ message: "Accept the delivery first, then pick up at the restaurant." });
      }
      const orderSt = String(row.order_status || "").toUpperCase();
      if (!isOrderHandedToDriver(orderSt)) {
        return res.status(400).json({
          message: "This order is not ready for pickup yet. Wait until the restaurant assigns you.",
        });
      }

      const partnerLat = parsed.data.lat ?? row.partner_lat;
      const partnerLng = parsed.data.lng ?? row.partner_lng;
      const restaurantLat = parseCoord(row.restaurant_latitude);
      const restaurantLng = parseCoord(row.restaurant_longitude);
      const atRestaurant = isWithinRestaurantPickupRadius(
        partnerLat,
        partnerLng,
        restaurantLat,
        restaurantLng
      );

      if (atRestaurant.missingRestaurantCoords) {
        return res.status(400).json({
          message: "Restaurant location is not set. Contact the restaurant to update their address on the map.",
        });
      }
      if (atRestaurant.missingPartnerCoords) {
        return res.status(400).json({
          message: "Turn on location on your device so we can verify you are at the restaurant.",
        });
      }
      if (!atRestaurant.atLocation) {
        return res.status(409).json({
          notAtRestaurant: true,
          message: "You must be at the restaurant to pick up this order.",
        });
      }

      if (parsed.data.lat != null && parsed.data.lng != null) {
        await pool.execute("UPDATE delivery_partners SET current_lat = ?, current_lng = ? WHERE id = ?", [
          parsed.data.lat,
          parsed.data.lng,
          partnerId,
        ]);
      }

      nextDeliveryStatus = "PICKED_UP";
      if (["OUT_FOR_DELIVERY"].includes(orderSt)) {
        nextOrderStatus = ORDER_STATUS_BY_DELIVERY.PICKED_UP;
      }
    } else if (action === "delivered") {
      if (current !== "PICKED_UP") {
        return res.status(400).json({
          message: "Mark picked up at the restaurant before completing delivery.",
        });
      }

      const partnerLat = parsed.data.lat ?? row.partner_lat;
      const partnerLng = parsed.data.lng ?? row.partner_lng;
      const customerLat = parseCoord(row.order_delivery_latitude) ?? parseCoord(row.customer_home_latitude);
      const customerLng = parseCoord(row.order_delivery_longitude) ?? parseCoord(row.customer_home_longitude);
      const proximity = isWithinDeliveryRadius(partnerLat, partnerLng, customerLat, customerLng);

      if (proximity.missingCustomerCoords) {
        return res.status(400).json({
          message: "Customer delivery location is not set on this order. Contact the restaurant.",
        });
      }
      if (proximity.missingPartnerCoords) {
        return res.status(400).json({
          message: "Turn on location sharing (Live tracking) so we can verify you are at the delivery address.",
        });
      }
      if (!proximity.atLocation && !confirmDeliverAnyway) {
        return res.status(409).json({
          notAtLocation: true,
          message:
            "You are not at the delivery location. Move closer to the customer's address, or confirm you still want to mark this order as delivered.",
          distanceM: proximity.distanceM,
          requiredRadiusM: proximity.radiusM ?? DELIVERY_ARRIVAL_RADIUS_M,
        });
      }

      if (parsed.data.lat != null && parsed.data.lng != null) {
        await pool.execute("UPDATE delivery_partners SET current_lat = ?, current_lng = ? WHERE id = ?", [
          parsed.data.lat,
          parsed.data.lng,
          partnerId,
        ]);
      }

      nextDeliveryStatus = "DELIVERED";
      nextOrderStatus = ORDER_STATUS_BY_DELIVERY.DELIVERED;
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute("UPDATE deliveries SET status = ? WHERE id = ?", [nextDeliveryStatus, deliveryId]);
      if (nextOrderStatus) {
        await conn.execute("UPDATE orders SET status = ? WHERE id = ? AND tenant_id = ?", [
          nextOrderStatus,
          row.order_id,
          req.tenantId,
        ]);
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      return res.status(500).json({ message: "Failed to update delivery", details: error.message });
    } finally {
      conn.release();
    }

    const finalOrderStatus = nextOrderStatus || row.order_status;
    const statusPayload = buildStatusPayload(finalOrderStatus, nextDeliveryStatus);

    if (io) {
      const payload = {
        deliveryId,
        orderId: row.order_id,
        deliveryStatus: nextDeliveryStatus,
        orderStatus: finalOrderStatus,
        ...statusPayload,
      };
      io.to(`tenant:${req.tenantId}`).emit("delivery:updated", payload);
      io.to(`tenant:${req.tenantId}`).emit("order:status-updated", { orderId: row.order_id, ...payload });
      if (row.customer_user_id) {
        io.to(`user:${row.customer_user_id}`).emit("order:status-updated", { orderId: row.order_id, ...payload });
      }
    }

    return res.json({
      message: "Delivery updated",
      deliveryStatus: nextDeliveryStatus,
      orderStatus: finalOrderStatus,
      ...statusPayload,
    });
  });

  router.patch("/partner/location", auth(), tenantScope, rbac("DELIVERY_PARTNER"), async (req, res) => {
    const schema = z.object({
      lat: z.coerce.number().min(-90).max(90),
      lng: z.coerce.number().min(-180).max(180),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const partnerId = await resolvePartnerIdForUser(pool, req.tenantId, req.user.sub);
    if (!partnerId) return res.status(404).json({ message: "Delivery partner profile not found." });

    await pool.execute("UPDATE delivery_partners SET current_lat = ?, current_lng = ? WHERE id = ?", [
      parsed.data.lat,
      parsed.data.lng,
      partnerId,
    ]);

    if (io) {
      io.to(`tenant:${req.tenantId}`).emit("delivery:location", {
        deliveryPartnerId: partnerId,
        lat: parsed.data.lat,
        lng: parsed.data.lng,
      });
    }

    return res.json({ message: "Location updated", ...parsed.data });
  });

  return router;
}

/** Assign delivery for an order (used from order placement). */
async function assignDeliveryForOrder(poolConn, tenantId, orderId, customerUserId, restaurantId, io) {
  const conn = poolConn;

  const [existing] = await conn.execute("SELECT id FROM deliveries WHERE order_id = ? LIMIT 1", [orderId]);
  if (existing[0]) return existing[0].id;

  let partnerId = await resolvePartnerIdForSubscriber(conn, tenantId, customerUserId, restaurantId);

  if (!partnerId) {
    const [partners] = await conn.execute(
      `SELECT dp.id
       FROM restaurant_delivery_partner_profiles p
       INNER JOIN delivery_partners dp ON dp.id = p.delivery_partner_id
       WHERE p.restaurant_id = ? AND p.tenant_id = ? AND p.is_active = 1 AND dp.is_available = 1
       ORDER BY dp.current_rating DESC
       LIMIT 1`,
      [restaurantId, tenantId]
    );
    partnerId = partners[0]?.id || null;
  }

  if (!partnerId) {
    const [fallback] = await conn.execute(
      "SELECT id FROM delivery_partners WHERE tenant_id = ? AND is_available = 1 ORDER BY current_rating DESC LIMIT 1",
      [tenantId]
    );
    partnerId = fallback[0]?.id || null;
  }

  if (!partnerId) return null;

  const [result] = await conn.execute(
    "INSERT INTO deliveries (tenant_id, order_id, delivery_partner_id, status, eta_minutes) VALUES (?, ?, ?, 'ASSIGNED', 30)",
    [tenantId, orderId, partnerId]
  );

  if (io) {
    io.to(`tenant:${tenantId}`).emit("delivery:assigned", {
      deliveryId: result.insertId,
      orderId,
      deliveryPartnerId: partnerId,
    });
  }

  return result.insertId;
}

module.exports = deliveryRouter;
module.exports.assignDeliveryForOrder = assignDeliveryForOrder;
