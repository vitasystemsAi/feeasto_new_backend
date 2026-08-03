const jwt = require("jsonwebtoken");
const env = require("../src/config/env");
const pool = require("../src/db/pool");

async function testRestaurantsQuery() {
  const limit = 100;
  const offset = 0;
  const whereSql = "1=1";
  const params = [];
  try {
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM restaurants r
       LEFT JOIN users u ON u.id = r.owner_user_id WHERE ${whereSql}`,
      params
    );
    console.log("total:", total);
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
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    console.log("rows:", rows.length);
  } catch (e) {
    console.error("restaurants FAIL:", e.message, e.code);
  }
}

async function testTrendingFoods() {
  try {
    const [manual] = await pool.execute(
      `SELECT tf.rank_position AS item_rank FROM trending_food_items tf LIMIT 1`
    );
    console.log("trending_food_items ok", manual.length);
  } catch (e) {
    console.error("trending FAIL:", e.message);
  }
}

async function testSearchAnalytics() {
  const type = "FOOD";
  const limit = 10;
  const dateFilter = "searched_on >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)";
  try {
    const [rows] = await pool.execute(
      `SELECT search_keyword, SUM(search_count) AS total_searches
       FROM search_analytics
       WHERE search_type = ? AND ${dateFilter}
       GROUP BY search_keyword
       ORDER BY total_searches DESC LIMIT ${limit}`,
      [type]
    );
    console.log("search ok", rows.length);
  } catch (e) {
    console.error("search FAIL:", e.message);
  }
}

async function testCustomers() {
  try {
    const [rows] = await pool.execute(
      `SELECT u.id, u.full_name, u.email, u.is_active, u.created_at,
              COUNT(DISTINCT o.id) AS total_orders,
              (SELECT MAX(ps.login_at) FROM portal_sessions ps WHERE ps.user_id = u.id) AS last_login
       FROM users u
       LEFT JOIN orders o ON o.customer_user_id = u.id
       WHERE u.role = 'CUSTOMER'
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT 50 OFFSET 0`
    );
    console.log("customers ok", rows.length);
  } catch (e) {
    console.error("customers FAIL:", e.message);
  }
}

async function main() {
  await testRestaurantsQuery();
  await testTrendingFoods();
  await testSearchAnalytics();
  await testCustomers();
  await pool.end();
}

main();
