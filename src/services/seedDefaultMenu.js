const { getDefaultMenuForVendorType } = require("../config/defaultMenusByVendorType");
const { getVendorTypeConfig } = require("../config/vendorTypes");

/**
 * Seed starter categories + items for a restaurant from its vendor type.
 *
 * Modes:
 *   - onlyIfEmpty (default true): skip entirely if any category already exists
 *   - onlyIfEmpty false: add missing categories/items by name (no duplicates)
 *
 * All seeded rows are normal editable menu data (rename / price / delete freely).
 */
async function seedDefaultMenuForRestaurant(pool, {
  restaurantId,
  tenantId,
  businessType,
  onlyIfEmpty = true,
  connection = null,
} = {}) {
  const db = connection || pool;
  const rid = Number(restaurantId);
  const tid = Number(tenantId);
  if (!rid || !tid) {
    return { seeded: false, reason: "invalid_ids", categoriesCreated: 0, itemsCreated: 0 };
  }

  const type =
    businessType ||
    (
      await db.execute("SELECT business_type FROM restaurants WHERE id = ? LIMIT 1", [rid]).then(([rows]) => rows[0])
    )?.business_type ||
    "restaurant";

  const template = getDefaultMenuForVendorType(type);
  const typeConfig = getVendorTypeConfig(type);
  if (!template?.categories?.length) {
    return { seeded: false, reason: "no_template", categoriesCreated: 0, itemsCreated: 0, businessType: type };
  }

  const [existingCats] = await db.execute(
    "SELECT id, name FROM menu_categories WHERE restaurant_id = ? AND tenant_id = ?",
    [rid, tid]
  );

  if (onlyIfEmpty && existingCats.length > 0) {
    return {
      seeded: false,
      reason: "already_has_menu",
      categoriesCreated: 0,
      itemsCreated: 0,
      businessType: type,
      existingCategories: existingCats.length,
    };
  }

  const catByName = new Map(
    existingCats.map((c) => [String(c.name || "").trim().toLowerCase(), Number(c.id)])
  );

  let categoriesCreated = 0;
  let itemsCreated = 0;
  const created = [];

  for (const category of template.categories) {
    const catName = String(category.name || "").trim();
    if (!catName) continue;
    const catKey = catName.toLowerCase();

    let categoryId = catByName.get(catKey);
    if (!categoryId) {
      const [result] = await db.execute(
        "INSERT INTO menu_categories (restaurant_id, tenant_id, name) VALUES (?, ?, ?)",
        [rid, tid, catName]
      );
      categoryId = Number(result.insertId);
      catByName.set(catKey, categoryId);
      categoriesCreated += 1;
    }

    const [existingItems] = await db.execute(
      "SELECT id, name FROM menu_items WHERE restaurant_id = ? AND tenant_id = ? AND category_id = ? AND is_active = 1",
      [rid, tid, categoryId]
    );
    const itemNames = new Set(existingItems.map((i) => String(i.name || "").trim().toLowerCase()));

    const createdItems = [];
    for (const item of category.items || []) {
      const itemName = String(item.name || "").trim();
      if (!itemName) continue;
      const itemKey = itemName.toLowerCase();
      if (itemNames.has(itemKey)) continue;

      const price = Number(item.price) > 0 ? Number(item.price) : 1;
      const isVeg = item.isVeg !== false ? 1 : 0;
      const text = item.description ? String(item.description).trim() : "";
      const sellUnit = String(item.unit || typeConfig.defaultUnit || "").trim() || null;
      const storedDescription =
        text || sellUnit
          ? JSON.stringify({ text: text || null, imageUrl: null, unit: sellUnit })
          : null;

      const [itemResult] = await db.execute(
        "INSERT INTO menu_items (tenant_id, restaurant_id, category_id, name, description, price, is_veg, is_available, available_stock) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)",
        [tid, rid, categoryId, itemName, storedDescription, price, isVeg]
      ).catch(async (err) => {
        // Fallback if is_available column missing
        if (err?.code !== "ER_BAD_FIELD_ERROR") throw err;
        return db.execute(
          "INSERT INTO menu_items (tenant_id, restaurant_id, category_id, name, description, price, is_veg, available_stock) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
          [tid, rid, categoryId, itemName, storedDescription, price, isVeg]
        );
      });

      itemNames.add(itemKey);
      itemsCreated += 1;
      createdItems.push({ id: Number(itemResult.insertId), name: itemName, price });
    }

    created.push({ id: categoryId, name: catName, items: createdItems });
  }

  return {
    seeded: categoriesCreated > 0 || itemsCreated > 0,
    reason: categoriesCreated > 0 || itemsCreated > 0 ? "ok" : "nothing_new",
    businessType: type,
    categoriesCreated,
    itemsCreated,
    categories: created,
  };
}

module.exports = { seedDefaultMenuForRestaurant };
