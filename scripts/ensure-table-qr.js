const { ensureTableQrSchema } = require("../src/modules/tables/ensureTableQrSchema");
const pool = require("../src/db/pool");

async function main() {
  await ensureTableQrSchema();
  const [cols] = await pool.query("SHOW COLUMNS FROM restaurant_tables LIKE 'qr_token'");
  const [cnt] = await pool.query(
    "SELECT COUNT(*) AS c, SUM(CASE WHEN qr_token IS NOT NULL AND qr_token <> '' THEN 1 ELSE 0 END) AS with_token FROM restaurant_tables"
  );
  console.log(JSON.stringify({ qrTokenColumn: cols.length > 0, tables: cnt[0] }, null, 2));
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
