/**
 * setup-multi-db.js
 * =================
 * One-time setup script to create the three platform databases.
 *
 * Run ONCE after pulling the multi-database architecture update:
 *
 *   node backend/scripts/setup-multi-db.js
 *
 * What it does:
 *   1. Connects to MySQL without selecting a database
 *   2. Creates super_admin_saas  (from database/super_admin_saas.sql)
 *   3. Creates customer_saas     (from database/customer_saas.sql)
 *   4. Leaves restaurant_saas    intact (existing data is preserved)
 *   5. Prints a summary
 *
 * Individual restaurant databases (restaurant_<slug>) are created
 * automatically at runtime when the super-admin approves an application.
 */

"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs    = require("fs");
const path  = require("path");
const mysql = require("mysql2/promise");

const DB_DIR = path.join(__dirname, "..", "database");

const FILES = [
  { label: "super_admin_saas", file: "super_admin_saas.sql" },
  { label: "customer_saas",    file: "customer_saas.sql"    },
];

/** Strip full-line SQL comments and blank lines. */
function stripComments(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

/** Split SQL into executable statements. */
function parseStatements(raw) {
  return stripComments(raw)
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runSqlFile(conn, filePath, label) {
  const raw = fs.readFileSync(filePath, "utf8");
  const statements = parseStatements(raw);

  let ok = 0;
  let skip = 0;

  for (const stmt of statements) {
    try {
      await conn.query(stmt);
      ok++;
    } catch (e) {
      if (
        e.code === "ER_TABLE_EXISTS_ERROR" ||
        e.code === "ER_DUP_KEYNAME" ||
        e.code === "ER_DUP_ENTRY" ||
        /already exists/i.test(e.message)
      ) {
        skip++;
      } else {
        console.warn(`  [WARN] ${label}: ${e.message.slice(0, 160)}`);
        skip++;
      }
    }
  }

  console.log(`  ✓ ${label}: ${ok} statements executed, ${skip} skipped`);
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║  Feesto Multi-DB Setup                              ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  const connOpts = {
    host:     process.env.MYSQL_HOST     || "localhost",
    port:     Number(process.env.MYSQL_PORT || 3307),
    user:     process.env.MYSQL_USER     || "root",
    password: process.env.MYSQL_PASSWORD || "",
    multipleStatements: false,
  };

  console.log(`Connecting to MySQL at ${connOpts.host}:${connOpts.port} as ${connOpts.user} ...`);
  const conn = await mysql.createConnection(connOpts);
  console.log("Connected.\n");

  for (const { label, file } of FILES) {
    const filePath = path.join(DB_DIR, file);
    if (!fs.existsSync(filePath)) {
      console.error(`  ✗ File not found: ${filePath}`);
      continue;
    }
    console.log(`Creating ${label} ...`);
    await runSqlFile(conn, filePath, label);
  }

  const [dbs] = await conn.query(
    "SHOW DATABASES WHERE `Database` IN ('super_admin_saas','customer_saas','restaurant_saas')"
  );
  const names = dbs.map((r) => r.Database);
  console.log("\n  Databases present:", names.join(", ") || "(none)");

  await conn.end();

  if (!names.includes("super_admin_saas") || !names.includes("customer_saas")) {
    console.error("\nSetup incomplete — required databases were not created.");
    process.exit(1);
  }

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║  Setup complete!                                     ║");
  console.log("║                                                      ║");
  console.log("║  Databases ready:                                    ║");
  console.log("║    • super_admin_saas  (platform control plane)     ║");
  console.log("║    • customer_saas     (all customers / owners)     ║");
  console.log("║    • restaurant_saas   (legacy – unchanged)         ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");
}

main().catch((err) => {
  console.error("Setup failed:", err.message);
  process.exit(1);
});
