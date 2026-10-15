CREATE TABLE migration_sales_references (
  business_id BIGINT UNSIGNED NOT NULL,
  source_business_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_sale_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_sale_id VARCHAR(100) NULL,
  fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sale_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (business_id, source_business_key, source_sale_key),
  UNIQUE KEY uq_migration_sales_sale (business_id, sale_id),
  KEY idx_migration_sales_fingerprint (business_id, source_business_key, fingerprint),
  CONSTRAINT fk_migration_sales_reference_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_migration_sales_reference_sale
    FOREIGN KEY (business_id, sale_id) REFERENCES sales (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;
