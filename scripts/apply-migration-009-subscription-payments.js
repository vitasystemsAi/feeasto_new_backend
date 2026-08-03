/**
 * Creates subscription_plan_payments table.
 * Run: node scripts/apply-migration-009-subscription-payments.js
 */
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

async function tableExists(conn, db, table) {
  const [rows] = await conn.execute(
    `SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1`,
    [db, table]
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

  if (await tableExists(conn, db, "subscription_plan_payments")) {
    console.log("subscription_plan_payments already exists — skipping.");
    await conn.end();
    return;
  }

  const sqlPath = path.join(__dirname, "..", "database", "migrations", "009_subscription_plan_payments.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  await conn.query(sql);
  console.log("Applied migration 009_subscription_plan_payments.sql");
  await conn.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
