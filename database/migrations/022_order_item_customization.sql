ALTER TABLE order_items
  ADD COLUMN customization_json JSON NULL AFTER unit_price;
