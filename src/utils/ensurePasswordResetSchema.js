const pool = require("../db/pool");

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function ensurePasswordResetSchema() {
  if (!(await columnExists("users", "phone"))) {
    await pool.query("ALTER TABLE users ADD COLUMN phone VARCHAR(20) NULL AFTER email");
  }
  if (!(await columnExists("users", "password_updated_at"))) {
    await pool.query("ALTER TABLE users ADD COLUMN password_updated_at DATETIME NULL AFTER password_hash");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_otps (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id BIGINT NOT NULL,
      identifier_key VARCHAR(64) NOT NULL,
      otp_hash VARCHAR(255) NOT NULL,
      expires_at DATETIME NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      resend_count INT NOT NULL DEFAULT 0,
      is_used TINYINT(1) NOT NULL DEFAULT 0,
      verified_at DATETIME NULL,
      locked_at DATETIME NULL,
      last_sent_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_password_reset_user (user_id),
      INDEX idx_password_reset_identifier (identifier_key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
}

module.exports = { ensurePasswordResetSchema };
