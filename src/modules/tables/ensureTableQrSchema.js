const crypto = require("crypto");
const pool = require("../../db/pool");

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

function generateQrToken() {
  return crypto.randomBytes(24).toString("hex");
}

async function ensureTableQrSchema() {
  if (!(await columnExists("restaurant_tables", "qr_token"))) {
    await pool.query(
      "ALTER TABLE restaurant_tables ADD COLUMN qr_token VARCHAR(64) NULL AFTER status"
    );
  }

  const [qrIdx] = await pool.query(
    "SHOW INDEX FROM restaurant_tables WHERE Key_name = 'uq_restaurant_tables_qr_token'"
  );
  if (!qrIdx.length) {
    try {
      await pool.query(
        "CREATE UNIQUE INDEX uq_restaurant_tables_qr_token ON restaurant_tables(qr_token)"
      );
    } catch (error) {
      if (error?.code !== "ER_DUP_KEYNAME") throw error;
    }
  }

  if (!(await columnExists("orders", "guest_name"))) {
    await pool.query(
      "ALTER TABLE orders ADD COLUMN guest_name VARCHAR(120) NULL AFTER customer_contact_phone"
    );
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS restaurant_table_customers (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      tenant_id BIGINT NOT NULL,
      restaurant_id BIGINT NOT NULL,
      full_name VARCHAR(120) NOT NULL,
      phone VARCHAR(15) NOT NULL,
      visit_count INT NOT NULL DEFAULT 1,
      last_table_id BIGINT NULL,
      last_order_id BIGINT NULL,
      first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_table_customers_restaurant_phone (restaurant_id, phone),
      KEY idx_table_customers_tenant (tenant_id),
      KEY idx_table_customers_restaurant (restaurant_id),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
    )
  `);

  // Backfill missing QR tokens for existing tables.
  const [missing] = await pool.execute(
    "SELECT id FROM restaurant_tables WHERE qr_token IS NULL OR qr_token = ''"
  );
  for (const row of missing) {
    let assigned = false;
    for (let attempt = 0; attempt < 5 && !assigned; attempt += 1) {
      const token = generateQrToken();
      try {
        await pool.execute("UPDATE restaurant_tables SET qr_token = ? WHERE id = ? AND (qr_token IS NULL OR qr_token = '')", [
          token,
          row.id,
        ]);
        assigned = true;
      } catch (error) {
        if (error?.code !== "ER_DUP_ENTRY") throw error;
      }
    }
  }
}

async function ensureTableHasQrToken(tableId) {
  const [[row]] = await pool.execute(
    "SELECT id, qr_token FROM restaurant_tables WHERE id = ? LIMIT 1",
    [tableId]
  );
  if (!row) return null;
  if (row.qr_token) return row.qr_token;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const token = generateQrToken();
    try {
      await pool.execute("UPDATE restaurant_tables SET qr_token = ? WHERE id = ? AND (qr_token IS NULL OR qr_token = '')", [
        token,
        tableId,
      ]);
      return token;
    } catch (error) {
      if (error?.code !== "ER_DUP_ENTRY") throw error;
    }
  }
  return null;
}

async function ensureQrGuestUser(tenantId) {
  const email = `qr-guest+tenant${tenantId}@internal.feeasto.local`;
  const [[existing]] = await pool.execute("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
  if (existing) return existing.id;

  const bcrypt = require("bcryptjs");
  const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
  try {
    const [created] = await pool.execute(
      "INSERT INTO users (tenant_id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, 'CUSTOMER')",
      [tenantId, "QR Guest", email, passwordHash]
    );
    return created.insertId;
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY") {
      const [[again]] = await pool.execute("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
      if (again) return again.id;
    }
    throw error;
  }
}

async function upsertTableCustomer({ tenantId, restaurantId, fullName, phone, tableId, orderId }) {
  const [[existing]] = await pool.execute(
    "SELECT id, visit_count FROM restaurant_table_customers WHERE restaurant_id = ? AND phone = ? LIMIT 1",
    [restaurantId, phone]
  );
  if (existing) {
    await pool.execute(
      `UPDATE restaurant_table_customers
       SET full_name = ?, visit_count = ?, last_table_id = ?, last_order_id = ?, last_seen_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [fullName, Number(existing.visit_count || 0) + 1, tableId || null, orderId || null, existing.id]
    );
    return existing.id;
  }
  const [created] = await pool.execute(
    `INSERT INTO restaurant_table_customers
      (tenant_id, restaurant_id, full_name, phone, visit_count, last_table_id, last_order_id)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    [tenantId, restaurantId, fullName, phone, tableId || null, orderId || null]
  );
  return created.insertId;
}

module.exports = {
  ensureTableQrSchema,
  ensureTableHasQrToken,
  ensureQrGuestUser,
  upsertTableCustomer,
  generateQrToken,
};
