-- READ ONLY: SELECT and INFORMATION_SCHEMA only. Run against the expected production DB.
SELECT DATABASE() AS selected_database;

SELECT version, file_name, checksum, status,
       CASE version
         WHEN '021' THEN checksum = 'd412cd557dc1359c6000a6b4cd9d6edc64ccb5e229e87e4a41e411cc0b68f93c'
         WHEN '022' THEN checksum = '5db367fcc9c65c7e48e79bf324138f1af0213e3cb80732ef74b1209f378e0157'
         ELSE NULL
       END AS matches_operator_verified_checksum
FROM schema_migrations
WHERE version IN ('021', '022', '023', '024', '025')
ORDER BY version;

SELECT COUNT(*) AS migration_023_ledger_rows
FROM schema_migrations
WHERE version = '023';

SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_name IN (
    'product_categories',
    'user_module_permission_profiles',
    'user_module_permissions',
    'sale_order_inventory_reservations'
  )
ORDER BY table_name;

SELECT table_name, column_name, column_type, is_nullable
FROM information_schema.columns
WHERE table_schema = DATABASE()
  AND table_name = 'product_categories'
ORDER BY ordinal_position;

SELECT table_name, index_name, non_unique, seq_in_index, column_name
FROM information_schema.statistics
WHERE table_schema = DATABASE()
  AND table_name = 'product_categories'
ORDER BY index_name, seq_in_index;

SELECT o.business_id,
       COUNT(DISTINCT o.id) AS pending_orders,
       COUNT(i.product_id) AS pending_order_lines,
       MIN(o.created_at) AS oldest_pending_order_at,
       MAX(o.created_at) AS newest_pending_order_at
FROM sale_orders o
LEFT JOIN sale_order_items i
  ON i.business_id = o.business_id AND i.order_id = o.id
WHERE o.status = 'PENDING'
  AND COALESCE(o.is_historical, FALSE) = FALSE
GROUP BY o.business_id
ORDER BY o.business_id;

WITH pending_product_units AS (
  SELECT o.business_id, i.product_id, SUM(i.quantity) AS pending_units
  FROM sale_orders o
  JOIN sale_order_items i
    ON i.business_id = o.business_id AND i.order_id = o.id
  WHERE o.status = 'PENDING'
    AND COALESCE(o.is_historical, FALSE) = FALSE
  GROUP BY o.business_id, i.product_id
)
SELECT COUNT(*) AS products_with_pending_orders,
       COALESCE(SUM(CASE WHEN pending.pending_units > p.stock THEN 1 ELSE 0 END), 0) AS products_already_overcommitted,
       COALESCE(SUM(GREATEST(pending.pending_units - p.stock, 0)), 0) AS excess_pending_units
FROM pending_product_units pending
JOIN products p
  ON p.business_id = pending.business_id AND p.id = pending.product_id;

SELECT COUNT(DISTINCT o.id) AS pending_orders_with_missing_product_rows
FROM sale_orders o
JOIN sale_order_items i
  ON i.business_id = o.business_id AND i.order_id = o.id
LEFT JOIN products p
  ON p.business_id = i.business_id AND p.id = i.product_id
WHERE o.status = 'PENDING'
  AND COALESCE(o.is_historical, FALSE) = FALSE
  AND p.id IS NULL;
