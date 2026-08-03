/**
 * Creates subscription_renewals (renewal audit history).
 */
const path = require("path");
const fs = require("fs");
const mysql = require("mysql2/promise");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

async function tableExists(conn, db, table) {
  const [rows] = await conn.execute(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ? LIMIT 1`,
    [db, table]
  );
  return rows.length > 0;
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "foodflow",
    multipleStatements: true,
  });
  const db = process.env.DB_NAME || "foodflow";

  if (await tableExists(conn, db, "subscription_renewals")) {
    console.log("subscription_renewals already exists — skipping.");
    await conn.end();
    return;
  }

  const sqlPath = path.join(__dirname, "..", "database", "migrations", "007_subscription_renewals.sql");
  await conn.query(fs.readFileSync(sqlPath, "utf8"));
  console.log("Applied migration 007_subscription_renewals.sql");
  await conn.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
