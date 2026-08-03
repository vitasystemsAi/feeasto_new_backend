/**
 * Adds payments.refunded_cumulative and extends payment_status enum (migration 002).
 * Safe to run multiple times.
 */
const mysql = require("mysql2/promise");
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

  if (!(await columnExists(conn, db, "payments", "refunded_cumulative"))) {
    await conn.execute(
      "ALTER TABLE payments ADD COLUMN refunded_cumulative DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER amount"
    );
    console.log("Added payments.refunded_cumulative");
  } else {
    console.log("Column refunded_cumulative already exists");
  }

  await conn.execute(`
    ALTER TABLE payments
    MODIFY COLUMN payment_status ENUM('PENDING','PAID','FAILED','REFUNDED','PARTIALLY_REFUNDED') NOT NULL DEFAULT 'PENDING'
  `);
  console.log("Updated payments.payment_status enum (includes PARTIALLY_REFUNDED)");

  await conn.end();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
