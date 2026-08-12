-- =============================================================================
-- DATABASE TEMPLATE: restaurant_{{DB_NAME}}
-- PURPOSE : Isolated per-restaurant / per-vendor database.
--           One copy of this schema is provisioned for EACH restaurant
--           when the super-admin approves their application.
--           The actual DB name is  restaurant_<slug>  e.g. restaurant_abc123
--
-- How it is created at runtime:
--   const { provisionRestaurantDb } = require('./src/db/dbProvisioner');
--   await provisionRestaurantDb(slug, restaurantApplicationRow);
-- =============================================================================

-- NOTE: the DB is created dynamically by dbProvisioner.js using the slug.
--       This file is the TEMPLATE that dbProvisioner executes table-by-table
--       after CREATE DATABASE restaurant_<slug>.

-- ---------------------------------------------------------------------------
-- 1. Restaurant / vendor profile (single row – the owner of this DB)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS restaurant (
  id                  BIGINT PRIMARY KEY AUTO_INCREMENT,
  -- Link back to super_admin_saas
  tenant_id           BIGINT        NOT NULL COMMENT 'FK → super_admin_saas.tenants.id',
  application_id      BIGINT        NOT NULL COMMENT 'FK → super_admin_saas.restaurant_applications.id',
  owner_user_id       BIGINT        NOT NULL COMMENT 'FK → customer_saas.users.id (OWNER role)',
  -- Business identity
  name                VARCHAR(150)  NOT NULL,
  slug                VARCHAR(150)  UNIQUE NOT NULL,
  description         TEXT          NULL,
  business_type       VARCHAR(80)   NOT NULL DEFAULT 'restaurant',
  business_type_label VARCHAR(120)  NULL,
  vendor_config       JSON          NULL,
  -- Location
  address             TEXT          NOT NULL,
  address_line1       VARCHAR(200)  NULL,
  address_line2       VARCHAR(200)  NULL,
  city                VARCHAR(100)  NULL,
  state               VARCHAR(100)  NULL,
  pincode             VARCHAR(20)   NULL,
  latitude            DECIMAL(10,8) NULL,
  longitude           DECIMAL(11,8) NULL,
  -- Operational
  rating              DECIMAL(3,2)  NOT NULL DEFAULT 0.00,
  is_active           TINYINT(1)    NOT NULL DEFAULT 1,
  is_online           TINYINT(1)    NOT NULL DEFAULT 0,
  kyc_document_url    TEXT          NULL COMMENT 'JSON array of KYC doc URLs',
  -- Approval (mirrored from super_admin_saas for quick reads)
  approval_status     ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'APPROVED',
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- 2. Restaurant staff (owner + managers + delivery partners for this outlet)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  full_name     VARCHAR(120)  NOT NULL,
  email         VARCHAR(150)  UNIQUE NULL,
  phone         VARCHAR(20)   NULL,
  password_hash VARCHAR(255)  NOT NULL,
  role          ENUM('OWNER','MANAGER','DELIVERY_PARTNER') NOT NULL DEFAULT 'MANAGER',
  employee_id   VARCHAR(40)   NULL COMMENT 'Internal employee ID',
  is_active     TINYINT(1)    NOT NULL DEFAULT 1,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
CREATE INDEX idx_staff_role  ON staff(role);
CREATE INDEX idx_staff_email ON staff(email);

-- ---------------------------------------------------------------------------
-- 3. Menu categories
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS menu_categories (
  id         BIGINT PRIMARY KEY AUTO_INCREMENT,
  name       VARCHAR(120) NOT NULL,
  sort_order INT          NOT NULL DEFAULT 0,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- 4. Menu items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS menu_items (
  id             BIGINT PRIMARY KEY AUTO_INCREMENT,
  category_id    BIGINT        NOT NULL,
  name           VARCHAR(150)  NOT NULL,
  description    TEXT          NULL,
  price          DECIMAL(10,2) NOT NULL,
  is_veg         TINYINT(1)    NOT NULL DEFAULT 1,
  is_available   TINYINT(1)    NOT NULL DEFAULT 1,
  available_stock INT           NOT NULL DEFAULT 0,
  image_url      VARCHAR(500)  NULL,
  is_active      TINYINT(1)    NOT NULL DEFAULT 1,
  created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES menu_categories(id) ON DELETE CASCADE
);
CREATE INDEX idx_mi_category ON menu_items(category_id);
CREATE INDEX idx_mi_active   ON menu_items(is_active, is_available);

-- ---------------------------------------------------------------------------
-- 5. Tables / seating
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS restaurant_tables (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  table_number  VARCHAR(20)   NOT NULL,
  capacity      INT           NOT NULL DEFAULT 4,
  status        ENUM('AVAILABLE','BOOKED','OCCUPIED') NOT NULL DEFAULT 'AVAILABLE',
  qr_token      VARCHAR(100)  UNIQUE NULL,
  reserved_from DATETIME      NULL,
  reserved_to   DATETIME      NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- 6. Reservations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservations (
  id                BIGINT PRIMARY KEY AUTO_INCREMENT,
  table_id          BIGINT        NOT NULL,
  customer_user_id  BIGINT        NOT NULL COMMENT 'FK → customer_saas.users.id',
  customer_name     VARCHAR(120)  NOT NULL,
  customer_phone    VARCHAR(20)   NULL,
  guest_count       INT           NOT NULL DEFAULT 1,
  reserved_from     DATETIME      NOT NULL,
  reserved_to       DATETIME      NOT NULL,
  status            ENUM('CONFIRMED','CANCELLED','COMPLETED') NOT NULL DEFAULT 'CONFIRMED',
  notes             TEXT          NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (table_id) REFERENCES restaurant_tables(id)
);
CREATE INDEX idx_res_table    ON reservations(table_id);
CREATE INDEX idx_res_customer ON reservations(customer_user_id);

-- ---------------------------------------------------------------------------
-- 7. Orders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id                     BIGINT PRIMARY KEY AUTO_INCREMENT,
  -- Customer link (cross-DB reference by ID)
  customer_user_id       BIGINT        NOT NULL COMMENT 'FK → customer_saas.users.id',
  customer_name          VARCHAR(120)  NOT NULL,
  customer_phone         VARCHAR(20)   NULL,
  -- Table / dine-in
  table_id               BIGINT        NULL,
  -- Type & status
  order_type             ENUM('DELIVERY','DINE_IN','TAKEAWAY') NOT NULL DEFAULT 'DELIVERY',
  status                 ENUM(
                           'PENDING','ACCEPTED','PREPARING','READY',
                           'OUT_FOR_DELIVERY','DELIVERED','CANCELLED','REJECTED'
                         ) NOT NULL DEFAULT 'PENDING',
  token_number           INT           NULL COMMENT 'Daily token for dine-in/takeaway',
  -- Delivery details
  delivery_address       TEXT          NULL,
  delivery_address_line1 VARCHAR(200)  NULL,
  delivery_address_line2 VARCHAR(200)  NULL,
  delivery_city          VARCHAR(100)  NULL,
  delivery_pincode       VARCHAR(20)   NULL,
  delivery_latitude      DECIMAL(10,8) NULL,
  delivery_longitude     DECIMAL(11,8) NULL,
  -- Financials
  subtotal               DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  tax_amount             DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  delivery_fee           DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  discount_amount        DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  total_amount           DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  -- Scheduling
  scheduled_at           DATETIME      NULL,
  -- Cancellation
  cancelled_by           ENUM('CUSTOMER','RESTAURANT','SYSTEM') NULL,
  cancellation_reason    TEXT          NULL,
  -- Timestamps
  accepted_at            TIMESTAMP     NULL,
  ready_at               TIMESTAMP     NULL,
  delivered_at           TIMESTAMP     NULL,
  created_at             TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (table_id) REFERENCES restaurant_tables(id)
);
CREATE INDEX idx_orders_customer ON orders(customer_user_id);
CREATE INDEX idx_orders_status   ON orders(status);
CREATE INDEX idx_orders_created  ON orders(created_at);

-- ---------------------------------------------------------------------------
-- 8. Order items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
  id                 BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id           BIGINT        NOT NULL,
  menu_item_id       BIGINT        NOT NULL,
  menu_item_name     VARCHAR(150)  NOT NULL COMMENT 'Snapshot at time of order',
  quantity           INT           NOT NULL DEFAULT 1,
  unit_price         DECIMAL(10,2) NOT NULL,
  customization_json TEXT          NULL COMMENT 'Selected add-ons/variants as JSON',
  FOREIGN KEY (order_id)     REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (menu_item_id) REFERENCES menu_items(id)
);
CREATE INDEX idx_oi_order ON order_items(order_id);

-- ---------------------------------------------------------------------------
-- 9. Payments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                   BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id             BIGINT        NOT NULL,
  method               ENUM('CASH','UPI','CARD','WALLET','ONLINE') NOT NULL DEFAULT 'CASH',
  provider             VARCHAR(60)   NULL COMMENT 'e.g. Razorpay, PhonePe',
  provider_reference   VARCHAR(120)  NULL,
  amount               DECIMAL(10,2) NOT NULL,
  refunded_amount      DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  refunded_cumulative  DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  status               ENUM('PENDING','PAID','FAILED','REFUNDED','PARTIAL_REFUND') NOT NULL DEFAULT 'PENDING',
  paid_at              TIMESTAMP     NULL,
  created_at           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX idx_pay_order  ON payments(order_id);
CREATE INDEX idx_pay_status ON payments(status);

-- ---------------------------------------------------------------------------
-- 10. Invoices
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id             BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id       BIGINT        NOT NULL UNIQUE,
  invoice_number VARCHAR(60)   NOT NULL UNIQUE,
  pdf_url        VARCHAR(500)  NULL,
  created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

-- ---------------------------------------------------------------------------
-- 11. Delivery partners (employed by / associated with this restaurant)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS delivery_partners (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  staff_id        BIGINT        NULL COMMENT 'FK → staff.id if internal partner',
  full_name       VARCHAR(120)  NOT NULL,
  phone           VARCHAR(20)   NOT NULL,
  vehicle_type    VARCHAR(60)   NULL,
  is_available    TINYINT(1)    NOT NULL DEFAULT 1,
  current_lat     DECIMAL(10,8) NULL,
  current_lng     DECIMAL(11,8) NULL,
  rating          DECIMAL(3,2)  NOT NULL DEFAULT 5.00,
  aadhaar_url     VARCHAR(500)  NULL,
  employee_id     VARCHAR(40)   NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (staff_id) REFERENCES staff(id)
);

-- ---------------------------------------------------------------------------
-- 12. Deliveries
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deliveries (
  id                      BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id                BIGINT        NOT NULL UNIQUE,
  delivery_partner_id     BIGINT        NULL,
  status                  ENUM('ASSIGNED','PICKED_UP','OUT_FOR_DELIVERY','DELIVERED','FAILED') NOT NULL DEFAULT 'ASSIGNED',
  restaurant_handoff_at   TIMESTAMP     NULL,
  partner_pickup_at       TIMESTAMP     NULL,
  delivered_at            TIMESTAMP     NULL,
  notes                   TEXT          NULL,
  FOREIGN KEY (order_id)           REFERENCES orders(id),
  FOREIGN KEY (delivery_partner_id) REFERENCES delivery_partners(id)
);

-- ---------------------------------------------------------------------------
-- 13. Inventory items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_items (
  id           BIGINT PRIMARY KEY AUTO_INCREMENT,
  name         VARCHAR(150) NOT NULL,
  unit         VARCHAR(30)  NOT NULL DEFAULT 'kg',
  current_stock DECIMAL(10,3) NOT NULL DEFAULT 0,
  low_stock_threshold DECIMAL(10,3) NOT NULL DEFAULT 0,
  is_active    TINYINT(1)   NOT NULL DEFAULT 1,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventory_stock_entries (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  inventory_item_id BIGINT        NOT NULL,
  pack_quantity   DECIMAL(10,3) NOT NULL,
  pack_unit       VARCHAR(20)   NOT NULL,
  rate            DECIMAL(10,2) NOT NULL,
  notes           VARCHAR(255)  NULL,
  created_by_staff_id BIGINT    NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id),
  FOREIGN KEY (created_by_staff_id) REFERENCES staff(id)
);

-- ---------------------------------------------------------------------------
-- 14. Feedback / reviews
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feedback (
  id               BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id         BIGINT        NOT NULL,
  customer_user_id BIGINT        NOT NULL COMMENT 'FK → customer_saas.users.id',
  food_rating      TINYINT       NOT NULL DEFAULT 5,
  delivery_rating  TINYINT       NULL,
  comment          TEXT          NULL,
  is_visible       TINYINT(1)    NOT NULL DEFAULT 1,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX idx_fb_order    ON feedback(order_id);
CREATE INDEX idx_fb_customer ON feedback(customer_user_id);

-- ---------------------------------------------------------------------------
-- 15. Complaints
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS complaints (
  id               BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id         BIGINT        NOT NULL,
  customer_user_id BIGINT        NOT NULL COMMENT 'FK → customer_saas.users.id',
  subject          VARCHAR(200)  NOT NULL,
  description      TEXT          NOT NULL,
  status           ENUM('OPEN','IN_PROGRESS','RESOLVED','CLOSED') NOT NULL DEFAULT 'OPEN',
  resolution_note  TEXT          NULL,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at      TIMESTAMP     NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

-- ---------------------------------------------------------------------------
-- 16. Refunds
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refunds (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id        BIGINT        NOT NULL,
  payment_id      BIGINT        NOT NULL,
  amount          DECIMAL(10,2) NOT NULL,
  reason          TEXT          NULL,
  status          ENUM('PENDING','PROCESSED','FAILED') NOT NULL DEFAULT 'PENDING',
  processed_at    TIMESTAMP     NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id)  REFERENCES orders(id),
  FOREIGN KEY (payment_id) REFERENCES payments(id)
);

-- ---------------------------------------------------------------------------
-- 17. Daily token counter (for dine-in / takeaway queue numbers)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS restaurant_daily_tokens (
  date           DATE         NOT NULL,
  last_token     INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (date)
);

-- ---------------------------------------------------------------------------
-- 18. Analytics snapshot (cached aggregates)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics_daily (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  date          DATE          NOT NULL,
  total_orders  INT           NOT NULL DEFAULT 0,
  total_revenue DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  new_customers INT           NOT NULL DEFAULT 0,
  cancelled     INT           NOT NULL DEFAULT 0,
  avg_rating    DECIMAL(3,2)  NULL,
  UNIQUE KEY uk_ad_date (date)
);

-- ---------------------------------------------------------------------------
-- 19. Table QR guest CRM
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS restaurant_table_customers (
  id               BIGINT PRIMARY KEY AUTO_INCREMENT,
  table_id         BIGINT        NOT NULL,
  session_token    VARCHAR(100)  NOT NULL UNIQUE,
  guest_name       VARCHAR(120)  NULL,
  guest_phone      VARCHAR(20)   NULL,
  customer_user_id BIGINT        NULL COMMENT 'FK → customer_saas.users.id if logged in',
  seated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  left_at          TIMESTAMP     NULL,
  FOREIGN KEY (table_id) REFERENCES restaurant_tables(id)
);

-- ---------------------------------------------------------------------------
-- 20. Notification log (for restaurant-specific push/SMS alerts)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_log (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  type        VARCHAR(60)  NOT NULL COMMENT 'e.g. ORDER_PLACED, LOW_STOCK',
  recipient   VARCHAR(150) NULL,
  payload     JSON         NULL,
  status      ENUM('SENT','FAILED') NOT NULL DEFAULT 'SENT',
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
