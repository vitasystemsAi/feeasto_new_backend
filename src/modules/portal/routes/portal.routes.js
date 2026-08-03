const express = require("express");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { z } = require("zod");
const pool = require("../../../db/pool");
const { portalGate } = require("../middleware/portalGate");
const { requirePermission, isSuperAdmin, ALL_PERMISSIONS } = require("../utils/permissions");
const { logPortalAction } = require("../utils/audit");
const { parsePagination, paginatedResponse, sqlLimitClause, sqlLimitOnly } = require("../utils/pagination");
const { syncAllTrending } = require("../services/trendingSync");
const { sendPortalNotificationEmail } = require("../../../services/portalMailer");

const router = express.Router();
const gate = portalGate();

// Must match app.js static: backend/uploads (not backend/src/uploads)
const uploadDir = path.join(__dirname, "..", "..", "..", "..", "uploads", "portal-ads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => cb(null, `ad-${Date.now()}-${file.originalname.replace(/\s+/g, "-")}`),
  }),
});

const {
  DEFAULT_AD_IMAGE_URL,
  resolveAdImageUrl,
  resolveStoredImageUrl,
} = require("../utils/adImageResolve");

// ——— Dashboard ———
router.get("/dashboard", ...gate, requirePermission("dashboard"), async (_req, res) => {
  const [[customers]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM users WHERE role = 'CUSTOMER'"
  );
  const [[activeCustomers]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM users WHERE role = 'CUSTOMER' AND is_active = 1"
  );
  const [[blockedCustomers]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM users WHERE role = 'CUSTOMER' AND is_active = 0"
  );
  const [[newToday]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM users WHERE role = 'CUSTOMER' AND DATE(created_at) = CURDATE()"
  );
  const [[restaurants]] = await pool.execute("SELECT COUNT(*) AS total FROM restaurants");
  const [[activeRestaurants]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM restaurants WHERE is_active = 1 AND approval_status = 'APPROVED'"
  );
  const [[inactiveRestaurants]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM restaurants WHERE is_active = 0"
  );
  const [[pendingRestaurants]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM restaurants WHERE approval_status = 'PENDING'"
  );
  const [[orders]] = await pool.execute("SELECT COUNT(*) AS total FROM orders");
  const [[ordersToday]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM orders WHERE DATE(created_at) = CURDATE()"
  );
  const [[ordersWeek]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM orders WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)"
  );
  const [[ordersMonth]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM orders WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)"
  );
  const revenue = async (days) => {
    const [[row]] = await pool.execute(
      `SELECT COALESCE(SUM(p.amount - p.refunded_cumulative), 0) AS revenue
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       WHERE p.payment_status IN ('PAID','PARTIALLY_REFUNDED')
         AND o.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
      [days]
    );
    return Number(row.revenue || 0);
  };

  const [revenueChart] = await pool.execute(
    `SELECT DATE(o.created_at) AS day, COALESCE(SUM(p.amount - p.refunded_cumulative), 0) AS revenue
     FROM orders o
     JOIN payments p ON p.order_id = o.id AND p.payment_status IN ('PAID','PARTIALLY_REFUNDED')
     WHERE o.created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
     GROUP BY DATE(o.created_at) ORDER BY day`
  );
  const [ordersChart] = await pool.execute(
    `SELECT DATE(created_at) AS day, COUNT(*) AS orders
     FROM orders WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
     GROUP BY DATE(created_at) ORDER BY day`
  );
  const [searchTrends] = await pool.execute(
    `SELECT search_keyword, SUM(search_count) AS total
     FROM search_analytics WHERE searched_on >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
     GROUP BY search_keyword ORDER BY total DESC LIMIT 10`
  );
  const [restaurantPerformance] = await pool.execute(
    `SELECT r.name, COUNT(o.id) AS orders, COALESCE(AVG(f.rating), r.rating) AS avg_rating
     FROM restaurants r
     LEFT JOIN orders o ON o.restaurant_id = r.id AND o.created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
     LEFT JOIN feedback f ON f.restaurant_id = r.id
     GROUP BY r.id, r.name, r.rating ORDER BY orders DESC LIMIT 10`
  );
  const [topFoodItems] = await pool.execute(
    `SELECT mi.name, r.name AS restaurant_name, COUNT(*) AS orders
     FROM order_items oi
     JOIN menu_items mi ON mi.id = oi.menu_item_id
     JOIN orders o ON o.id = oi.order_id
     JOIN restaurants r ON r.id = mi.restaurant_id
     WHERE o.status NOT IN ('CANCELLED')
     GROUP BY mi.id, mi.name, r.name ORDER BY orders DESC LIMIT 10`
  );
  const [topRestaurants] = await pool.execute(
    `SELECT r.name, COUNT(o.id) AS orders FROM orders o
     JOIN restaurants r ON r.id = o.restaurant_id
     WHERE o.status NOT IN ('CANCELLED')
     GROUP BY r.id, r.name ORDER BY orders DESC LIMIT 10`
  );
  const [[trendingFoodCount]] = await pool.execute("SELECT COUNT(*) AS total FROM trending_food_items");
  const [[trendingRestCount]] = await pool.execute("SELECT COUNT(*) AS total FROM trending_restaurants");
  const [[activeAds]] = await pool.execute("SELECT COUNT(*) AS total FROM advertisements WHERE status = 'ACTIVE'");
  const [[totalReviews]] = await pool.execute("SELECT COUNT(*) AS total FROM feedback");
  const [[searchesToday]] = await pool.execute(
    "SELECT COALESCE(SUM(search_count),0) AS total FROM search_analytics WHERE searched_on = CURDATE()"
  );
  const [recentCustomers] = await pool.execute(
    `SELECT id, full_name, email, created_at FROM users WHERE role = 'CUSTOMER'
     ORDER BY created_at DESC LIMIT 10`
  );
  const [recentReviews] = await pool.execute(
    `SELECT f.id, f.rating, f.comment, f.created_at, u.full_name AS customer_name, r.name AS restaurant_name
     FROM feedback f
     JOIN users u ON u.id = f.customer_user_id
     JOIN restaurants r ON r.id = f.restaurant_id
     ORDER BY f.id DESC LIMIT 10`
  );
  const [mostSearchedFoods] = await pool.execute(
    `SELECT search_keyword, SUM(search_count) AS search_count FROM search_analytics
     WHERE search_type = 'FOOD' AND searched_on >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
     GROUP BY search_keyword ORDER BY search_count DESC LIMIT 10`
  );
  const [mostSearchedRestaurants] = await pool.execute(
    `SELECT search_keyword, SUM(search_count) AS search_count FROM search_analytics
     WHERE search_type = 'RESTAURANT' AND searched_on >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
     GROUP BY search_keyword ORDER BY search_count DESC LIMIT 10`
  );

  return res.json({
    customers: {
      total: Number(customers.total),
      active: Number(activeCustomers.total),
      newToday: Number(newToday.total),
      blocked: Number(blockedCustomers.total),
    },
    restaurants: {
      total: Number(restaurants.total),
      active: Number(activeRestaurants.total),
      inactive: Number(inactiveRestaurants.total),
      pending: Number(pendingRestaurants.total),
    },
    orders: {
      total: Number(orders.total),
      today: Number(ordersToday.total),
      week: Number(ordersWeek.total),
      month: Number(ordersMonth.total),
    },
    revenue: {
      daily: await revenue(1),
      weekly: await revenue(7),
      monthly: await revenue(30),
    },
    cards: {
      totalCustomers: Number(customers.total),
      totalRestaurants: Number(restaurants.total),
      activeRestaurants: Number(activeRestaurants.total),
      trendingFoodsCount: Number(trendingFoodCount.total),
      trendingRestaurantsCount: Number(trendingRestCount.total),
      activeAds: Number(activeAds.total),
      totalReviews: Number(totalReviews.total),
      searchesToday: Number(searchesToday.total),
    },
    trending: { topFoodItems, topRestaurants },
    charts: {
      revenueChart,
      ordersChart,
      searchTrends,
      restaurantPerformance,
      mostSearchedFoods,
      mostSearchedRestaurants,
    },
    recent: { customers: recentCustomers, reviews: recentReviews },
  });
});

// ——— Customers ———
router.get("/customers/recent-logins", ...gate, requirePermission("customers"), async (_req, res) => {
  const [rows] = await pool.execute(
    `SELECT u.id, u.full_name, u.email, ps.login_at, ps.ip_address
     FROM portal_sessions ps
     JOIN users u ON u.id = ps.user_id AND u.role = 'CUSTOMER'
     WHERE ps.login_at IS NOT NULL
     ORDER BY ps.login_at DESC LIMIT 10`
  );
  return res.json(rows);
});

router.get("/customers", ...gate, requirePermission("customers"), async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const search = String(req.query.search || "").trim();
  const status = req.query.status;
  const sort = req.query.sort === "name" ? "u.full_name" : "u.created_at";
  const order = req.query.order === "asc" ? "ASC" : "DESC";

  const where = ["u.role = 'CUSTOMER'"];
  const params = [];
  if (search) {
    where.push("(u.full_name LIKE ? OR u.email LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  if (status === "active") where.push("u.is_active = 1");
  if (status === "blocked") where.push("u.is_active = 0");

  const whereSql = where.join(" AND ");
  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM users u WHERE ${whereSql}`,
    params
  );
  const [rows] = await pool.execute(
    `SELECT u.id, u.full_name, u.email, u.is_active, u.created_at,
            COUNT(DISTINCT o.id) AS total_orders,
            (SELECT MAX(ps.login_at) FROM portal_sessions ps WHERE ps.user_id = u.id) AS last_login
     FROM users u
     LEFT JOIN orders o ON o.customer_user_id = u.id
     WHERE ${whereSql}
     GROUP BY u.id
     ORDER BY ${sort} ${order}
     ${sqlLimitClause(limit, offset)}`,
    params
  );

  return res.json(
    paginatedResponse(
      rows.map((r) => ({
        id: Number(r.id),
        name: r.full_name,
        email: r.email,
        phone: null,
        registrationDate: r.created_at,
        lastLogin: r.last_login,
        status: r.is_active ? "ACTIVE" : "BLOCKED",
        totalOrders: Number(r.total_orders || 0),
      })),
      total,
      page,
      limit
    )
  );
});

router.get("/customers/:id", ...gate, requirePermission("customers"), async (req, res) => {
  const id = Number(req.params.id);
  const [[user]] = await pool.execute(
    `SELECT id, full_name, email, is_active, created_at FROM users WHERE id = ? AND role = 'CUSTOMER'`,
    [id]
  );
  if (!user) return res.status(404).json({ message: "Customer not found" });
  const [orders] = await pool.execute(
    `SELECT o.id, o.status, o.order_type, o.created_at, r.name AS restaurant_name
     FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
     WHERE o.customer_user_id = ? ORDER BY o.id DESC LIMIT 50`,
    [id]
  );
  return res.json({
    id: Number(user.id),
    name: user.full_name,
    email: user.email,
    phone: null,
    status: user.is_active ? "ACTIVE" : "BLOCKED",
    registrationDate: user.created_at,
    orders,
  });
});

router.patch("/customers/:id/status", ...gate, requirePermission("customers"), async (req, res) => {
  const schema = z.object({ isActive: z.boolean() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
  const id = Number(req.params.id);
  await pool.execute("UPDATE users SET is_active = ? WHERE id = ? AND role = 'CUSTOMER'", [
    parsed.data.isActive ? 1 : 0,
    id,
  ]);
  await logPortalAction(req, {
    action: parsed.data.isActive ? "CUSTOMER_ENABLED" : "CUSTOMER_DISABLED",
    module: "customers",
    targetEntity: "user",
    targetId: id,
  });
  return res.json({ message: "Customer status updated" });
});

// ——— Restaurants ———
router.get("/restaurants", ...gate, requirePermission("restaurants"), async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const search = String(req.query.search || "").trim();
  const where = ["1=1"];
  const params = [];
  if (search) {
    where.push("(r.name LIKE ? OR u.full_name LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  const whereSql = where.join(" AND ");
  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM restaurants r
     LEFT JOIN users u ON u.id = r.owner_user_id WHERE ${whereSql}`,
    params
  );
  const [rows] = await pool.execute(
    `SELECT r.id, r.name, r.approval_status, r.is_active, r.rating,
            u.full_name AS owner_name, u.email AS owner_email,
            COALESCE(rp.priority_rank, 999) AS priority_rank,
            COUNT(DISTINCT o.id) AS total_orders
     FROM restaurants r
     LEFT JOIN users u ON u.id = r.owner_user_id
     LEFT JOIN restaurant_priorities rp ON rp.restaurant_id = r.id
     LEFT JOIN orders o ON o.restaurant_id = r.id
     WHERE ${whereSql}
     GROUP BY r.id
     ORDER BY COALESCE(rp.priority_rank, 999), r.name
     ${sqlLimitClause(limit, offset)}`,
    params
  );
  return res.json(paginatedResponse(rows, total, page, limit));
});

router.patch("/restaurants/:id/activate", ...gate, requirePermission("restaurants"), async (req, res) => {
  const id = Number(req.params.id);
  await pool.execute("UPDATE restaurants SET is_active = 1 WHERE id = ?", [id]);
  await logPortalAction(req, { action: "RESTAURANT_ACTIVATED", module: "restaurants", targetEntity: "restaurant", targetId: id });
  return res.json({ message: "Restaurant activated" });
});

router.patch("/restaurants/:id/deactivate", ...gate, requirePermission("restaurants"), async (req, res) => {
  const id = Number(req.params.id);
  await pool.execute("UPDATE restaurants SET is_active = 0 WHERE id = ?", [id]);
  await logPortalAction(req, { action: "RESTAURANT_DEACTIVATED", module: "restaurants", targetEntity: "restaurant", targetId: id });
  return res.json({ message: "Restaurant deactivated" });
});

router.put("/restaurants/:id/priority", ...gate, requirePermission("restaurants"), async (req, res) => {
  const schema = z.object({ priorityRank: z.number().int().min(1).max(9999) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
  const id = Number(req.params.id);
  await pool.execute(
    `INSERT INTO restaurant_priorities (restaurant_id, priority_rank, updated_by_user_id)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE priority_rank = VALUES(priority_rank), updated_by_user_id = VALUES(updated_by_user_id)`,
    [id, parsed.data.priorityRank, req.user.sub]
  );
  await logPortalAction(req, { action: "RESTAURANT_PRIORITY_SET", module: "restaurants", targetEntity: "restaurant", targetId: id, meta: parsed.data });
  return res.json({ message: "Priority updated" });
});

// ——— Trending ———
router.get("/trending/food", ...gate, requirePermission("trending"), async (_req, res) => {
  const [rows] = await pool.execute(
    `SELECT tf.rank_position AS item_rank, mi.name AS food_item, r.name AS restaurant,
            tf.order_count, tf.is_manual, tf.menu_item_id
     FROM trending_food_items tf
     JOIN menu_items mi ON mi.id = tf.menu_item_id
     JOIN restaurants r ON r.id = mi.restaurant_id
     ORDER BY tf.rank_position`
  );
  return res.json(rows);
});

router.put("/trending/food/manual", ...gate, requirePermission("trending"), async (req, res) => {
  const schema = z.object({
    items: z.array(z.object({ rank: z.number().int().min(1).max(5), menuItemId: z.number().int() })).max(5),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  for (const item of parsed.data.items) {
    await pool.execute("DELETE FROM trending_food_items WHERE rank_position = ? AND is_manual = 1", [item.rank]);
    await pool.execute(
      `INSERT INTO trending_food_items (menu_item_id, rank_position, is_manual, order_count)
       VALUES (?, ?, 1, 0)
       ON DUPLICATE KEY UPDATE menu_item_id = VALUES(menu_item_id), is_manual = 1, rank_position = VALUES(rank_position)`,
      [item.menuItemId, item.rank]
    );
  }
  await syncAllTrending();
  await logPortalAction(req, { action: "TRENDING_FOOD_UPDATED", module: "trending" });
  return res.json({ message: "Manual trending food updated" });
});

router.get("/trending/restaurants", ...gate, requirePermission("trending"), async (_req, res) => {
  const [rows] = await pool.execute(
    `SELECT tr.rank_position AS item_rank, r.name AS restaurant, tr.order_count, tr.is_manual, tr.restaurant_id
     FROM trending_restaurants tr
     JOIN restaurants r ON r.id = tr.restaurant_id
     ORDER BY tr.rank_position`
  );
  return res.json(rows);
});

router.put("/trending/restaurants/manual", ...gate, requirePermission("trending"), async (req, res) => {
  const schema = z.object({
    items: z.array(z.object({ rank: z.number().int().min(1).max(5), restaurantId: z.number().int() })).max(5),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  for (const item of parsed.data.items) {
    await pool.execute("DELETE FROM trending_restaurants WHERE rank_position = ? AND is_manual = 1", [item.rank]);
    await pool.execute(
      `INSERT INTO trending_restaurants (restaurant_id, rank_position, is_manual, order_count)
       VALUES (?, ?, 1, 0)
       ON DUPLICATE KEY UPDATE restaurant_id = VALUES(restaurant_id), is_manual = 1`,
      [item.restaurantId, item.rank]
    );
  }
  await syncAllTrending();
  await logPortalAction(req, { action: "TRENDING_RESTAURANT_UPDATED", module: "trending" });
  return res.json({ message: "Manual trending restaurants updated" });
});

router.post("/trending/sync", ...gate, requirePermission("trending"), async (req, res) => {
  await syncAllTrending();
  await logPortalAction(req, { action: "TRENDING_SYNC", module: "trending" });
  return res.json({ message: "Trending data synced" });
});

// ——— Ads ———
router.get("/ads", ...gate, requirePermission("ads"), async (req, res) => {
  const [rows] = await pool.execute("SELECT * FROM advertisements ORDER BY priority, id DESC");
  const enriched = await Promise.all(
    rows.map(async (ad) => {
      const [[imp]] = await pool.execute(
        "SELECT COUNT(*) AS c FROM ad_impressions WHERE advertisement_id = ?",
        [ad.id]
      );
      const [[clk]] = await pool.execute("SELECT COUNT(*) AS c FROM ad_clicks WHERE advertisement_id = ?", [ad.id]);
      const impressions = Number(imp.c);
      const clicks = Number(clk.c);
      return {
        ...ad,
        image_url: resolveStoredImageUrl(ad.image_url, ad.redirect_url),
        impressions,
        clicks,
        ctr: impressions ? ((clicks / impressions) * 100).toFixed(2) : "0.00",
      };
    })
  );
  return res.json(enriched);
});

router.post("/ads/sync-images", ...gate, requirePermission("ads"), async (_req, res) => {
  const [rows] = await pool.execute("SELECT id, image_url, redirect_url FROM advertisements");
  let updated = 0;
  for (const row of rows) {
    const next = resolveStoredImageUrl(row.image_url, row.redirect_url);
    if (next && next !== row.image_url) {
      await pool.execute("UPDATE advertisements SET image_url = ? WHERE id = ?", [next, row.id]);
      updated += 1;
    }
  }
  return res.json({ message: "Ad images synced from redirect URLs", updated });
});

router.post("/ads", ...gate, requirePermission("ads"), upload.single("image"), async (req, res) => {
  const schema = z.object({
    adTitle: z.string().min(2),
    description: z.string().optional(),
    redirectUrl: z.union([z.string().url(), z.literal("")]).optional(),
    imageUrl: z.string().url().optional().or(z.literal("")),
    adType: z.enum(["HOMEPAGE_BANNER", "CAROUSEL_BANNER", "RESTAURANT_SPONSORED", "FOOD_SPONSORED", "POPUP"]),
    restaurantId: z.coerce.number().optional(),
    menuItemId: z.coerce.number().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    priority: z.coerce.number().default(1),
    status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "ENDED"]).default("DRAFT"),
    targetPincode: z.string().regex(/^\d{6}$/).optional().or(z.literal("")),
    targetDistrict: z.string().max(120).optional(),
    targetRadiusKm: z.coerce.number().min(1).max(100).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
  const imageUrl = resolveAdImageUrl(req.file, req.body.imageUrl, parsed.data.redirectUrl);
  const targetPin = parsed.data.targetPincode ? String(parsed.data.targetPincode).trim() : null;
  const targetDist = parsed.data.targetDistrict ? String(parsed.data.targetDistrict).trim() : null;
  const targetRadius = parsed.data.targetRadiusKm ?? 15;
  const [result] = await pool.execute(
    `INSERT INTO advertisements
      (ad_title, description, image_url, redirect_url, ad_type, restaurant_id, menu_item_id,
       target_pincode, target_district, target_radius_km,
       start_date, end_date, priority, status, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      parsed.data.adTitle,
      parsed.data.description || null,
      imageUrl,
      parsed.data.redirectUrl || null,
      parsed.data.adType,
      parsed.data.restaurantId || null,
      parsed.data.menuItemId || null,
      targetPin,
      targetDist,
      targetRadius,
      parsed.data.startDate || null,
      parsed.data.endDate || null,
      parsed.data.priority,
      parsed.data.status,
      req.user.sub,
    ]
  );
  await logPortalAction(req, { action: "AD_CREATED", module: "ads", targetId: result.insertId });
  return res.status(201).json({ id: result.insertId });
});

router.patch("/ads/:id", ...gate, requirePermission("ads"), upload.single("image"), async (req, res) => {
  const id = Number(req.params.id);
  const fields = [];
  const params = [];
  const allowed = [
    "ad_title",
    "description",
    "redirect_url",
    "ad_type",
    "priority",
    "status",
    "start_date",
    "end_date",
    "target_pincode",
    "target_district",
    "target_radius_km",
  ];
  for (const key of allowed) {
    const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (req.body[camel] !== undefined && req.body[camel] !== "") {
      fields.push(`${key} = ?`);
      params.push(req.body[camel]);
    }
  }
  if (req.file) {
    fields.push("image_url = ?");
    params.push(`/uploads/portal-ads/${req.file.filename}`);
  } else if (req.body.imageUrl && String(req.body.imageUrl).trim()) {
    fields.push("image_url = ?");
    params.push(String(req.body.imageUrl).trim());
  } else if (req.body.redirectUrl && String(req.body.redirectUrl).trim()) {
    const resolved = resolveAdImageUrl(null, null, req.body.redirectUrl);
    if (resolved) {
      fields.push("image_url = ?");
      params.push(resolved);
    }
  }
  if (!fields.length) return res.status(400).json({ message: "No fields to update" });
  params.push(id);
  await pool.execute(`UPDATE advertisements SET ${fields.join(", ")} WHERE id = ?`, params);
  await logPortalAction(req, { action: "AD_UPDATED", module: "ads", targetId: id });
  return res.json({ message: "Ad updated" });
});

router.delete("/ads/:id", ...gate, requirePermission("ads"), async (req, res) => {
  const id = Number(req.params.id);
  await pool.execute("DELETE FROM advertisements WHERE id = ?", [id]);
  await logPortalAction(req, { action: "AD_DELETED", module: "ads", targetId: id });
  return res.json({ message: "Ad deleted" });
});

// ——— Search analytics ———
router.get("/search-analytics", ...gate, requirePermission("search_analytics"), async (req, res) => {
  const limit = Math.min(50, Math.max(10, Number(req.query.limit) || 10));
  const type = req.query.type === "RESTAURANT" ? "RESTAURANT" : "FOOD";
  const range = String(req.query.range || "week");
  let dateFilter = "searched_on >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)";
  if (range === "today") dateFilter = "searched_on = CURDATE()";
  if (range === "month") dateFilter = "searched_on >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)";

  const [rows] = await pool.execute(
    `SELECT search_keyword, SUM(search_count) AS total_searches
     FROM search_analytics
     WHERE search_type = ? AND ${dateFilter}
     GROUP BY search_keyword
     ORDER BY total_searches DESC ${sqlLimitOnly(limit)}`,
    [type]
  );
  return res.json({ type, range, data: rows });
});

// ——— Reports ———
router.get("/reports/:type", ...gate, requirePermission("reports"), async (req, res) => {
  const type = String(req.params.type);
  const format = String(req.query.format || "json");
  let data = [];

  if (type === "customers") {
    const [rows] = await pool.execute(
      `SELECT DATE(created_at) AS day,
              SUM(role = 'CUSTOMER' AND is_active = 1) AS active,
              SUM(role = 'CUSTOMER' AND is_active = 0) AS inactive,
              COUNT(*) AS new_customers
       FROM users WHERE role = 'CUSTOMER' AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       GROUP BY DATE(created_at) ORDER BY day`
    );
    data = rows;
  } else if (type === "restaurants") {
    const [rows] = await pool.execute(
      `SELECT r.name, COUNT(o.id) AS orders, r.rating
       FROM restaurants r LEFT JOIN orders o ON o.restaurant_id = r.id
       GROUP BY r.id ORDER BY orders DESC`
    );
    data = rows;
  } else if (type === "orders") {
    const [rows] = await pool.execute(
      `SELECT DATE(created_at) AS day, COUNT(*) AS orders FROM orders
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) GROUP BY DATE(created_at)`
    );
    data = rows;
  } else if (type === "revenue") {
    const [rows] = await pool.execute(
      `SELECT DATE(o.created_at) AS day, SUM(p.amount - p.refunded_cumulative) AS revenue
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.payment_status IN ('PAID','PARTIALLY_REFUNDED')
         AND o.created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       GROUP BY DATE(o.created_at)`
    );
    data = rows;
  } else {
    return res.status(400).json({ message: "Unknown report type" });
  }

  if (format === "csv") {
    const header = Object.keys(data[0] || { day: "", value: "" }).join(",");
    const lines = data.map((row) => Object.values(row).join(","));
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${type}-report.csv"`);
    return res.send([header, ...lines].join("\n"));
  }
  return res.json({ type, data });
});

// ——— Audit logs ———
router.get("/audit-logs", ...gate, requirePermission("audit_logs"), async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const [[{ total }]] = await pool.execute("SELECT COUNT(*) AS total FROM portal_audit_logs");
  const [rows] = await pool.execute(
    `SELECT pal.*, u.full_name AS actor_name, u.email AS actor_email
     FROM portal_audit_logs pal
     JOIN users u ON u.id = pal.actor_user_id
     ORDER BY pal.id DESC ${sqlLimitClause(limit, offset)}`
  );
  return res.json(paginatedResponse(rows, total, page, limit));
});

// ——— Customer admins (super only) ———
router.get("/customer-admins", ...gate, async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ message: "Super admin only" });
  const [rows] = await pool.execute(
    `SELECT ca.id, u.id AS user_id, u.full_name, u.email, ca.is_active, ca.last_login_at, ca.created_at
     FROM customer_admins ca JOIN users u ON u.id = ca.user_id ORDER BY ca.id DESC`
  );
  return res.json(rows);
});

router.post("/customer-admins", ...gate, async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ message: "Super admin only" });
  const schema = z.object({
    fullName: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(8),
    permissions: z.array(z.string()).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const email = parsed.data.email.trim().toLowerCase();
  const hash = await bcrypt.hash(parsed.data.password, 10);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [userResult] = await conn.execute(
      "INSERT INTO users (full_name, email, password_hash, role, tenant_id, is_active) VALUES (?, ?, ?, 'CUSTOMER_ADMIN', NULL, 1)",
      [parsed.data.fullName, email, hash]
    );
    const userId = userResult.insertId;
    const [caResult] = await conn.execute(
      "INSERT INTO customer_admins (user_id, created_by_user_id) VALUES (?, ?)",
      [userId, req.user.sub]
    );
    const perms = parsed.data.permissions?.length ? parsed.data.permissions : ALL_PERMISSIONS.filter((p) => p !== "customer_admins");
    for (const key of perms) {
      await conn.execute(
        "INSERT INTO admin_permissions (customer_admin_id, permission_key, is_granted, updated_by_user_id) VALUES (?, ?, 1, ?)",
        [caResult.insertId, key, req.user.sub]
      );
    }
    await conn.commit();
    await logPortalAction(req, { action: "CUSTOMER_ADMIN_CREATED", module: "customer_admins", targetId: userId });
    return res.status(201).json({ userId, customerAdminId: caResult.insertId });
  } catch (e) {
    await conn.rollback();
    if (e.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "Email already exists" });
    throw e;
  } finally {
    conn.release();
  }
});

router.put("/customer-admins/:id/permissions", ...gate, async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ message: "Super admin only" });
  const schema = z.object({ permissions: z.array(z.string()) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
  const caId = Number(req.params.id);
  await pool.execute("DELETE FROM admin_permissions WHERE customer_admin_id = ?", [caId]);
  for (const key of parsed.data.permissions) {
    await pool.execute(
      "INSERT INTO admin_permissions (customer_admin_id, permission_key, is_granted, updated_by_user_id) VALUES (?, ?, 1, ?)",
      [caId, key, req.user.sub]
    );
  }
  await logPortalAction(req, { action: "PERMISSIONS_UPDATED", module: "customer_admins", targetId: caId });
  return res.json({ message: "Permissions updated" });
});

// ——— Notifications ———
router.post("/notifications", ...gate, requirePermission("settings"), async (req, res) => {
  const schema = z.object({
    recipientUserId: z.number().int(),
    title: z.string().min(2),
    body: z.string().min(2),
    channel: z.enum(["PUSH", "EMAIL", "IN_APP"]).default("IN_APP"),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  await pool.execute(
    `INSERT INTO portal_notifications (recipient_user_id, title, body, channel, created_by_user_id)
     VALUES (?, ?, ?, ?, ?)`,
    [parsed.data.recipientUserId, parsed.data.title, parsed.data.body, parsed.data.channel, req.user.sub]
  );
  if (parsed.data.channel === "EMAIL") {
    const [[u]] = await pool.execute("SELECT email FROM users WHERE id = ?", [parsed.data.recipientUserId]);
    if (u?.email) await sendPortalNotificationEmail({ to: u.email, title: parsed.data.title, body: parsed.data.body });
  }
  return res.status(201).json({ message: "Notification sent" });
});

router.get("/notifications", ...gate, async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT * FROM portal_notifications WHERE recipient_user_id = ? ORDER BY id DESC LIMIT 50`,
    [req.user.sub]
  );
  return res.json(rows);
});

const { registerPriorityRoutes, registerReviewsRoutes } = require("./priority-reviews.routes");
const { registerCustomerAdminExtensions } = require("./customer-admin.extensions");
registerPriorityRoutes(router, gate, requirePermission);
registerReviewsRoutes(router, gate, requirePermission);
registerCustomerAdminExtensions(router, gate, requirePermission);

module.exports = router;
