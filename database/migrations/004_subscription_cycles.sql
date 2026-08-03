-- Subscription billing/delivery cycles (master data per restaurant)
CREATE TABLE IF NOT EXISTS subscription_cycles (
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
