/**
 * Verify menu upload files vs DB, optionally force-refresh all image metadata.
 * Usage:
 *   node scripts/refresh-restaurant-menu-images.js Garuda
 *   node scripts/refresh-restaurant-menu-images.js 6 --force
 */
const pool = require("../src/db/pool");
const { parseMenuItemDescription } = require("../src/utils/menuItemDescription");
const {
  resolveMenuItemUploadPath,
  uploadFileExists,
  normalizeStoredUploadPath,
  refreshIndexIfNeeded,
} = require("../src/utils/menuUploadIndex");

async function main() {
  const arg = process.argv[2];
  const force = process.argv.includes("--force");
  if (!arg) {
    console.error("Usage: node scripts/refresh-restaurant-menu-images.js <restaurantId|name> [--force]");
    process.exit(1);
  }

  let restaurantId = Number(arg);
  if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
    const [rows] = await pool.execute(
      "SELECT id, name, tenant_id FROM restaurants WHERE name LIKE ? LIMIT 1",
      [`%${arg}%`]
    );
    if (!rows.length) {
      console.error("Restaurant not found:", arg);
      process.exit(1);
    }
    restaurantId = rows[0].id;
    console.log(`Restaurant: ${rows[0].name} (id=${restaurantId}, tenant=${rows[0].tenant_id})`);
  }

  const fileCount = refreshIndexIfNeeded().files.length;
  console.log(`Indexed ${fileCount} file(s) in uploads/`);

  const [items] = await pool.execute(
    "SELECT id, name, description, tenant_id FROM menu_items WHERE restaurant_id = ? AND is_active = 1",
    [restaurantId]
  );

  let ok = 0;
  let missing = 0;
  let updated = 0;
  const syncedAt = new Date().toISOString();
  const tenantId = items[0]?.tenant_id;

  for (const row of items) {
    const meta = parseMenuItemDescription(row.description);
    const stored = meta.imageUrl ? normalizeStoredUploadPath(meta.imageUrl) : null;
    const resolved = resolveMenuItemUploadPath(row.name, meta.imageUrl);
    const pathToUse = resolved || stored;

    if (!pathToUse || !uploadFileExists(pathToUse)) {
      missing += 1;
      console.log(`MISSING #${row.id} ${row.name}`);
      continue;
    }
    ok += 1;

    const shouldUpdate = force || (resolved && resolved !== meta.imageUrl);
    if (!shouldUpdate) continue;

    const next = JSON.stringify({
      text: meta.text || null,
      imageUrl: resolved || meta.imageUrl,
      imageSyncedAt: syncedAt,
    });
    const [result] = await pool.execute(
      "UPDATE menu_items SET description = ? WHERE id = ? AND tenant_id = ?",
      [next, row.id, row.tenant_id]
    );
    if (result.affectedRows > 0) updated += 1;
  }

  console.log(`\nItems: ${items.length} | on disk: ${ok} | missing file: ${missing}`);
  if (force) console.log(`Force-refreshed: ${updated}`);
  else console.log(`Re-linked: ${updated} (run with --force to refresh all paths)`);
  process.exit(missing > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
