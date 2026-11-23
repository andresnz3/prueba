CREATE TABLE user_module_permission_profiles (
  business_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (business_id, user_id),
  CONSTRAINT fk_user_module_permission_profile_user
    FOREIGN KEY (business_id, user_id) REFERENCES users (business_id, id)
    ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE user_module_permissions (
  business_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  module_code VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (business_id, user_id, module_code),
  CONSTRAINT chk_user_module_permissions_code CHECK (module_code IN (
    'sales', 'inventory', 'purchases', 'payables', 'clients', 'suppliers',
    'history', 'cash', 'expenses', 'reports', 'dashboard', 'settings'
  )),
  CONSTRAINT fk_user_module_permissions_profile
    FOREIGN KEY (business_id, user_id) REFERENCES user_module_permission_profiles (business_id, user_id)
    ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB;
