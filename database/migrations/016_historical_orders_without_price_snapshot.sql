-- Preserve historical orders whose source never stored per-line prices.
-- Existing rows keep their original non-null values; only explicit unknown
-- snapshots on imported historical orders may use NULL.
ALTER TABLE sale_order_items
  MODIFY COLUMN estimated_unit_price DECIMAL(12,2) NULL,
  MODIFY COLUMN estimated_subtotal DECIMAL(12,2) NULL,
  ADD COLUMN price_snapshot_available TINYINT(1) NOT NULL DEFAULT 1 AFTER estimated_subtotal,
  ADD CONSTRAINT chk_sale_order_item_price_snapshot CHECK (
    (price_snapshot_available = 1 AND estimated_unit_price IS NOT NULL AND estimated_subtotal IS NOT NULL)
    OR
    (price_snapshot_available = 0 AND estimated_unit_price IS NULL AND estimated_subtotal IS NULL)
  );
