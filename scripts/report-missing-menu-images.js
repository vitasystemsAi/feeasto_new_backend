/**
 * Lists menu items whose imageUrl in DB has no file in backend/uploads.
 * Run: node scripts/report-missing-menu-images.js [restaurantId]
 */
const pool = require("../src/db/pool");
const { parseMenuItemDescription } = require("../src/utils/menuItemDescription");
const { uploadFileExists, normalizeStoredUploadPath } = require("../src/utils/menuUploadIndex");

(async () => {
  const restaurantId = Number(process.argv[2] || 0);
  const sql = restaurantId
    ? "SELECT id, name, description FROM menu_items WHERE restaurant_id = ? AND is_active = 1"
    : "SELECT id, name, description, restaurant_id FROM menu_items WHERE is_active = 1";
  const params = restaurantId ? [restaurantId] : [];
  const [rows] = await pool.execute(sql, params);

  let missing = 0;
  let ok = 0;
  for (const row of rows) {
    const meta = parseMenuItemDescription(row.description);
    const path = normalizeStoredUploadPath(meta.imageUrl);
    if (!path) continue;
    if (uploadFileExists(path)) {
      ok += 1;
    } else {
      missing += 1;
      console.log(`MISSING #${row.id} ${row.name}: ${path}`);
    }
  }
  console.log(`\nFiles on disk: ${ok}, missing: ${missing}`);
  console.log("Re-upload images in Master Data → Menu (Edit item → choose file → Update).");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
