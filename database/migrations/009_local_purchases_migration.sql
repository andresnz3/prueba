ALTER TABLE purchases
  ADD COLUMN discount DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER subtotal,
  ADD COLUMN notes VARCHAR(500) NULL AFTER cancel_reason,
  ADD COLUMN is_historical TINYINT(1) NOT NULL DEFAULT 0 AFTER status,
  ADD CONSTRAINT chk_purchases_discount CHECK (discount >= 0 AND discount <= subtotal);

ALTER TABLE purchase_items
  ADD COLUMN discount DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER subtotal,
  ADD COLUMN tax DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER discount,
  ADD CONSTRAINT chk_purchase_items_history_amounts CHECK (discount >= 0 AND tax >= 0 AND discount <= subtotal);

CREATE TABLE migration_purchase_references (
  business_id BIGINT UNSIGNED NOT NULL,
  source_business_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_purchase_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_purchase_id VARCHAR(100) NULL,
  fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  purchase_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (business_id, source_business_key, source_purchase_key),
  UNIQUE KEY uq_migration_purchases_purchase (business_id, purchase_id),
  KEY idx_migration_purchases_fingerprint (business_id, source_business_key, fingerprint),
  CONSTRAINT fk_migration_purchases_reference_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_migration_purchases_reference_purchase
    FOREIGN KEY (business_id, purchase_id) REFERENCES purchases (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;
