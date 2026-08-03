CREATE TABLE IF NOT EXISTS subscription_plan_payments (
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
