const express = require("express");
const authRoutes = require("../modules/auth/auth.routes");
const restaurantRoutes = require("../modules/restaurants/restaurant.routes");
const orderRouter = require("../modules/orders/order.routes");
const deliveryRoutes = require("../modules/delivery/delivery.routes");
const complaintRoutes = require("../modules/complaints/complaint.routes");
const analyticsRoutes = require("../modules/analytics/analytics.routes");
const aiRoutes = require("../modules/ai/ai.routes");
const adminRoutes = require("../modules/admin/admin.routes");
const tableRoutes = require("../modules/tables/table.routes");
const tablePublicRoutes = require("../modules/tables/table-public.routes");
const tableCustomersRoutes = require("../modules/tables/table-customers.routes");
const reservationRoutes = require("../modules/reservations/reservation.routes");
const inventoryRoutes = require("../modules/inventory/inventory.routes");
const billingRoutes = require("../modules/billing/billing.routes");
const feedbackRoutes = require("../modules/feedback/feedback.routes");
const subscriptionRoutes = require("../modules/subscriptions/subscription.routes");
const platformCategoryRoutes = require("../modules/catalog/platform-category.routes");
const portalRoutes = require("../modules/portal");
const customerPublicRoutes = require("../modules/customer/customer-public.routes");
const geoRoutes = require("../modules/geo/geo.routes");
const staffRoutes = require("../modules/staff/staff.routes");

function createRouter(io) {
  const router = express.Router();

  router.get("/health", (_req, res) => res.json({ status: "ok", service: "restaurant-saas-api" }));
  router.use("/geo", geoRoutes);
  router.use("/auth", authRoutes);
  router.use("/restaurants", restaurantRoutes);
  router.use("/staff", staffRoutes);
  router.use("/orders", orderRouter(io));
  router.use("/delivery", deliveryRoutes(io));
  router.use("/complaints", complaintRoutes);
  router.use("/analytics", analyticsRoutes);
  router.use("/ai", aiRoutes);
  router.use("/admin", adminRoutes);
  router.use("/tables", tableRoutes(io));
  router.use("/public/table-qr", tablePublicRoutes(io));
  router.use("/table-customers", tableCustomersRoutes());
  router.use("/reservations", reservationRoutes);
  router.use("/inventory", inventoryRoutes);
  router.use("/billing", billingRoutes);
  router.use("/feedback", feedbackRoutes);
  router.use("/subscriptions", subscriptionRoutes);
  router.use("/catalog/platform-categories", platformCategoryRoutes);
  router.use("/customer", customerPublicRoutes);
  router.use("/customer-admin", portalRoutes);
  router.use("/portal", portalRoutes);

  return router;
}

module.exports = createRouter;
