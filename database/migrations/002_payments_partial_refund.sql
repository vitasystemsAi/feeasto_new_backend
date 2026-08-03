-- Partial refunds: track cumulative refunded amount per payment row.
-- Run once against existing DBs (idempotent-ish: may error if column exists).

ALTER TABLE payments
  ADD COLUMN refunded_cumulative DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER amount;

ALTER TABLE payments
  MODIFY COLUMN payment_status ENUM('PENDING','PAID','FAILED','REFUNDED','PARTIALLY_REFUNDED') NOT NULL DEFAULT 'PENDING';
