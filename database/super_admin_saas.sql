-- =============================================================================
-- DATABASE: super_admin_saas
-- PURPOSE : Super-admin / platform control plane.
--           Holds: platform users (SUPER_ADMIN / ADMIN), all restaurant
--           registration requests, approval workflow, tenants directory,
--           subscriptions, portal ads/trending, audit logs.
--           This DB is NEVER accessible by customers or restaurant owners
--           directly – only the platform team reads/writes it.
-- =============================================================================

CREATE DATABASE IF NOT EXISTS super_admin_saas
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE super_admin_saas;

-- ---------------------------------------------------------------------------
-- 1. Platform admin users (SUPER_ADMIN / ADMIN only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_users (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  full_name     VARCHAR(120)  NOT NULL,
  email         VARCHAR(150)  UNIQUE NOT NULL,
  phone         VARCHAR(20)   NULL,
  password_hash VARCHAR(255)  NOT NULL,
  role          ENUM('SUPER_ADMIN','ADMIN') NOT NULL DEFAULT 'ADMIN',
  is_active     TINYINT(1)    NOT NULL DEFAULT 1,
  last_login_at TIMESTAMP     NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
CREATE INDEX idx_pu_email ON platform_users(email);
CREATE INDEX idx_pu_role  ON platform_users(role);

-- ---------------------------------------------------------------------------
-- 2. Tenants directory
--    One row per approved restaurant/vendor. db_name stores the isolated
--    per-restaurant database name (e.g. "restaurant_abc123").
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id           BIGINT PRIMARY KEY AUTO_INCREMENT,
  name         VARCHAR(150)  NOT NULL,
  subdomain    VARCHAR(100)  UNIQUE NOT NULL,
  db_name      VARCHAR(100)  UNIQUE NULL COMMENT 'Isolated MySQL database for this restaurant',
  status       ENUM('ACTIVE','SUSPENDED','PENDING_DB') NOT NULL DEFAULT 'PENDING_DB',
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
CREATE INDEX idx_tenants_status ON tenants(status);

-- ---------------------------------------------------------------------------
-- 3. Restaurant registration / approval queue
--    Vendors submit an application here; super-admin approves/rejects.
--    On approval the system provisions an isolated restaurant_XXXX database.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS restaurant_applications (
  id                  BIGINT PRIMARY KEY AUTO_INCREMENT,
  -- Applicant identity (from customer_saas.users)
  owner_user_id       BIGINT        NOT NULL COMMENT 'FK → customer_saas.users.id (OWNER role)',
  owner_name          VARCHAR(120)  NOT NULL,
  owner_email         VARCHAR(150)  NOT NULL,
  owner_phone         VARCHAR(20)   NULL,
  -- Business details
  business_name       VARCHAR(150)  NOT NULL,
  business_type       VARCHAR(80)   NOT NULL DEFAULT 'restaurant',
  business_type_label VARCHAR(120)  NULL,
  address             TEXT          NOT NULL,
  city                VARCHAR(100)  NULL,
  state               VARCHAR(100)  NULL,
  pincode             VARCHAR(20)   NULL,
  latitude            DECIMAL(10,8) NULL,
  longitude           DECIMAL(11,8) NULL,
  description         TEXT          NULL,
  -- KYC / compliance documents stored as JSON array of URLs
  kyc_document_url    TEXT          NULL COMMENT 'JSON array of document URLs',
  vendor_config       JSON          NULL COMMENT 'Business-specific config flags',
  -- Approval workflow
  approval_status     ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  rejection_reason    TEXT          NULL,
  reviewed_by_user_id BIGINT        NULL COMMENT 'FK → platform_users.id',
  reviewed_at         TIMESTAMP     NULL,
  -- After approval these are populated
  tenant_id           BIGINT        NULL COMMENT 'FK → tenants.id after approval',
  db_name             VARCHAR(100)  NULL COMMENT 'Provisioned DB name',
  slug                VARCHAR(150)  UNIQUE NULL,
  -- Timestamps
  submitted_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
CREATE INDEX idx_ra_status        ON restaurant_applications(approval_status);
CREATE INDEX idx_ra_owner         ON restaurant_applications(owner_user_id);
CREATE INDEX idx_ra_tenant        ON restaurant_applications(tenant_id);

-- ---------------------------------------------------------------------------
-- 4. Subscription plans (platform-wide definitions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscription_plans (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  name            VARCHAR(100) NOT NULL,
  description     TEXT         NULL,
  price           DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  billing_cycle   ENUM('MONTHLY','QUARTERLY','YEARLY') NOT NULL DEFAULT 'MONTHLY',
  features        JSON         NULL,
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Per-restaurant subscription (which plan each restaurant is on)
CREATE TABLE IF NOT EXISTS restaurant_subscriptions (
  id             BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id      BIGINT       NOT NULL COMMENT 'FK → tenants.id',
  plan_id        BIGINT       NOT NULL COMMENT 'FK → subscription_plans.id',
  status         ENUM('ACTIVE','EXPIRED','CANCELLED','TRIAL') NOT NULL DEFAULT 'TRIAL',
  starts_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at     TIMESTAMP    NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (plan_id) REFERENCES subscription_plans(id)
);
CREATE INDEX idx_rs_tenant  ON restaurant_subscriptions(tenant_id);
CREATE INDEX idx_rs_status  ON restaurant_subscriptions(status);

-- ---------------------------------------------------------------------------
-- 5. Platform category catalog (shown on customer browse page)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_category_catalog (
  id           BIGINT PRIMARY KEY AUTO_INCREMENT,
  category_key VARCHAR(120) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  image_url    VARCHAR(500) NULL,
  sort_order   INT          NOT NULL DEFAULT 0,
  is_active    TINYINT(1)   NOT NULL DEFAULT 1,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_category_key (category_key)
);
CREATE INDEX idx_pcc_sort ON platform_category_catalog(is_active, sort_order);

-- ---------------------------------------------------------------------------
-- 6. Advertisements (platform-wide ads managed by super-admin)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advertisements (
  id             BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id      BIGINT        NULL COMMENT 'NULL = platform-wide, set = restaurant-specific',
  title          VARCHAR(200)  NOT NULL,
  image_url      VARCHAR(500)  NULL,
  link_url       VARCHAR(500)  NULL,
  ad_type        ENUM('BANNER','POPUP','SPONSORED') NOT NULL DEFAULT 'BANNER',
  target_city    VARCHAR(100)  NULL,
  target_pincode VARCHAR(20)   NULL,
  is_active      TINYINT(1)    NOT NULL DEFAULT 1,
  starts_at      TIMESTAMP     NULL,
  ends_at        TIMESTAMP     NULL,
  created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_ads_active ON advertisements(is_active, starts_at, ends_at);

-- ---------------------------------------------------------------------------
-- 7. Trending restaurants / food items (curated by super-admin)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trending_restaurants (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id     BIGINT       NOT NULL,
  sort_order    INT          NOT NULL DEFAULT 0,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS trending_food_items (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id       BIGINT       NOT NULL,
  menu_item_label VARCHAR(150) NOT NULL COMMENT 'Denormalised label for display',
  sort_order      INT          NOT NULL DEFAULT 0,
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- 8. Platform audit log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  actor_id    BIGINT       NULL COMMENT 'platform_users.id who performed the action',
  actor_email VARCHAR(150) NULL,
  action      VARCHAR(100) NOT NULL COMMENT 'e.g. RESTAURANT_APPROVED, RESTAURANT_REJECTED',
  target_type VARCHAR(80)  NULL COMMENT 'e.g. restaurant_application',
  target_id   BIGINT       NULL,
  detail      JSON         NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_al_action    ON audit_logs(action);
CREATE INDEX idx_al_actor     ON audit_logs(actor_id);
CREATE INDEX idx_al_target    ON audit_logs(target_type, target_id);

-- ---------------------------------------------------------------------------
-- 9. Password-reset OTPs for platform users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_password_reset_otps (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  email       VARCHAR(150) NOT NULL,
  otp_hash    VARCHAR(255) NOT NULL,
  attempts    INT          NOT NULL DEFAULT 0,
  expires_at  TIMESTAMP    NOT NULL,
  used        TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ppr_email (email)
);

-- ---------------------------------------------------------------------------
-- 10. Portal sessions (super-admin web portal)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_sessions (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id       BIGINT       NOT NULL COMMENT 'FK → platform_users.id',
  token_hash    VARCHAR(255) NOT NULL,
  ip_address    VARCHAR(45)  NULL,
  user_agent    TEXT         NULL,
  expires_at    TIMESTAMP    NOT NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_ps_token (token_hash)
);
CREATE INDEX idx_ps_user ON portal_sessions(user_id);
