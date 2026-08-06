-- Table QR self-ordering: unique token per table, guest name on orders, customer CRM store.

ALTER TABLE restaurant_tables
  ADD COLUMN qr_token VARCHAR(64) NULL AFTER status;

CREATE UNIQUE INDEX uq_restaurant_tables_qr_token ON restaurant_tables(qr_token);

ALTER TABLE orders
  ADD COLUMN guest_name VARCHAR(120) NULL AFTER customer_contact_phone;

CREATE TABLE IF NOT EXISTS restaurant_table_customers (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id BIGINT NOT NULL,
  restaurant_id BIGINT NOT NULL,
  full_name VARCHAR(120) NOT NULL,
  phone VARCHAR(15) NOT NULL,
  visit_count INT NOT NULL DEFAULT 1,
  last_table_id BIGINT NULL,
  last_order_id BIGINT NULL,
  first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_table_customers_restaurant_phone (restaurant_id, phone),
  KEY idx_table_customers_tenant (tenant_id),
  KEY idx_table_customers_restaurant (restaurant_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
);
