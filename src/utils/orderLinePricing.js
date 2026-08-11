const { z } = require("zod");
const { isMenuItemInStock } = require("./menuItemStock");
const { parseMenuItemDescription } = require("./menuItemDescription");

const WEIGHT_UNITS = new Set(["kg", "g", "gm", "grams", "500g", "250g", "half-kg"]);
const VOLUME_UNITS = new Set(["litre", "l", "ml", "500ml", "250ml", "glass"]);

const UNIT_TO_BASE = {
  kg: 1,
  "half-kg": 0.5,
  "500g": 0.5,
  "250g": 0.25,
  g: 0.001,
  gm: 0.001,
  grams: 0.001,
  litre: 1,
  l: 1,
  "500ml": 0.5,
  "250ml": 0.25,
  ml: 0.001,
  glass: 1,
  piece: 1,
  pcs: 1,
  plate: 1,
  half: 0.5,
  full: 1,
  cup: 1,
  small: 0.75,
  medium: 1,
  large: 1.25,
  pack: 1,
  packet: 1,
  box: 1,
  bunch: 1,
  dozen: 12,
  bottle: 1,
};

const PORTION_FACTORS = {
  Half: 0.5,
  half: 0.5,
  Full: 1,
  full: 1,
  Small: 0.75,
  Regular: 1,
  Medium: 1,
  Large: 1.25,
  Bottle: 1.5,
  "1 Piece": 1,
  "6 Pieces": 6,
  Box: 1,
  "1 kg": 1,
  "250 g": 0.25,
  "500 g": 0.5,
  "2 kg": 2,
  Dozen: 12,
  "1 Pack": 1,
  "1 Litre": 1,
  "250 ml": 0.25,
  "500 ml": 0.5,
  Packet: 1,
  "1 Unit": 1,
  Piece: 1,
};

function normalizeUnitKey(unit) {
  return String(unit || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function unitPriceFactor(itemUnit, selectedUnit) {
  const base = normalizeUnitKey(itemUnit) || "piece";
  const sel = normalizeUnitKey(selectedUnit) || base;
  if (base === sel) return 1;
  const baseVal = UNIT_TO_BASE[base];
  const selVal = UNIT_TO_BASE[sel];
  if (baseVal == null || selVal == null || baseVal === 0) return 1;
  const baseWeight = WEIGHT_UNITS.has(base);
  const selWeight = WEIGHT_UNITS.has(sel);
  const baseVol = VOLUME_UNITS.has(base);
  const selVol = VOLUME_UNITS.has(sel);
  if ((baseWeight && selWeight) || (baseVol && selVol)) return selVal / baseVal;
  return 1;
}

function portionPriceFactor(portionLabel) {
  if (!portionLabel) return 1;
  if (PORTION_FACTORS[portionLabel] != null) return PORTION_FACTORS[portionLabel];
  return PORTION_FACTORS[String(portionLabel).trim()] ?? 1;
}

function dishCustomizationOptions(description) {
  let addons = [];
  try {
    const raw = description;
    if (raw && String(raw).trim().startsWith("{")) {
      const data = JSON.parse(raw);
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
  return { addons };
}

function lineUnitPrice(basePrice, factor, addonIds, addons) {
  const addonTotal = (addonIds || []).reduce((sum, id) => {
    const a = addons.find((x) => x.id === id);
    return sum + (a ? Number(a.price) || 0 : 0);
  }, 0);
  return Math.round((Number(basePrice) * (Number(factor) || 1) + addonTotal) * 100) / 100;
}

const customerOrderItemSchema = z.object({
  menuItemId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().positive().max(99),
  sizeId: z.string().max(40).optional(),
  addonIds: z.array(z.string().max(40)).max(12).optional(),
  instructions: z.string().max(500).optional(),
  unitPrice: z.coerce.number().positive().optional(),
  selectedUnit: z.string().max(40).optional(),
  portion: z.string().max(40).optional(),
  unitNote: z.string().max(80).optional(),
  itemUnit: z.string().max(40).optional(),
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

  const meta = parseMenuItemDescription(row.description);
  const itemUnit = item.itemUnit || meta.unit || item.selectedUnit || "piece";
  const { addons } = dishCustomizationOptions(row.description);
  const addonIds = (item.addonIds || []).filter((id) => addons.some((a) => a.id === id));

  let factor = 1;
  if (item.portion) factor = portionPriceFactor(item.portion);
  else if (item.selectedUnit) factor = unitPriceFactor(itemUnit, item.selectedUnit);

  const unitPrice = lineUnitPrice(row.price, factor, addonIds, addons);

  if (item.unitPrice != null && Math.abs(Number(item.unitPrice) - unitPrice) > 0.05) {
    throw new Error(`Price mismatch for ${row.name}. Refresh your cart and try again.`);
  }

  const customization = {
    selectedUnit: item.selectedUnit || null,
    portion: item.portion || null,
    itemUnit: itemUnit || null,
    unitNote: item.unitNote || null,
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
