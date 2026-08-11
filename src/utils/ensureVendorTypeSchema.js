const pool = require("../db/pool");

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT 1 AS ok
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
     LIMIT 1`,
    [table, column]
  );
  return Boolean(rows[0]);
}

async function ensureVendorTypeSchema() {
  if (!(await columnExists("restaurants", "business_type"))) {
    await pool.query(
      "ALTER TABLE restaurants ADD COLUMN business_type VARCHAR(50) NOT NULL DEFAULT 'restaurant' AFTER name"
    );
  }
  if (!(await columnExists("restaurants", "business_type_label"))) {
    await pool.query(
      "ALTER TABLE restaurants ADD COLUMN business_type_label VARCHAR(100) NULL AFTER business_type"
    );
  }
  if (!(await columnExists("restaurants", "vendor_config"))) {
    await pool.query(
      "ALTER TABLE restaurants ADD COLUMN vendor_config JSON NULL AFTER business_type_label"
    );
  }
}

module.exports = { ensureVendorTypeSchema };
