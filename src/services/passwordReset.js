const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db/pool");
const env = require("../config/env");
const { sendPasswordResetOtpEmail } = require("./mailer");
const { normalizeIndianPhone } = require("../utils/phone");

const GENERIC_SENT_MSG =
  "If an account exists, a verification code has been sent to your registered email.";

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function makeOtpCode(length = 6) {
  const n = Math.min(8, Math.max(4, Number(length) || 6));
  let out = "";
  for (let i = 0; i < n; i += 1) out += String(Math.floor(Math.random() * 10));
  return out;
}

function hashOtp(otp) {
  return crypto.createHash("sha256").update(String(otp)).digest("hex");
}

function identifierKey(raw) {
  const email = normalizeEmail(raw);
  if (email.includes("@")) return `email:${email}`;
  const phone = normalizeIndianPhone(raw);
  if (phone) return `phone:${phone}`;
  return `raw:${String(raw || "").trim().toLowerCase()}`;
}

async function resolveUserPhone(userId, rowPhone) {
  if (rowPhone) {
    const p = normalizeIndianPhone(rowPhone);
    if (p) return p;
  }
  try {
    const [[sub]] = await pool.execute(
      "SELECT phone FROM subscribers WHERE user_id = ? AND phone IS NOT NULL AND phone != '' ORDER BY id DESC LIMIT 1",
      [userId]
    );
    if (sub?.phone) {
      const p = normalizeIndianPhone(sub.phone);
      if (p) return p;
    }
  } catch {
    /* optional */
  }
  try {
    const [[addr]] = await pool.execute(
      `SELECT contact_phone FROM customer_saved_addresses
       WHERE user_id = ? AND contact_phone IS NOT NULL AND contact_phone != ''
       ORDER BY is_default DESC, id DESC LIMIT 1`,
      [userId]
    );
    if (addr?.contact_phone) {
      const p = normalizeIndianPhone(addr.contact_phone);
      if (p) return p;
    }
  } catch {
    /* optional */
  }
  return null;
}

async function selectUserRow(sqlWithPhone, sqlWithoutPhone, params) {
  try {
    const [[row]] = await pool.execute(sqlWithPhone, params);
    return row || null;
  } catch (err) {
    if (err?.code !== "ER_BAD_FIELD_ERROR") throw err;
    const [[row]] = await pool.execute(sqlWithoutPhone, params);
    return row ? { ...row, phone: null } : null;
  }
}

async function findActiveUserByIdentifier(identifier) {
  const key = identifierKey(identifier);
  if (key.startsWith("email:")) {
    const email = key.slice(6);
    return selectUserRow(
      "SELECT id, full_name, email, phone, role FROM users WHERE LOWER(email) = ? AND is_active = 1 LIMIT 1",
      "SELECT id, full_name, email, role FROM users WHERE LOWER(email) = ? AND is_active = 1 LIMIT 1",
      [email]
    );
  }
  if (key.startsWith("phone:")) {
    const phone = key.slice(6);
    let row = await selectUserRow(
      "SELECT id, full_name, email, phone, role FROM users WHERE phone = ? AND is_active = 1 LIMIT 1",
      "SELECT id, full_name, email, role FROM users WHERE phone = ? AND is_active = 1 LIMIT 1",
      [phone]
    );
    if (row) return row;
    const [subs] = await pool.execute(
      `SELECT u.id, u.full_name, u.email, u.phone, u.role
       FROM subscribers s
       INNER JOIN users u ON u.id = s.user_id AND u.is_active = 1
       WHERE REPLACE(REPLACE(REPLACE(s.phone, ' ', ''), '-', ''), '+', '') LIKE ?
       LIMIT 1`,
      [`%${phone}%`]
    );
    if (subs[0]) return subs[0];
    return null;
  }
  return null;
}

async function getResetRow(userId) {
  const [[row]] = await pool.execute("SELECT * FROM password_reset_otps WHERE user_id = ? LIMIT 1", [userId]);
  return row || null;
}

async function issueOtpForUser(user, { isResend = false } = {}) {
  const otp = makeOtpCode(6);
  const otpHash = hashOtp(otp);
  const expiresAt = new Date(Date.now() + env.resetOtpTtlMinutes * 60 * 1000);
  const idKey = identifierKey(user.email);

  const existing = await getResetRow(user.id);
  if (isResend && existing) {
    if (existing.locked_at) {
      const err = new Error("LOCKED");
      err.code = "LOCKED";
      throw err;
    }
    if (Number(existing.resend_count || 0) >= env.resetOtpMaxResends) {
      const err = new Error("RESEND_LIMIT");
      err.code = "RESEND_LIMIT";
      throw err;
    }
    if (existing.last_sent_at) {
      const elapsed = Math.floor((Date.now() - new Date(existing.last_sent_at).getTime()) / 1000);
      if (elapsed < env.resetOtpResendCooldownSeconds) {
        const err = new Error("COOLDOWN");
        err.code = "COOLDOWN";
        err.retryAfter = env.resetOtpResendCooldownSeconds - elapsed;
        throw err;
      }
    }
  }

  if (isResend && existing) {
    await pool.execute(
      `UPDATE password_reset_otps SET
         identifier_key = ?, otp_hash = ?, expires_at = ?, attempts = 0,
         resend_count = resend_count + 1, is_used = 0, verified_at = NULL, locked_at = NULL, last_sent_at = NOW()
       WHERE user_id = ?`,
      [idKey, otpHash, expiresAt, user.id]
    );
  } else {
    await pool.execute(
      `INSERT INTO password_reset_otps
       (user_id, identifier_key, otp_hash, expires_at, attempts, resend_count, is_used, verified_at, locked_at, last_sent_at)
       VALUES (?, ?, ?, ?, 0, 0, 0, NULL, NULL, NOW())
       ON DUPLICATE KEY UPDATE
         identifier_key = VALUES(identifier_key),
         otp_hash = VALUES(otp_hash),
         expires_at = VALUES(expires_at),
         attempts = 0,
         resend_count = 0,
         is_used = 0,
         verified_at = NULL,
         locked_at = NULL,
         last_sent_at = NOW()`,
      [user.id, idKey, otpHash, expiresAt]
    );
  }

  const phone = await resolveUserPhone(user.id, user.phone);
  dispatchResetNotifications(user, otp, phone);

  return { expiresInMinutes: env.resetOtpTtlMinutes, maskedEmail: maskEmail(user.email), maskedPhone: maskPhone(phone) };
}

/** Send email OTP without blocking the HTTP response (SMTP can be slow). */
function dispatchResetNotifications(user, otp, _phone) {
  setImmediate(() => {
    (async () => {
      try {
        await sendPasswordResetOtpEmail({
          to: user.email,
          otp,
          expiresInMinutes: env.resetOtpTtlMinutes,
        });
      } catch (emailErr) {
        // eslint-disable-next-line no-console
        console.error("[password-reset] Email failed:", emailErr.message);
        if (env.nodeEnv !== "production") {
          // eslint-disable-next-line no-console
          console.log(`[password-reset-dev] OTP for ${user.email}: ${otp}`);
        }
      }
    })();
  });
}

function maskEmail(email) {
  const e = String(email || "");
  const [local, domain] = e.split("@");
  if (!domain) return "***";
  const head = local.slice(0, 2);
  return `${head}***@${domain}`;
}

function maskPhone(phone) {
  if (!phone) return null;
  return `******${String(phone).slice(-4)}`;
}

async function requestPasswordReset(identifier) {
  const user = await findActiveUserByIdentifier(identifier);
  let meta = {};
  if (user) {
    try {
      meta = await issueOtpForUser(user, { isResend: false });
    } catch (err) {
      if (err.code === "COOLDOWN" || err.code === "RESEND_LIMIT" || err.code === "LOCKED") {
        /* still generic response */
      } else {
        // eslint-disable-next-line no-console
        console.error("[password-reset] issueOtp failed:", err.message);
      }
    }
  }
  return { message: GENERIC_SENT_MSG, expiresInMinutes: meta.expiresInMinutes || env.resetOtpTtlMinutes };
}

async function resendPasswordResetOtp(identifier) {
  const user = await findActiveUserByIdentifier(identifier);
  if (!user) {
    return { message: GENERIC_SENT_MSG };
  }
  try {
    const meta = await issueOtpForUser(user, { isResend: true });
    return { message: GENERIC_SENT_MSG, ...meta, retryAfterSeconds: env.resetOtpResendCooldownSeconds };
  } catch (err) {
    if (err.code === "COOLDOWN") {
      return {
        message: GENERIC_SENT_MSG,
        retryAfterSeconds: err.retryAfter || env.resetOtpResendCooldownSeconds,
      };
    }
    if (err.code === "RESEND_LIMIT") {
      return { message: GENERIC_SENT_MSG, resendLimitReached: true };
    }
    if (err.code === "LOCKED") {
      return { message: GENERIC_SENT_MSG, locked: true };
    }
    throw err;
  }
}

async function verifyPasswordResetOtp(identifier, otpRaw) {
  const user = await findActiveUserByIdentifier(identifier);
  if (!user) {
    return { ok: false, message: "Invalid Verification Code" };
  }

  const row = await getResetRow(user.id);
  if (!row || row.is_used) {
    return { ok: false, message: "Invalid Verification Code" };
  }
  if (row.locked_at) {
    return { ok: false, message: "Too many attempts. Request a new verification code.", locked: true };
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, message: "Verification Code Expired", expired: true };
  }
  if (Number(row.attempts || 0) >= env.resetOtpMaxAttempts) {
    await pool.execute("UPDATE password_reset_otps SET locked_at = NOW() WHERE user_id = ?", [user.id]);
    return { ok: false, message: "Too many attempts. Request a new verification code.", locked: true };
  }

  const otp = String(otpRaw || "").trim().replace(/\s/g, "");
  if (hashOtp(otp) !== row.otp_hash) {
    const attempts = Number(row.attempts || 0) + 1;
    if (attempts >= env.resetOtpMaxAttempts) {
      await pool.execute(
        "UPDATE password_reset_otps SET attempts = ?, locked_at = NOW() WHERE user_id = ?",
        [attempts, user.id]
      );
      return { ok: false, message: "Too many attempts. Request a new verification code.", locked: true };
    }
    await pool.execute("UPDATE password_reset_otps SET attempts = ? WHERE user_id = ?", [attempts, user.id]);
    return { ok: false, message: "Invalid Verification Code" };
  }

  await pool.execute(
    "UPDATE password_reset_otps SET verified_at = NOW(), attempts = 0 WHERE user_id = ?",
    [user.id]
  );

  const resetToken = jwt.sign(
    { sub: Number(user.id), purpose: "password_reset", email: user.email },
    env.jwtSecret,
    { expiresIn: env.resetTokenExpiresIn }
  );

  return {
    ok: true,
    message: "Verification successful.",
    resetToken,
    maskedEmail: maskEmail(user.email),
    maskedPhone: maskPhone(await resolveUserPhone(user.id, user.phone)),
  };
}

function passwordMeetsPolicy(password) {
  const p = String(password || "");
  if (p.length < 8) return false;
  if (!/[A-Z]/.test(p)) return false;
  if (!/[a-z]/.test(p)) return false;
  if (!/[0-9]/.test(p)) return false;
  if (!/[^A-Za-z0-9]/.test(p)) return false;
  return true;
}

async function completePasswordReset(resetToken, password) {
  if (!passwordMeetsPolicy(password)) {
    return { ok: false, message: "Password does not meet security requirements." };
  }

  let decoded;
  try {
    decoded = jwt.verify(resetToken, env.jwtSecret);
  } catch {
    return { ok: false, message: "Reset session expired. Please start again." };
  }
  if (decoded.purpose !== "password_reset") {
    return { ok: false, message: "Invalid reset session." };
  }

  const userId = Number(decoded.sub);
  const row = await getResetRow(userId);
  if (!row || !row.verified_at || row.is_used) {
    return { ok: false, message: "Reset session invalid. Verify OTP again." };
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, message: "Verification Code Expired", expired: true };
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      "UPDATE users SET password_hash = ?, password_updated_at = NOW() WHERE id = ? AND is_active = 1",
      [passwordHash, userId]
    );
    await conn.execute("UPDATE password_reset_otps SET is_used = 1 WHERE user_id = ?", [userId]);
    await conn.execute("DELETE FROM password_reset_otps WHERE user_id = ?", [userId]);
    try {
      await conn.execute(
        "UPDATE portal_sessions SET logout_at = NOW() WHERE user_id = ? AND logout_at IS NULL",
        [userId]
      );
    } catch {
      /* optional table */
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  return { ok: true, message: "Password changed successfully." };
}

module.exports = {
  GENERIC_SENT_MSG,
  identifierKey,
  requestPasswordReset,
  resendPasswordResetOtp,
  verifyPasswordResetOtp,
  completePasswordReset,
  passwordMeetsPolicy,
  findActiveUserByIdentifier,
};
