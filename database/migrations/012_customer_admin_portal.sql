-- Customer Admin Management Portal schema
USE restaurant_saas;

ALTER TABLE users
  MODIFY role ENUM(
    'CUSTOMER','OWNER','MANAGER','DELIVERY_PARTNER','ADMIN','SUPER_ADMIN','CUSTOMER_ADMIN'
  ) NOT NULL;

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER approval_status;

CREATE TABLE IF NOT EXISTS customer_admins (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL UNIQUE,
  created_by_user_id BIGINT NULL,
  title VARCHAR(120) NULL,
  last_login_at DATETIME NULL,
  remember_token_hash VARCHAR(255) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS admin_permissions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  customer_admin_id BIGINT NOT NULL,
  permission_key VARCHAR(80) NOT NULL,
  is_granted TINYINT(1) NOT NULL DEFAULT 1,
  updated_by_user_id BIGINT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_admin_permission (customer_admin_id, permission_key),
  FOREIGN KEY (customer_admin_id) REFERENCES customer_admins(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS restaurant_priorities (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  restaurant_id BIGINT NOT NULL UNIQUE,
  priority_rank INT NOT NULL DEFAULT 999,
  updated_by_user_id BIGINT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
);
CREATE INDEX idx_restaurant_priorities_rank ON restaurant_priorities(priority_rank);

CREATE TABLE IF NOT EXISTS trending_food_items (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  menu_item_id BIGINT NOT NULL,
  rank_position INT NOT NULL,
  is_manual TINYINT(1) NOT NULL DEFAULT 0,
  order_count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_trending_food_rank (rank_position),
  UNIQUE KEY uq_trending_food_item (menu_item_id),
  FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS trending_restaurants (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  restaurant_id BIGINT NOT NULL,
  rank_position INT NOT NULL,
  is_manual TINYINT(1) NOT NULL DEFAULT 0,
  order_count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_trending_rest_rank (rank_position),
  UNIQUE KEY uq_trending_restaurant (restaurant_id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS advertisements (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  ad_title VARCHAR(200) NOT NULL,
  description TEXT NULL,
  image_url VARCHAR(500) NULL,
  redirect_url VARCHAR(500) NULL,
  ad_type ENUM(
    'HOMEPAGE_BANNER','CAROUSEL_BANNER','RESTAURANT_SPONSORED','FOOD_SPONSORED','POPUP'
  ) NOT NULL,
  restaurant_id BIGINT NULL,
  menu_item_id BIGINT NULL,
  start_date DATE NULL,
  end_date DATE NULL,
  priority INT NOT NULL DEFAULT 1,
  status ENUM('DRAFT','ACTIVE','PAUSED','ENDED') NOT NULL DEFAULT 'DRAFT',
  revenue_generated DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_by_user_id BIGINT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE SET NULL,
  FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS ad_impressions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  advertisement_id BIGINT NOT NULL,
  user_id BIGINT NULL,
  ip_address VARCHAR(45) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (advertisement_id) REFERENCES advertisements(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_ad_impressions_ad ON ad_impressions(advertisement_id);

CREATE TABLE IF NOT EXISTS ad_clicks (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  advertisement_id BIGINT NOT NULL,
  user_id BIGINT NULL,
  ip_address VARCHAR(45) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (advertisement_id) REFERENCES advertisements(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_ad_clicks_ad ON ad_clicks(advertisement_id);

CREATE TABLE IF NOT EXISTS review_moderation (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  feedback_id BIGINT NOT NULL UNIQUE,
  moderation_status ENUM('PENDING','APPROVED','REJECTED','HIDDEN') NOT NULL DEFAULT 'PENDING',
  moderated_by_user_id BIGINT NULL,
  moderation_note TEXT NULL,
  edited_comment TEXT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (feedback_id) REFERENCES feedback(id) ON DELETE CASCADE,
  FOREIGN KEY (moderated_by_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS review_moderation_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  feedback_id BIGINT NOT NULL,
  actor_user_id BIGINT NOT NULL,
  action VARCHAR(80) NOT NULL,
  previous_status VARCHAR(40) NULL,
  new_status VARCHAR(40) NULL,
  meta_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (feedback_id) REFERENCES feedback(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS search_analytics (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  search_keyword VARCHAR(255) NOT NULL,
  search_type ENUM('FOOD','RESTAURANT','GENERAL') NOT NULL DEFAULT 'GENERAL',
  user_id BIGINT NULL,
  search_count INT NOT NULL DEFAULT 1,
  searched_on DATE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_search_day (search_keyword, search_type, searched_on, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_search_analytics_keyword ON search_analytics(search_keyword);
CREATE INDEX idx_search_analytics_date ON search_analytics(searched_on);

CREATE TABLE IF NOT EXISTS customer_activity_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  customer_user_id BIGINT NOT NULL,
  activity_type VARCHAR(80) NOT NULL,
  meta_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS portal_audit_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  actor_user_id BIGINT NOT NULL,
  action VARCHAR(120) NOT NULL,
  module VARCHAR(80) NOT NULL,
  target_entity VARCHAR(80) NULL,
  target_id BIGINT NULL,
  ip_address VARCHAR(45) NULL,
  device_info VARCHAR(255) NULL,
  meta_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);
CREATE INDEX idx_portal_audit_created ON portal_audit_logs(created_at);

CREATE TABLE IF NOT EXISTS portal_sessions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  login_at DATETIME NOT NULL,
  logout_at DATETIME NULL,
  ip_address VARCHAR(45) NULL,
  device_info VARCHAR(255) NULL,
  refresh_token_hash VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS portal_password_resets (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  token_hash VARCHAR(255) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dashboard_reports (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  report_type VARCHAR(80) NOT NULL,
  report_key VARCHAR(120) NOT NULL,
  payload_json JSON NOT NULL,
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dashboard_report (report_type, report_key)
);

CREATE TABLE IF NOT EXISTS portal_notifications (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  recipient_user_id BIGINT NOT NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  channel ENUM('PUSH','EMAIL','IN_APP') NOT NULL DEFAULT 'IN_APP',
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_by_user_id BIGINT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);
