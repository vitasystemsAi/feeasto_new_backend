CREATE DATABASE IF NOT EXISTS restaurant_saas;
USE restaurant_saas;

CREATE TABLE tenants (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  subdomain VARCHAR(100) UNIQUE NOT NULL,
  status ENUM('ACTIVE','SUSPENDED') DEFAULT 'ACTIVE',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE users (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NULL,
  full_name VARCHAR(120) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('CUSTOMER','OWNER','MANAGER','DELIVERY_PARTNER','ADMIN','SUPER_ADMIN') NOT NULL,
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX idx_users_tenant ON users(tenant_id);

CREATE TABLE restaurants (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NULL,
  owner_user_id BIGINT NOT NULL,
  name VARCHAR(150) NOT NULL,
  slug VARCHAR(150) UNIQUE NOT NULL,
  description TEXT NULL,
  address TEXT NOT NULL,
  rating DECIMAL(3,2) DEFAULT 0,
  kyc_document_url TEXT NOT NULL,
  approval_status ENUM('PENDING','APPROVED','REJECTED') DEFAULT 'PENDING',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);
CREATE INDEX idx_restaurants_status ON restaurants(approval_status);

CREATE TABLE menu_categories (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  restaurant_id BIGINT NOT NULL,
  name VARCHAR(120) NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
);

CREATE TABLE menu_items (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  restaurant_id BIGINT NOT NULL,
  category_id BIGINT NOT NULL,
  name VARCHAR(150) NOT NULL,
  description TEXT NULL,
  price DECIMAL(10,2) NOT NULL,
  is_veg TINYINT(1) DEFAULT 1,
  is_available TINYINT(1) DEFAULT 1,
  available_stock INT DEFAULT 0,
  is_active TINYINT(1) DEFAULT 1,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
  FOREIGN KEY (category_id) REFERENCES menu_categories(id)
);
CREATE INDEX idx_menu_items_status ON menu_items(is_active);

CREATE TABLE platform_category_catalog (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  category_key VARCHAR(120) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  image_url VARCHAR(500) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_platform_category_key (category_key)
);
CREATE INDEX idx_platform_category_sort ON platform_category_catalog (is_active, sort_order, display_name);

CREATE TABLE restaurant_tables (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  restaurant_id BIGINT NOT NULL,
  table_number VARCHAR(20) NOT NULL,
  capacity INT NOT NULL,
  status ENUM('AVAILABLE','BOOKED','OCCUPIED') DEFAULT 'AVAILABLE',
  reserved_from DATETIME NULL,
  reserved_to DATETIME NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
);

CREATE TABLE reservations (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  restaurant_id BIGINT NOT NULL,
  table_id BIGINT NOT NULL,
  customer_user_id BIGINT NOT NULL,
  customer_name VARCHAR(120) NULL,
  mobile_number VARCHAR(20) NULL,
  party_size INT NULL,
  notes VARCHAR(500) NULL,
  start_time DATETIME NOT NULL,
  end_time DATETIME NOT NULL,
  status ENUM('BOOKED','CANCELLED','COMPLETED') DEFAULT 'BOOKED',
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
  FOREIGN KEY (table_id) REFERENCES restaurant_tables(id),
  FOREIGN KEY (customer_user_id) REFERENCES users(id)
);
CREATE INDEX idx_reservation_status ON reservations(status);

CREATE TABLE orders (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  restaurant_id BIGINT NOT NULL,
  customer_user_id BIGINT NOT NULL,
  table_id BIGINT NULL,
  order_type ENUM('DELIVERY','DINE_IN','TAKEAWAY') NOT NULL,
  token_number INT NULL,
  status ENUM('PLACED','ACCEPTED','PREPARING','READY','OUT_FOR_DELIVERY','DELIVERED','CANCELLED') DEFAULT 'PLACED',
  scheduled_delivery_date DATE NULL,
  scheduled_delivery_time VARCHAR(5) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
  FOREIGN KEY (customer_user_id) REFERENCES users(id),
  FOREIGN KEY (table_id) REFERENCES restaurant_tables(id)
);
CREATE INDEX idx_orders_user_id ON orders(customer_user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_scheduled_date ON orders(scheduled_delivery_date);
CREATE INDEX idx_orders_table_id ON orders(table_id);

CREATE TABLE order_items (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id BIGINT NOT NULL,
  menu_item_id BIGINT NOT NULL,
  quantity INT NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (menu_item_id) REFERENCES menu_items(id)
);
CREATE INDEX idx_order_items_order_id ON order_items(order_id);

CREATE TABLE payments (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  payment_method ENUM('COD','ONLINE') NOT NULL,
  payment_provider VARCHAR(40) NULL,
  amount DECIMAL(10,2) NOT NULL,
  refunded_cumulative DECIMAL(10,2) NOT NULL DEFAULT 0,
  payment_status ENUM('PENDING','PAID','FAILED','REFUNDED','PARTIALLY_REFUNDED') DEFAULT 'PENDING',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX idx_payments_order_id ON payments(order_id);
CREATE INDEX idx_payments_status ON payments(payment_status);

CREATE TABLE invoices (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  invoice_number VARCHAR(80) UNIQUE NOT NULL,
  pdf_url TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE delivery_partners (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  is_available TINYINT(1) DEFAULT 1,
  current_rating DECIMAL(3,2) DEFAULT 5.00,
  current_lat DECIMAL(10,7) NULL,
  current_lng DECIMAL(10,7) NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE deliveries (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  delivery_partner_id BIGINT NOT NULL,
  status ENUM('ASSIGNED','ACCEPTED','REJECTED','PICKED_UP','DELIVERED') DEFAULT 'ASSIGNED',
  eta_minutes INT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (delivery_partner_id) REFERENCES delivery_partners(id)
);
CREATE INDEX idx_deliveries_order_id ON deliveries(order_id);
CREATE INDEX idx_deliveries_status ON deliveries(status);

CREATE TABLE complaints (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id BIGINT NOT NULL,
  customer_user_id BIGINT NOT NULL,
  title VARCHAR(180) NOT NULL,
  description TEXT NOT NULL,
  status ENUM('OPEN','IN_REVIEW','RESOLVED') DEFAULT 'OPEN',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (customer_user_id) REFERENCES users(id)
);
CREATE INDEX idx_complaints_status ON complaints(status);

CREATE TABLE refunds (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  complaint_id BIGINT NOT NULL,
  requested_by_user_id BIGINT NOT NULL,
  status ENUM('REQUESTED','UNDER_REVIEW','APPROVED','REJECTED') DEFAULT 'REQUESTED',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (complaint_id) REFERENCES complaints(id),
  FOREIGN KEY (requested_by_user_id) REFERENCES users(id)
);
CREATE INDEX idx_refunds_status ON refunds(status);

CREATE TABLE inventory_items (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  restaurant_id BIGINT NOT NULL,
  name VARCHAR(120) NOT NULL,
  quantity DECIMAL(10,2) NOT NULL DEFAULT 0,
  unit VARCHAR(20) NOT NULL,
  low_stock_threshold DECIMAL(10,2) NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
);

CREATE TABLE inventory_stock_entries (
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
  FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id),
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);
CREATE INDEX idx_inventory_stock_entries_item ON inventory_stock_entries(inventory_item_id);
CREATE INDEX idx_inventory_stock_entries_restaurant ON inventory_stock_entries(restaurant_id);

CREATE TABLE audit_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  actor_user_id BIGINT NOT NULL,
  action_type VARCHAR(120) NOT NULL,
  target_entity VARCHAR(80) NOT NULL,
  target_id BIGINT NULL,
  meta_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);

CREATE TABLE feedback (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  restaurant_id BIGINT NOT NULL,
  customer_user_id BIGINT NOT NULL,
  order_id BIGINT NULL,
  rating INT NOT NULL,
  comment TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
  FOREIGN KEY (customer_user_id) REFERENCES users(id),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX idx_feedback_restaurant ON feedback(restaurant_id);

CREATE TABLE delivery_ratings (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  delivery_partner_id BIGINT NOT NULL,
  customer_user_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  rating INT NOT NULL,
  comment TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (delivery_partner_id) REFERENCES delivery_partners(id),
  FOREIGN KEY (customer_user_id) REFERENCES users(id),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX idx_delivery_ratings_partner ON delivery_ratings(delivery_partner_id);

-- Operating expenses (rent, utilities, payroll allocations, etc.) for revenue / P&L
CREATE TABLE IF NOT EXISTS restaurant_expenses (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  restaurant_id BIGINT NOT NULL,
  category VARCHAR(80) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  note VARCHAR(500) NULL,
  spent_at DATETIME NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
);
CREATE INDEX idx_restaurant_expenses_restaurant ON restaurant_expenses(restaurant_id);
CREATE INDEX idx_restaurant_expenses_spent_at ON restaurant_expenses(spent_at);

CREATE TABLE subscription_cycles (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  restaurant_id BIGINT NOT NULL,
  name VARCHAR(120) NOT NULL,
  value_type ENUM('DAYS','QUANTITY') NOT NULL DEFAULT 'DAYS',
  value INT NOT NULL DEFAULT 1,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
);
CREATE INDEX idx_subscription_cycles_restaurant ON subscription_cycles(restaurant_id);

CREATE TABLE subscription_plans (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  restaurant_id BIGINT NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(500) NULL,
  price DECIMAL(10,2) NOT NULL DEFAULT 0,
  cycle_id BIGINT NOT NULL,
  includes_daily_delivery TINYINT(1) NOT NULL DEFAULT 1,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
  FOREIGN KEY (cycle_id) REFERENCES subscription_cycles(id)
);
CREATE INDEX idx_subscription_plans_restaurant ON subscription_plans(restaurant_id);
CREATE INDEX idx_subscription_plans_cycle ON subscription_plans(cycle_id);

CREATE TABLE subscription_plan_items (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  plan_id BIGINT NOT NULL,
  menu_item_id BIGINT NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE CASCADE,
  FOREIGN KEY (menu_item_id) REFERENCES menu_items(id),
  UNIQUE KEY uk_plan_menu_item (plan_id, menu_item_id)
);
CREATE INDEX idx_subscription_plan_items_plan ON subscription_plan_items(plan_id);

CREATE TABLE restaurant_delivery_partner_profiles (
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

CREATE TABLE partner_employee_id_counters (
  restaurant_id BIGINT PRIMARY KEY,
  letter_series CHAR(2) NOT NULL DEFAULT 'AA',
  next_number INT NOT NULL DEFAULT 1,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
);

CREATE TABLE subscription_subscribers (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  restaurant_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  plan_id BIGINT NULL,
  phone VARCHAR(20) NOT NULL,
  address TEXT NULL,
  pincode VARCHAR(12) NULL,
  alt_phone VARCHAR(20) NULL,
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

CREATE TABLE subscription_renewals (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  restaurant_id BIGINT NOT NULL,
  subscriber_id BIGINT NOT NULL,
  previous_plan_id BIGINT NULL,
  new_plan_id BIGINT NOT NULL,
  previous_status ENUM('ACTIVE','PAUSED','CANCELLED') NULL,
  new_status ENUM('ACTIVE','PAUSED','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
  notes VARCHAR(500) NULL,
  renewed_by_user_id BIGINT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
  FOREIGN KEY (subscriber_id) REFERENCES subscription_subscribers(id),
  FOREIGN KEY (previous_plan_id) REFERENCES subscription_plans(id),
  FOREIGN KEY (new_plan_id) REFERENCES subscription_plans(id),
  FOREIGN KEY (renewed_by_user_id) REFERENCES users(id)
);
CREATE INDEX idx_subscription_renewals_subscriber ON subscription_renewals(subscriber_id);
CREATE INDEX idx_subscription_renewals_restaurant ON subscription_renewals(restaurant_id);

CREATE TABLE subscription_plan_payments (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  restaurant_id BIGINT NOT NULL,
  subscriber_id BIGINT NOT NULL,
  plan_id BIGINT NOT NULL,
  renewal_id BIGINT NULL,
  plan_price DECIMAL(10,2) NOT NULL,
  collection_type ENUM('ADVANCE','PARTIAL','FULL') NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  balance_due DECIMAL(10,2) NOT NULL DEFAULT 0,
  payment_method ENUM('COD','ONLINE') NOT NULL,
  payment_provider VARCHAR(40) NULL,
  payment_status ENUM('PENDING','PAID','FAILED') NOT NULL DEFAULT 'PENDING',
  gateway_reference VARCHAR(120) NULL,
  gateway_order_id VARCHAR(120) NULL,
  created_by_user_id BIGINT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
  FOREIGN KEY (subscriber_id) REFERENCES subscription_subscribers(id),
  FOREIGN KEY (plan_id) REFERENCES subscription_plans(id),
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);
CREATE INDEX idx_sub_plan_payments_subscriber ON subscription_plan_payments(subscriber_id);
CREATE INDEX idx_sub_plan_payments_plan ON subscription_plan_payments(plan_id);
