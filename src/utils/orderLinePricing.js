const { z } = require("zod");
const { isMenuItemInStock } = require("./menuItemStock");

const DEFAULT_SIZES = [
  { id: "regular", label: "Regular", priceFactor: 1 },
  { id: "large", label: "Large", priceFactor: 1.2 },
];

function dishCustomizationOptions(description, basePrice) {
  let sizes = DEFAULT_SIZES;
  let addons = [];
  try {
    const raw = description;
    if (raw && String(raw).trim().startsWith("{")) {
      const data = JSON.parse(raw);
      if (Array.isArray(data.sizes) && data.sizes.length) {
        sizes = data.sizes.map((s, i) => ({
          id: String(s.id || s.label || `size-${i}`).toLowerCase(),
          label: String(s.label || "Regular"),
          priceFactor: Number(s.priceFactor ?? s.multiplier ?? 1) || 1,
        }));
      }
      if (Array.isArray(data.addons)) {
        addons = data.addons.map((a, i) => ({
          id: String(a.id || a.label || `addon-${i}`).toLowerCase(),
          label: String(a.label || "Extra"),
          price: Math.max(0, Number(a.price) || 0),
        }));
      }
    }
  } catch {
    /* defaults */
  }
  if (sizes.length === 1 && Number(basePrice) < 120) {
    sizes = [{ id: "regular", label: "Regular", priceFactor: 1 }];
  }
  return { sizes, addons };
}

function lineUnitPrice(basePrice, size, addonIds, addons) {
  const factor = Number(size?.priceFactor) || 1;
  const addonTotal = (addonIds || []).reduce((sum, id) => {
    const a = addons.find((x) => x.id === id);
    return sum + (a ? Number(a.price) || 0 : 0);
  }, 0);
  return Math.round((Number(basePrice) * factor + addonTotal) * 100) / 100;
}

const customerOrderItemSchema = z.object({
  menuItemId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().positive().max(99),
  sizeId: z.string().max(40).optional(),
  addonIds: z.array(z.string().max(40)).max(12).optional(),
  instructions: z.string().max(500).optional(),
  unitPrice: z.coerce.number().positive().optional(),
});

const customerOrderItemsSchema = z.array(customerOrderItemSchema).min(1);

async function resolveOrderLine(conn, restaurantId, rawItem) {
  const item = customerOrderItemSchema.parse(rawItem);
  const [[row]] = await conn.execute(
    `SELECT id, name, description, price, is_active, available_stock
     FROM menu_items WHERE id = ? AND restaurant_id = ? LIMIT 1`,
    [item.menuItemId, restaurantId]
  );
  if (!row || Number(row.is_active) === 0) {
    throw new Error(`Menu item #${item.menuItemId} is not available.`);
  }
  if (!isMenuItemInStock(row)) {
    throw new Error(`Menu item #${item.menuItemId} is out of stock.`);
  }

  const { sizes, addons } = dishCustomizationOptions(row.description, row.price);
  const size = sizes.find((s) => s.id === String(item.sizeId || sizes[0]?.id)) || sizes[0];
  const addonIds = (item.addonIds || []).filter((id) => addons.some((a) => a.id === id));
  const unitPrice = lineUnitPrice(row.price, size, addonIds, addons);

  if (item.unitPrice != null && Math.abs(Number(item.unitPrice) - unitPrice) > 0.02) {
    throw new Error(`Price mismatch for ${row.name}. Refresh your cart and try again.`);
  }

  const customization = {
    sizeId: size.id,
    sizeLabel: size.label,
    addonIds,
    addonLabels: addonIds.map((id) => addons.find((a) => a.id === id)?.label).filter(Boolean),
    instructions: String(item.instructions || "").trim() || null,
  };

  return {
    menuItemId: Number(row.id),
    menuItemName: row.name,
    quantity: item.quantity,
    unitPrice,
    customization,
    customizationJson: JSON.stringify(customization),
  };
}

async function resolveOrderLines(conn, restaurantId, items) {
  const lines = [];
  for (const raw of items) {
    lines.push(await resolveOrderLine(conn, restaurantId, raw));
  }
  return lines;
}

async function computeCustomerCartTotal(conn, restaurantId, items) {
  const lines = await resolveOrderLines(conn, restaurantId, items);
  const total = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  return { total: Math.round(total * 100) / 100, lines };
}

function parseCustomizationJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

module.exports = {
  customerOrderItemSchema,
  customerOrderItemsSchema,
  resolveOrderLines,
  computeCustomerCartTotal,
  parseCustomizationJson,
};
