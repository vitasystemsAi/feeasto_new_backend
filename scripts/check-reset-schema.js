const pool = require("../src/db/pool");
const { ensurePasswordResetSchema } = require("../src/utils/ensurePasswordResetSchema");
const { requestPasswordReset } = require("../src/services/passwordReset");

(async () => {
  try {
    await ensurePasswordResetSchema();
    const [c] = await pool.query("SHOW COLUMNS FROM users LIKE 'phone'");
    console.log("phone column:", c.length);
    const [t] = await pool.query("SHOW TABLES LIKE 'password_reset_otps'");
    console.log("reset table:", t.length);
    const [[u]] = await pool.execute("SELECT id, email FROM users WHERE is_active = 1 LIMIT 1");
    console.log("user:", u?.email);
    if (u?.email) {
      const r = await requestPasswordReset(u.email);
      console.log("forgot result:", r);
    }
  } catch (e) {
    console.error("FAIL:", e.message);
    console.error(e.stack);
  }
  process.exit(0);
})();
