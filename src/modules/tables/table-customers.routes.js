const express = require("express");
const { z } = require("zod");
const pool = require("../../db/pool");
const auth = require("../../middlewares/auth");
const rbac = require("../../middlewares/rbac");
const tenantScope = require("../../middlewares/tenant");

function tableCustomersRoutes() {
  const router = express.Router();

  router.get("/", auth(), rbac("OWNER", "MANAGER", "ADMIN", "SUPER_ADMIN"), tenantScope, async (req, res) => {
    const schema = z.object({
      restaurantId: z.coerce.number().int().positive(),
      q: z.string().trim().max(80).optional(),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const { restaurantId, q } = parsed.data;
    try {
      const params = [req.tenantId, restaurantId];
      let searchSql = "";
      if (q) {
        searchSql = " AND (c.full_name LIKE ? OR c.phone LIKE ?)";
        const like = `%${q}%`;
        params.push(like, like);
      }

      const [rows] = await pool.execute(
        `SELECT c.id, c.full_name, c.phone, c.visit_count, c.first_seen_at, c.last_seen_at,
                c.last_table_id, c.last_order_id, rt.table_number AS last_table_number
         FROM restaurant_table_customers c
         LEFT JOIN restaurant_tables rt ON rt.id = c.last_table_id
         WHERE c.tenant_id = ? AND c.restaurant_id = ?${searchSql}
         ORDER BY c.last_seen_at DESC
         LIMIT 500`,
        params
      );

      return res.json({
        items: rows.map((r) => ({
          id: r.id,
          fullName: r.full_name,
          phone: r.phone,
          visitCount: Number(r.visit_count || 0),
          firstSeenAt: r.first_seen_at,
          lastSeenAt: r.last_seen_at,
          lastTableId: r.last_table_id,
          lastTableNumber: r.last_table_number || null,
          lastOrderId: r.last_order_id,
        })),
      });
    } catch (error) {
      if (error?.code === "ER_NO_SUCH_TABLE") {
        return res.json({ items: [] });
      }
      return res.status(500).json({ message: "Failed to load customer details", details: error.message });
    }
  });

  return router;
}

module.exports = tableCustomersRoutes;
