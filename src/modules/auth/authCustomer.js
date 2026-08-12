/**
 * authCustomer.js
 * ===============
 * Customer / Owner authentication helpers that operate on the
 * customer_saas database (not the old shared restaurant_saas).
 *
 * These functions are called by auth.routes.js.
 *
 * Operations:
 *   findUserByEmail(email)             → user row or null
 *   findUserByPhone(phone)             → user row or null
 *   createCustomer(data)               → newly inserted user row
 *   storeRegistrationOtp(data)         → insert into registration_otps
 *   findRegistrationOtp(identifier)    → otp row or null
 *   markOtpUsed(id)
 *   logActivity(userId, action, detail)
 */

"use strict";

const bcrypt = require("bcryptjs");
const { getCustomerPool } = require("../../db/dbManager");

function pool() {
  return getCustomerPool();
}

// ── User lookups ──────────────────────────────────────────────────────────────

async function findUserByEmail(email) {
  const [[row]] = await pool().execute(
    "SELECT * FROM users WHERE email = ? LIMIT 1",
    [email]
  );
  return row || null;
}

async function findUserByPhone(phone) {
  const [[row]] = await pool().execute(
    "SELECT * FROM users WHERE phone = ? LIMIT 1",
    [phone]
  );
  return row || null;
}

async function findUserById(id) {
  const [[row]] = await pool().execute(
    "SELECT * FROM users WHERE id = ? LIMIT 1",
    [id]
  );
  return row || null;
}

// ── Registration ───────────────────────────────────────────────────────────────

/**
 * Store a pending OTP for email registration.
 * @param {Object} p
 * @param {string} p.identifier  email or phone
 * @param {string} p.identifierType  'EMAIL' | 'PHONE'
 * @param {string} p.otpHash     bcrypt hash of the OTP code
 * @param {string} p.fullName
 * @param {string} p.passwordHash  bcrypt hash of the chosen password
 * @param {Date}   p.expiresAt
 */
async function storeRegistrationOtp({ identifier, identifierType = "EMAIL", otpHash, fullName, passwordHash, expiresAt }) {
  // Remove any existing unused OTP for this identifier
  await pool().execute(
    "DELETE FROM registration_otps WHERE identifier = ? AND used = 0",
    [identifier]
  );
  await pool().execute(
    `INSERT INTO registration_otps
       (identifier, identifier_type, otp_hash, full_name, password_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [identifier, identifierType, otpHash, fullName, passwordHash, expiresAt]
  );
}

/**
 * Find a pending (unused, not expired) OTP row.
 */
async function findRegistrationOtp(identifier) {
  const [[row]] = await pool().execute(
    `SELECT * FROM registration_otps
     WHERE identifier = ? AND used = 0 AND expires_at > NOW()
     ORDER BY id DESC LIMIT 1`,
    [identifier]
  );
  return row || null;
}

async function incrementOtpAttempts(id) {
  await pool().execute(
    "UPDATE registration_otps SET attempts = attempts + 1 WHERE id = ?",
    [id]
  );
}

async function markOtpUsed(id) {
  await pool().execute(
    "UPDATE registration_otps SET used = 1 WHERE id = ?",
    [id]
  );
}

/**
 * Create a new customer user in customer_saas.users.
 * @returns {Object} inserted user (with id)
 */
async function createCustomer({ fullName, email, phone, passwordHash, role = "CUSTOMER" }) {
  const [result] = await pool().execute(
    `INSERT INTO users (full_name, email, phone, password_hash, role, email_verified, is_active)
     VALUES (?, ?, ?, ?, ?, 1, 1)`,
    [fullName, email || null, phone || null, passwordHash, role]
  );
  return findUserById(result.insertId);
}

/**
 * Update last_login_at.
 */
async function touchLogin(userId) {
  await pool().execute(
    "UPDATE users SET last_login_at = NOW() WHERE id = ?",
    [userId]
  );
}

/**
 * Update password_updated_at (used to invalidate old JWTs).
 */
async function stampPasswordChange(userId) {
  await pool().execute(
    "UPDATE users SET password_updated_at = NOW() WHERE id = ?",
    [userId]
  );
}

// ── Saved addresses ────────────────────────────────────────────────────────────

async function getSavedAddresses(userId) {
  const [rows] = await pool().execute(
    `SELECT * FROM customer_saved_addresses WHERE user_id = ? ORDER BY is_default DESC, id ASC`,
    [userId]
  );
  return rows;
}

async function addSavedAddress(userId, addressData) {
  const {
    label, contactName, contactPhone,
    addressLine1, addressLine2, landmark,
    city, state, pincode, latitude, longitude, isDefault = false,
  } = addressData;

  if (isDefault) {
    await pool().execute(
      "UPDATE customer_saved_addresses SET is_default = 0 WHERE user_id = ?",
      [userId]
    );
  }

  const [result] = await pool().execute(
    `INSERT INTO customer_saved_addresses
       (user_id, label, contact_name, contact_phone,
        address_line1, address_line2, landmark,
        city, state, pincode, latitude, longitude, is_default)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId, label || "HOME", contactName || null, contactPhone || null,
      addressLine1, addressLine2 || null, landmark || null,
      city, state, pincode,
      latitude || null, longitude || null,
      isDefault ? 1 : 0,
    ]
  );
  return result.insertId;
}

// ── Order references ───────────────────────────────────────────────────────────

/**
 * Record a cross-DB order reference so the customer can list all orders.
 */
async function addOrderRef({ userId, restaurantDb, restaurantName, restaurantSlug, remoteOrderId, orderType, status, totalAmount }) {
  await pool().execute(
    `INSERT INTO customer_order_refs
       (user_id, restaurant_db, restaurant_name, restaurant_slug,
        remote_order_id, order_type, status, total_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status), total_amount = VALUES(total_amount), updated_at = NOW()`,
    [userId, restaurantDb, restaurantName, restaurantSlug, remoteOrderId, orderType, status, totalAmount]
  );
}

async function getOrderRefs(userId, { limit = 20, offset = 0 } = {}) {
  const [rows] = await pool().execute(
    `SELECT * FROM customer_order_refs
     WHERE user_id = ?
     ORDER BY ordered_at DESC
     LIMIT ? OFFSET ?`,
    [userId, limit, offset]
  );
  return rows;
}

// ── Activity log ───────────────────────────────────────────────────────────────

async function logActivity(userId, action, detail = null, ipAddress = null) {
  try {
    await pool().execute(
      `INSERT INTO customer_activity_logs (user_id, action, detail, ip_address)
       VALUES (?, ?, ?, ?)`,
      [userId, action, detail ? JSON.stringify(detail) : null, ipAddress]
    );
  } catch (e) {
    console.warn("[authCustomer] logActivity failed:", e.message);
  }
}

module.exports = {
  findUserByEmail,
  findUserByPhone,
  findUserById,
  storeRegistrationOtp,
  findRegistrationOtp,
  incrementOtpAttempts,
  markOtpUsed,
  createCustomer,
  touchLogin,
  stampPasswordChange,
  getSavedAddresses,
  addSavedAddress,
  addOrderRef,
  getOrderRefs,
  logActivity,
};
