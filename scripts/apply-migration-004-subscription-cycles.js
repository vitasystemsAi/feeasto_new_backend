/**
 * Applies migration 004 (subscription_cycles).
 * Safe to run multiple times.
 */
const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const env = require("../src/config/env");

async function tableExists(conn, dbName, table) {
  const [[row]] = await conn.execute(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [dbName, table]
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
  if (await tableExists(conn, db, "subscription_cycles")) {
    console.log("subscription_cycles already exists — skipping.");
    await conn.end();
    return;
  }

  const sqlPath = path.join(__dirname, "..", "database", "migrations", "004_subscription_cycles.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  await conn.query(sql);
  console.log("Applied migration 004_subscription_cycles.sql");

  await conn.end();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
