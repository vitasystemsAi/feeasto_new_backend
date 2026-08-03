const pool = require("../../../db/pool");

function clientMeta(req) {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    null;
  const device = String(req.headers["user-agent"] || "").slice(0, 255) || null;
  return { ip, device };
}

async function logPortalAction(req, { action, module, targetEntity = null, targetId = null, meta = null }) {
  if (!req.user?.sub) return;
  const { ip, device } = clientMeta(req);
  await pool.execute(
    `INSERT INTO portal_audit_logs
      (actor_user_id, action, module, target_entity, target_id, ip_address, device_info, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.user.sub,
      action,
      module,
      targetEntity,
      targetId,
      ip,
      device,
      meta ? JSON.stringify(meta) : null,
    ]
  );
}

module.exports = { logPortalAction, clientMeta };
