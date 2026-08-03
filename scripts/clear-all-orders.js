/**
 * Delete ALL order history (every role: customer, owner, delivery, dine-in, takeaway, subscription deliveries).
 * Keeps users, restaurants, menus, subscriptions, and delivery partner profiles.
 *
 * Usage: node scripts/clear-all-orders.js
 *        node scripts/clear-all-orders.js --yes   (skip confirmation prompt)
 */
const readline = require("readline");
const pool = require("../src/db/pool");

async function tableExists(table) {
  const [rows] = await pool.execute(
    `SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [table]
  );
  return rows.length > 0;
}

async function columnExists(table, column) {
  const [rows] = await pool.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function countRows(table) {
  if (!(await tableExists(table))) return 0;
  const [rows] = await pool.execute(`SELECT COUNT(*) AS c FROM \`${table}\``);
  return Number(rows[0].c);
}

async function clearAllOrders() {
  const conn = await pool.getConnection();
  const deleted = {};

  try {
    await conn.beginTransaction();

    const [orderRows] = await conn.execute("SELECT id FROM orders");
    const orderIds = orderRows.map((r) => r.id);
    deleted.orders = orderIds.length;

    if (orderIds.length) {
      const placeholders = orderIds.map(() => "?").join(",");

      if (await tableExists("complaints")) {
        const [complaints] = await conn.execute(
          `SELECT id FROM complaints WHERE order_id IN (${placeholders})`,
          orderIds
        );
        const complaintIds = complaints.map((c) => c.id);
        if (complaintIds.length && (await tableExists("refunds"))) {
          const cp = complaintIds.map(() => "?").join(",");
          const [r] = await conn.execute(`DELETE FROM refunds WHERE complaint_id IN (${cp})`, complaintIds);
          deleted.refunds = r.affectedRows;
        }
        const [c] = await conn.execute(`DELETE FROM complaints WHERE order_id IN (${placeholders})`, orderIds);
        deleted.complaints = c.affectedRows;
      }

      const childDeletes = [
        ["delivery_ratings", `DELETE FROM delivery_ratings WHERE order_id IN (${placeholders})`],
        ["feedback", `DELETE FROM feedback WHERE order_id IN (${placeholders})`],
        ["invoices", `DELETE FROM invoices WHERE order_id IN (${placeholders})`],
        ["payments", `DELETE FROM payments WHERE order_id IN (${placeholders})`],
        ["deliveries", `DELETE FROM deliveries WHERE order_id IN (${placeholders})`],
        ["order_items", `DELETE FROM order_items WHERE order_id IN (${placeholders})`],
      ];

      for (const [table, sql] of childDeletes) {
        if (!(await tableExists(table))) continue;
        const [r] = await conn.execute(sql, orderIds);
        deleted[table] = r.affectedRows;
      }

      const [o] = await conn.execute(`DELETE FROM orders WHERE id IN (${placeholders})`, orderIds);
      deleted.ordersRemoved = o.affectedRows;
    } else {
      deleted.ordersRemoved = 0;
    }

    if (await tableExists("restaurant_tables")) {
      const sets = ["status = 'AVAILABLE'"];
      if (await columnExists("restaurant_tables", "reserved_from")) sets.push("reserved_from = NULL");
      if (await columnExists("restaurant_tables", "reserved_to")) sets.push("reserved_to = NULL");
      const [t] = await conn.execute(
        `UPDATE restaurant_tables SET ${sets.join(", ")} WHERE status IN ('OCCUPIED', 'BOOKED')`
      );
      deleted.tablesReset = t.affectedRows;
    }

    await conn.commit();
    return deleted;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

function askConfirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(answer).trim()));
    });
  });
}

async function main() {
  const skipConfirm = process.argv.includes("--yes");

  const before = {
    orders: await countRows("orders"),
    order_items: await countRows("order_items"),
    payments: await countRows("payments"),
    invoices: await countRows("invoices"),
    deliveries: await countRows("deliveries"),
  };

  console.log("Current order data:");
  console.log(before);

  if (!before.orders) {
    console.log("No orders to delete.");
    await pool.end();
    return;
  }

  if (!skipConfirm) {
    const ok = await askConfirm(
      `Delete ALL ${before.orders} orders and related rows for every role? (yes/no): `
    );
    if (!ok) {
      console.log("Cancelled.");
      await pool.end();
      return;
    }
  }

  const result = await clearAllOrders();
  console.log("Deleted / reset:", result);

  const after = {
    orders: await countRows("orders"),
    order_items: await countRows("order_items"),
    payments: await countRows("payments"),
  };
  console.log("After:", after);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
