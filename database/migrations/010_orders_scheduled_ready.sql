ALTER TABLE orders
  ADD COLUMN scheduled_delivery_date DATE NULL AFTER status,
  ADD COLUMN scheduled_delivery_time VARCHAR(5) NULL AFTER scheduled_delivery_date;

ALTER TABLE orders
  MODIFY status ENUM(
    'PLACED',
    'ACCEPTED',
    'PREPARING',
    'READY',
    'OUT_FOR_DELIVERY',
    'DELIVERED',
    'CANCELLED'
  ) NOT NULL DEFAULT 'PLACED';

CREATE INDEX idx_orders_scheduled_date ON orders(scheduled_delivery_date);
