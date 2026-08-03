const jwt = require("jsonwebtoken");
const env = require("../config/env");
const pool = require("../db/pool");

async function isTokenRevokedByPasswordChange(decoded) {
  if (!decoded?.sub || decoded.purpose === "password_reset") return false;
  try {
    const [[row]] = await pool.execute(
      "SELECT password_updated_at FROM users WHERE id = ? LIMIT 1",
      [decoded.sub]
    );
    if (!row?.password_updated_at) return false;
    const pwdAt = new Date(row.password_updated_at).getTime();
    const issuedAt = (decoded.iat || 0) * 1000;
    return issuedAt < pwdAt;
  } catch {
    return false;
  }
}

function auth(required = true) {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      if (!required) return next();
      return res.status(401).json({ message: "Unauthorized" });
    }

    try {
      const decoded = jwt.verify(token, env.jwtSecret);
      if (await isTokenRevokedByPasswordChange(decoded)) {
        return res.status(401).json({ message: "Session expired. Please login again." });
      }
      req.user = decoded;
      return next();
    } catch {
      return res.status(401).json({ message: "Invalid token" });
    }
  };
}

module.exports = auth;
