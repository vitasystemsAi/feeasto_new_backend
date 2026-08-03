-- Restaurant, customer, and order delivery coordinates
ALTER TABLE restaurants
  ADD COLUMN latitude DECIMAL(10, 7) NULL AFTER address,
  ADD COLUMN longitude DECIMAL(10, 7) NULL AFTER latitude;

ALTER TABLE users
  ADD COLUMN home_address TEXT NULL AFTER email,
  ADD COLUMN home_latitude DECIMAL(10, 7) NULL AFTER home_address,
  ADD COLUMN home_longitude DECIMAL(10, 7) NULL AFTER home_latitude;

ALTER TABLE orders
  ADD COLUMN delivery_address TEXT NULL AFTER order_type,
  ADD COLUMN delivery_latitude DECIMAL(10, 7) NULL AFTER delivery_address,
  ADD COLUMN delivery_longitude DECIMAL(10, 7) NULL AFTER delivery_latitude;
