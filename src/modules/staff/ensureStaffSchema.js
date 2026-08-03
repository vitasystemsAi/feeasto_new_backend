const pool = require("../../db/pool");

async function ensureStaffSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS restaurant_staff (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      tenant_id BIGINT NOT NULL,
      restaurant_id BIGINT NOT NULL,
      user_id BIGINT NULL,
      full_name VARCHAR(120) NOT NULL,
      email VARCHAR(150) NULL,
      phone VARCHAR(20) NULL,
      staff_role ENUM(
        'OWNER_MANAGER',
        'COOK',
        'ASSISTANT_COOK',
        'SERVER',
        'HELPER',
        'CASHIER',
        'DELIVERY_PERSON'
      ) NOT NULL,
      employment_type ENUM('FULL_TIME', 'PART_TIME', 'CONTRACT', 'TEMP') NOT NULL DEFAULT 'FULL_TIME',
      shift_note VARCHAR(120) NULL,
      emergency_contact VARCHAR(120) NULL,
      emergency_phone VARCHAR(20) NULL,
      date_joined DATE NULL,
      notes TEXT NULL,
      has_app_login TINYINT(1) NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  const [idxRestaurant] = await pool.query(
    "SHOW INDEX FROM restaurant_staff WHERE Key_name = 'idx_restaurant_staff_restaurant'"
  );
  if (!idxRestaurant.length) {
    await pool.query("CREATE INDEX idx_restaurant_staff_restaurant ON restaurant_staff(restaurant_id)");
  }
}

module.exports = { ensureStaffSchema };
