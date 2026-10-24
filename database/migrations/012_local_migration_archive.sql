CREATE TABLE migration_import_batches (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_id BIGINT UNSIGNED NOT NULL,
  source_business_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_business_name VARCHAR(160) NOT NULL,
  package_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  package_version TINYINT UNSIGNED NOT NULL,
  status ENUM('ARCHIVING', 'ARCHIVED', 'PROJECTING', 'BLOCKED', 'COMPLETED') NOT NULL,
  current_stage VARCHAR(40) NULL,
  actor_business_id BIGINT UNSIGNED NOT NULL,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  manifest JSON NOT NULL,
  stage_results JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_migration_import_source (business_id, source_business_key),
  UNIQUE KEY uq_migration_import_business_id (business_id, id),
  KEY idx_migration_import_status (business_id, status, updated_at),
  CONSTRAINT fk_migration_import_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_migration_import_actor
    FOREIGN KEY (actor_business_id, actor_user_id) REFERENCES users (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE migration_source_records (
  business_id BIGINT UNSIGNED NOT NULL,
  batch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  entity_type VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_record_key VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  source_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  record_status ENUM('ARCHIVED', 'PROJECTED', 'PENDING', 'EXCLUDED') NOT NULL DEFAULT 'ARCHIVED',
  target_table VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  target_record_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NULL,
  source_actor VARCHAR(180) NULL,
  pending_reason VARCHAR(500) NULL,
  source_payload JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (business_id, batch_id, entity_type, source_record_key),
  KEY idx_migration_source_record_status (business_id, batch_id, record_status, entity_type),
  KEY idx_migration_source_record_fingerprint (business_id, batch_id, entity_type, source_fingerprint),
  CONSTRAINT fk_migration_source_record_batch
    FOREIGN KEY (business_id, batch_id) REFERENCES migration_import_batches (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;
