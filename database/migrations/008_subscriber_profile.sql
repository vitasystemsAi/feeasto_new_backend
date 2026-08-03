-- Subscriber contact profile + optional plan until assigned
ALTER TABLE subscription_subscribers
  MODIFY plan_id BIGINT NULL,
  ADD COLUMN address TEXT NULL AFTER phone,
  ADD COLUMN pincode VARCHAR(12) NULL AFTER address,
  ADD COLUMN alt_phone VARCHAR(20) NULL AFTER pincode;
