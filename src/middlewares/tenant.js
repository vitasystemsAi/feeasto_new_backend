const { ensureVendorTenant } = require("../utils/restaurantTenant");

async function tenantScope(req, res, next) {
  let tenantId = req.headers["x-tenant-id"] || req.user?.tenantId || null;
  req.tenantId = tenantId ? Number(tenantId) : null;

  if (
    !req.tenantId &&
    req.user?.role === "OWNER" &&
    (req.query?.restaurantId || req.body?.restaurantId)
  ) {
    try {
      const restaurantId = Number(req.query?.restaurantId || req.body?.restaurantId);
      if (Number.isFinite(restaurantId) && restaurantId > 0) {
        const healed = await ensureVendorTenant(null, {
          restaurantId,
          ownerUserId: req.user.sub,
        });
        if (healed) req.tenantId = Number(healed);
      }
    } catch {
      // fall through to missing-tenant response
    }
  }

  if (!req.tenantId && req.user?.role !== "SUPER_ADMIN" && req.user?.role !== "ADMIN") {
    return res.status(400).json({ message: "Missing tenant context" });
  }
  return next();
}

module.exports = tenantScope;
