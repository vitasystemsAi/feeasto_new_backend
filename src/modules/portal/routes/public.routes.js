const express = require("express");
const { z } = require("zod");
const pool = require("../../../db/pool");
const auth = require("../../../middlewares/auth");
const { fetchActiveAds, recordAdImpression, recordAdClick } = require("../services/customerAds");
const {
  attachDistanceKm,
  parseCoord,
  filterRestaurantsWithinCustomerRadius,
} = require("../../../utils/geo");
const {
  searchNearbyFoodItems,
  suggestNearbyFoodItems,
} = require("../services/foodBrowseSearch");

const router = express.Router();

function clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || null;
}

router.get("/trending/food", async (req, res) => {
  const customerLat = parseCoord(req.query.customerLat ?? req.query.lat);
  const customerLng = parseCoord(req.query.customerLng ?? req.query.lng);
  let rows;
  try {
    [rows] = await pool.execute(
      `SELECT tf.rank_position AS item_rank, mi.id AS menu_item_id, mi.name, mi.description, mi.price,
              r.id AS restaurant_id, r.name AS restaurant_name, r.latitude AS restaurant_latitude,
              r.longitude AS restaurant_longitude, tf.order_count
       FROM trending_food_items tf
       JOIN menu_items mi ON mi.id = tf.menu_item_id AND mi.is_active = 1
       JOIN restaurants r ON r.id = mi.restaurant_id AND r.is_active = 1 AND r.approval_status = 'APPROVED'
       ORDER BY tf.rank_position LIMIT 50`
    );
  } catch (error) {
    if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
    [rows] = await pool.execute(
      `SELECT tf.rank_position AS item_rank, mi.id AS menu_item_id, mi.name, mi.description, mi.price,
              r.id AS restaurant_id, r.name AS restaurant_name, tf.order_count
       FROM trending_food_items tf
       JOIN menu_items mi ON mi.id = tf.menu_item_id AND mi.is_active = 1
       JOIN restaurants r ON r.id = mi.restaurant_id AND r.is_active = 1 AND r.approval_status = 'APPROVED'
       ORDER BY tf.rank_position LIMIT 50`
    );
  }
  let list = rows;
  if (customerLat != null && customerLng != null) {
    list = filterRestaurantsWithinCustomerRadius(
      attachDistanceKm(rows, customerLat, customerLng, {
        latKey: "restaurant_latitude",
        lngKey: "restaurant_longitude",
      }),
      customerLat,
      customerLng
    );
  }
  return res.json(list);
});

router.get("/trending/restaurants", async (req, res) => {
  const customerLat = parseCoord(req.query.customerLat ?? req.query.lat);
  const customerLng = parseCoord(req.query.customerLng ?? req.query.lng);
  let rows;
  try {
    [rows] = await pool.execute(
      `SELECT tr.rank_position AS item_rank, r.id, r.name, r.slug, r.rating, r.description, tr.order_count,
              r.latitude, r.longitude, COALESCE(rp.priority_rank, 999) AS priority_rank
       FROM trending_restaurants tr
       JOIN restaurants r ON r.id = tr.restaurant_id AND r.is_active = 1 AND r.approval_status = 'APPROVED'
       LEFT JOIN restaurant_priorities rp ON rp.restaurant_id = r.id AND COALESCE(rp.is_active, 1) = 1
       ORDER BY COALESCE(rp.priority_rank, 999), tr.rank_position LIMIT 50`
    );
  } catch (error) {
    if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
    [rows] = await pool.execute(
      `SELECT tr.rank_position AS item_rank, r.id, r.name, r.slug, r.rating, r.description, tr.order_count,
              COALESCE(rp.priority_rank, 999) AS priority_rank
       FROM trending_restaurants tr
       JOIN restaurants r ON r.id = tr.restaurant_id AND r.is_active = 1 AND r.approval_status = 'APPROVED'
       LEFT JOIN restaurant_priorities rp ON rp.restaurant_id = r.id AND COALESCE(rp.is_active, 1) = 1
       ORDER BY COALESCE(rp.priority_rank, 999), tr.rank_position LIMIT 50`
    );
  }
  let list = attachDistanceKm(rows, customerLat, customerLng);
  if (customerLat != null && customerLng != null) {
    list = filterRestaurantsWithinCustomerRadius(list, customerLat, customerLng);
  }
  return res.json(list);
});

router.get("/ads", async (req, res) => {
  const ads = await fetchActiveAds({ adType: req.query.type });
  return res.json({ success: true, ads });
});

router.post("/ads/:id/impression", auth(false), async (req, res) => {
  const id = Number(req.params.id);
  await recordAdImpression(id, req.user?.sub || null, clientIp(req));
  return res.status(204).end();
});

router.post("/ads/:id/click", async (req, res) => {
  const id = Number(req.params.id);
  await recordAdClick(id, req.user?.sub || null, clientIp(req));
  return res.status(204).end();
});

router.get("/browse/food", async (req, res) => {
  const q = String(req.query.q || req.query.search || "").trim();
  const limit = Number(req.query.limit) || 60;
  const customerLat = parseCoord(req.query.customerLat ?? req.query.lat);
  const customerLng = parseCoord(req.query.customerLng ?? req.query.lng);
  const result = await searchNearbyFoodItems({
    keyword: q,
    customerLat,
    customerLng,
    limit,
  });
  return res.json(result);
});

router.get("/browse/food/suggestions", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const limit = Number(req.query.limit) || 10;
  const customerLat = parseCoord(req.query.customerLat ?? req.query.lat);
  const customerLng = parseCoord(req.query.customerLng ?? req.query.lng);
  const result = await suggestNearbyFoodItems({
    keyword: q,
    customerLat,
    customerLng,
    limit,
  });
  return res.json(result);
});

router.post("/search", auth(false), async (req, res) => {
  const schema = z.object({
    keyword: z.string().min(1).max(255),
    searchType: z.enum(["FOOD", "RESTAURANT", "GENERAL"]).default("GENERAL"),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const keyword = parsed.data.keyword.trim().toLowerCase();
  const userId = req.user?.sub || null;
  await pool.execute(
    `INSERT INTO search_analytics (search_keyword, search_type, user_id, search_count, searched_on)
     VALUES (?, ?, ?, 1, CURDATE())
     ON DUPLICATE KEY UPDATE search_count = search_count + 1, updated_at = CURRENT_TIMESTAMP`,
    [keyword, parsed.data.searchType, userId]
  );
  return res.status(204).end();
});

module.exports = router;
