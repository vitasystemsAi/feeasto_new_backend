/**
 * Adds scheduled_delivery_date/time and READY order status.
 * Run: node scripts/apply-migration-010-orders-scheduled.js
 */
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

async function columnExists(conn, db, table, column) {
  const [rows] = await conn.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [db, table, column]
  );
  return Boolean(rows[0]);
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || process.env.DB_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT || process.env.DB_PORT || 3306),
    user: process.env.MYSQL_USER || process.env.DB_USER || "root",
    password: process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || process.env.DB_NAME || "restaurant_saas",
    multipleStatements: true,
  });
  const db = process.env.MYSQL_DATABASE || process.env.DB_NAME || "restaurant_saas";

  if (await columnExists(conn, db, "orders", "scheduled_delivery_date")) {
    console.log("orders.scheduled_delivery_date already exists — skipping.");
    await conn.end();
    return;
  }

  const sqlPath = path.join(__dirname, "..", "database", "migrations", "010_orders_scheduled_ready.sql");
  await conn.query(fs.readFileSync(sqlPath, "utf8"));
  console.log("Applied migration 010_orders_scheduled_ready.sql");
  await conn.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
