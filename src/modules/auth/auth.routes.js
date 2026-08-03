const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { z } = require("zod");
const pool = require("../../db/pool");
const env = require("../../config/env");
const auth = require("../../middlewares/auth");
const rbac = require("../../middlewares/rbac");
const { sendRegistrationOtpEmail } = require("../../services/mailer");
const { sendPasswordResetOtpSms } = require("../../services/sms");
const { ensurePasswordResetSchema } = require("../../utils/ensurePasswordResetSchema");
const {
  GENERIC_SENT_MSG,
  requestPasswordReset,
  resendPasswordResetOtp,
  verifyPasswordResetOtp,
  completePasswordReset,
} = require("../../services/passwordReset");
const { parseCoord, hasCoords } = require("../../utils/geo");
const {
  parseStructuredAddressFromBody,
  formatStructuredAddress,
  DEFAULT_COUNTRY,
} = require("../../utils/structuredAddress");
const { validateIndianPhone } = require("../../utils/phone");
const { fetchUserProfile, updateUserProfile } = require("../../services/userProfile");

const router = express.Router();

const registerRequestOtpSchema = z.object({
  fullName: z.string().min(2),
  email: z.string().email(),
  mobile: z.string().min(10).max(15),
  phone: z.string().min(10).max(15).optional(),
  password: z.string().min(8),
});

const registerVerifyOtpSchema = z.object({
  email: z.string().email(),
  otp: z.string().min(4).max(10),
  homeAddress: z.string().min(5).max(500).optional(),
  homeLatitude: z.coerce.number().min(-90).max(90).optional(),
  homeLongitude: z.coerce.number().min(-180).max(180).optional(),
  village: z.string().optional(),
  city: z.string().min(1).optional(),
  district: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  country: z.string().optional(),
  pincode: z.string().optional(),
  addressLine: z.string().optional(),
});

const customerLocationSchema = z.object({
  homeAddress: z.string().min(5).max(500).optional(),
  homeLatitude: z.coerce.number().min(-90).max(90).optional(),
  homeLongitude: z.coerce.number().min(-180).max(180).optional(),
  village: z.string().optional(),
  city: z.string().min(1).optional(),
  district: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  country: z.string().optional(),
  pincode: z.string().optional(),
  addressLine: z.string().optional(),
});

const savedAddressLabelSchema = z.enum(["HOME", "OFFICE", "OTHER"]);

function mapSavedAddressRow(row) {
  const formatted = formatStructuredAddress({
    village: row.village,
    city: row.city,
    district: row.district,
    state: row.state,
    country: row.country,
    pincode: row.pincode,
    addressLine: row.address_line,
  });
  return {
    id: Number(row.id),
    label: row.label,
    contactName: row.contact_name || "",
    contactPhone: row.contact_phone || "",
    village: row.village || null,
    city: row.city,
    district: row.district,
    state: row.state,
    country: row.country || DEFAULT_COUNTRY,
    pincode: row.pincode,
    addressLine: row.address_line || null,
    formattedAddress: formatted,
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    isDefault: Boolean(row.is_default),
  };
}

function resolveCustomerHomeFromBody(body) {
  const structured = parseStructuredAddressFromBody(body);
  if (structured.ok) {
    return {
      homeAddress: structured.data.formattedAddress,
      homeVillage: structured.data.village,
      homeCity: structured.data.city,
      homeDistrict: structured.data.district,
      homeState: structured.data.state,
      homeCountry: structured.data.country,
      homePincode: structured.data.pincode,
      homeLat: structured.data.latitude ?? parseCoord(body.homeLatitude),
      homeLng: structured.data.longitude ?? parseCoord(body.homeLongitude),
    };
  }
  const legacy = String(body.homeAddress || "").trim();
  if (legacy.length >= 5) {
    return {
      homeAddress: legacy,
      homeVillage: null,
      homeCity: null,
      homeDistrict: null,
      homeState: null,
      homeCountry: DEFAULT_COUNTRY,
      homePincode: null,
      homeLat: parseCoord(body.homeLatitude),
      homeLng: parseCoord(body.homeLongitude),
    };
  }
  return { ok: false, errors: structured.errors };
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function makeOtpCode(length = 6) {
  const safeLength = Math.min(8, Math.max(4, Number(length) || 6));
  let out = "";
  for (let i = 0; i < safeLength; i += 1) {
    out += String(Math.floor(Math.random() * 10));
  }
  return out;
}

function hashOtp(otp) {
  return crypto.createHash("sha256").update(String(otp)).digest("hex");
}

router.post("/register/request-otp", async (req, res) => {
  const parsed = registerRequestOtpSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const fullName = parsed.data.fullName.trim();
  const email = normalizeEmail(parsed.data.email);
  const password = parsed.data.password;
  const phoneParsed = validateIndianPhone(parsed.data.mobile ?? parsed.data.phone);
  if (!phoneParsed.ok) {
    return res.status(400).json({ message: phoneParsed.message });
  }
  const phone = phoneParsed.phone;

  try {
    const [[existingUser]] = await pool.execute("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
    if (existingUser) {
      return res.status(409).json({ message: "Email already exists. Please login with this email." });
    }
    try {
      const [[phoneUser]] = await pool.execute(
        "SELECT id FROM users WHERE phone = ? AND phone IS NOT NULL LIMIT 1",
        [phone]
      );
      if (phoneUser) {
        return res.status(409).json({ message: "This mobile number is already registered." });
      }
    } catch (phoneErr) {
      if (phoneErr?.code !== "ER_BAD_FIELD_ERROR") throw phoneErr;
    }

    const [[existingOtp]] = await pool.execute(
      "SELECT created_at FROM registration_otps WHERE email = ? LIMIT 1",
      [email]
    );
    if (existingOtp) {
      const elapsedSeconds = Math.floor((Date.now() - new Date(existingOtp.created_at).getTime()) / 1000);
      if (elapsedSeconds < env.otpResendCooldownSeconds) {
        return res.status(429).json({
          message: `Please wait ${env.otpResendCooldownSeconds - elapsedSeconds}s before requesting another OTP.`,
        });
      }
    }

    const otp = makeOtpCode(env.otpCodeLength);
    const otpHash = hashOtp(otp);
    const passwordHash = await bcrypt.hash(password, 10);
    const expiresAt = new Date(Date.now() + env.otpTtlMinutes * 60 * 1000);

    try {
      await pool.execute(
        `INSERT INTO registration_otps (email, full_name, phone, password_hash, otp_hash, expires_at, attempts, verified_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, NULL)
         ON DUPLICATE KEY UPDATE
           full_name = VALUES(full_name),
           phone = VALUES(phone),
           password_hash = VALUES(password_hash),
           otp_hash = VALUES(otp_hash),
           expires_at = VALUES(expires_at),
           attempts = 0,
           verified_at = NULL,
           created_at = CURRENT_TIMESTAMP`,
        [email, fullName, phone, passwordHash, otpHash, expiresAt]
      );
    } catch (insErr) {
      if (insErr?.code !== "ER_BAD_FIELD_ERROR") throw insErr;
      await pool.execute(
        `INSERT INTO registration_otps (email, full_name, password_hash, otp_hash, expires_at, attempts, verified_at)
         VALUES (?, ?, ?, ?, ?, 0, NULL)
         ON DUPLICATE KEY UPDATE
           full_name = VALUES(full_name),
           password_hash = VALUES(password_hash),
           otp_hash = VALUES(otp_hash),
           expires_at = VALUES(expires_at),
           attempts = 0,
           verified_at = NULL,
           created_at = CURRENT_TIMESTAMP`,
        [email, fullName, passwordHash, otpHash, expiresAt]
      );
    }

    setImmediate(() => {
      (async () => {
        await Promise.allSettled([
          sendRegistrationOtpEmail({
            to: email,
            otp,
            fullName,
            expiresInMinutes: env.otpTtlMinutes,
          }).catch((emailErr) => {
            // eslint-disable-next-line no-console
            console.error("[register-otp] email failed:", emailErr.message);
            if (env.nodeEnv !== "production") {
              // eslint-disable-next-line no-console
              console.log(`[register-otp-dev] OTP for ${email}: ${otp}`);
            }
          }),
          sendPasswordResetOtpSms({ to: phone, otp, expiresMinutes: env.otpTtlMinutes }).then((smsResult) => {
            if (!smsResult.sent) {
              // eslint-disable-next-line no-console
              console.warn("[register-otp] SMS not delivered:", smsResult.reason, smsResult.details || "");
            }
          }),
        ]);
      })();
    });

    return res.status(200).json({
      message: "Verification code sent to your email and mobile. Enter it to complete registration.",
      expiresInMinutes: env.otpTtlMinutes,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Could not send OTP. Check email SMTP settings and try again.",
      details: error.message,
    });
  }
});

router.post("/register/verify-otp", async (req, res) => {
  const parsed = registerVerifyOtpSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const email = normalizeEmail(parsed.data.email);
  const otp = String(parsed.data.otp || "").trim();
  const [[otpRow]] = await pool.execute(
    "SELECT * FROM registration_otps WHERE email = ? LIMIT 1",
    [email]
  );
  if (!otpRow) {
    return res.status(400).json({ message: "OTP session not found. Request a new OTP." });
  }
  if (otpRow.verified_at) {
    return res.status(400).json({ message: "OTP already used. Request a new OTP." });
  }
  if (new Date(otpRow.expires_at).getTime() < Date.now()) {
    await pool.execute("DELETE FROM registration_otps WHERE email = ?", [email]);
    return res.status(400).json({ message: "OTP expired. Request a new OTP." });
  }
  if (Number(otpRow.attempts || 0) >= env.otpMaxAttempts) {
    await pool.execute("DELETE FROM registration_otps WHERE email = ?", [email]);
    return res.status(400).json({ message: "Too many invalid OTP attempts. Request a new OTP." });
  }
  if (hashOtp(otp) !== otpRow.otp_hash) {
    await pool.execute("UPDATE registration_otps SET attempts = attempts + 1 WHERE email = ?", [email]);
    return res.status(400).json({ message: "Please enter the correct OTP." });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[existingUser]] = await conn.execute("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
    if (existingUser) {
      await conn.rollback();
      return res.status(409).json({ message: "Email already exists. Please login with this email." });
    }
    const home = resolveCustomerHomeFromBody(parsed.data);
    if (!home || home.ok === false) {
      await conn.rollback();
      return res.status(400).json({
        message: "Delivery address is required (village, city, district, state, pincode).",
        errors: home?.errors,
      });
    }
    const regPhoneRaw = otpRow.phone || null;
    const regPhoneParsed = regPhoneRaw ? validateIndianPhone(regPhoneRaw) : { ok: false };
    const regPhone = regPhoneParsed.ok ? regPhoneParsed.phone : null;

    let userInsert;
    try {
      [userInsert] = await conn.execute(
        `INSERT INTO users (full_name, email, phone, password_hash, role, tenant_id, is_active,
         home_address, home_village, home_city, home_district, home_state, home_country, home_pincode,
         home_latitude, home_longitude)
         VALUES (?, ?, ?, ?, 'CUSTOMER', NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          otpRow.full_name,
          email,
          regPhone,
          otpRow.password_hash,
          home.homeAddress,
          home.homeVillage,
          home.homeCity,
          home.homeDistrict,
          home.homeState,
          home.homeCountry,
          home.homePincode,
          home.homeLat,
          home.homeLng,
        ]
      );
    } catch (userInsErr) {
      if (userInsErr?.code !== "ER_BAD_FIELD_ERROR") throw userInsErr;
      [userInsert] = await conn.execute(
        `INSERT INTO users (full_name, email, password_hash, role, tenant_id, is_active,
         home_address, home_village, home_city, home_district, home_state, home_country, home_pincode,
         home_latitude, home_longitude)
         VALUES (?, ?, ?, 'CUSTOMER', NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          otpRow.full_name,
          email,
          otpRow.password_hash,
          home.homeAddress,
          home.homeVillage,
          home.homeCity,
          home.homeDistrict,
          home.homeState,
          home.homeCountry,
          home.homePincode,
          home.homeLat,
          home.homeLng,
        ]
      );
    }
    const userId = userInsert.insertId;
    if (userId && home.homeCity && home.homePincode) {
      try {
        await conn.execute(
          `INSERT INTO customer_saved_addresses
           (user_id, label, contact_phone, village, city, district, state, country, pincode, address_line, latitude, longitude, is_default)
           VALUES (?, 'HOME', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            userId,
            regPhone || "",
            home.homeVillage,
            home.homeCity,
            home.homeDistrict,
            home.homeState,
            home.homeCountry,
            home.homePincode,
            home.homeAddress,
            home.homeLat,
            home.homeLng,
          ]
        );
      } catch (addrErr) {
        if (addrErr?.code === "ER_BAD_FIELD_ERROR") {
          await conn.execute(
            `INSERT INTO customer_saved_addresses
             (user_id, label, village, city, district, state, country, pincode, address_line, latitude, longitude, is_default)
             VALUES (?, 'HOME', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [
              userId,
              home.homeVillage,
              home.homeCity,
              home.homeDistrict,
              home.homeState,
              home.homeCountry,
              home.homePincode,
              home.homeAddress,
              home.homeLat,
              home.homeLng,
            ]
          );
        } else {
          throw addrErr;
        }
      }
    }
    await conn.execute("DELETE FROM registration_otps WHERE email = ?", [email]);
    await conn.commit();
    return res.status(201).json({ message: "Registration successful. You can now login.", role: "CUSTOMER" });
  } catch (error) {
    await conn.rollback();
    return res.status(500).json({ message: "OTP verification failed due to server error.", details: error.message });
  } finally {
    conn.release();
  }
});

router.post("/register", async (req, res) => {
  const parsed = registerRequestOtpSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
  return res.status(400).json({
    message: "OTP verification is required. Use /auth/register/request-otp then /auth/register/verify-otp.",
  });
});

function validationMessage(issues) {
  const first = issues?.[0];
  if (!first) return "Invalid login details.";
  if (first.path?.[0] === "password" && first.code === "too_small") {
    return "Password must be at least 8 characters.";
  }
  if (first.path?.[0] === "email") return "Enter a valid email address.";
  return first.message || "Invalid login details.";
}

router.post("/login", async (req, res) => {
  try {
    const schema = z.object({ email: z.string().email(), password: z.string().min(8) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: validationMessage(parsed.error.issues),
        errors: parsed.error.issues,
      });
    }

    const { email, password } = parsed.data;
    const [rows] = await pool.execute(
      "SELECT id, full_name, email, password_hash, role, tenant_id FROM users WHERE email = ? AND is_active = 1",
      [email]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ message: "Invalid credentials" });
    if (!user.password_hash || typeof user.password_hash !== "string") {
      return res.status(401).json({ message: "Account password is not set. Please register again." });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) return res.status(401).json({ message: "Invalid credentials" });

    if (user.role === "CUSTOMER_ADMIN") {
      const [[ca]] = await pool.execute(
        "SELECT id FROM customer_admins WHERE user_id = ? AND is_active = 1 LIMIT 1",
        [user.id]
      );
      if (!ca) return res.status(401).json({ message: "Customer admin account is inactive" });
    }

    const payload = { sub: Number(user.id), role: user.role, tenantId: user.tenant_id ? Number(user.tenant_id) : null, email: user.email };
    const accessToken = jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
    const refreshToken = jwt.sign(payload, env.jwtRefreshSecret, { expiresIn: env.jwtRefreshExpiresIn });

    if (user.role === "CUSTOMER" || user.role === "CUSTOMER_ADMIN") {
      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || null;
      const device = String(req.headers["user-agent"] || "").slice(0, 255);
      await pool.execute(
        "INSERT INTO portal_sessions (user_id, login_at, ip_address, device_info) VALUES (?, NOW(), ?, ?)",
        [user.id, ip, device]
      );
    }

    return res.json({
      accessToken,
      refreshToken,
      user: {
        id: Number(user.id),
        fullName: user.full_name,
        email: user.email,
        role: user.role,
        tenantId: user.tenant_id ? Number(user.tenant_id) : null,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: "Login failed due to server error.", details: error.message });
  }
});

router.post("/refresh", async (req, res) => {
  const schema = z.object({ refreshToken: z.string().min(20) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  try {
    const decoded = jwt.verify(parsed.data.refreshToken, env.jwtRefreshSecret);
    const [rows] = await pool.execute(
      "SELECT id, full_name, email, role, tenant_id, password_updated_at FROM users WHERE id = ? AND is_active = 1",
      [decoded.sub]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ message: "Invalid refresh token" });
    if (user.password_updated_at) {
      const pwdAt = new Date(user.password_updated_at).getTime();
      const issuedAt = (decoded.iat || 0) * 1000;
      if (issuedAt < pwdAt) {
        return res.status(401).json({ message: "Session expired. Please login again." });
      }
    }

    const payload = {
      sub: Number(user.id),
      role: user.role,
      tenantId: user.tenant_id ? Number(user.tenant_id) : null,
      email: user.email,
    };
    const accessToken = jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
    const refreshToken = jwt.sign(payload, env.jwtRefreshSecret, { expiresIn: env.jwtRefreshExpiresIn });
    return res.json({ accessToken, refreshToken });
  } catch {
    return res.status(401).json({ message: "Invalid refresh token" });
  }
});

router.get("/me", auth(), async (req, res) => {
  try {
    const profile = await fetchUserProfile(req.user.sub);
    if (!profile) return res.status(404).json({ message: "User not found" });
    return res.json(profile);
  } catch (error) {
    return res.status(500).json({ message: "Could not load profile", details: error.message });
  }
});

const profileUpdateSchema = z.object({
  fullName: z.string().min(2).max(120),
  email: z.string().email(),
  phone: z.string().min(10).max(15),
});

router.patch("/me/profile", auth(), async (req, res) => {
  const parsed = profileUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message =
      issue?.path?.[0] === "fullName" && issue?.code === "too_small"
        ? "Name must be at least 2 characters."
        : issue?.path?.[0] === "email"
          ? "Enter a valid email address."
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
    return res.json({ message: "Profile updated.", user: result.profile });
  } catch (error) {
    return res.status(500).json({ message: "Could not update profile", details: error.message });
  }
});

router.get("/me/location", auth(), rbac("CUSTOMER"), async (req, res) => {
  try {
    const [[row]] = await pool.execute(
      `SELECT home_address, home_village, home_city, home_district, home_state, home_country, home_pincode,
              home_latitude, home_longitude FROM users WHERE id = ? LIMIT 1`,
      [req.user.sub]
    );
    if (!row) return res.status(404).json({ message: "User not found" });
    return res.json({
      homeAddress: row.home_address || null,
      village: row.home_village || null,
      city: row.home_city || null,
      district: row.home_district || null,
      state: row.home_state || null,
      country: row.home_country || DEFAULT_COUNTRY,
      pincode: row.home_pincode || null,
      homeLatitude: row.home_latitude != null ? Number(row.home_latitude) : null,
      homeLongitude: row.home_longitude != null ? Number(row.home_longitude) : null,
      hasCoordinates: hasCoords(row.home_latitude, row.home_longitude),
    });
  } catch (error) {
    if (error?.code === "ER_BAD_FIELD_ERROR") {
      return res.json({ homeAddress: null, homeLatitude: null, homeLongitude: null, hasCoordinates: false });
    }
    throw error;
  }
});

router.patch("/me/location", auth(), rbac("CUSTOMER"), async (req, res) => {
  const parsed = customerLocationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

  const home = resolveCustomerHomeFromBody(parsed.data);
  if (!home || home.ok === false) {
    return res.status(400).json({ message: "Valid address is required.", errors: home?.errors });
  }

  try {
    await pool.execute(
      `UPDATE users SET home_address = ?, home_village = ?, home_city = ?, home_district = ?,
       home_state = ?, home_country = ?, home_pincode = ?, home_latitude = ?, home_longitude = ? WHERE id = ?`,
      [
        home.homeAddress,
        home.homeVillage,
        home.homeCity,
        home.homeDistrict,
        home.homeState,
        home.homeCountry,
        home.homePincode,
        home.homeLat,
        home.homeLng,
        req.user.sub,
      ]
    );
  } catch (error) {
    if (error?.code === "ER_BAD_FIELD_ERROR") {
      await pool.execute(
        "UPDATE users SET home_address = ?, home_latitude = ?, home_longitude = ? WHERE id = ?",
        [home.homeAddress, home.homeLat, home.homeLng, req.user.sub]
      );
    } else {
      throw error;
    }
  }
  return res.json({
    message: "Location saved",
    homeAddress: home.homeAddress,
    village: home.homeVillage,
    city: home.homeCity,
    district: home.homeDistrict,
    state: home.homeState,
    country: home.homeCountry,
    pincode: home.homePincode,
    homeLatitude: home.homeLat,
    homeLongitude: home.homeLng,
    hasCoordinates: hasCoords(home.homeLat, home.homeLng),
  });
});

router.get("/me/addresses", auth(), rbac("CUSTOMER"), async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, label, contact_name, contact_phone, village, city, district, state, country, pincode, address_line, latitude, longitude, is_default
       FROM customer_saved_addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC`,
      [req.user.sub]
    );
    return res.json({ addresses: rows.map(mapSavedAddressRow) });
  } catch (error) {
    if (error?.code === "ER_NO_SUCH_TABLE") {
      return res.json({ addresses: [] });
    }
    throw error;
  }
});

router.post("/me/addresses", auth(), rbac("CUSTOMER"), async (req, res) => {
  const labelParsed = savedAddressLabelSchema.safeParse(String(req.body.label || "HOME").toUpperCase());
  if (!labelParsed.success) return res.status(400).json({ message: "label must be HOME, OFFICE, or OTHER" });

  const contactName = String(req.body.contactName || req.body.contact_name || "").trim();
  if (contactName.length < 2) {
    return res.status(400).json({ message: "Contact name is required (at least 2 characters)." });
  }

  const phoneParsed = validateIndianPhone(req.body.contactPhone ?? req.body.contact_phone);
  if (!phoneParsed.ok) {
    return res.status(400).json({ message: phoneParsed.message });
  }

  const structured = parseStructuredAddressFromBody(req.body);
  if (!structured.ok) return res.status(400).json({ errors: structured.error.issues });

  const d = structured.data;
  const lat = d.latitude ?? parseCoord(req.body.latitude);
  const lng = d.longitude ?? parseCoord(req.body.longitude);
  const isDefault = req.body.isDefault === true || req.body.isDefault === "true";

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (isDefault) {
      await conn.execute("UPDATE customer_saved_addresses SET is_default = 0 WHERE user_id = ?", [req.user.sub]);
    }
    const [[countRow]] = await conn.execute(
      "SELECT COUNT(*) AS c FROM customer_saved_addresses WHERE user_id = ?",
      [req.user.sub]
    );
    const makeDefault = isDefault || Number(countRow?.c || 0) === 0;

    const [result] = await conn.execute(
      `INSERT INTO customer_saved_addresses
       (user_id, label, contact_name, contact_phone, village, city, district, state, country, pincode, address_line, latitude, longitude, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.sub,
        labelParsed.data,
        contactName,
        phoneParsed.phone,
        d.village,
        d.city,
        d.district,
        d.state,
        d.country,
        d.pincode,
        d.addressLine || d.formattedAddress,
        lat,
        lng,
        makeDefault ? 1 : 0,
      ]
    );

    if (makeDefault) {
      await conn.execute(
        `UPDATE users SET home_address = ?, home_village = ?, home_city = ?, home_district = ?,
         home_state = ?, home_country = ?, home_pincode = ?, home_latitude = ?, home_longitude = ? WHERE id = ?`,
        [
          d.formattedAddress,
          d.village,
          d.city,
          d.district,
          d.state,
          d.country,
          d.pincode,
          lat,
          lng,
          req.user.sub,
        ]
      );
    }
    await conn.commit();
    const [[row]] = await pool.execute("SELECT * FROM customer_saved_addresses WHERE id = ? LIMIT 1", [
      result.insertId,
    ]);
    return res.status(201).json({ address: mapSavedAddressRow(row) });
  } catch (error) {
    await conn.rollback();
    if (error?.code === "ER_BAD_FIELD_ERROR") {
      const [result] = await pool.execute(
        `INSERT INTO customer_saved_addresses
         (user_id, label, village, city, district, state, country, pincode, address_line, latitude, longitude, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.user.sub,
          labelParsed.data,
          d.village,
          d.city,
          d.district,
          d.state,
          d.country,
          d.pincode,
          d.addressLine || d.formattedAddress,
          lat,
          lng,
          makeDefault ? 1 : 0,
        ]
      );
      const [[row]] = await pool.execute("SELECT * FROM customer_saved_addresses WHERE id = ? LIMIT 1", [
        result.insertId,
      ]);
      return res.status(201).json({ address: mapSavedAddressRow(row) });
    }
    throw error;
  } finally {
    conn.release();
  }
});

router.patch("/me/addresses/:addressId", auth(), rbac("CUSTOMER"), async (req, res) => {
  const addressId = Number(req.params.addressId);
  if (!Number.isFinite(addressId) || addressId <= 0) {
    return res.status(400).json({ message: "Valid address id is required" });
  }

  const [[existing]] = await pool.execute(
    "SELECT * FROM customer_saved_addresses WHERE id = ? AND user_id = ? LIMIT 1",
    [addressId, req.user.sub]
  );
  if (!existing) return res.status(404).json({ message: "Address not found" });

  const structured = parseStructuredAddressFromBody({
    village: req.body.village ?? existing.village,
    city: req.body.city ?? existing.city,
    district: req.body.district ?? existing.district,
    state: req.body.state ?? existing.state,
    country: req.body.country ?? existing.country,
    pincode: req.body.pincode ?? existing.pincode,
    addressLine: req.body.addressLine ?? existing.address_line,
    latitude: req.body.latitude ?? existing.latitude,
    longitude: req.body.longitude ?? existing.longitude,
  });
  if (!structured.ok) return res.status(400).json({ errors: structured.error.issues });

  const d = structured.data;
  const labelRaw = req.body.label != null ? String(req.body.label).toUpperCase() : existing.label;
  const labelParsed = savedAddressLabelSchema.safeParse(labelRaw);
  if (!labelParsed.success) return res.status(400).json({ message: "label must be HOME, OFFICE, or OTHER" });

  let contactName = existing.contact_name || "";
  if (req.body.contactName != null || req.body.contact_name != null) {
    contactName = String(req.body.contactName || req.body.contact_name || "").trim();
    if (contactName.length < 2) {
      return res.status(400).json({ message: "Contact name is required (at least 2 characters)." });
    }
  }

  let contactPhone = existing.contact_phone || "";
  if (req.body.contactPhone != null || req.body.contact_phone != null) {
    const phoneParsed = validateIndianPhone(req.body.contactPhone ?? req.body.contact_phone);
    if (!phoneParsed.ok) {
      return res.status(400).json({ message: phoneParsed.message });
    }
    contactPhone = phoneParsed.phone;
  } else if (!contactPhone) {
    return res.status(400).json({ message: "Mobile number is required." });
  }

  const isDefault = req.body.isDefault === true || req.body.isDefault === "true";
  const lat = d.latitude ?? parseCoord(existing.latitude);
  const lng = d.longitude ?? parseCoord(existing.longitude);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (isDefault) {
      await conn.execute("UPDATE customer_saved_addresses SET is_default = 0 WHERE user_id = ?", [req.user.sub]);
    }
    await conn.execute(
      `UPDATE customer_saved_addresses SET label = ?, contact_name = ?, contact_phone = ?, village = ?, city = ?, district = ?, state = ?, country = ?,
       pincode = ?, address_line = ?, latitude = ?, longitude = ?, is_default = ?
       WHERE id = ? AND user_id = ?`,
      [
        labelParsed.data,
        contactName,
        contactPhone,
        d.village,
        d.city,
        d.district,
        d.state,
        d.country,
        d.pincode,
        d.addressLine || d.formattedAddress,
        lat,
        lng,
        isDefault ? 1 : existing.is_default,
        addressId,
        req.user.sub,
      ]
    );
    if (isDefault || existing.is_default) {
      await conn.execute(
        `UPDATE users SET home_address = ?, home_village = ?, home_city = ?, home_district = ?,
         home_state = ?, home_country = ?, home_pincode = ?, home_latitude = ?, home_longitude = ? WHERE id = ?`,
        [
          d.formattedAddress,
          d.village,
          d.city,
          d.district,
          d.state,
          d.country,
          d.pincode,
          lat,
          lng,
          req.user.sub,
        ]
      );
    }
    await conn.commit();
    const [[row]] = await pool.execute("SELECT * FROM customer_saved_addresses WHERE id = ? LIMIT 1", [addressId]);
    return res.json({ address: mapSavedAddressRow(row) });
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
});

router.delete("/me/addresses/:addressId", auth(), rbac("CUSTOMER"), async (req, res) => {
  const addressId = Number(req.params.addressId);
  if (!Number.isFinite(addressId) || addressId <= 0) {
    return res.status(400).json({ message: "Valid address id is required" });
  }

  const [[existing]] = await pool.execute(
    "SELECT id, is_default FROM customer_saved_addresses WHERE id = ? AND user_id = ? LIMIT 1",
    [addressId, req.user.sub]
  );
  if (!existing) return res.status(404).json({ message: "Address not found" });

  await pool.execute("DELETE FROM customer_saved_addresses WHERE id = ? AND user_id = ?", [
    addressId,
    req.user.sub,
  ]);

  if (existing.is_default) {
    const [[next]] = await pool.execute(
      "SELECT * FROM customer_saved_addresses WHERE user_id = ? ORDER BY id DESC LIMIT 1",
      [req.user.sub]
    );
    if (next) {
      await pool.execute("UPDATE customer_saved_addresses SET is_default = 1 WHERE id = ?", [next.id]);
      await pool.execute(
        `UPDATE users SET home_address = ?, home_village = ?, home_city = ?, home_district = ?,
         home_state = ?, home_country = ?, home_pincode = ?, home_latitude = ?, home_longitude = ? WHERE id = ?`,
        [
          formatStructuredAddress(next),
          next.village,
          next.city,
          next.district,
          next.state,
          next.country,
          next.pincode,
          next.latitude,
          next.longitude,
          req.user.sub,
        ]
      );
    }
  }

  return res.json({ message: "Address deleted" });
});

function parseIdentifierBody(body) {
  const direct = String(body?.identifier || body?.emailOrMobile || "").trim();
  if (direct) return direct;
  if (body?.email) return String(body.email).trim();
  return "";
}

router.post("/forgot-password", async (req, res) => {
  const id = parseIdentifierBody(req.body);
  if (id.length < 3) {
    return res.status(400).json({ message: "Enter a valid email or mobile number." });
  }
  try {
    await ensurePasswordResetSchema();
    const result = await requestPasswordReset(id);
    return res.json(result);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[forgot-password]", error.message);
    return res.status(500).json({
      message: "Could not process request. Try again later.",
      details: env.nodeEnv === "development" ? error.message : undefined,
    });
  }
});

router.post("/send-reset-otp", async (req, res) => {
  const id = parseIdentifierBody(req.body);
  if (id.length < 3) return res.status(400).json({ message: "Enter a valid email or mobile number." });
  try {
    const result = await requestPasswordReset(id);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: "Could not send verification code." });
  }
});

router.post("/resend-reset-otp", async (req, res) => {
  const id = parseIdentifierBody(req.body);
  if (id.length < 3) return res.status(400).json({ message: "Enter a valid email or mobile number." });
  try {
    await ensurePasswordResetSchema();
    const result = await resendPasswordResetOtp(id);
    return res.json({ message: result.message || GENERIC_SENT_MSG, ...result });
  } catch (error) {
    return res.status(500).json({ message: "Could not resend verification code." });
  }
});

router.post("/verify-reset-otp", async (req, res) => {
  const schema = z.object({
    identifier: z.string().min(3).optional(),
    emailOrMobile: z.string().min(3).optional(),
    otp: z.string().min(4).max(10),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
  const identifier = parseIdentifierBody(req.body);
  if (identifier.length < 3) {
    return res.status(400).json({ message: "Session expired. Start forgot password again." });
  }
  const result = await verifyPasswordResetOtp(identifier, parsed.data.otp);
  if (!result.ok) {
    const status = result.expired || result.locked ? 400 : 400;
    return res.status(status).json(result);
  }
  return res.json(result);
});

router.post("/reset-password", async (req, res) => {
  const schema = z.object({
    resetToken: z.string().min(20),
    password: z.string().min(8),
    confirmPassword: z.string().min(8).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
  if (parsed.data.confirmPassword != null && parsed.data.password !== parsed.data.confirmPassword) {
    return res.status(400).json({ message: "Passwords do not match." });
  }
  const result = await completePasswordReset(parsed.data.resetToken, parsed.data.password);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

module.exports = router;
