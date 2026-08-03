/**
 * Create CUSTOMER_ADMIN with full customer-admin permissions.
 * Usage: node scripts/seed-customer-admin.js [email] [password] [fullName]
 */
const bcrypt = require("bcryptjs");
const pool = require("../src/db/pool");
const { ALL_PERMISSIONS } = require("../src/modules/portal/utils/permissions");

const email = (process.argv[2] || "nikhilsuvva77@gmail.com").trim().toLowerCase();
const password = process.argv[3] || "Nikhil@123";
const fullName = process.argv[4] || "Customer Admin";

const perms = ALL_PERMISSIONS.filter((p) => p !== "customer_admins");

async function main() {
  const hash = await bcrypt.hash(password, 10);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[existing]] = await conn.execute("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
    let userId;
    if (existing) {
      userId = existing.id;
      await conn.execute(
        "UPDATE users SET full_name = ?, password_hash = ?, role = 'CUSTOMER_ADMIN', is_active = 1 WHERE id = ?",
        [fullName, hash, userId]
      );
    } else {
      const [ins] = await conn.execute(
        "INSERT INTO users (full_name, email, password_hash, role, tenant_id, is_active) VALUES (?, ?, ?, 'CUSTOMER_ADMIN', NULL, 1)",
        [fullName, email, hash]
      );
      userId = ins.insertId;
    }

    const [[ca]] = await conn.execute("SELECT id FROM customer_admins WHERE user_id = ? LIMIT 1", [userId]);
    let caId = ca?.id;
    if (!caId) {
      const [caIns] = await conn.execute(
        "INSERT INTO customer_admins (user_id, is_active) VALUES (?, 1)",
        [userId]
      );
      caId = caIns.insertId;
    } else {
      await conn.execute("UPDATE customer_admins SET is_active = 1 WHERE id = ?", [caId]);
    }

    await conn.execute("DELETE FROM admin_permissions WHERE customer_admin_id = ?", [caId]);
    for (const key of perms) {
      await conn.execute(
        "INSERT INTO admin_permissions (customer_admin_id, permission_key, is_granted) VALUES (?, ?, 1)",
        [caId, key]
      );
    }
    await conn.commit();
    console.log(`CUSTOMER_ADMIN ready: ${email} (user ${userId}, ca ${caId})`);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
