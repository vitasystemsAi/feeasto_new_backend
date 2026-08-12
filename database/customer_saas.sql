-- =============================================================================
-- DATABASE: customer_saas
-- PURPOSE : Central customer registry.
--           Stores ALL customers who register on the platform,
--           their saved addresses, order history references (by IDs),
--           subscriptions, and authentication tokens.
--           Restaurants and super-admin NEVER write to this DB directly;
--           they only read customer info by customer_user_id.
-- =============================================================================

CREATE DATABASE IF NOT EXISTS customer_saas
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE customer_saas;

-- ---------------------------------------------------------------------------
-- 1. Users
--    Holds CUSTOMER and OWNER accounts.
--    OWNERs are customers who have registered a restaurant.
--    Platform staff (ADMIN/SUPER_ADMIN) live in super_admin_saas.platform_users.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                 BIGINT PRIMARY KEY AUTO_INCREMENT,
  full_name          VARCHAR(120)  NOT NULL,
  email              VARCHAR(150)  UNIQUE NULL,
  phone              VARCHAR(20)   UNIQUE NULL,
  password_hash      VARCHAR(255)  NOT NULL,
  role               ENUM('CUSTOMER','OWNER') NOT NULL DEFAULT 'CUSTOMER',
  -- Profile
  profile_image_url  VARCHAR(500)  NULL,
  date_of_birth      DATE          NULL,
  gender             ENUM('M','F','OTHER') NULL,
  -- Account state
  is_active          TINYINT(1)    NOT NULL DEFAULT 1,
  email_verified     TINYINT(1)    NOT NULL DEFAULT 0,
  phone_verified     TINYINT(1)    NOT NULL DEFAULT 0,
  -- Security
  password_updated_at TIMESTAMP    NULL,
  profile_updated_at  TIMESTAMP    NULL,
  last_login_at       TIMESTAMP    NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_role  ON users(role);

-- ---------------------------------------------------------------------------
-- 2. Registration OTPs (email / SMS OTP before account is created)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS registration_otps (
  id                BIGINT PRIMARY KEY AUTO_INCREMENT,
  identifier        VARCHAR(150)  NOT NULL COMMENT 'email or phone',
  identifier_type   ENUM('EMAIL','PHONE') NOT NULL DEFAULT 'EMAIL',
  otp_hash          VARCHAR(255)  NOT NULL,
  full_name         VARCHAR(120)  NOT NULL,
  password_hash     VARCHAR(255)  NOT NULL,
  attempts          INT           NOT NULL DEFAULT 0,
  resend_count      INT           NOT NULL DEFAULT 0,
  last_resend_at    TIMESTAMP     NULL,
  expires_at        TIMESTAMP     NOT NULL,
  used              TINYINT(1)    NOT NULL DEFAULT 0,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_rotp_identifier (identifier, used)
);

-- ---------------------------------------------------------------------------
-- 3. Password reset OTPs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_reset_otps (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id     BIGINT       NOT NULL,
  otp_hash    VARCHAR(255) NOT NULL,
  attempts    INT          NOT NULL DEFAULT 0,
  resend_count INT         NOT NULL DEFAULT 0,
  expires_at  TIMESTAMP    NOT NULL,
  used        TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_prot_user (user_id, used)
);

-- ---------------------------------------------------------------------------
-- 4. Auth refresh tokens (persistent login)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id     BIGINT       NOT NULL,
  token_hash  VARCHAR(255) NOT NULL UNIQUE,
  device_info VARCHAR(300) NULL,
  expires_at  TIMESTAMP    NOT NULL,
  revoked     TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_rt_user ON refresh_tokens(user_id);

-- ---------------------------------------------------------------------------
-- 5. Saved / default delivery addresses
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_saved_addresses (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id       BIGINT        NOT NULL,
  label         VARCHAR(60)   NULL COMMENT 'Home, Work, etc.',
  contact_name  VARCHAR(120)  NULL,
  contact_phone VARCHAR(20)   NULL,
  address_line1 VARCHAR(200)  NOT NULL,
  address_line2 VARCHAR(200)  NULL,
  landmark      VARCHAR(200)  NULL,
  city          VARCHAR(100)  NOT NULL,
  state         VARCHAR(100)  NOT NULL,
  pincode       VARCHAR(20)   NOT NULL,
  latitude      DECIMAL(10,8) NULL,
  longitude     DECIMAL(11,8) NULL,
  is_default    TINYINT(1)    NOT NULL DEFAULT 0,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_csa_user ON customer_saved_addresses(user_id);

-- ---------------------------------------------------------------------------
-- 6. Customer order references
--    Cross-DB: the full order lives in restaurant_<slug>.orders
--    Here we keep a lightweight reference so a customer can list all
--    their orders across all restaurants without joining every restaurant DB.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_order_refs (
  id                BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id           BIGINT        NOT NULL,
  -- Where the real order lives
  restaurant_db     VARCHAR(100)  NOT NULL COMMENT 'DB name, e.g. restaurant_abc123',
  restaurant_name   VARCHAR(150)  NOT NULL COMMENT 'Denormalised for display',
  restaurant_slug   VARCHAR(150)  NOT NULL,
  remote_order_id   BIGINT        NOT NULL COMMENT 'orders.id in restaurant_db',
  -- Quick-read summary (snapshot copied from restaurant DB)
  order_type        ENUM('DELIVERY','DINE_IN','TAKEAWAY') NOT NULL DEFAULT 'DELIVERY',
  status            VARCHAR(40)   NOT NULL DEFAULT 'PENDING',
  total_amount      DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  ordered_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_cor_remote (restaurant_db, remote_order_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_cor_user   ON customer_order_refs(user_id, ordered_at);
CREATE INDEX idx_cor_status ON customer_order_refs(status);

-- ---------------------------------------------------------------------------
-- 7. Customer favourite restaurants (wishlist)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_favourites (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id         BIGINT        NOT NULL,
  restaurant_slug VARCHAR(150)  NOT NULL COMMENT 'slug to look up tenant',
  restaurant_name VARCHAR(150)  NOT NULL COMMENT 'Denormalised display name',
  added_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_cf_user_slug (user_id, restaurant_slug),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- 8. Customer notifications
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_notifications (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id     BIGINT       NOT NULL,
  title       VARCHAR(200) NOT NULL,
  body        TEXT         NULL,
  type        VARCHAR(60)  NOT NULL DEFAULT 'INFO',
  is_read     TINYINT(1)   NOT NULL DEFAULT 0,
  related_db  VARCHAR(100) NULL COMMENT 'restaurant DB name for deep-link',
  related_id  BIGINT       NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_cn_user_unread ON customer_notifications(user_id, is_read);

-- ---------------------------------------------------------------------------
-- 9. Customer subscriptions to restaurants (delivery/subscription plans)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_subscriptions (
  id                 BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id            BIGINT        NOT NULL,
  restaurant_db      VARCHAR(100)  NOT NULL,
  restaurant_slug    VARCHAR(150)  NOT NULL,
  plan_name          VARCHAR(100)  NOT NULL,
  status             ENUM('ACTIVE','PAUSED','CANCELLED','EXPIRED') NOT NULL DEFAULT 'ACTIVE',
  starts_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at         TIMESTAMP     NULL,
  created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_cs_user   ON customer_subscriptions(user_id);
CREATE INDEX idx_cs_status ON customer_subscriptions(status);

-- ---------------------------------------------------------------------------
-- 10. Activity / audit log for customer actions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_activity_logs (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id     BIGINT       NOT NULL,
  action      VARCHAR(100) NOT NULL COMMENT 'e.g. LOGIN, ORDER_PLACED, ADDRESS_ADDED',
  detail      JSON         NULL,
  ip_address  VARCHAR(45)  NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_cal_user   ON customer_activity_logs(user_id);
CREATE INDEX idx_cal_action ON customer_activity_logs(action);
