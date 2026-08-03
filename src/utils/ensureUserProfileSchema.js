const pool = require("../db/pool");

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function ensureUserProfileSchema() {
  if (!(await columnExists("users", "phone"))) {
    await pool.query("ALTER TABLE users ADD COLUMN phone VARCHAR(20) NULL AFTER email");
  }
  if (!(await columnExists("users", "profile_updated_at"))) {
    const after = (await columnExists("users", "password_updated_at"))
      ? "password_updated_at"
      : "password_hash";
    await pool.query(
      `ALTER TABLE users ADD COLUMN profile_updated_at DATETIME NULL AFTER ${after}`
    );
  }
}

module.exports = { ensureUserProfileSchema };
