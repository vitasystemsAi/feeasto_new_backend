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

async function addColumnIfMissing(table, column, definition) {
  if (await columnExists(table, column)) return;
  try {
    await pool.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    if (error?.code !== "ER_DUP_FIELDNAME") throw error;
  }
}

async function ensureStructuredAddressSchema() {
  if (ensured) return true;

  const restaurantCols = [
    ["address_village", "VARCHAR(120) NULL"],
    ["address_city", "VARCHAR(120) NULL"],
    ["address_district", "VARCHAR(120) NULL"],
    ["address_state", "VARCHAR(120) NULL"],
    ["address_country", "VARCHAR(80) NOT NULL DEFAULT 'India'"],
    ["address_pincode", "VARCHAR(12) NULL"],
  ];
  for (const [col, def] of restaurantCols) {
    await addColumnIfMissing("restaurants", col, def);
  }

  const userCols = [
    ["home_village", "VARCHAR(120) NULL"],
    ["home_city", "VARCHAR(120) NULL"],
    ["home_district", "VARCHAR(120) NULL"],
    ["home_state", "VARCHAR(120) NULL"],
    ["home_country", "VARCHAR(80) NOT NULL DEFAULT 'India'"],
    ["home_pincode", "VARCHAR(12) NULL"],
  ];
  for (const [col, def] of userCols) {
    await addColumnIfMissing("users", col, def);
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS customer_saved_addresses (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id BIGINT NOT NULL,
      label ENUM('HOME','OFFICE','OTHER') NOT NULL DEFAULT 'HOME',
      village VARCHAR(120) NULL,
      city VARCHAR(120) NOT NULL,
      district VARCHAR(120) NOT NULL,
      state VARCHAR(120) NOT NULL,
      country VARCHAR(80) NOT NULL DEFAULT 'India',
      pincode VARCHAR(12) NOT NULL,
      address_line VARCHAR(500) NULL,
      latitude DECIMAL(10,7) NULL,
      longitude DECIMAL(10,7) NULL,
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_customer_saved_addresses_user (user_id)
    )
  `);

  const adCols = [
    ["target_pincode", "VARCHAR(12) NULL"],
    ["target_district", "VARCHAR(120) NULL"],
    ["target_radius_km", "DECIMAL(5,2) NULL DEFAULT 15"],
  ];
  for (const [col, def] of adCols) {
    await addColumnIfMissing("advertisements", col, def);
  }

  await addColumnIfMissing("customer_saved_addresses", "contact_name", "VARCHAR(120) NOT NULL DEFAULT ''");
  await addColumnIfMissing("customer_saved_addresses", "contact_phone", "VARCHAR(15) NOT NULL DEFAULT ''");
  await addColumnIfMissing("orders", "customer_contact_phone", "VARCHAR(15) NULL");
  await addColumnIfMissing("order_items", "customization_json", "JSON NULL");

  ensured = true;
  return true;
}

module.exports = { ensureStructuredAddressSchema };
