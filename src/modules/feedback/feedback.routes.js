const express = require("express");
const { z } = require("zod");
const pool = require("../../db/pool");
const auth = require("../../middlewares/auth");
const rbac = require("../../middlewares/rbac");
const tenantScope = require("../../middlewares/tenant");

const router = express.Router();

router.get("/", auth(), tenantScope, async (req, res) => {
  const schema = z.object({
    restaurantId: z.coerce.number().int().positive().optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const params = [req.tenantId];
  let where = "f.tenant_id = ?";
  if (parsed.data.restaurantId) {
    where += " AND f.restaurant_id = ?";
    params.push(parsed.data.restaurantId);
  }

  const [rows] = await pool.execute(
    `SELECT f.id, f.restaurant_id, f.customer_user_id, f.order_id, f.rating, f.comment, f.created_at
     FROM feedback f
     WHERE ${where}
     ORDER BY f.created_at DESC
     LIMIT 200`,
    params
  );
  return res.json({ items: rows });
});

router.post("/", auth(), rbac("CUSTOMER"), tenantScope, async (req, res) => {
  const schema = z.object({
    restaurantId: z.coerce.number().int().positive(),
    orderId: z.coerce.number().int().positive().optional(),
    rating: z.coerce.number().int().min(1).max(5),
    comment: z.string().max(2000).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const [result] = await pool.execute(
    "INSERT INTO feedback (tenant_id, restaurant_id, customer_user_id, order_id, rating, comment) VALUES (?, ?, ?, ?, ?, ?)",
    [req.tenantId, parsed.data.restaurantId, req.user.sub, parsed.data.orderId || null, parsed.data.rating, parsed.data.comment || null]
  );
  return res.status(201).json({ id: result.insertId });
});

router.post("/delivery-ratings", auth(), rbac("CUSTOMER"), tenantScope, async (req, res) => {
  const schema = z.object({
    orderId: z.coerce.number().int().positive(),
    deliveryPartnerId: z.coerce.number().int().positive(),
    rating: z.coerce.number().int().min(1).max(5),
    comment: z.string().max(2000).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const [result] = await pool.execute(
    "INSERT INTO delivery_ratings (tenant_id, delivery_partner_id, customer_user_id, order_id, rating, comment) VALUES (?, ?, ?, ?, ?, ?)",
    [
      req.tenantId,
      parsed.data.deliveryPartnerId,
      req.user.sub,
      parsed.data.orderId,
      parsed.data.rating,
      parsed.data.comment || null,
    ]
  );
  return res.status(201).json({ id: result.insertId });
});

module.exports = router;

