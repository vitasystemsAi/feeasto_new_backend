const pool = require("../../../db/pool");
const { resolveStoredImageUrl } = require("../utils/adImageResolve");
const { adMatchesCustomerLocation } = require("../../../utils/structuredAddress");

const AD_TYPE_ALIASES = {
  SPONSORED_RESTAURANT: "RESTAURANT_SPONSORED",
  SPONSORED_FOOD: "FOOD_SPONSORED",
  POPUP_BANNER: "POPUP",
};

function normalizeAdType(type) {
  if (!type) return null;
  const t = String(type).toUpperCase();
  return AD_TYPE_ALIASES[t] || t;
}

async function getCustomerAdLocation(userId) {
  if (!userId) return null;
  try {
    const [[addr]] = await pool.execute(
      `SELECT pincode, district FROM customer_saved_addresses
       WHERE user_id = ? ORDER BY is_default DESC, id DESC LIMIT 1`,
      [userId]
    );
    if (addr?.pincode) {
      return { pincode: addr.pincode, district: addr.district };
    }
    const [[user]] = await pool.execute(
      "SELECT home_pincode, home_district FROM users WHERE id = ? LIMIT 1",
      [userId]
    );
    if (user?.home_pincode) {
      return { pincode: user.home_pincode, district: user.home_district };
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchActiveAds({ adType, customerLocation } = {}) {
  const where = [
    "a.status = 'ACTIVE'",
    "(a.start_date IS NULL OR a.start_date <= CURDATE())",
    "(a.end_date IS NULL OR a.end_date >= CURDATE())",
  ];
  const params = [];
  const normalized = normalizeAdType(adType);
  if (normalized) {
    where.push("a.ad_type = ?");
    params.push(normalized);
  }

  const [rows] = await pool.execute(
    `SELECT a.id, a.ad_title AS title, a.description, a.image_url, a.redirect_url, a.ad_type, a.priority,
            a.restaurant_id, a.menu_item_id, a.target_pincode, a.target_district, a.target_radius_km,
            r.name AS restaurant_name, r.slug AS restaurant_slug, r.rating AS restaurant_rating,
            r.description AS restaurant_description,
            mi.name AS menu_item_name, mi.price AS menu_item_price, mi.description AS menu_item_description,
            mi.restaurant_id AS menu_item_restaurant_id
     FROM advertisements a
     LEFT JOIN restaurants r ON r.id = a.restaurant_id
     LEFT JOIN menu_items mi ON mi.id = a.menu_item_id
     WHERE ${where.join(" AND ")}
     ORDER BY a.priority ASC, a.id ASC`,
    params
  );

  const mapped = rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    image_url: resolveStoredImageUrl(row.image_url, row.redirect_url),
    redirect_url: row.redirect_url,
    ad_type: row.ad_type,
    priority: row.priority,
    restaurant_id: row.restaurant_id,
    menu_item_id: row.menu_item_id,
    restaurant: row.restaurant_id
      ? {
          id: row.restaurant_id,
          name: row.restaurant_name,
          slug: row.restaurant_slug,
          rating: row.restaurant_rating,
          description: row.restaurant_description,
        }
      : null,
    menu_item: row.menu_item_id
      ? {
          id: row.menu_item_id,
          name: row.menu_item_name,
          price: row.menu_item_price,
          description: row.menu_item_description,
          restaurant_id: row.menu_item_restaurant_id,
        }
      : null,
    target_pincode: row.target_pincode || null,
    target_district: row.target_district || null,
    target_radius_km: row.target_radius_km != null ? Number(row.target_radius_km) : null,
  }));

  if (!customerLocation) return mapped;
  return mapped.filter((ad) => adMatchesCustomerLocation(ad, customerLocation));
}

async function recordAdImpression(adId, userId, ip) {
  await pool.execute(
    "INSERT INTO ad_impressions (advertisement_id, user_id, ip_address) VALUES (?, ?, ?)",
    [adId, userId, ip || null]
  );
  await pool.execute(
    "UPDATE advertisements SET impression_count = COALESCE(impression_count, 0) + 1 WHERE id = ?",
    [adId]
  );
}

async function recordAdClick(adId, userId, ip) {
  await pool.execute("INSERT INTO ad_clicks (advertisement_id, user_id, ip_address) VALUES (?, ?, ?)", [
    adId,
    userId,
    ip || null,
  ]);
  await pool.execute("UPDATE advertisements SET click_count = COALESCE(click_count, 0) + 1 WHERE id = ?", [adId]);
}

module.exports = {
  fetchActiveAds,
  getCustomerAdLocation,
  recordAdImpression,
  recordAdClick,
  normalizeAdType,
};
