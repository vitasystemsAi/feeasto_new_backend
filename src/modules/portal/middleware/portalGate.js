const auth = require("../../../middlewares/auth");
const { requirePortalRole, loadPortalPermissions } = require("../utils/permissions");

function portalGate() {
  return [auth(), requirePortalRole, loadPortalPermissions];
}

module.exports = { portalGate };
