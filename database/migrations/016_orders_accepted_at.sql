ALTER TABLE orders
  ADD COLUMN accepted_at DATETIME NULL DEFAULT NULL AFTER created_at;

UPDATE orders
SET accepted_at = created_at
WHERE status NOT IN ('PLACED', 'CANCELLED') AND accepted_at IS NULL;
