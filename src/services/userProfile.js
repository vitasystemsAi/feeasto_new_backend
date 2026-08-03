const pool = require("../db/pool");
const { validateIndianPhone } = require("../utils/phone");

function startOfTodayLocal() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function canEditProfileToday(profileUpdatedAt) {
  if (!profileUpdatedAt) return true;
  const updated = new Date(profileUpdatedAt);
  if (Number.isNaN(updated.getTime())) return true;
  return updated < startOfTodayLocal();
}

function nextProfileEditAt(profileUpdatedAt) {
  if (!profileUpdatedAt || canEditProfileToday(profileUpdatedAt)) return null;
  const next = new Date(startOfTodayLocal());
  next.setDate(next.getDate() + 1);
  return next.toISOString();
}

function mapUserProfileRow(row) {
  if (!row) return null;
  const profileUpdatedAt = row.profile_updated_at
    ? new Date(row.profile_updated_at).toISOString()
    : null;
  return {
    id: Number(row.id),
    fullName: row.full_name,
    email: row.email,
    phone: row.phone || null,
    role: row.role,
    tenantId: row.tenant_id != null ? Number(row.tenant_id) : null,
    profileUpdatedAt,
    canEditProfileToday: canEditProfileToday(row.profile_updated_at),
    nextProfileEditAt: nextProfileEditAt(row.profile_updated_at),
  };
}

async function fetchUserProfile(userId) {
  const [rows] = await pool.execute(
    `SELECT id, full_name, email, phone, role, tenant_id, profile_updated_at
     FROM users WHERE id = ? AND is_active = 1 LIMIT 1`,
    [userId]
  );
  return mapUserProfileRow(rows[0]);
}

async function syncPhoneToRelatedProfiles(conn, userId, phone) {
  try {
    await conn.execute(
      "UPDATE restaurant_delivery_partner_profiles SET phone = ? WHERE user_id = ?",
      [phone, userId]
    );
  } catch (err) {
    if (err?.code !== "ER_BAD_FIELD_ERROR" && err?.code !== "ER_NO_SUCH_TABLE") throw err;
  }
  try {
    await conn.execute("UPDATE subscription_subscribers SET phone = ? WHERE user_id = ?", [phone, userId]);
  } catch (err) {
    if (err?.code !== "ER_BAD_FIELD_ERROR" && err?.code !== "ER_NO_SUCH_TABLE") throw err;
  }
}

async function updateUserProfile(userId, { fullName, email, phone }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[user]] = await conn.execute(
      `SELECT id, full_name, email, phone, role, tenant_id, profile_updated_at
       FROM users WHERE id = ? AND is_active = 1 FOR UPDATE`,
      [userId]
    );
    if (!user) {
      await conn.rollback();
      return { ok: false, status: 404, message: "User not found" };
    }

    if (!canEditProfileToday(user.profile_updated_at)) {
      await conn.rollback();
      return {
        ok: false,
        status: 429,
        message: "Profile can only be edited once per day. Try again tomorrow.",
        nextProfileEditAt: nextProfileEditAt(user.profile_updated_at),
      };
    }

    const trimmedName = String(fullName || "").trim();
    const trimmedEmail = String(email || "").trim().toLowerCase();
    const phoneParsed = validateIndianPhone(phone);
    if (!phoneParsed.ok) {
      await conn.rollback();
      return { ok: false, status: 400, message: phoneParsed.message };
    }
    if (trimmedName.length < 2) {
      await conn.rollback();
      return { ok: false, status: 400, message: "Name must be at least 2 characters." };
    }

    const [[emailTaken]] = await conn.execute(
      "SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1",
      [trimmedEmail, userId]
    );
    if (emailTaken) {
      await conn.rollback();
      return { ok: false, status: 409, message: "This email is already registered." };
    }

    try {
      const [[phoneTaken]] = await conn.execute(
        "SELECT id FROM users WHERE phone = ? AND id != ? AND phone IS NOT NULL LIMIT 1",
        [phoneParsed.phone, userId]
      );
      if (phoneTaken) {
        await conn.rollback();
        return { ok: false, status: 409, message: "This mobile number is already registered." };
      }
    } catch (err) {
      if (err?.code !== "ER_BAD_FIELD_ERROR") throw err;
    }

    const unchanged =
      trimmedName === user.full_name &&
      trimmedEmail === user.email &&
      phoneParsed.phone === (user.phone || null);
    if (unchanged) {
      await conn.rollback();
      return {
        ok: false,
        status: 400,
        message: "No changes to save.",
      };
    }

    try {
      await conn.execute(
        `UPDATE users SET full_name = ?, email = ?, phone = ?, profile_updated_at = NOW()
         WHERE id = ?`,
        [trimmedName, trimmedEmail, phoneParsed.phone, userId]
      );
    } catch (err) {
      if (err?.code === "ER_BAD_FIELD_ERROR") {
        await conn.execute(
          "UPDATE users SET full_name = ?, email = ?, profile_updated_at = NOW() WHERE id = ?",
          [trimmedName, trimmedEmail, userId]
        );
      } else {
        throw err;
      }
    }

    await syncPhoneToRelatedProfiles(conn, userId, phoneParsed.phone);
    await conn.commit();

    const profile = await fetchUserProfile(userId);
    return { ok: true, profile };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = {
  canEditProfileToday,
  fetchUserProfile,
  mapUserProfileRow,
  updateUserProfile,
};
