const pool = require("../db/pool");

let ensured = false;

async function columnExists(table, column) {
  const [rows] = await pool.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function ensureLocationColumns() {
  if (ensured) return true;
  const alters = [
    ["restaurants", "latitude", "DECIMAL(10,7) NULL AFTER address"],
    ["restaurants", "longitude", "DECIMAL(10,7) NULL AFTER latitude"],
    ["users", "home_address", "TEXT NULL AFTER email"],
    ["users", "home_latitude", "DECIMAL(10,7) NULL AFTER home_address"],
    ["users", "home_longitude", "DECIMAL(10,7) NULL AFTER home_latitude"],
    ["orders", "delivery_address", "TEXT NULL AFTER order_type"],
    ["orders", "delivery_latitude", "DECIMAL(10,7) NULL AFTER delivery_address"],
    ["orders", "delivery_longitude", "DECIMAL(10,7) NULL AFTER delivery_latitude"],
  ];
  for (const [table, column, def] of alters) {
    if (!(await columnExists(table, column))) {
      try {
        await pool.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      } catch (error) {
        if (error?.code !== "ER_DUP_FIELDNAME") throw error;
      }
    }
  }
  ensured = true;
  return true;
}

module.exports = { ensureLocationColumns };
