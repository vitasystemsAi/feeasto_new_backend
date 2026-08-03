function rbac(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user?.role) return res.status(401).json({ message: "Unauthorized" });
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden for this role" });
    }
    return next();
  };
}

module.exports = rbac;
