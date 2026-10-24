-- Add the pending state without changing existing supplier payment rows.
-- Keep PENDING at the end so existing ENUM ordinals are not renumbered.
-- Requires migrations 002 and 003 for idempotent writes and cash confirmation metadata.
-- Never modify database/schema.sql.
ALTER TABLE supplier_payments
  MODIFY COLUMN status ENUM('POSTED', 'VOID', 'PENDING') NOT NULL DEFAULT 'POSTED',
  ALGORITHM=INPLACE,
  LOCK=NONE;
