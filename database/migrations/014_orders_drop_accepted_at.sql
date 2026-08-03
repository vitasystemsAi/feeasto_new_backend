-- accepted_at is unused; cancel window is based on created_at only.
ALTER TABLE orders DROP COLUMN accepted_at;
