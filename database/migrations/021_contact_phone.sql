ALTER TABLE customer_saved_addresses
  ADD COLUMN contact_phone VARCHAR(15) NOT NULL DEFAULT '' AFTER contact_name;

ALTER TABLE orders
  ADD COLUMN customer_contact_phone VARCHAR(15) NULL AFTER delivery_longitude;
