const { resolveMenuItemUploadPath, normalizeStoredUploadPath } = require("./menuUploadIndex");

/** Parse menu_items.description JSON (owner text + image path). */

function parseMenuItemDescription(description) {
  if (!description) return { text: "", imageUrl: null, unit: null };
  try {
    const data = JSON.parse(description);
    if (data && typeof data === "object") {
      const imageUrl = String(data.imageUrl || data.image || "").trim() || null;
      let text = String(data.text || data.notes || data.ingredients || "").trim();
      let unit = String(data.unit || data.sellUnit || "").trim() || null;
      // Legacy seeded notes like "Per kg" → treat as unit when unit missing
      if (!unit && /^per\s+/i.test(text)) {
        const inferred = text.replace(/^per\s+/i, "").trim().toLowerCase();
        const map = { kg: "kg", grams: "g", g: "g", piece: "piece", litre: "litre", bunch: "bunch", dozen: "dozen", set: "piece" };
        if (map[inferred]) {
          unit = map[inferred];
          text = "";
        }
      }
      return { text, imageUrl, unit };
    }
  } catch {
    /* plain text */
  }
  const plain = String(description).trim();
  return { text: plain, imageUrl: null, unit: null };
}

function menuItemDisplayRating(itemId, restaurantRating) {
  const base = Number(restaurantRating);
  if (Number.isFinite(base) && base > 0) {
    const jitter = ((Number(itemId) % 7) - 3) * 0.05;
    return Math.min(5, Math.max(3.8, Math.round((base + jitter) * 10) / 10));
  }
  return Math.round((4.2 + (Number(itemId) % 8) * 0.1) * 10) / 10;
}

async function fetchMenuItemOrderStats(pool, restaurantId) {
  try {
    const [rows] = await pool.execute(
      `SELECT oi.menu_item_id, SUM(oi.quantity) AS total_qty, COUNT(DISTINCT oi.order_id) AS order_times
       FROM order_items oi
       INNER JOIN orders o ON o.id = oi.order_id
       WHERE o.restaurant_id = ? AND o.status NOT IN ('CANCELLED')
       GROUP BY oi.menu_item_id`,
      [restaurantId]
    );
    return rows;
  } catch {
    return [];
  }
}

function computeMostOrderedIds(statsRows, menuItemIds) {
  const menuSet = new Set(menuItemIds.map((id) => Number(id)));
  const ranked = statsRows
    .map((r) => ({
      id: Number(r.menu_item_id),
      totalQty: Number(r.total_qty) || 0,
      orderTimes: Number(r.order_times) || 0,
    }))
    .filter((r) => menuSet.has(r.id) && r.totalQty > 0)
    .sort((a, b) => b.totalQty - a.totalQty);

  if (!ranked.length) return new Set();

  const repeat = ranked.filter((r) => r.orderTimes >= 2 || r.totalQty >= 3);
  const pool = repeat.length ? repeat : ranked.slice(0, Math.min(3, ranked.length));
  return new Set(pool.slice(0, 5).map((r) => r.id));
}

function enrichBrowseMenuItem(row, { mostOrderedIds, restaurantRating, statsByItemId } = {}) {
  const meta = parseMenuItemDescription(row.description);
  const id = Number(row.id);
  const stat = statsByItemId?.get(id);
  const resolved = resolveMenuItemUploadPath(row.name, meta.imageUrl);
  const stored = meta.imageUrl ? normalizeStoredUploadPath(meta.imageUrl) : null;
  const imageUrl = resolved || stored;
  const image_available = Boolean(resolved);
  return {
    ...row,
    image_url: imageUrl,
    image_available,
    description_text: meta.text || null,
    sell_unit: meta.unit || null,
    rating: menuItemDisplayRating(id, restaurantRating),
    order_times: stat?.orderTimes ?? 0,
    total_qty: stat?.totalQty ?? 0,
    is_most_ordered: mostOrderedIds?.has(id) ?? false,
  };
}

async function enrichBrowseMenuItems(pool, restaurantId, rows) {
  const [[restaurant]] = await pool.execute(
    "SELECT rating FROM restaurants WHERE id = ? LIMIT 1",
    [restaurantId]
  );
  const restaurantRating = restaurant?.rating;
  const statsRows = await fetchMenuItemOrderStats(pool, restaurantId);
  const statsByItemId = new Map(
    statsRows.map((r) => [
      Number(r.menu_item_id),
      { totalQty: Number(r.total_qty) || 0, orderTimes: Number(r.order_times) || 0 },
    ])
  );
  const mostOrderedIds = computeMostOrderedIds(statsRows, rows.map((r) => r.id));
  return rows.map((row) =>
    enrichBrowseMenuItem(row, { mostOrderedIds, restaurantRating, statsByItemId })
  );
}

module.exports = {
  parseMenuItemDescription,
  enrichBrowseMenuItem,
  enrichBrowseMenuItems,
};
