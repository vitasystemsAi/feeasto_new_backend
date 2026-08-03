const { z } = require("zod");
const pool = require("../../../db/pool");
const { logPortalAction } = require("../utils/audit");
const {
  reorderRestaurantPriorities,
  moveRestaurantPriority,
  insertRestaurantPriorityAtRank,
  findOccupantAtRank,
  buildConflictResponse,
} = require("../services/priorityReorder");

function registerPriorityRoutes(router, gate, requirePermission) {
  router.get("/restaurant-priority/available", ...gate, requirePermission("restaurants"), async (_req, res) => {
    const [rows] = await pool.execute(
      `SELECT r.id, r.name, r.rating, r.is_active, r.approval_status
       FROM restaurants r
       WHERE r.approval_status = 'APPROVED'
         AND r.id NOT IN (SELECT restaurant_id FROM restaurant_priorities)
       ORDER BY r.name`
    );
    return res.json(rows);
  });

  router.get("/restaurant-priority", ...gate, requirePermission("restaurants"), async (_req, res) => {
    const [rows] = await pool.execute(
      `SELECT rp.id AS priority_id, rp.restaurant_id, rp.priority_rank AS priority,
              COALESCE(rp.is_active, 1) AS active, r.name, r.rating,
              (SELECT COUNT(*) FROM orders o WHERE o.restaurant_id = r.id) AS orders_count,
              r.is_active AS restaurant_is_active, r.approval_status
       FROM restaurant_priorities rp
       INNER JOIN restaurants r ON r.id = rp.restaurant_id
       ORDER BY rp.priority_rank ASC`
    );
    return res.json(rows);
  });

  router.post("/restaurant-priority", ...gate, requirePermission("restaurants"), async (req, res) => {
    const schema = z.object({
      restaurantId: z.number().int(),
      priorityRank: z.number().int().min(1),
      active: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const { restaurantId, priorityRank } = parsed.data;
    const active = parsed.data.active !== false ? 1 : 0;

    const [[exists]] = await pool.execute(
      "SELECT id FROM restaurant_priorities WHERE restaurant_id = ? LIMIT 1",
      [restaurantId]
    );
    if (exists) return res.status(409).json({ message: "Restaurant already in priority list" });

    await insertRestaurantPriorityAtRank(pool, restaurantId, priorityRank, active, req.user.sub);
    await logPortalAction(req, {
      action: "PRIORITY_ADDED",
      module: "restaurants",
      targetEntity: "restaurant",
      targetId: restaurantId,
    });
    return res.status(201).json({ message: "Restaurant added to priority list" });
  });

  router.put("/restaurant-priority/:restaurantId", ...gate, requirePermission("restaurants"), async (req, res) => {
    const schema = z.object({
      priorityRank: z.number().int().min(1).optional(),
      active: z.boolean().optional(),
      confirmReorder: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const restaurantId = Number(req.params.restaurantId);
    const [[row]] = await pool.execute(
      "SELECT id FROM restaurant_priorities WHERE restaurant_id = ? LIMIT 1",
      [restaurantId]
    );
    if (!row) return res.status(404).json({ message: "Restaurant not in priority list" });

    let moveResult = null;
    if (parsed.data.priorityRank !== undefined) {
      const [[current]] = await pool.execute(
        "SELECT priority_rank FROM restaurant_priorities WHERE restaurant_id = ? LIMIT 1",
        [restaurantId]
      );
      const oldRank = Number(current.priority_rank);
      const newRank = Number(parsed.data.priorityRank);
      const occupant =
        oldRank !== newRank ? await findOccupantAtRank(pool, newRank, restaurantId) : null;

      if (occupant && !parsed.data.confirmReorder) {
        return res.status(409).json(buildConflictResponse(occupant, oldRank, newRank));
      }

      moveResult = await moveRestaurantPriority(pool, restaurantId, newRank, req.user.sub);
    }

    if (parsed.data.active !== undefined) {
      await pool.execute("UPDATE restaurant_priorities SET is_active = ? WHERE restaurant_id = ?", [
        parsed.data.active ? 1 : 0,
        restaurantId,
      ]);
    }

    await logPortalAction(req, { action: "PRIORITY_UPDATED", module: "restaurants", targetId: restaurantId });
    const message = moveResult?.swappedWith
      ? `Priority updated. "${moveResult.swappedWith.name}" is now #${moveResult.swappedWith.toRank}.`
      : "Priority updated";
    return res.json({ message, move: moveResult });
  });

  router.delete("/restaurant-priority/:restaurantId", ...gate, requirePermission("restaurants"), async (req, res) => {
    const restaurantId = Number(req.params.restaurantId);
    const [result] = await pool.execute("DELETE FROM restaurant_priorities WHERE restaurant_id = ?", [
      restaurantId,
    ]);
    if (!result.affectedRows) return res.status(404).json({ message: "Restaurant not in priority list" });
    await reorderRestaurantPriorities();
    await logPortalAction(req, { action: "PRIORITY_REMOVED", module: "restaurants", targetId: restaurantId });
    return res.json({ message: "Removed from priority list" });
  });
}

function registerReviewsRoutes(router, gate, requirePermission) {
  router.get("/reviews/restaurants", ...gate, requirePermission("reviews"), async (_req, res) => {
    const [rows] = await pool.execute(
      "SELECT id, name FROM restaurants WHERE approval_status = 'APPROVED' ORDER BY name"
    );
    return res.json(rows);
  });

  router.get("/reviews", ...gate, requirePermission("reviews"), async (req, res) => {
    const rating = req.query.rating ? Number(req.query.rating) : null;
    const restaurantId = req.query.restaurantId ? Number(req.query.restaurantId) : null;
    const status = req.query.status ? String(req.query.status).toUpperCase() : "";
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom) : "";
    const dateTo = req.query.dateTo ? String(req.query.dateTo) : "";

    const where = ["(f.deleted_at IS NULL)"];
    const params = [];

    if (rating) {
      where.push("f.rating = ?");
      params.push(rating);
    }
    if (restaurantId) {
      where.push("f.restaurant_id = ?");
      params.push(restaurantId);
    }
    if (status) {
      where.push("COALESCE(rm.moderation_status, 'PENDING') = ?");
      params.push(status);
    }
    if (dateFrom) {
      where.push("DATE(f.created_at) >= ?");
      params.push(dateFrom);
    }
    if (dateTo) {
      where.push("DATE(f.created_at) <= ?");
      params.push(dateTo);
    }

    const [rows] = await pool.execute(
      `SELECT f.id, f.rating, f.comment, f.created_at,
              u.full_name AS customer_name, r.name AS restaurant_name, r.id AS restaurant_id,
              COALESCE(rm.moderation_status, 'PENDING') AS moderation_status,
              COALESCE(rm.is_visible, 1) AS is_visible
       FROM feedback f
       JOIN users u ON u.id = f.customer_user_id
       JOIN restaurants r ON r.id = f.restaurant_id
       LEFT JOIN review_moderation rm ON rm.feedback_id = f.id
       WHERE ${where.join(" AND ")}
       ORDER BY f.created_at DESC
       LIMIT 500`,
      params
    );

    const [[metrics]] = await pool.execute(
      `SELECT
         COUNT(*) AS total_reviews,
         SUM(CASE WHEN COALESCE(rm.moderation_status, 'PENDING') = 'APPROVED' THEN 1 ELSE 0 END) AS approved_reviews,
         SUM(CASE WHEN COALESCE(rm.moderation_status, 'PENDING') = 'HIDDEN' OR COALESCE(rm.is_visible, 1) = 0 THEN 1 ELSE 0 END) AS hidden_reviews,
         AVG(f.rating) AS average_rating
       FROM feedback f
       LEFT JOIN review_moderation rm ON rm.feedback_id = f.id
       WHERE f.deleted_at IS NULL`
    );

    return res.json({
      reviews: rows,
      metrics: {
        totalReviews: Number(metrics.total_reviews || 0),
        approvedReviews: Number(metrics.approved_reviews || 0),
        hiddenReviews: Number(metrics.hidden_reviews || 0),
        averageRating: Number(metrics.average_rating || 0).toFixed(2),
      },
    });
  });

  router.put("/reviews/:id", ...gate, requirePermission("reviews"), async (req, res) => {
    const schema = z.object({
      rating: z.number().int().min(1).max(5),
      comment: z.string().max(5000),
      status: z.enum(["PENDING", "APPROVED", "REJECTED", "HIDDEN"]),
      visible: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const feedbackId = Number(req.params.id);
    const [[fb]] = await pool.execute("SELECT id FROM feedback WHERE id = ? AND deleted_at IS NULL", [feedbackId]);
    if (!fb) return res.status(404).json({ message: "Review not found" });

    await pool.execute("UPDATE feedback SET rating = ?, comment = ?, updated_by_user_id = ? WHERE id = ?", [
      parsed.data.rating,
      parsed.data.comment,
      req.user.sub,
      feedbackId,
    ]);

    const visible = parsed.data.visible !== undefined ? (parsed.data.visible ? 1 : 0) : parsed.data.status !== "HIDDEN" ? 1 : 0;

    await pool.execute(
      `INSERT INTO review_moderation (feedback_id, moderation_status, moderated_by_user_id, is_visible, edited_comment)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         moderation_status = VALUES(moderation_status),
         moderated_by_user_id = VALUES(moderated_by_user_id),
         is_visible = VALUES(is_visible),
         edited_comment = VALUES(edited_comment)`,
      [feedbackId, parsed.data.status, req.user.sub, visible, parsed.data.comment]
    );

    await pool.execute(
      `INSERT INTO review_moderation_logs (feedback_id, actor_user_id, action, new_status)
       VALUES (?, ?, 'EDIT', ?)`,
      [feedbackId, req.user.sub, parsed.data.status]
    );
    await logPortalAction(req, { action: "REVIEW_EDITED", module: "reviews", targetId: feedbackId });
    return res.json({ message: "Review updated" });
  });

  router.patch("/reviews/:id/moderate", ...gate, requirePermission("reviews"), async (req, res) => {
    const schema = z.object({
      action: z.enum(["APPROVE", "REJECT", "HIDE", "DELETE", "EDIT"]),
      note: z.string().optional(),
      editedComment: z.string().optional(),
      rating: z.number().int().min(1).max(5).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const feedbackId = Number(req.params.id);
    const [[fb]] = await pool.execute("SELECT id FROM feedback WHERE id = ?", [feedbackId]);
    if (!fb) return res.status(404).json({ message: "Review not found" });

    if (parsed.data.action === "DELETE") {
      await pool.execute("UPDATE feedback SET deleted_at = NOW(), updated_by_user_id = ? WHERE id = ?", [
        req.user.sub,
        feedbackId,
      ]);
      await pool.execute(
        `INSERT INTO review_moderation_logs (feedback_id, actor_user_id, action, new_status)
         VALUES (?, ?, 'DELETE', 'DELETED')`,
        [feedbackId, req.user.sub]
      );
      await logPortalAction(req, { action: "REVIEW_DELETED", module: "reviews", targetId: feedbackId });
      return res.json({ message: "Review soft deleted" });
    }

    const statusMap = {
      APPROVE: { status: "APPROVED", visible: 1 },
      REJECT: { status: "REJECTED", visible: 0 },
      HIDE: { status: "HIDDEN", visible: 0 },
      EDIT: { status: "APPROVED", visible: 1 },
    };
    const cfg = statusMap[parsed.data.action];

    if (parsed.data.rating) {
      await pool.execute("UPDATE feedback SET rating = ? WHERE id = ?", [parsed.data.rating, feedbackId]);
    }
    if (parsed.data.editedComment) {
      await pool.execute("UPDATE feedback SET comment = ?, updated_by_user_id = ? WHERE id = ?", [
        parsed.data.editedComment,
        req.user.sub,
        feedbackId,
      ]);
    }

    await pool.execute(
      `INSERT INTO review_moderation (feedback_id, moderation_status, moderated_by_user_id, moderation_note, is_visible, edited_comment)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         moderation_status = VALUES(moderation_status),
         moderated_by_user_id = VALUES(moderated_by_user_id),
         moderation_note = VALUES(moderation_note),
         is_visible = VALUES(is_visible),
         edited_comment = COALESCE(VALUES(edited_comment), edited_comment)`,
      [
        feedbackId,
        cfg.status,
        req.user.sub,
        parsed.data.note || null,
        cfg.visible,
        parsed.data.editedComment || null,
      ]
    );

    await pool.execute(
      `INSERT INTO review_moderation_logs (feedback_id, actor_user_id, action, new_status)
       VALUES (?, ?, ?, ?)`,
      [feedbackId, req.user.sub, parsed.data.action, cfg.status]
    );
    await logPortalAction(req, { action: `REVIEW_${parsed.data.action}`, module: "reviews", targetId: feedbackId });
    return res.json({ message: "Review moderated" });
  });
}

module.exports = { registerPriorityRoutes, registerReviewsRoutes };
