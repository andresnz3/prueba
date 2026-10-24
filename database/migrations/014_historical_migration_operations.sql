-- Mark imported historical rows so their original values remain queryable without
-- changing current cash, inventory, payable, or order workflows.
-- Additive only: existing rows default to operational (FALSE), preserving data.
ALTER TABLE cash_sessions
  ADD COLUMN is_historical TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN source_opened_by VARCHAR(180) NULL,
  ADD COLUMN source_closed_by VARCHAR(180) NULL;

ALTER TABLE cash_movements
  ADD COLUMN is_historical TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN source_actor VARCHAR(180) NULL,
  ADD COLUMN source_status VARCHAR(32) NULL;

ALTER TABLE inventory_movements
  ADD COLUMN is_historical TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN source_actor VARCHAR(180) NULL;

ALTER TABLE expenses
  ADD COLUMN is_historical TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN source_actor VARCHAR(180) NULL,
  ADD COLUMN source_method VARCHAR(32) NULL;

ALTER TABLE supplier_payments
  ADD COLUMN is_historical TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN source_actor VARCHAR(180) NULL,
  ADD COLUMN source_cancelled_by VARCHAR(180) NULL;

ALTER TABLE sales
  ADD COLUMN source_actor VARCHAR(180) NULL,
  ADD COLUMN source_cancelled_by VARCHAR(180) NULL;

ALTER TABLE customer_payments
  ADD COLUMN source_actor VARCHAR(180) NULL,
  ADD COLUMN source_cancelled_by VARCHAR(180) NULL;

ALTER TABLE purchases
  ADD COLUMN source_actor VARCHAR(180) NULL,
  ADD COLUMN source_cancelled_by VARCHAR(180) NULL;

ALTER TABLE expenses
  ADD COLUMN source_cancelled_by VARCHAR(180) NULL;

ALTER TABLE cash_sessions
  ADD COLUMN source_status VARCHAR(20) NULL;

ALTER TABLE cash_movements
  ADD COLUMN source_reference_type VARCHAR(40) NULL,
  ADD COLUMN source_reference_id VARCHAR(100) NULL,
  ADD COLUMN source_method VARCHAR(32) NULL;

ALTER TABLE inventory_movements
  ADD COLUMN source_reference_type VARCHAR(40) NULL,
  ADD COLUMN source_reference_id VARCHAR(100) NULL;

ALTER TABLE sale_orders
  ADD COLUMN is_historical TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN source_actor VARCHAR(180) NULL,
  ADD COLUMN source_cancelled_by VARCHAR(180) NULL,
  ADD COLUMN source_completed_by VARCHAR(180) NULL;

CREATE TABLE migration_supplier_payment_references (
  business_id BIGINT UNSIGNED NOT NULL,
  source_business_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_payment_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_payment_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  supplier_payment_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (business_id, source_business_key, source_payment_key),
  UNIQUE KEY uq_migration_supplier_payment_target (business_id, supplier_payment_id),
  KEY idx_migration_supplier_payment_source_id (business_id, source_business_key, source_payment_id),
  CONSTRAINT fk_migration_supplier_payment_reference_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_migration_supplier_payment_reference_payment
    FOREIGN KEY (business_id, supplier_payment_id) REFERENCES supplier_payments (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;
