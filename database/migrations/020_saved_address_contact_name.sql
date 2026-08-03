ALTER TABLE customer_saved_addresses
  ADD COLUMN contact_name VARCHAR(120) NOT NULL DEFAULT '' AFTER label;
