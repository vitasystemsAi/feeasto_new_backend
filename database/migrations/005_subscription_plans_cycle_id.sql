-- Link subscription plans to master-data cycles (replaces billing_cycle enum usage)
ALTER TABLE subscription_plans
  ADD COLUMN cycle_id BIGINT NULL AFTER price,
  ADD INDEX idx_subscription_plans_cycle (cycle_id);

ALTER TABLE subscription_plans
  ADD CONSTRAINT fk_subscription_plans_cycle
  FOREIGN KEY (cycle_id) REFERENCES subscription_cycles(id);
