-- Superseded by 014: cancel window uses created_at only. Safe to skip if 014 already applied.
ALTER TABLE orders
  ADD COLUMN accepted_at DATETIME NULL AFTER status;
