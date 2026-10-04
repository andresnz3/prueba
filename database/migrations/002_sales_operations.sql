-- Apply explicitly after migration 001. Never changes database/schema.sql.
CREATE TABLE pos_operations (
  business_id BIGINT UNSIGNED NOT NULL,
  operation_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  kind VARCHAR(24) NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (business_id, operation_key),
  CONSTRAINT fk_pos_operations_user FOREIGN KEY (business_id, user_id)
    REFERENCES users (business_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;
ALTER TABLE sales
  ADD COLUMN cash_received DECIMAL(12,2) NULL,
  ADD COLUMN change_amount DECIMAL(12,2) NULL,
  ADD CONSTRAINT chk_sales_tender CHECK (
    (cash_received IS NULL AND change_amount IS NULL)
    OR (cash_received >= total AND change_amount = cash_received - total)
  );
