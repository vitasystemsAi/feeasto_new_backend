USE restaurant_saas;

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
