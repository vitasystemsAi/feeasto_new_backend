/**
 * Adds cycle_id to subscription_plans (links plans to subscription_cycles).
 * Safe to run multiple times.
 */
const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const env = require("../src/config/env");

async function columnExists(conn, dbName, table, column) {
  const [[row]] = await conn.execute(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [dbName, table, column]
  );
  return Number(row?.c || 0) > 0;
}

async function main() {
  const conn = await mysql.createConnection({
    host: env.mysqlHost,
    port: env.mysqlPort,
    user: env.mysqlUser,
    password: env.mysqlPassword,
    database: env.mysqlDatabase,
    multipleStatements: true,
  });

  const db = env.mysqlDatabase;
  if (await columnExists(conn, db, "subscription_plans", "cycle_id")) {
    console.log("subscription_plans.cycle_id already exists — skipping.");
    await conn.end();
    return;
  }

  const sqlPath = path.join(__dirname, "..", "database", "migrations", "005_subscription_plans_cycle_id.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  await conn.query(sql);
  console.log("Applied migration 005_subscription_plans_cycle_id.sql");

  await conn.end();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
