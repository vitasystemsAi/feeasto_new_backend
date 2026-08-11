const http = require("http");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");
const createApp = require("./app");
const env = require("./config/env");
const pool = require("./db/pool");
const { ensurePortalSchema } = require("./modules/portal/ensurePortalSchema");
const { ensureLocationColumns } = require("./utils/ensureLocationColumns");
const { ensureStructuredAddressSchema } = require("./utils/ensureStructuredAddressSchema");
const { ensurePasswordResetSchema } = require("./utils/ensurePasswordResetSchema");
const { ensureUserProfileSchema } = require("./utils/ensureUserProfileSchema");
const { ensureStaffSchema } = require("./modules/staff/ensureStaffSchema");
const { ensureTableQrSchema } = require("./modules/tables/ensureTableQrSchema");
const { ensureDeliveryHandoffSchema } = require("./modules/delivery/ensureDeliveryHandoffSchema");
const { ensureVendorTypeSchema } = require("./utils/ensureVendorTypeSchema");
const { startTrendingSyncJob } = require("./modules/portal/services/trendingSync");
const { startOwnerAcceptTimeoutJob } = require("./services/ownerAcceptTimeout");
const { warmSmtpConnection } = require("./services/mailer");
const { smsConfigured } = require("./services/sms");

const server = http.createServer();
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      const allowed =
        !origin ||
        origin === env.frontendUrl ||
        /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin) ||
        /^capacitor:\/\/localhost$/i.test(origin) ||
        /^ionic:\/\/localhost$/i.test(origin);
      callback(null, allowed);
    },
    credentials: true,
  },
});
const app = createApp(io);

server.removeAllListeners("request");
server.on("request", app);

io.on("connection", (socket) => {
  socket.on("tenant:join", (tenantId) => {
    socket.join(`tenant:${tenantId}`);
  });
  socket.on("user:join", (userId) => {
    if (userId) socket.join(`user:${userId}`);
  });
});

async function ensureInventorySchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_stock_entries (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      tenant_id BIGINT NOT NULL,
      restaurant_id BIGINT NOT NULL,
      inventory_item_id BIGINT NOT NULL,
      pack_quantity DECIMAL(10,3) NOT NULL,
      pack_unit VARCHAR(20) NOT NULL,
      rate DECIMAL(10,2) NOT NULL,
      notes VARCHAR(255) NULL,
      created_by_user_id BIGINT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
      FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id)
    )
  `);
  const [idx] = await pool.query(
    "SHOW INDEX FROM inventory_stock_entries WHERE Key_name = 'idx_inventory_stock_entries_item'"
  );
  if (!idx.length) {
    await pool.query(
      "CREATE INDEX idx_inventory_stock_entries_item ON inventory_stock_entries(inventory_item_id)"
    );
  }
  const [idx2] = await pool.query(
    "SHOW INDEX FROM inventory_stock_entries WHERE Key_name = 'idx_inventory_stock_entries_restaurant'"
  );
  if (!idx2.length) {
    await pool.query(
      "CREATE INDEX idx_inventory_stock_entries_restaurant ON inventory_stock_entries(restaurant_id)"
    );
  }
}

async function ensureTableWiseOrderSchema() {
  const [tableIdColumns] = await pool.query("SHOW COLUMNS FROM orders LIKE 'table_id'");
  if (!tableIdColumns.length) {
    await pool.query("ALTER TABLE orders ADD COLUMN table_id BIGINT NULL AFTER customer_user_id");
  }

  const [tableIdIndex] = await pool.query("SHOW INDEX FROM orders WHERE Key_name = 'idx_orders_table_id'");
  if (!tableIdIndex.length) {
    await pool.query("CREATE INDEX idx_orders_table_id ON orders(table_id)");
  }

  const [tableIdFk] = await pool.query("SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'table_id' AND REFERENCED_TABLE_NAME = 'restaurant_tables' LIMIT 1");
  if (!tableIdFk.length) {
    await pool.query(
      "ALTER TABLE orders ADD CONSTRAINT fk_orders_table_id FOREIGN KEY (table_id) REFERENCES restaurant_tables(id)"
    );
  }
}

async function ensureRegistrationOtpSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS registration_otps (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      email VARCHAR(255) NOT NULL,
      full_name VARCHAR(120) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      otp_hash VARCHAR(255) NOT NULL,
      expires_at DATETIME NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      verified_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_registration_otps_email (email)
    )
  `);
  const [phoneCol] = await pool.query(
    "SHOW COLUMNS FROM registration_otps LIKE 'phone'"
  );
  if (!phoneCol.length) {
    await pool.query("ALTER TABLE registration_otps ADD COLUMN phone VARCHAR(20) NULL AFTER full_name");
  }
}

async function startServer() {
  try {
    await pool.query("SELECT 1");
    await ensureInventorySchema();
    await ensureTableWiseOrderSchema();
    await ensureRegistrationOtpSchema();
    await ensurePortalSchema();
    await ensureLocationColumns();
    await ensureStructuredAddressSchema();
    await ensurePasswordResetSchema();
    await ensureUserProfileSchema();
    await ensureStaffSchema();
    await ensureTableQrSchema();
    await ensureDeliveryHandoffSchema();
    await ensureVendorTypeSchema();
    setImmediate(() => {
      warmSmtpConnection().catch(() => {});
    });
    if (!smsConfigured()) {
      // eslint-disable-next-line no-console
      console.log("[sms] SMS provider not configured — OTP delivery is email-only.");
    }
    startTrendingSyncJob();
    startOwnerAcceptTimeoutJob(io);
    const adminEmail = String(env.defaultAdminEmail || "").trim().toLowerCase();
    if (adminEmail) {
      const [[existing]] = await pool.execute("SELECT id, role FROM users WHERE email = ? LIMIT 1", [adminEmail]);
      const hash = await bcrypt.hash(env.defaultAdminPassword, 10);
      if (!existing) {
        await pool.execute(
          "INSERT INTO users (full_name, email, password_hash, role, tenant_id, is_active) VALUES (?, ?, ?, 'SUPER_ADMIN', NULL, 1)",
          [env.defaultAdminName, adminEmail, hash]
        );
        // eslint-disable-next-line no-console
        console.log(`Default super admin created: ${adminEmail}`);
      } else if (existing.role !== "SUPER_ADMIN") {
        await pool.execute(
          "UPDATE users SET role = 'SUPER_ADMIN', password_hash = ?, is_active = 1 WHERE id = ?",
          [hash, existing.id]
        );
        // eslint-disable-next-line no-console
        console.log(`Default super admin promoted: ${adminEmail}`);
      }
    }
    server.listen(env.port, () => {
      // eslint-disable-next-line no-console
      console.log(`API running at http://localhost:${env.port}`);
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Database connection failed. Check MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE in backend/.env");
    // eslint-disable-next-line no-console
    console.error(error.message);
    process.exit(1);
  }
}

startServer();
