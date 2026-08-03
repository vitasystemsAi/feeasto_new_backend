function tenantScope(req, res, next) {
  const tenantId = req.headers["x-tenant-id"] || req.user?.tenantId || null;
  req.tenantId = tenantId ? Number(tenantId) : null;

  if (!req.tenantId && req.user?.role !== "SUPER_ADMIN" && req.user?.role !== "ADMIN") {
    return res.status(400).json({ message: "Missing tenant context" });
  }
  return next();
}

module.exports = tenantScope;
