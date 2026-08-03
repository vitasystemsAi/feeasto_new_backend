const { z } = require("zod");
const pool = require("../../../db/pool");
const { logPortalAction } = require("../utils/audit");

function registerCustomerAdminExtensions(router, gate, requirePermission) {
  router.get("/trending-foods", ...gate, requirePermission("trending"), async (_req, res) => {
    const [manual] = await pool.execute(
      `SELECT tf.rank_position AS item_rank, tf.menu_item_id, mi.name AS food_item, r.name AS restaurant,
              tf.order_count, tf.is_manual, 1 AS editable
       FROM trending_food_items tf
       JOIN menu_items mi ON mi.id = tf.menu_item_id
       JOIN restaurants r ON r.id = mi.restaurant_id
       WHERE tf.rank_position <= 5
       ORDER BY tf.rank_position`
    );
    const [auto] = await pool.execute(
      `SELECT tf.rank_position AS item_rank, tf.menu_item_id, mi.name AS food_item, r.name AS restaurant,
              tf.order_count, tf.is_manual, 0 AS editable
       FROM trending_food_items tf
       JOIN menu_items mi ON mi.id = tf.menu_item_id
       JOIN restaurants r ON r.id = mi.restaurant_id
       WHERE tf.rank_position > 5
       ORDER BY tf.rank_position`
    );
    return res.json({ manual, auto });
  });

  router.put("/trending-foods", ...gate, requirePermission("trending"), async (req, res) => {
    const schema = z.object({
      items: z.array(z.object({ rank: z.number().int().min(1).max(5), menuItemId: z.number().int() })).max(5),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
    await pool.execute("DELETE FROM trending_food_items WHERE is_manual = 1 AND rank_position <= 5");
    for (const item of parsed.data.items) {
      await pool.execute(
        `INSERT INTO trending_food_items (menu_item_id, rank_position, is_manual, order_count)
         VALUES (?, ?, 1, 0)`,
        [item.menuItemId, item.rank]
      );
    }
    const { syncAllTrending } = require("../services/trendingSync");
    await syncAllTrending();
    await logPortalAction(req, { action: "TRENDING_FOOD_MANUAL", module: "trending" });
    return res.json({ message: "Top 5 trending foods updated" });
  });

  router.get("/trending-restaurants", ...gate, requirePermission("trending"), async (_req, res) => {
    const [manual] = await pool.execute(
      `SELECT tr.rank_position AS item_rank, tr.restaurant_id, r.name AS restaurant, tr.order_count, 1 AS editable
       FROM trending_restaurants tr JOIN restaurants r ON r.id = tr.restaurant_id
       WHERE tr.rank_position <= 5 AND tr.is_manual = 1 ORDER BY tr.rank_position`
    );
    const [auto] = await pool.execute(
      `SELECT tr.rank_position AS item_rank, tr.restaurant_id, r.name AS restaurant, tr.order_count, 0 AS editable
       FROM trending_restaurants tr JOIN restaurants r ON r.id = tr.restaurant_id
       WHERE tr.rank_position > 5 OR (tr.rank_position <= 5 AND tr.is_manual = 0)
       ORDER BY tr.rank_position`
    );
    return res.json({ manual, auto });
  });

  router.put("/trending-restaurants", ...gate, requirePermission("trending"), async (req, res) => {
    const schema = z.object({
      items: z.array(z.object({ rank: z.number().int().min(1).max(5), restaurantId: z.number().int() })).max(5),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
    await pool.execute("DELETE FROM trending_restaurants WHERE is_manual = 1 AND rank_position <= 5");
    for (const item of parsed.data.items) {
      await pool.execute(
        `INSERT INTO trending_restaurants (restaurant_id, rank_position, is_manual, order_count)
         VALUES (?, ?, 1, 0)`,
        [item.restaurantId, item.rank]
      );
    }
    const { syncAllTrending } = require("../services/trendingSync");
    await syncAllTrending();
    await logPortalAction(req, { action: "TRENDING_RESTAURANT_MANUAL", module: "trending" });
    return res.json({ message: "Top 5 trending restaurants updated" });
  });

  router.put("/restaurants/:id/status", ...gate, requirePermission("restaurants"), async (req, res) => {
    const schema = z.object({ action: z.enum(["activate", "deactivate", "suspend", "restore"]) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
    const id = Number(req.params.id);
    const map = {
      activate: { is_active: 1, approval: null },
      restore: { is_active: 1, approval: "APPROVED" },
      deactivate: { is_active: 0, approval: null },
      suspend: { is_active: 0, approval: "REJECTED" },
    };
    const cfg = map[parsed.data.action];
    if (cfg.approval) {
      await pool.execute("UPDATE restaurants SET is_active = ?, approval_status = ? WHERE id = ?", [
        cfg.is_active,
        cfg.approval,
        id,
      ]);
    } else {
      await pool.execute("UPDATE restaurants SET is_active = ? WHERE id = ?", [cfg.is_active, id]);
    }
    const [[owner]] = await pool.execute("SELECT owner_user_id FROM restaurants WHERE id = ?", [id]);
    if (owner && (parsed.data.action === "deactivate" || parsed.data.action === "suspend")) {
      await pool.execute("UPDATE users SET is_active = 0 WHERE id = ?", [owner.owner_user_id]);
    }
    if (owner && (parsed.data.action === "activate" || parsed.data.action === "restore")) {
      await pool.execute("UPDATE users SET is_active = 1 WHERE id = ?", [owner.owner_user_id]);
    }
    await logPortalAction(req, { action: `RESTAURANT_${parsed.data.action.toUpperCase()}`, module: "restaurants", targetId: id });
    return res.json({ message: "Restaurant status updated" });
  });

  router.get("/ads/stats", ...gate, requirePermission("ads"), async (req, res) => {
    const range = String(req.query.range || "week");
    let dateFilter = "created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)";
    if (range === "today") dateFilter = "DATE(created_at) = CURDATE()";
    if (range === "month") dateFilter = "created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)";

    const [[ads]] = await pool.execute("SELECT COUNT(*) AS total FROM advertisements");
    const [[active]] = await pool.execute("SELECT COUNT(*) AS total FROM advertisements WHERE status = 'ACTIVE'");
    const [[clicks]] = await pool.execute(`SELECT COUNT(*) AS total FROM ad_clicks WHERE ${dateFilter}`);
    const [[impressions]] = await pool.execute(`SELECT COUNT(*) AS total FROM ad_impressions WHERE ${dateFilter}`);
    const [[revenue]] = await pool.execute("SELECT COALESCE(SUM(revenue_generated),0) AS total FROM advertisements");

    const clicksN = Number(clicks.total);
    const impN = Number(impressions.total);
    return res.json({
      totalAds: Number(ads.total),
      activeAds: Number(active.total),
      clicks: clicksN,
      impressions: impN,
      ctr: impN ? ((clicksN / impN) * 100).toFixed(2) : "0.00",
      revenueGenerated: Number(revenue.total),
    });
  });

  router.get("/menu-items-picker", ...gate, requirePermission("trending"), async (_req, res) => {
    const [rows] = await pool.execute(
      `SELECT mi.id, mi.name, r.id AS restaurant_id, r.name AS restaurant_name
       FROM menu_items mi
       JOIN restaurants r ON r.id = mi.restaurant_id
       WHERE mi.is_active = 1 AND r.approval_status = 'APPROVED' AND r.is_active = 1
       ORDER BY r.name, mi.name LIMIT 500`
    );
    return res.json(rows);
  });
}

module.exports = { registerCustomerAdminExtensions };
