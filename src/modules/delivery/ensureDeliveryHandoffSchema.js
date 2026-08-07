const pool = require("../../db/pool");

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

async function ensureDeliveryHandoffSchema() {
  if (!(await columnExists("deliveries", "restaurant_handoff_at"))) {
    await pool.query(
      "ALTER TABLE deliveries ADD COLUMN restaurant_handoff_at DATETIME NULL AFTER eta_minutes"
    );
  }
  if (!(await columnExists("deliveries", "partner_pickup_at"))) {
    await pool.query(
      "ALTER TABLE deliveries ADD COLUMN partner_pickup_at DATETIME NULL AFTER restaurant_handoff_at"
    );
  }
  if (!(await columnExists("restaurant_delivery_partner_profiles", "vehicle_number"))) {
    await pool.query(
      "ALTER TABLE restaurant_delivery_partner_profiles ADD COLUMN vehicle_number VARCHAR(40) NULL AFTER phone"
    );
  }
}

module.exports = { ensureDeliveryHandoffSchema };
