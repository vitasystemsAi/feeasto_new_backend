-- Structured Indian addresses + saved customer addresses + ad geo targeting

ALTER TABLE restaurants
  ADD COLUMN address_village VARCHAR(120) NULL AFTER address,
  ADD COLUMN address_city VARCHAR(120) NULL AFTER address_village,
  ADD COLUMN address_district VARCHAR(120) NULL AFTER address_city,
  ADD COLUMN address_state VARCHAR(120) NULL AFTER address_district,
  ADD COLUMN address_country VARCHAR(80) NOT NULL DEFAULT 'India' AFTER address_state,
  ADD COLUMN address_pincode VARCHAR(12) NULL AFTER address_country;

ALTER TABLE users
  ADD COLUMN home_village VARCHAR(120) NULL AFTER home_address,
  ADD COLUMN home_city VARCHAR(120) NULL AFTER home_village,
  ADD COLUMN home_district VARCHAR(120) NULL AFTER home_city,
  ADD COLUMN home_state VARCHAR(120) NULL AFTER home_district,
  ADD COLUMN home_country VARCHAR(80) NOT NULL DEFAULT 'India' AFTER home_state,
  ADD COLUMN home_pincode VARCHAR(12) NULL AFTER home_country;

CREATE TABLE IF NOT EXISTS customer_saved_addresses (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  label ENUM('HOME','OFFICE','OTHER') NOT NULL DEFAULT 'HOME',
  village VARCHAR(120) NULL,
  city VARCHAR(120) NOT NULL,
  district VARCHAR(120) NOT NULL,
  state VARCHAR(120) NOT NULL,
  country VARCHAR(80) NOT NULL DEFAULT 'India',
  pincode VARCHAR(12) NOT NULL,
  address_line VARCHAR(500) NULL,
  latitude DECIMAL(10,7) NULL,
  longitude DECIMAL(10,7) NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_customer_saved_addresses_user (user_id)
);

ALTER TABLE advertisements
  ADD COLUMN target_pincode VARCHAR(12) NULL AFTER menu_item_id,
  ADD COLUMN target_district VARCHAR(120) NULL AFTER target_pincode,
  ADD COLUMN target_radius_km DECIMAL(5,2) NULL DEFAULT 15 AFTER target_district;
