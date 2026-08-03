const env = require("../config/env");

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isPlatformRestaurantApproverEmail(email) {
  return normalizeEmail(email) === normalizeEmail(env.defaultAdminEmail);
}

/** Only the platform approver account (DEFAULT_ADMIN_EMAIL) may approve restaurants. */
function platformApprover() {
  return (req, res, next) => {
    if (!req.user?.email) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    if (!isPlatformRestaurantApproverEmail(req.user.email)) {
      return res.status(403).json({
        message: "Restaurant approval is restricted to the platform approver account.",
      });
    }
    return next();
  };
}

module.exports = { platformApprover, isPlatformRestaurantApproverEmail };
