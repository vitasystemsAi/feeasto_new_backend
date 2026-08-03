const express = require("express");
const authRoutes = require("./routes/auth.routes");
const portalRoutes = require("./routes/portal.routes");
const publicRoutes = require("./routes/public.routes");

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/public", publicRoutes);
router.use("/", portalRoutes);

module.exports = router;
