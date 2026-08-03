/**
 * Delete all order history for a customer by name (partial match).
 * Usage: node scripts/delete-customer-orders.js "bhavani chary"
 */
const pool = require("../src/db/pool");

const nameQuery = process.argv.slice(2).join(" ").trim() || "bhavani chary";

async function tableExists(table) {
  const [rows] = await pool.execute(
    `SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [table]
  );
  return rows.length > 0;
}

async function deleteForUser(userId) {
  const [orders] = await pool.execute(
    "SELECT id FROM orders WHERE customer_user_id = ?",
    [userId]
  );
  const orderIds = orders.map((o) => o.id);
  if (!orderIds.length) {
    return { orderIds: [], deleted: {} };
  }

  const placeholders = orderIds.map(() => "?").join(",");
  const deleted = {};

  const steps = [
    ["delivery_ratings", `DELETE FROM delivery_ratings WHERE order_id IN (${placeholders})`],
    ["feedback", `DELETE FROM feedback WHERE order_id IN (${placeholders})`],
    ["invoices", `DELETE FROM invoices WHERE order_id IN (${placeholders})`],
    ["payments", `DELETE FROM payments WHERE order_id IN (${placeholders})`],
    ["deliveries", `DELETE FROM deliveries WHERE order_id IN (${placeholders})`],
    ["order_items", `DELETE FROM order_items WHERE order_id IN (${placeholders})`],
  ];

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [complaints] = await conn.execute(
      `SELECT id FROM complaints WHERE order_id IN (${placeholders}) OR customer_user_id = ?`,
      [...orderIds, userId]
    );
    const complaintIds = complaints.map((c) => c.id);
    if (complaintIds.length) {
      const cp = complaintIds.map(() => "?").join(",");
      if (await tableExists("refunds")) {
        const [r] = await conn.execute(`DELETE FROM refunds WHERE complaint_id IN (${cp})`, complaintIds);
        deleted.refunds = r.affectedRows;
      }
      const [c] = await conn.execute(`DELETE FROM complaints WHERE id IN (${cp})`, complaintIds);
      deleted.complaints = c.affectedRows;
    }

    for (const [label, sql] of steps) {
      if (!(await tableExists(label.split(" ")[0] === "delivery_ratings" ? "delivery_ratings" : label))) continue;
      try {
        const [r] = await conn.execute(sql, orderIds);
        deleted[label] = r.affectedRows;
      } catch (err) {
        if (err?.code === "ER_NO_SUCH_TABLE") continue;
        throw err;
      }
    }

    const [o] = await conn.execute(`DELETE FROM orders WHERE id IN (${placeholders})`, orderIds);
    deleted.orders = o.affectedRows;

    await conn.commit();
    return { orderIds, deleted };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function main() {
  const pattern = `%${nameQuery.replace(/\s+/g, "%")}%`;
  const [users] = await pool.execute(
    `SELECT id, full_name, email, role FROM users
     WHERE role = 'CUSTOMER' AND (full_name LIKE ? OR email LIKE ?)
     ORDER BY id`,
    [pattern, pattern]
  );

  if (!users.length) {
    console.log(`No customer found matching: ${nameQuery}`);
    process.exit(1);
  }

  if (users.length > 1) {
    console.log("Multiple matches — specify a more exact name:");
    users.forEach((u) => console.log(`  ${u.id}: ${u.full_name} <${u.email}>`));
    process.exit(1);
  }

  const user = users[0];
  console.log(`Customer: ${user.full_name} (id=${user.id}, ${user.email})`);

  const result = await deleteForUser(user.id);
  console.log(`Orders removed: ${result.orderIds.length} (ids: ${result.orderIds.join(", ") || "none"})`);
  console.log("Rows deleted:", result.deleted);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
