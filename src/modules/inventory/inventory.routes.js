const express = require("express");
const { z } = require("zod");
const pool = require("../../db/pool");
const auth = require("../../middlewares/auth");
const rbac = require("../../middlewares/rbac");
const tenantScope = require("../../middlewares/tenant");

const router = express.Router();

router.get("/", auth(), rbac("OWNER", "MANAGER"), tenantScope, async (req, res) => {
  const schema = z.object({ restaurantId: z.coerce.number().int().positive() });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const [rows] = await pool.execute(
    `SELECT id, name, quantity, unit, low_stock_threshold
     FROM inventory_items
     WHERE tenant_id = ? AND restaurant_id = ?
     ORDER BY name ASC`,
    [req.tenantId, parsed.data.restaurantId]
  );
  return res.json({ items: rows });
});

router.post("/", auth(), rbac("OWNER", "MANAGER"), tenantScope, async (req, res) => {
  const schema = z.object({
    restaurantId: z.coerce.number().int().positive(),
    name: z.string().min(2).max(120),
    quantity: z.coerce.number().nonnegative(),
    unit: z.string().min(1).max(20),
    lowStockThreshold: z.coerce.number().nonnegative(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const [result] = await pool.execute(
    "INSERT INTO inventory_items (tenant_id, restaurant_id, name, quantity, unit, low_stock_threshold) VALUES (?, ?, ?, ?, ?, ?)",
    [
      req.tenantId,
      parsed.data.restaurantId,
      parsed.data.name,
      parsed.data.quantity,
      parsed.data.unit,
      parsed.data.lowStockThreshold,
    ]
  );
  return res.status(201).json({ id: result.insertId });
});

router.patch("/:itemId", auth(), rbac("OWNER", "MANAGER"), tenantScope, async (req, res) => {
  const schema = z.object({
    name: z.string().min(2).max(120).optional(),
    quantity: z.coerce.number().nonnegative().optional(),
    unit: z.string().min(1).max(20).optional(),
    lowStockThreshold: z.coerce.number().nonnegative().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const itemId = Number(req.params.itemId);
  const fields = [];
  const values = [];

  if (parsed.data.name !== undefined) {
    fields.push("name = ?");
    values.push(parsed.data.name);
  }
  if (parsed.data.quantity !== undefined) {
    fields.push("quantity = ?");
    values.push(parsed.data.quantity);
  }
  if (parsed.data.unit !== undefined) {
    fields.push("unit = ?");
    values.push(parsed.data.unit);
  }
  if (parsed.data.lowStockThreshold !== undefined) {
    fields.push("low_stock_threshold = ?");
    values.push(parsed.data.lowStockThreshold);
  }
  if (fields.length === 0) return res.status(400).json({ message: "No updates provided" });

  values.push(itemId, req.tenantId);
  await pool.execute(`UPDATE inventory_items SET ${fields.join(", ")} WHERE id = ? AND tenant_id = ?`, values);
  return res.json({ ok: true });
});

router.delete("/:itemId", auth(), rbac("OWNER", "MANAGER"), tenantScope, async (req, res) => {
  const itemId = Number(req.params.itemId);
  await pool.execute("DELETE FROM inventory_items WHERE id = ? AND tenant_id = ?", [itemId, req.tenantId]);
  return res.json({ ok: true });
});

// ----------------------------------------------------------------------------
// Stock entries: track each grocery purchase (pack size + rate) for a master
// inventory item, and update the master quantity with unit-aware conversion.
// ----------------------------------------------------------------------------

function normalizeUnit(unit) {
  if (!unit) return "";
  const u = String(unit).trim().toLowerCase();
  if (u === "l" || u === "lt" || u === "ltr" || u === "liter" || u === "litre" || u === "liters" || u === "litres") {
    return "l";
  }
  if (u === "ml" || u === "milliliter" || u === "millilitre") return "ml";
  if (u === "kg" || u === "kgs" || u === "kilogram" || u === "kilograms") return "kg";
  if (u === "g" || u === "gm" || u === "gms" || u === "gram" || u === "grams") return "g";
  if (u === "pc" || u === "pcs" || u === "piece" || u === "pieces") return "pcs";
  if (u === "pkt" || u === "pkts" || u === "packet" || u === "packets") return "packets";
  return u;
}

// Convert a quantity from `fromUnit` into `toUnit`. Returns null when the units
// are not compatible (e.g. mixing kg and L).
function convertQuantity(qty, fromUnit, toUnit) {
  const f = normalizeUnit(fromUnit);
  const t = normalizeUnit(toUnit);
  if (f === t) return Number(qty);

  const weights = { g: 1, kg: 1000 };
  const volumes = { ml: 1, l: 1000 };

  if (weights[f] && weights[t]) {
    return (Number(qty) * weights[f]) / weights[t];
  }
  if (volumes[f] && volumes[t]) {
    return (Number(qty) * volumes[f]) / volumes[t];
  }
  return null;
}

router.get("/entries", auth(), rbac("OWNER", "MANAGER"), tenantScope, async (req, res) => {
  const schema = z.object({
    restaurantId: z.coerce.number().int().positive(),
    itemId: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const params = [req.tenantId, parsed.data.restaurantId];
  let where = "e.tenant_id = ? AND e.restaurant_id = ?";
  if (parsed.data.itemId) {
    where += " AND e.inventory_item_id = ?";
    params.push(parsed.data.itemId);
  }
  const limit = parsed.data.limit || 50;

  const [rows] = await pool.query(
    `SELECT e.id, e.inventory_item_id, e.pack_quantity, e.pack_unit, e.rate, e.notes,
            e.created_at, i.name AS item_name, i.unit AS item_unit
       FROM inventory_stock_entries e
       JOIN inventory_items i ON i.id = e.inventory_item_id
      WHERE ${where}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ${Number(limit)}`,
    params
  );
  return res.json({ entries: rows });
});

router.post("/entries", auth(), rbac("OWNER", "MANAGER"), tenantScope, async (req, res) => {
  const schema = z.object({
    restaurantId: z.coerce.number().int().positive(),
    inventoryItemId: z.coerce.number().int().positive(),
    packQuantity: z.coerce.number().positive(),
    packUnit: z.string().min(1).max(20),
    rate: z.coerce.number().nonnegative(),
    notes: z.string().max(255).optional().nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [items] = await conn.execute(
      "SELECT id, unit, quantity FROM inventory_items WHERE id = ? AND tenant_id = ? AND restaurant_id = ? FOR UPDATE",
      [parsed.data.inventoryItemId, req.tenantId, parsed.data.restaurantId]
    );
    const item = items[0];
    if (!item) {
      await conn.rollback();
      return res.status(404).json({ message: "Grocery item not found in master data for this restaurant" });
    }

    const [result] = await conn.execute(
      `INSERT INTO inventory_stock_entries
         (tenant_id, restaurant_id, inventory_item_id, pack_quantity, pack_unit, rate, notes, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.tenantId,
        parsed.data.restaurantId,
        parsed.data.inventoryItemId,
        parsed.data.packQuantity,
        parsed.data.packUnit,
        parsed.data.rate,
        parsed.data.notes || null,
        req.user?.sub || req.user?.id || null,
      ]
    );

    const converted = convertQuantity(parsed.data.packQuantity, parsed.data.packUnit, item.unit);
    let stockUpdated = false;
    if (converted !== null && Number.isFinite(converted)) {
      await conn.execute(
        "UPDATE inventory_items SET quantity = quantity + ? WHERE id = ? AND tenant_id = ?",
        [converted, item.id, req.tenantId]
      );
      stockUpdated = true;
    }

    await conn.commit();
    return res.status(201).json({
      id: result.insertId,
      stockUpdated,
      addedToStock: stockUpdated ? converted : null,
      stockUnit: item.unit,
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

router.delete("/entries/:entryId", auth(), rbac("OWNER", "MANAGER"), tenantScope, async (req, res) => {
  const entryId = Number(req.params.entryId);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT e.id, e.pack_quantity, e.pack_unit, e.inventory_item_id, i.unit AS item_unit
         FROM inventory_stock_entries e
         JOIN inventory_items i ON i.id = e.inventory_item_id
        WHERE e.id = ? AND e.tenant_id = ?
        FOR UPDATE`,
      [entryId, req.tenantId]
    );
    const entry = rows[0];
    if (!entry) {
      await conn.rollback();
      return res.status(404).json({ message: "Entry not found" });
    }

    const reverse = convertQuantity(entry.pack_quantity, entry.pack_unit, entry.item_unit);
    if (reverse !== null && Number.isFinite(reverse)) {
      await conn.execute(
        "UPDATE inventory_items SET quantity = GREATEST(0, quantity - ?) WHERE id = ? AND tenant_id = ?",
        [reverse, entry.inventory_item_id, req.tenantId]
      );
    }
    await conn.execute("DELETE FROM inventory_stock_entries WHERE id = ? AND tenant_id = ?", [entryId, req.tenantId]);
    await conn.commit();
    return res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

module.exports = router;

