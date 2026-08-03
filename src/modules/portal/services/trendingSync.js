const pool = require("../../../db/pool");

async function syncAutoTrendingFood() {
  const [manualRows] = await pool.execute(
    "SELECT menu_item_id FROM trending_food_items WHERE is_manual = 1 AND rank_position <= 5"
  );
  const manualItemIds = manualRows.map((r) => Number(r.menu_item_id));

  await pool.execute("DELETE FROM trending_food_items WHERE is_manual = 0 OR rank_position > 5");

  const [topItems] = await pool.execute(
    `SELECT oi.menu_item_id, COUNT(*) AS order_count
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.status NOT IN ('CANCELLED')
     GROUP BY oi.menu_item_id
     ORDER BY order_count DESC
     LIMIT 100`
  );

  let autoRank = 6;
  for (const row of topItems) {
    const menuItemId = Number(row.menu_item_id);
    if (manualItemIds.includes(menuItemId)) continue;
    await pool.execute(
      `INSERT INTO trending_food_items (menu_item_id, rank_position, is_manual, order_count)
       VALUES (?, ?, 0, ?)`,
      [menuItemId, autoRank, Number(row.order_count || 0)]
    );
    autoRank += 1;
  }
}

async function syncAutoTrendingRestaurants() {
  const [manualRows] = await pool.execute(
    "SELECT restaurant_id FROM trending_restaurants WHERE is_manual = 1 AND rank_position <= 5"
  );
  const manualIds = manualRows.map((r) => Number(r.restaurant_id));

  await pool.execute("DELETE FROM trending_restaurants WHERE is_manual = 0 OR rank_position > 5");

  const [topRestaurants] = await pool.execute(
    `SELECT restaurant_id, COUNT(*) AS order_count
     FROM orders WHERE status NOT IN ('CANCELLED')
     GROUP BY restaurant_id ORDER BY order_count DESC LIMIT 100`
  );

  let autoRank = 6;
  for (const row of topRestaurants) {
    const restaurantId = Number(row.restaurant_id);
    if (manualIds.includes(restaurantId)) continue;
    await pool.execute(
      `INSERT INTO trending_restaurants (restaurant_id, rank_position, is_manual, order_count)
       VALUES (?, ?, 0, ?)`,
      [restaurantId, autoRank, Number(row.order_count || 0)]
    );
    autoRank += 1;
  }
}

async function syncAllTrending() {
  await syncAutoTrendingFood();
  await syncAutoTrendingRestaurants();
}

function startTrendingSyncJob(intervalMs = 15 * 60 * 1000) {
  const run = async () => {
    try {
      await syncAllTrending();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[portal] trending sync failed:", err.message);
    }
  };
  run();
  return setInterval(run, intervalMs);
}

module.exports = { syncAllTrending, syncAutoTrendingFood, syncAutoTrendingRestaurants, startTrendingSyncJob };
