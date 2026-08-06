-- Daily takeaway/counter token numbers (reset each calendar day at midnight IST).
ALTER TABLE orders
  ADD COLUMN token_number INT NULL DEFAULT NULL AFTER order_type;

CREATE INDEX idx_orders_restaurant_token_date ON orders (restaurant_id, created_at, token_number);

CREATE TABLE IF NOT EXISTS restaurant_daily_tokens (
  restaurant_id BIGINT NOT NULL,
  token_date DATE NOT NULL,
  next_token INT NOT NULL DEFAULT 1,
  PRIMARY KEY (restaurant_id, token_date),
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
);
