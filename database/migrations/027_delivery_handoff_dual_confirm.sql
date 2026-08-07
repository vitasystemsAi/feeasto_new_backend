-- Dual confirmation before "On the way": restaurant handoff + partner pickup.
-- Applied automatically on API boot via ensureDeliveryHandoffSchema.js
-- Manual (MySQL 8+ without IF NOT EXISTS support): run one column at a time if needed.

ALTER TABLE deliveries ADD COLUMN restaurant_handoff_at DATETIME NULL;
ALTER TABLE deliveries ADD COLUMN partner_pickup_at DATETIME NULL;
ALTER TABLE restaurant_delivery_partner_profiles ADD COLUMN vehicle_number VARCHAR(40) NULL;
