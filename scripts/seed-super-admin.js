/**
 * Create or update a SUPER_ADMIN user.
 * Usage: node scripts/seed-super-admin.js [email] [password] [fullName]
 */
const bcrypt = require("bcryptjs");
const pool = require("../src/db/pool");

const email = (process.argv[2] || process.env.DEFAULT_ADMIN_EMAIL || "").trim().toLowerCase();
const password = process.argv[3] || process.env.DEFAULT_ADMIN_PASSWORD || "";
const fullName = process.argv[4] || process.env.DEFAULT_ADMIN_NAME || "Super Admin";

async function main() {
  if (!email || !password) {
    console.error("Usage: node scripts/seed-super-admin.js <email> <password> [fullName]");
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);
  const [[existing]] = await pool.execute("SELECT id, role FROM users WHERE email = ? LIMIT 1", [email]);

  if (existing) {
    await pool.execute(
      "UPDATE users SET full_name = ?, password_hash = ?, role = 'SUPER_ADMIN', is_active = 1 WHERE id = ?",
      [fullName, hash, existing.id]
    );
    console.log(`Updated SUPER_ADMIN: ${email} (id ${existing.id})`);
  } else {
    const [result] = await pool.execute(
      "INSERT INTO users (full_name, email, password_hash, role, tenant_id, is_active) VALUES (?, ?, ?, 'SUPER_ADMIN', NULL, 1)",
      [fullName, email, hash]
    );
    console.log(`Created SUPER_ADMIN: ${email} (id ${result.insertId})`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
