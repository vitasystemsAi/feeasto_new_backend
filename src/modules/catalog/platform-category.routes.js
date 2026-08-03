const express = require("express");
const { z } = require("zod");
const auth = require("../../middlewares/auth");
const rbac = require("../../middlewares/rbac");
const {
  getCustomerBrowseCatalog,
  fetchCatalogRows,
  syncDiscoveredCategories,
  updateCatalogEntry,
  reorderCatalog,
} = require("./platform-category.service");

const router = express.Router();

/** Customer home: deduped categories + per-restaurant category keys. */
router.get("/browse", auth(), rbac("CUSTOMER", "DELIVERY_PARTNER", "ADMIN", "SUPER_ADMIN"), async (_req, res) => {
  try {
    const data = await getCustomerBrowseCatalog();
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ message: "Failed to load categories", details: err.message });
  }
});

router.get("/", auth(), rbac("SUPER_ADMIN", "ADMIN"), async (_req, res) => {
  try {
    await syncDiscoveredCategories();
    const rows = await fetchCatalogRows(true);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ message: "Failed to load catalog", details: err.message });
  }
});

router.post("/sync", auth(), rbac("SUPER_ADMIN"), async (_req, res) => {
  try {
    const result = await syncDiscoveredCategories();
    const rows = await fetchCatalogRows(true);
    return res.json({ ...result, categories: rows });
  } catch (err) {
    return res.status(500).json({ message: "Sync failed", details: err.message });
  }
});

router.patch("/:id", auth(), rbac("SUPER_ADMIN"), async (req, res) => {
  const id = Number(req.params.id);
  const schema = z.object({
    displayName: z.string().min(1).max(120).optional(),
    imageUrl: z.string().max(500).nullable().optional(),
    sortOrder: z.coerce.number().int().optional(),
    isActive: z.coerce.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  try {
    const row = await updateCatalogEntry(id, parsed.data);
    if (!row) return res.status(404).json({ message: "Category not found" });
    return res.json(row);
  } catch (err) {
    return res.status(500).json({ message: "Update failed", details: err.message });
  }
});

router.post("/reorder", auth(), rbac("SUPER_ADMIN"), async (req, res) => {
  const schema = z.object({
    orderedIds: z.array(z.coerce.number().int().positive()).min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  try {
    const rows = await reorderCatalog(parsed.data.orderedIds);
    return res.json({ categories: rows });
  } catch (err) {
    return res.status(500).json({ message: "Reorder failed", details: err.message });
  }
});

module.exports = router;
