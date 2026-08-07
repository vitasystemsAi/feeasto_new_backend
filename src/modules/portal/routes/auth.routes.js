const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { z } = require("zod");
const pool = require("../../../db/pool");
const env = require("../../../config/env");
const auth = require("../../../middlewares/auth");
const { logPortalAction, clientMeta } = require("../utils/audit");
const { PORTAL_ROLES } = require("../utils/permissions"); // SUPER_ADMIN, CUSTOMER_ADMIN
const { sendPasswordResetEmail } = require("../../../services/portalMailer");
const { fetchUserProfile, updateUserProfile } = require("../../../services/userProfile");

const router = express.Router();

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function signTokens(user) {
  const payload = {
    sub: Number(user.id),
    role: user.role,
    tenantId: null,
    email: user.email,
    portal: true,
  };
  return {
    accessToken: jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn }),
    refreshToken: jwt.sign(payload, env.jwtRefreshSecret, { expiresIn: env.jwtRefreshExpiresIn }),
  };
}

router.post("/login", async (req, res) => {
  const schema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    rememberMe: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const email = normalizeEmail(parsed.data.email);
  const [rows] = await pool.execute(
    `SELECT u.id, u.full_name, u.email, u.password_hash, u.role, u.is_active
     FROM users u
     WHERE u.email = ? AND u.is_active = 1`,
    [email]
  );
  const user = rows[0];
  if (!user || !PORTAL_ROLES.includes(user.role)) {
    return res.status(401).json({ message: "Invalid portal credentials" });
  }
  if (user.role === "CUSTOMER_ADMIN") {
    const [[ca]] = await pool.execute(
      "SELECT id FROM customer_admins WHERE user_id = ? AND is_active = 1 LIMIT 1",
      [user.id]
    );
    if (!ca) return res.status(401).json({ message: "Customer admin account is inactive" });
  }

  const valid = await bcrypt.compare(parsed.data.password, user.password_hash);
  if (!valid) return res.status(401).json({ message: "Invalid portal credentials" });

  const tokens = signTokens(user);
  const { ip, device } = clientMeta(req);
  const refreshHash = crypto.createHash("sha256").update(tokens.refreshToken).digest("hex");

  await pool.execute(
    `INSERT INTO portal_sessions (user_id, login_at, ip_address, device_info, refresh_token_hash)
     VALUES (?, NOW(), ?, ?, ?)`,
    [user.id, ip, device, refreshHash]
  );
  if (user.role === "CUSTOMER_ADMIN") {
    await pool.execute("UPDATE customer_admins SET last_login_at = NOW() WHERE user_id = ?", [user.id]);
  }

  req.user = { sub: Number(user.id), role: user.role, email: user.email };
  await logPortalAction(req, { action: "LOGIN", module: "auth" });

  return res.json({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    user: {
      id: Number(user.id),
      fullName: user.full_name,
      email: user.email,
      role: user.role,
    },
  });
});

router.post("/refresh", async (req, res) => {
  const schema = z.object({ refreshToken: z.string().min(20) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  try {
    const decoded = jwt.verify(parsed.data.refreshToken, env.jwtRefreshSecret);
    if (!PORTAL_ROLES.includes(decoded.role)) {
      return res.status(401).json({ message: "Invalid refresh token" });
    }
    const [rows] = await pool.execute(
      "SELECT id, full_name, email, role FROM users WHERE id = ? AND is_active = 1",
      [decoded.sub]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ message: "Invalid refresh token" });
    const tokens = signTokens(user);
    return res.json(tokens);
  } catch {
    return res.status(401).json({ message: "Invalid refresh token" });
  }
});

router.post("/logout", auth(), async (req, res) => {
  const { ip, device } = clientMeta(req);
  await pool.execute(
    `UPDATE portal_sessions SET logout_at = NOW()
     WHERE user_id = ? AND logout_at IS NULL
     ORDER BY id DESC LIMIT 1`,
    [req.user.sub]
  );
  await logPortalAction(req, { action: "LOGOUT", module: "auth", meta: { ip, device } });
  return res.json({ message: "Logged out" });
});

router.post("/forgot-password", async (req, res) => {
  const schema = z.object({ email: z.string().email() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const email = normalizeEmail(parsed.data.email);
  const [[user]] = await pool.execute(
    "SELECT id, full_name, email, role FROM users WHERE email = ? AND is_active = 1",
    [email]
  );
  if (user && PORTAL_ROLES.includes(user.role)) {
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await pool.execute(
      "INSERT INTO portal_password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
      [user.id, tokenHash, expiresAt]
    );
    const resetUrl = `${env.frontendUrl}/portal/reset-password?token=${token}&email=${encodeURIComponent(email)}`;
    await sendPasswordResetEmail({ to: email, fullName: user.full_name, resetUrl });
  }
  return res.json({ message: "If the account exists, a reset link has been sent." });
});

router.post("/reset-password", async (req, res) => {
  const schema = z.object({
    email: z.string().email(),
    token: z.string().min(20),
    password: z.string().min(8),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const email = normalizeEmail(parsed.data.email);
  const tokenHash = crypto.createHash("sha256").update(parsed.data.token).digest("hex");
  const [[row]] = await pool.execute(
    `SELECT pr.id, pr.user_id, u.role
     FROM portal_password_resets pr
     JOIN users u ON u.id = pr.user_id
     WHERE u.email = ? AND pr.token_hash = ? AND pr.used_at IS NULL AND pr.expires_at > NOW()
     ORDER BY pr.id DESC LIMIT 1`,
    [email, tokenHash]
  );
  if (!row || !PORTAL_ROLES.includes(row.role)) {
    return res.status(400).json({ message: "Invalid or expired reset token" });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  await pool.execute("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, row.user_id]);
  await pool.execute("UPDATE portal_password_resets SET used_at = NOW() WHERE id = ?", [row.id]);
  return res.json({ message: "Password updated. You can login now." });
});

async function portalPermissionsForUser(userId, role) {
  if (role === "SUPER_ADMIN") {
    const { ALL_PERMISSIONS } = require("../utils/permissions");
    return ALL_PERMISSIONS;
  }
  const [permRows] = await pool.execute(
    `SELECT ap.permission_key FROM admin_permissions ap
     JOIN customer_admins ca ON ca.id = ap.customer_admin_id
     WHERE ca.user_id = ? AND ap.is_granted = 1`,
    [userId]
  );
  return permRows.map((p) => p.permission_key);
}

const profileUpdateSchema = z.object({
  fullName: z.string().min(2).max(120),
  email: z.string().email(),
  phone: z.string().min(10).max(15),
});

router.get("/me", auth(), async (req, res) => {
  if (!PORTAL_ROLES.includes(req.user.role)) {
    return res.status(403).json({ message: "Not a portal user" });
  }
  try {
    const profile = await fetchUserProfile(req.user.sub);
    if (!profile) return res.status(404).json({ message: "User not found" });
    const permissions = await portalPermissionsForUser(req.user.sub, profile.role);
    return res.json({ ...profile, permissions });
  } catch (error) {
    return res.status(500).json({ message: "Could not load profile", details: error.message });
  }
});

router.patch("/me/profile", auth(), async (req, res) => {
  if (!PORTAL_ROLES.includes(req.user.role)) {
    return res.status(403).json({ message: "Not a portal user" });
  }
  const parsed = profileUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message =
      issue?.path?.[0] === "fullName" && issue?.code === "too_small"
        ? "Name must be at least 2 characters."
        : issue?.path?.[0] === "email"
          ? "Enter a valid email address."
          : issue?.path?.[0] === "phone"
            ? "Enter a valid 10-digit Indian mobile number."
            : issue?.message || "Invalid profile details.";
    return res.status(400).json({ message, errors: parsed.error.issues });
  }
  try {
    const result = await updateUserProfile(req.user.sub, parsed.data);
    if (!result.ok) {
      const body = { message: result.message };
      if (result.nextProfileEditAt) body.nextProfileEditAt = result.nextProfileEditAt;
      return res.status(result.status).json(body);
    }
    const permissions = await portalPermissionsForUser(req.user.sub, result.profile.role);
    return res.json({
      message: "Profile updated.",
      user: { ...result.profile, permissions },
    });
  } catch (error) {
    return res.status(500).json({ message: "Could not update profile", details: error.message });
  }
});

module.exports = router;
