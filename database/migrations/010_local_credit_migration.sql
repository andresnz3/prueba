ALTER TABLE sales
  ADD COLUMN is_historical TINYINT(1) NOT NULL DEFAULT 0 AFTER status,
  ADD KEY idx_sales_business_historical_credit (business_id, sale_type, is_historical, status);

ALTER TABLE customer_payments
  ADD COLUMN is_historical TINYINT(1) NOT NULL DEFAULT 0 AFTER status,
  ADD COLUMN source_status VARCHAR(100) NULL AFTER is_historical,
  ADD KEY idx_customer_payments_business_historical (business_id, is_historical, status);

ALTER TABLE migration_sales_references
  ADD COLUMN source_client_id VARCHAR(100) NULL AFTER source_sale_id,
  ADD COLUMN source_invoice_number VARCHAR(100) NULL AFTER sale_id;

CREATE TABLE migration_credit_payment_references (
  business_id BIGINT UNSIGNED NOT NULL,
  source_business_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_payment_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_payment_id VARCHAR(100) NOT NULL,
  source_client_id VARCHAR(100) NOT NULL,
  source_sale_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  customer_payment_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (business_id, source_business_key, source_payment_key, source_sale_key),
  UNIQUE KEY uq_migration_credit_payment (business_id, customer_payment_id),
  KEY idx_migration_credit_payment_source (business_id, source_business_key, source_payment_id),
  CONSTRAINT fk_migration_credit_payment_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_migration_credit_payment_record
    FOREIGN KEY (business_id, customer_payment_id) REFERENCES customer_payments (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;
