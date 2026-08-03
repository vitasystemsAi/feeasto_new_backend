-- Subscription plans (master data per restaurant)
CREATE TABLE IF NOT EXISTS subscription_plans (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  restaurant_id BIGINT NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(500) NULL,
  price DECIMAL(10,2) NOT NULL DEFAULT 0,
  billing_cycle ENUM('DAILY','WEEKLY','MONTHLY') NOT NULL DEFAULT 'MONTHLY',
  includes_daily_delivery TINYINT(1) NOT NULL DEFAULT 1,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
);
CREATE INDEX idx_subscription_plans_restaurant ON subscription_plans(restaurant_id);

-- Delivery partner profiles registered by owner per restaurant
CREATE TABLE IF NOT EXISTS restaurant_delivery_partner_profiles (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  restaurant_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  delivery_partner_id BIGINT NULL,
  employee_id VARCHAR(24) NOT NULL,
  phone VARCHAR(20) NULL,
  address TEXT NOT NULL,
  aadhaar_number VARCHAR(12) NOT NULL,
  aadhaar_front_url TEXT NOT NULL,
  aadhaar_back_url TEXT NOT NULL,
  profile_pic_url TEXT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (delivery_partner_id) REFERENCES delivery_partners(id),
  UNIQUE KEY uk_partner_employee_id (employee_id),
  UNIQUE KEY uk_partner_restaurant_user (restaurant_id, user_id)
);
CREATE INDEX idx_partner_profiles_restaurant ON restaurant_delivery_partner_profiles(restaurant_id);

-- Employee ID series counter per restaurant (FAR-XX-0001)
CREATE TABLE IF NOT EXISTS partner_employee_id_counters (
  restaurant_id BIGINT PRIMARY KEY,
  letter_series CHAR(2) NOT NULL DEFAULT 'AA',
  next_number INT NOT NULL DEFAULT 1,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
);

-- Subscription customers (meal plan subscribers)
CREATE TABLE IF NOT EXISTS subscription_subscribers (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  restaurant_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  plan_id BIGINT NOT NULL,
  phone VARCHAR(20) NOT NULL,
  delivery_partner_profile_id BIGINT NULL,
  delivery_frequency ENUM('EVERY_DAY','WEEKDAYS','CUSTOM') NOT NULL DEFAULT 'EVERY_DAY',
  delivery_days_json JSON NULL,
  status ENUM('ACTIVE','PAUSED','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (plan_id) REFERENCES subscription_plans(id),
  FOREIGN KEY (delivery_partner_profile_id) REFERENCES restaurant_delivery_partner_profiles(id),
  UNIQUE KEY uk_subscriber_restaurant_user (restaurant_id, user_id)
);
CREATE INDEX idx_subscription_subscribers_restaurant ON subscription_subscribers(restaurant_id);
