-- Stores vendor ordering/unit configuration as JSON:
-- { orderingMode, defaultUnit, allowedUnits, portionOptions, orderFlow }
ALTER TABLE restaurants ADD COLUMN vendor_config JSON NULL AFTER business_type_label;
