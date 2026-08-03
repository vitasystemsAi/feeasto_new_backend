/** Roles allowed to access Customer Admin Control Center APIs */
const PORTAL_ROLES = ["SUPER_ADMIN", "CUSTOMER_ADMIN"];

const ALL_PERMISSIONS = [
  "dashboard",
  "customers",
  "restaurants",
  "trending",
  "ads",
  "reviews",
  "search_analytics",
  "reports",
  "audit_logs",
  "settings",
  "customer_admins",
];

function isSuperAdmin(req) {
  return req.user?.role === "SUPER_ADMIN";
}

function requirePortalRole(req, res, next) {
  if (!req.user?.role || !PORTAL_ROLES.includes(req.user.role)) {
    return res.status(403).json({ message: "Portal access denied for this role" });
  }
  return next();
}

function requirePermission(permissionKey) {
  return async (req, res, next) => {
    if (isSuperAdmin(req)) return next();
    if (req.user?.role !== "CUSTOMER_ADMIN") {
      return res.status(403).json({ message: "Forbidden" });
    }
    const granted = req.portalPermissions?.includes(permissionKey);
    if (!granted) {
      return res.status(403).json({ message: `Missing permission: ${permissionKey}` });
    }
    return next();
  };
}

async function loadPortalPermissions(req, _res, next) {
  if (isSuperAdmin(req)) {
    req.portalPermissions = [...ALL_PERMISSIONS];
    return next();
  }
  if (req.user?.role !== "CUSTOMER_ADMIN") {
    req.portalPermissions = [];
    return next();
  }
  const pool = require("../../../db/pool");
  const [rows] = await pool.execute(
    `SELECT ap.permission_key
     FROM admin_permissions ap
     JOIN customer_admins ca ON ca.id = ap.customer_admin_id
     WHERE ca.user_id = ? AND ap.is_granted = 1 AND ca.is_active = 1`,
    [req.user.sub]
  );
  req.portalPermissions = rows.map((r) => r.permission_key);
  return next();
}

module.exports = {
  PORTAL_ROLES,
  ALL_PERMISSIONS,
  isSuperAdmin,
  requirePortalRole,
  requirePermission,
  loadPortalPermissions,
};
