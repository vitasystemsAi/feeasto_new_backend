const pool = require("../../../db/pool");
const {
  attachDistanceKm,
  parseCoord,
  filterRestaurantsWithinCustomerRadius,
} = require("../../../utils/geo");
const {
  parseMenuItemDescription,
  enrichBrowseMenuItem,
} = require("../../../utils/menuItemDescription");
const { resolveMenuItemUploadPath, normalizeStoredUploadPath } = require("../../../utils/menuUploadIndex");

let hasIsAvailableColumn = null;

async function ensureMenuItemsIsAvailableColumn() {
  if (hasIsAvailableColumn === true) return true;
  if (hasIsAvailableColumn === false) return false;
  const [rows] = await pool.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'menu_items' AND COLUMN_NAME = 'is_available' LIMIT 1`
  );
  hasIsAvailableColumn = rows.length > 0;
  return hasIsAvailableColumn;
}

function normalizeKeyword(raw) {
  const s = String(raw || "")
    .trim()
    .slice(0, 80);
  if (s.length < 1) return null;
  return s;
}

function likePattern(keyword) {
  const safe = keyword.replace(/[%_]/g, "").trim();
  return `%${safe}%`;
}

/** Split "chicken biryani egg" → ["chicken","biryani","egg"] for OR matching. */
function searchTokens(keyword) {
  const raw = String(keyword || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ");
  const parts = raw.split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 2);
  const unique = [...new Set(parts)];
  if (unique.length) return unique.slice(0, 8);
  const single = raw.trim();
  return single.length >= 1 ? [single] : [];
}

function lightEnrichRow(row) {
  const meta = parseMenuItemDescription(row.description);
  const id = Number(row.id);
  const resolved = resolveMenuItemUploadPath(row.name, meta.imageUrl);
  const stored = meta.imageUrl ? normalizeStoredUploadPath(meta.imageUrl) : null;
  const imageUrl = resolved || stored;
  return enrichBrowseMenuItem(
    {
      ...row,
      image_url: imageUrl,
      image_available: Boolean(resolved),
      description_text: meta.text || null,
    },
    { restaurantRating: row.restaurant_rating }
  );
}

function tokenMatchScore(nameLower, descLower, tokens) {
  let score = 0;
  for (const t of tokens) {
    if (nameLower.includes(t)) score += nameLower.startsWith(t) ? 4 : 2;
    else if (descLower.includes(t)) score += 1;
  }
  return score;
}

function rankFoodRows(rows, keyword) {
  const tokens = searchTokens(keyword);
  const primary = tokens[0] || String(keyword || "").toLowerCase();
  return [...rows].sort((a, b) => {
    const aName = String(a.name || "").toLowerCase();
    const bName = String(b.name || "").toLowerCase();
    const aDesc = String(a.description || "").toLowerCase();
    const bDesc = String(b.description || "").toLowerCase();
    const aScore = tokenMatchScore(aName, aDesc, tokens.length ? tokens : [primary]);
    const bScore = tokenMatchScore(bName, bDesc, tokens.length ? tokens : [primary]);
    if (aScore !== bScore) return bScore - aScore;
    const aStarts = aName.startsWith(primary) ? 0 : 1;
    const bStarts = bName.startsWith(primary) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    const da = a.distance_km != null ? Number(a.distance_km) : Infinity;
    const db = b.distance_km != null ? Number(b.distance_km) : Infinity;
    if (da !== db) return da - db;
    return aName.localeCompare(bName);
  });
}

function buildNameMatchClause(tokens) {
  const perToken = tokens.map(
    () => `(
      LOWER(mi.name) LIKE LOWER(?)
      OR LOWER(COALESCE(mi.description, '')) LIKE LOWER(?)
      OR LOWER(mc.name) LIKE LOWER(?)
      OR EXISTS (
        SELECT 1 FROM platform_category_catalog pc
        WHERE pc.is_active = 1
          AND LOWER(pc.display_name) LIKE LOWER(?)
          AND LOWER(TRIM(mc.name)) = LOWER(pc.category_key)
      )
    )`
  );
  return perToken.join(" OR ");
}

async function fetchMatchingMenuRows(keyword) {
  const tokens = searchTokens(keyword);
  if (!tokens.length) return [];

  const hasAvail = await ensureMenuItemsIsAvailableColumn();
  const availClause = hasAvail ? "AND COALESCE(mi.is_available, 1) = 1" : "";
  const matchClause = buildNameMatchClause(tokens);
  const params = tokens.flatMap((t) => {
    const p = likePattern(t);
    return [p, p, p, p];
  });

  const [rows] = await pool.execute(
    `SELECT mi.id, mi.name, mi.description, mi.price, mi.is_veg,
            ${hasAvail ? "mi.is_available," : "1 AS is_available,"}
            mi.available_stock, mc.name AS category_name,
            r.id AS restaurant_id, r.name AS restaurant_name, r.rating AS restaurant_rating,
            r.latitude AS restaurant_latitude, r.longitude AS restaurant_longitude,
            r.is_online AS restaurant_is_online
     FROM menu_items mi
     INNER JOIN menu_categories mc ON mc.id = mi.category_id
     INNER JOIN restaurants r ON r.id = mi.restaurant_id
       AND r.is_active = 1 AND r.approval_status = 'APPROVED'
     WHERE mi.is_active = 1 ${availClause}
       AND (${matchClause})
     LIMIT 250`,
    params
  );
  return rows;
}

/**
 * Nearby menu items matching a food keyword (customer coords required).
 */
async function searchNearbyFoodItems({ keyword, customerLat, customerLng, limit = 60 }) {
  const kw = normalizeKeyword(keyword);
  if (!kw) return { items: [], keyword: null };

  const cLat = parseCoord(customerLat);
  const cLng = parseCoord(customerLng);
  if (cLat == null || cLng == null) {
    return { items: [], keyword: kw, requiresLocation: true };
  }

  const rows = await fetchMatchingMenuRows(kw);
  let list = attachDistanceKm(rows, cLat, cLng, {
    latKey: "restaurant_latitude",
    lngKey: "restaurant_longitude",
  });
  list = filterRestaurantsWithinCustomerRadius(list, cLat, cLng);
  list = rankFoodRows(list, kw);
  const cap = Math.min(Math.max(Number(limit) || 60, 1), 100);
  const items = list.slice(0, cap).map((row) => {
    const enriched = lightEnrichRow(row);
    return {
      id: enriched.id,
      name: enriched.name,
      description: enriched.description,
      description_text: enriched.description_text,
      price: enriched.price,
      is_veg: enriched.is_veg,
      is_available: enriched.is_available,
      available_stock: enriched.available_stock,
      category_name: enriched.category_name,
      image_url: enriched.image_url,
      image_available: enriched.image_available,
      rating: enriched.rating,
      restaurant_id: Number(row.restaurant_id),
      restaurant_name: row.restaurant_name,
      restaurant_rating: row.restaurant_rating,
      restaurant_is_online: row.restaurant_is_online,
      distance_km: row.distance_km,
    };
  });

  return { items, keyword: kw };
}

/**
 * Short suggestion list (distinct dish names) for autocomplete.
 */
async function suggestNearbyFoodItems({ keyword, customerLat, customerLng, limit = 10 }) {
  const { items, keyword: kw, requiresLocation } = await searchNearbyFoodItems({
    keyword,
    customerLat,
    customerLng,
    limit: 80,
  });
  if (!kw) return { suggestions: [], requiresLocation };
  if (requiresLocation) return { suggestions: [], requiresLocation: true };

  const cap = Math.min(Math.max(Number(limit) || 10, 1), 20);
  const seen = new Set();
  const suggestions = [];
  for (const item of items) {
    const label = String(item.name || "").trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    suggestions.push({
      label,
      menu_item_id: item.id,
      restaurant_id: item.restaurant_id,
      restaurant_name: item.restaurant_name,
      price: item.price,
    });
    if (suggestions.length >= cap) break;
  }
  return { suggestions, requiresLocation: false };
}

module.exports = {
  searchNearbyFoodItems,
  suggestNearbyFoodItems,
  normalizeKeyword,
};
