const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../src/db/pool");
const env = require("../src/config/env");

async function main() {
  await pool.query("SELECT 1");
  const [[user]] = await pool.execute(
    "SELECT id, email, role FROM users WHERE email = ? LIMIT 1",
    ["nikhilsuvva77@gmail.com"]
  );
  console.log("user:", user);

  try {
    const [restaurants] = await pool.execute(
      `SELECT r.id, r.name, r.is_active, r.approval_status
       FROM restaurants r LIMIT 5`
    );
    console.log("restaurants sample:", restaurants);
  } catch (e) {
    console.error("restaurants query failed:", e.message);
  }

  if (user) {
    const [perms] = await pool.execute(
      `SELECT ap.permission_key FROM admin_permissions ap
       JOIN customer_admins ca ON ca.id = ap.customer_admin_id
       WHERE ca.user_id = ? AND ap.is_granted = 1`,
      [user.id]
    );
    console.log("permissions:", perms.map((p) => p.permission_key));
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
