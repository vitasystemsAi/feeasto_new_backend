-- Add business_type to restaurants table to support universal vendor types
-- Vendors: restaurant, chicken_shop, mutton_shop, vegetables_shop, fruits_shop, bakery, grocery, dairy, fish_shop, sweets_shop, juice_bar, cafe, other

ALTER TABLE restaurants ADD COLUMN business_type VARCHAR(50) NOT NULL DEFAULT 'restaurant' AFTER name;
ALTER TABLE restaurants ADD COLUMN business_type_label VARCHAR(100) NULL AFTER business_type;
