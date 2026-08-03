const pool = require("../../db/pool");
const { normalizeCategoryKey, titleCaseFromKey } = require("../../utils/categoryKey.util");

async function ensureCatalogTable() {
  try {
    await pool.execute(
      `CREATE TABLE IF NOT EXISTS platform_category_catalog (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        category_key VARCHAR(120) NOT NULL,
        display_name VARCHAR(120) NOT NULL,
        image_url VARCHAR(500) NULL,
        sort_order INT NOT NULL DEFAULT 0,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_platform_category_key (category_key)
      )`
    );
    return true;
  } catch {
    return false;
  }
}

/** Distinct category names from approved restaurants with active menu items. */
async function discoverCategoryKeysFromMenus() {
  const [rows] = await pool.execute(
    `SELECT LOWER(TRIM(mc.name)) AS category_key,
            MIN(TRIM(mc.name)) AS sample_name,
            COUNT(DISTINCT mc.restaurant_id) AS restaurant_count
     FROM menu_categories mc
     INNER JOIN restaurants r ON r.id = mc.restaurant_id AND r.approval_status = 'APPROVED'
     INNER JOIN menu_items mi ON mi.category_id = mc.id AND mi.is_active = 1
     WHERE TRIM(mc.name) <> ''
     GROUP BY LOWER(TRIM(mc.name))
     ORDER BY sample_name ASC`
  );
  return rows.map((r) => ({
    categoryKey: normalizeCategoryKey(r.category_key || r.sample_name),
    sampleName: r.sample_name,
    restaurantCount: Number(r.restaurant_count) || 0,
  }));
}

async function syncDiscoveredCategories() {
  const hasTable = await ensureCatalogTable();
  if (!hasTable) return { synced: false, discovered: [] };

  const discovered = await discoverCategoryKeysFromMenus();
  const [[maxRow]] = await pool.execute(
    "SELECT COALESCE(MAX(sort_order), 0) AS mx FROM platform_category_catalog"
  );
  let nextOrder = Number(maxRow?.mx) || 0;

  for (const d of discovered) {
    if (!d.categoryKey) continue;
    const [existing] = await pool.execute(
      "SELECT id FROM platform_category_catalog WHERE category_key = ? LIMIT 1",
      [d.categoryKey]
    );
    if (!existing[0]) {
      nextOrder += 10;
      await pool.execute(
        `INSERT INTO platform_category_catalog (category_key, display_name, sort_order, is_active)
         VALUES (?, ?, ?, 1)`,
        [d.categoryKey, d.sampleName || titleCaseFromKey(d.categoryKey), nextOrder]
      );
    }
  }
  return { synced: true, discovered };
}

async function fetchCatalogRows(includeInactive = false) {
  const hasTable = await ensureCatalogTable();
  if (!hasTable) {
    const discovered = await discoverCategoryKeysFromMenus();
    return discovered.map((d, i) => ({
      id: null,
      categoryKey: d.categoryKey,
      displayName: d.sampleName || titleCaseFromKey(d.categoryKey),
      imageUrl: null,
      sortOrder: (i + 1) * 10,
      isActive: true,
      restaurantCount: d.restaurantCount,
    }));
  }

  await syncDiscoveredCategories();

  const where = includeInactive ? "" : "WHERE c.is_active = 1";
  const [rows] = await pool.execute(
    `SELECT c.id, c.category_key, c.display_name, c.image_url, c.sort_order, c.is_active,
            (
              SELECT COUNT(DISTINCT mc.restaurant_id)
              FROM menu_categories mc
              INNER JOIN restaurants r ON r.id = mc.restaurant_id AND r.approval_status = 'APPROVED'
              INNER JOIN menu_items mi ON mi.category_id = mc.id AND mi.is_active = 1
              WHERE LOWER(TRIM(mc.name)) = c.category_key
            ) AS restaurant_count
     FROM platform_category_catalog c
     ${where}
     ORDER BY c.sort_order ASC, c.display_name ASC`
  );

  return rows
    .filter((r) => includeInactive || Number(r.restaurant_count) > 0)
    .map((r) => ({
      id: r.id,
      categoryKey: r.category_key,
      displayName: r.display_name,
      imageUrl: r.image_url,
      sortOrder: Number(r.sort_order) || 0,
      isActive: Boolean(r.is_active),
      restaurantCount: Number(r.restaurant_count) || 0,
    }));
}

async function fetchRestaurantCategoryKeys() {
  const [rows] = await pool.execute(
    `SELECT DISTINCT mc.restaurant_id,
            LOWER(TRIM(mc.name)) AS category_key
     FROM menu_categories mc
     INNER JOIN restaurants r ON r.id = mc.restaurant_id AND r.approval_status = 'APPROVED'
     INNER JOIN menu_items mi ON mi.category_id = mc.id AND mi.is_active = 1
     WHERE TRIM(mc.name) <> ''`
  );
  const map = {};
  for (const row of rows) {
    const rid = String(row.restaurant_id);
    const key = normalizeCategoryKey(row.category_key);
    if (!key) continue;
    if (!map[rid]) map[rid] = [];
    if (!map[rid].includes(key)) map[rid].push(key);
  }
  return map;
}

async function getCustomerBrowseCatalog() {
  const categories = await fetchCatalogRows(false);
  const restaurantCategoryKeys = await fetchRestaurantCategoryKeys();
  return { categories, restaurantCategoryKeys };
}

async function updateCatalogEntry(id, payload) {
  await ensureCatalogTable();
  const fields = [];
  const values = [];
  if (payload.displayName !== undefined) {
    fields.push("display_name = ?");
    values.push(String(payload.displayName).trim());
  }
  if (payload.imageUrl !== undefined) {
    fields.push("image_url = ?");
    values.push(payload.imageUrl || null);
  }
  if (payload.sortOrder !== undefined) {
    fields.push("sort_order = ?");
    values.push(Number(payload.sortOrder));
  }
  if (payload.isActive !== undefined) {
    fields.push("is_active = ?");
    values.push(payload.isActive ? 1 : 0);
  }
  if (!fields.length) return null;
  values.push(id);
  await pool.execute(
    `UPDATE platform_category_catalog SET ${fields.join(", ")} WHERE id = ?`,
    values
  );
  return fetchCatalogRows(true).then((rows) => rows.find((r) => Number(r.id) === Number(id)));
}

async function reorderCatalog(orderedIds) {
  await ensureCatalogTable();
  let order = 0;
  for (const id of orderedIds) {
    order += 10;
    await pool.execute("UPDATE platform_category_catalog SET sort_order = ? WHERE id = ?", [order, id]);
  }
  return fetchCatalogRows(true);
}

module.exports = {
  getCustomerBrowseCatalog,
  fetchCatalogRows,
  syncDiscoveredCategories,
  updateCatalogEntry,
  reorderCatalog,
  discoverCategoryKeysFromMenus,
};
