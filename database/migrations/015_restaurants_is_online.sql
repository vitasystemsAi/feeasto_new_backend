ALTER TABLE restaurants
  ADD COLUMN is_online TINYINT(1) NOT NULL DEFAULT 1 AFTER is_active;
