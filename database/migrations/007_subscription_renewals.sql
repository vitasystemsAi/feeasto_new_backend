CREATE TABLE IF NOT EXISTS subscription_renewals (
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
