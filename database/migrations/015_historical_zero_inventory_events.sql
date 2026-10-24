-- Preserve zero-quantity local inventory events for audit/Kardex display.
-- These events are kept separately so they cannot affect stock calculations.
CREATE TABLE migration_zero_inventory_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  batch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_record_key VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  source_type VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  quantity DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  stock_after DECIMAL(12,3) NULL,
  unit_cost DECIMAL(12,2) NULL,
  reason VARCHAR(500) NULL,
  source_actor VARCHAR(180) NULL,
  source_reference_type VARCHAR(40) NULL,
  source_reference_id VARCHAR(100) NULL,
  source_payload JSON NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_migration_zero_inventory_source (business_id, batch_id, source_record_key),
  KEY idx_migration_zero_inventory_kardex (business_id, product_id, occurred_at, id),
  CONSTRAINT chk_migration_zero_inventory_quantity CHECK (quantity = 0.000),
  CONSTRAINT fk_migration_zero_inventory_batch
    FOREIGN KEY (business_id, batch_id) REFERENCES migration_import_batches (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_migration_zero_inventory_product
    FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;
