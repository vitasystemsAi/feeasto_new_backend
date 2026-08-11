const pool = require("../db/pool");

/** Resolve tenant for a restaurant (backfill restaurants.tenant_id when missing). */
async function resolveRestaurantTenantId(conn, restaurantId, { customerUserId } = {}) {
  const [[restaurant]] = await conn.execute(
    "SELECT id, tenant_id, owner_user_id, name FROM restaurants WHERE id = ? LIMIT 1",
    [restaurantId]
  );
  if (!restaurant) return { restaurant: null, tenantId: null };

  if (restaurant.tenant_id != null && restaurant.tenant_id !== "") {
    return { restaurant, tenantId: Number(restaurant.tenant_id) };
  }

  let tenantId = null;
  if (customerUserId) {
    const [[sub]] = await conn.execute(
      `SELECT tenant_id FROM subscription_subscribers
       WHERE user_id = ? AND restaurant_id = ?
       ORDER BY (status = 'ACTIVE') DESC, id DESC
       LIMIT 1`,
      [customerUserId, restaurantId]
    );
    if (sub?.tenant_id != null) tenantId = Number(sub.tenant_id);
  }

  if (!tenantId && restaurant.owner_user_id) {
    const [[owner]] = await conn.execute("SELECT tenant_id FROM users WHERE id = ? LIMIT 1", [
      restaurant.owner_user_id,
    ]);
    if (owner?.tenant_id != null) tenantId = Number(owner.tenant_id);
  }

  if (tenantId) {
    await conn.execute("UPDATE restaurants SET tenant_id = ? WHERE id = ? AND tenant_id IS NULL", [
      tenantId,
      restaurantId,
    ]);
    restaurant.tenant_id = tenantId;
  }

  return { restaurant, tenantId };
}

/**
 * Ensure a vendor/restaurant and its owner have a tenant.
 * Creates a new tenants row when both restaurant and owner lack tenant_id.
 */
async function ensureVendorTenant(db, { restaurantId, ownerUserId, businessName } = {}) {
  const executor = db || pool;
  let tenantId = null;
  let restaurant = null;

  if (restaurantId) {
    const [[row]] = await executor.execute(
      "SELECT id, tenant_id, owner_user_id, name FROM restaurants WHERE id = ? LIMIT 1",
      [restaurantId]
    );
    restaurant = row || null;
    if (restaurant?.tenant_id != null && restaurant.tenant_id !== "") {
      tenantId = Number(restaurant.tenant_id);
    }
    if (!ownerUserId && restaurant?.owner_user_id) {
      ownerUserId = Number(restaurant.owner_user_id);
    }
    if (!businessName && restaurant?.name) businessName = restaurant.name;
  }

  if (!tenantId && ownerUserId) {
    const [[owner]] = await executor.execute("SELECT id, tenant_id FROM users WHERE id = ? LIMIT 1", [
      ownerUserId,
    ]);
    if (owner?.tenant_id != null && owner.tenant_id !== "") {
      tenantId = Number(owner.tenant_id);
    }
  }

  if (!tenantId) {
    const label = String(businessName || "Vendor").trim().slice(0, 100) || "Vendor";
    const subdomain = `v${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`.slice(0, 100);
    const [created] = await executor.execute(
      "INSERT INTO tenants (name, subdomain, status) VALUES (?, ?, 'ACTIVE')",
      [label, subdomain]
    );
    tenantId = Number(created.insertId);
  }

  if (restaurantId && tenantId) {
    await executor.execute(
      "UPDATE restaurants SET tenant_id = ? WHERE id = ? AND (tenant_id IS NULL OR tenant_id = 0)",
      [tenantId, restaurantId]
    );
  }

  if (ownerUserId && tenantId) {
    await executor.execute(
      "UPDATE users SET tenant_id = ? WHERE id = ? AND (tenant_id IS NULL OR tenant_id = 0)",
      [tenantId, ownerUserId]
    );
  }

  return tenantId;
}

function todayIsoLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nowSlotTimeLocal() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

module.exports = {
  resolveRestaurantTenantId,
  ensureVendorTenant,
  todayIsoLocal,
  nowSlotTimeLocal,
};
