CREATE TABLE business_migration_controls (
  business_id BIGINT UNSIGNED NOT NULL,
  state ENUM('PENDING', 'COMPLETE') NOT NULL DEFAULT 'PENDING',
  source_business_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  batch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  actor_business_id BIGINT UNSIGNED NOT NULL,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  PRIMARY KEY (business_id),
  KEY idx_business_migration_control_state (state, created_at),
  CONSTRAINT chk_business_migration_control_state CHECK (
    (state = 'PENDING' AND completed_at IS NULL) OR
    (state = 'COMPLETE' AND completed_at IS NOT NULL AND batch_id IS NOT NULL AND source_business_key IS NOT NULL)
  ),
  CONSTRAINT fk_business_migration_control_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_business_migration_control_actor
    FOREIGN KEY (actor_business_id, actor_user_id) REFERENCES users (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_business_migration_control_batch
    FOREIGN KEY (business_id, batch_id) REFERENCES migration_import_batches (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;
