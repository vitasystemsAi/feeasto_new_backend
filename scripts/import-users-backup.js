/**
 * Import users from JSON backup — inserts only emails not already in `users`.
 * Restores CUSTOMER_ADMIN role + permissions when email exists but role was lost.
 *
 * Usage:
 *   node scripts/import-users-backup.js
 *   node scripts/import-users-backup.js "C:\path\to\users_backup.json"
 */
const fs = require("fs");
const path = require("path");
const pool = require("../src/db/pool");
const { ALL_PERMISSIONS } = require("../src/modules/portal/utils/permissions");

const defaultPath = path.join(__dirname, "..", "data", "users_backup.json");
const backupPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultPath;

const CUSTOMER_ADMIN_PERMS = ALL_PERMISSIONS.filter((p) => p !== "customer_admins");

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

async function ensureCustomerAdmin(conn, userId) {
  const [[ca]] = await conn.execute("SELECT id FROM customer_admins WHERE user_id = ? LIMIT 1", [userId]);
  let caId = ca?.id;
  if (!caId) {
    const [ins] = await conn.execute("INSERT INTO customer_admins (user_id, is_active) VALUES (?, 1)", [userId]);
    caId = ins.insertId;
  } else {
    await conn.execute("UPDATE customer_admins SET is_active = 1 WHERE id = ?", [caId]);
  }
  await conn.execute("DELETE FROM admin_permissions WHERE customer_admin_id = ?", [caId]);
  for (const key of CUSTOMER_ADMIN_PERMS) {
    await conn.execute(
      "INSERT INTO admin_permissions (customer_admin_id, permission_key, is_granted) VALUES (?, ?, 1)",
      [caId, key]
    );
  }
  return caId;
}

async function idAvailable(conn, id) {
  const [[row]] = await conn.execute("SELECT id FROM users WHERE id = ? LIMIT 1", [id]);
  return !row;
}

async function ensureRoleEnum(conn) {
  await conn.execute(`
    ALTER TABLE users
    MODIFY role ENUM(
      'CUSTOMER','OWNER','MANAGER','DELIVERY_PARTNER','ADMIN','SUPER_ADMIN','CUSTOMER_ADMIN'
    ) NOT NULL
  `);
}

async function main() {
  if (!fs.existsSync(backupPath)) {
    console.error(`Backup file not found: ${backupPath}`);
    process.exit(1);
  }

  const users = JSON.parse(fs.readFileSync(backupPath, "utf8"));
  if (!Array.isArray(users)) {
    console.error("Backup must be a JSON array of users.");
    process.exit(1);
  }

  const conn = await pool.getConnection();
  const summary = { inserted: 0, skipped: 0, roleRestored: 0, errors: [] };

  try {
    await conn.beginTransaction();
    await ensureRoleEnum(conn);

    for (const row of users) {
      const email = normalizeEmail(row.email);
      if (!email) {
        summary.errors.push("Skipped row with missing email");
        continue;
      }

      const [[existing]] = await conn.execute(
        "SELECT id, email, role FROM users WHERE LOWER(email) = ? LIMIT 1",
        [email]
      );

      if (existing) {
        summary.skipped += 1;
        console.log(`Skip (exists): ${email} — id ${existing.id}, role ${existing.role}`);

        if (row.role === "CUSTOMER_ADMIN" && existing.role !== "CUSTOMER_ADMIN") {
          await conn.execute(
            "UPDATE users SET role = 'CUSTOMER_ADMIN', full_name = ?, password_hash = ?, is_active = 1, tenant_id = ? WHERE id = ?",
            [row.full_name, row.password_hash, row.tenant_id ?? null, existing.id]
          );
          const caId = await ensureCustomerAdmin(conn, existing.id);
          summary.roleRestored += 1;
          console.log(`  → Restored CUSTOMER_ADMIN + permissions (customer_admins ${caId})`);
        }
        continue;
      }

      const useId = row.id && (await idAvailable(conn, row.id)) ? row.id : null;
      let insertId;

      if (useId) {
        const [ins] = await conn.execute(
          `INSERT INTO users (id, tenant_id, full_name, email, password_hash, role, is_active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            useId,
            row.tenant_id ?? null,
            row.full_name,
            email,
            row.password_hash,
            row.role,
            row.is_active ? 1 : 0,
            row.created_at || new Date(),
          ]
        );
        insertId = ins.insertId || useId;
      } else {
        const [ins] = await conn.execute(
          `INSERT INTO users (tenant_id, full_name, email, password_hash, role, is_active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            row.tenant_id ?? null,
            row.full_name,
            email,
            row.password_hash,
            row.role,
            row.is_active ? 1 : 0,
            row.created_at || new Date(),
          ]
        );
        insertId = ins.insertId;
      }

      summary.inserted += 1;
      console.log(`Inserted: ${email} — id ${insertId}, role ${row.role}`);

      if (row.role === "CUSTOMER_ADMIN") {
        const caId = await ensureCustomerAdmin(conn, insertId);
        console.log(`  → customer_admins ${caId} + permissions`);
      }
    }

    await conn.commit();
    console.log("\nDone:", summary);
  } catch (err) {
    await conn.rollback();
    console.error("Import failed:", err.message);
    process.exit(1);
  } finally {
    conn.release();
    await pool.end();
  }
}

main();
