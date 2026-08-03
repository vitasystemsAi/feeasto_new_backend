-- Platform-wide category catalog (deduped display + sort for customer home & super admin)

CREATE TABLE IF NOT EXISTS platform_category_catalog (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  category_key VARCHAR(120) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  image_url VARCHAR(500) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_platform_category_key (category_key)
);

CREATE INDEX idx_platform_category_sort ON platform_category_catalog (is_active, sort_order, display_name);
