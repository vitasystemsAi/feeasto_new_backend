/**
 * Adds address/pincode/alt_phone and nullable plan_id on subscription_subscribers.
 * Run: node scripts/apply-migration-008-subscriber-profile.js
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
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "restaurant_saas",
    multipleStatements: true,
  });
  const db = process.env.DB_NAME || "restaurant_saas";

  if (await columnExists(conn, db, "subscription_subscribers", "address")) {
    console.log("subscription_subscribers profile columns already exist — skipping.");
    await conn.end();
    return;
  }

  const sqlPath = path.join(__dirname, "..", "database", "migrations", "008_subscriber_profile.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  await conn.query(sql);
  console.log("Applied migration 008_subscriber_profile.sql");
  await conn.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
