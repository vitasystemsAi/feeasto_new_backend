-- Menu items included in each subscription plan (with per-delivery quantities).
CREATE TABLE IF NOT EXISTS subscription_plan_items (
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
