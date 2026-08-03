const express = require("express");
const pool = require("../../db/pool");
const auth = require("../../middlewares/auth");
const rbac = require("../../middlewares/rbac");
const tenantScope = require("../../middlewares/tenant");
const revenueRoutes = require("./revenue.routes");

const router = express.Router();

router.use(revenueRoutes);

router.get("/owner-kpis", auth(), tenantScope, rbac("OWNER", "MANAGER"), async (req, res) => {
  const [orders] = await pool.execute(
    "SELECT COUNT(*) AS totalOrders FROM orders WHERE tenant_id = ? AND status = 'DELIVERED'",
    [req.tenantId]
  );
  const [revenue] = await pool.execute(
    `SELECT COALESCE(SUM(amount), 0) AS totalRevenue FROM payments
     WHERE tenant_id = ? AND payment_status IN ('PAID','PARTIALLY_REFUNDED')`,
    [req.tenantId]
  );
  return res.json({ totalOrders: orders[0].totalOrders, totalRevenue: revenue[0].totalRevenue });
});

router.get("/admin-kpis", auth(), rbac("ADMIN", "SUPER_ADMIN"), async (_req, res) => {
  const [restaurants] = await pool.execute("SELECT COUNT(*) AS totalRestaurants FROM restaurants");
  const [users] = await pool.execute("SELECT COUNT(*) AS totalUsers FROM users");
  return res.json({ totalRestaurants: restaurants[0].totalRestaurants, totalUsers: users[0].totalUsers });
});

module.exports = router;
