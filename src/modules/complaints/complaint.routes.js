const express = require("express");
const { z } = require("zod");
const pool = require("../../db/pool");
const auth = require("../../middlewares/auth");
const rbac = require("../../middlewares/rbac");

const router = express.Router();

router.post("/", auth(), async (req, res) => {
  const schema = z.object({ orderId: z.number().int(), title: z.string().min(3), description: z.string().min(5) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
  const [created] = await pool.execute(
    "INSERT INTO complaints (order_id, customer_user_id, title, description, status) VALUES (?, ?, ?, ?, 'OPEN')",
    [parsed.data.orderId, req.user.sub, parsed.data.title, parsed.data.description]
  );
  return res.status(201).json({ id: created.insertId, message: "Complaint created" });
});

router.post("/:complaintId/refund-request", auth(), async (req, res) => {
  const [created] = await pool.execute(
    "INSERT INTO refunds (complaint_id, requested_by_user_id, status) VALUES (?, ?, 'REQUESTED')",
    [Number(req.params.complaintId), req.user.sub]
  );
  return res.status(201).json({ id: created.insertId, message: "Refund requested" });
});

router.patch("/refunds/:refundId/review", auth(), rbac("SUPER_ADMIN"), async (req, res) => {
  const approved = Boolean(req.body.approved);
  await pool.execute("UPDATE refunds SET status = ? WHERE id = ?", [
    approved ? "APPROVED" : "REJECTED",
    Number(req.params.refundId),
  ]);
  return res.json({ message: approved ? "Refund approved" : "Refund rejected" });
});

module.exports = router;
