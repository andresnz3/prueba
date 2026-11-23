-- READ ONLY: SELECT and INFORMATION_SCHEMA only. Run after migrations, before reopening traffic.
SELECT DATABASE() AS selected_database;

SELECT version, file_name, checksum, status,
       CASE version
         WHEN '021' THEN checksum = 'd412cd557dc1359c6000a6b4cd9d6edc64ccb5e229e87e4a41e411cc0b68f93c'
         WHEN '022' THEN checksum = '5db367fcc9c65c7e48e79bf324138f1af0213e3cb80732ef74b1209f378e0157'
         WHEN '024' THEN checksum = '16d34641e3f03e5eca47c2f6a20ee248a6c781bfa1842ebd9455f172b9ab7e73'
         WHEN '025' THEN checksum = '9ef10f924a17b6a29d14da8353e40f59d0d61847b8a542cecff0499e51a284b0'
         ELSE NULL
       END AS matches_expected_checksum
FROM schema_migrations
WHERE version IN ('021', '022', '023', '024', '025')
ORDER BY version;

SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_name IN (
    'user_module_permission_profiles',
    'user_module_permissions',
    'sale_order_inventory_reservations'
  )
ORDER BY table_name;

SELECT table_name, column_name, column_type, is_nullable
FROM information_schema.columns
WHERE table_schema = DATABASE()
  AND table_name IN (
    'user_module_permission_profiles',
    'user_module_permissions',
    'sale_order_inventory_reservations'
  )
ORDER BY table_name, ordinal_position;

SELECT table_name, index_name, non_unique, seq_in_index, column_name
FROM information_schema.statistics
WHERE table_schema = DATABASE()
  AND table_name IN (
    'product_categories',
    'user_module_permission_profiles',
    'user_module_permissions',
    'sale_order_inventory_reservations'
  )
ORDER BY table_name, index_name, seq_in_index;

SELECT status, COUNT(*) AS reservation_lines
FROM sale_order_inventory_reservations
GROUP BY status
ORDER BY status;

SELECT COUNT(*) AS pending_explicit_reservation_orders
FROM sale_orders o
WHERE o.status = 'PENDING'
  AND COALESCE(o.is_historical, FALSE) = FALSE
  AND EXISTS (
    SELECT 1 FROM sale_order_inventory_reservations r
    WHERE r.business_id = o.business_id AND r.order_id = o.id
  );

SELECT COUNT(*) AS pending_legacy_virtual_orders
FROM sale_orders o
WHERE o.status = 'PENDING'
  AND COALESCE(o.is_historical, FALSE) = FALSE
  AND NOT EXISTS (
    SELECT 1 FROM sale_order_inventory_reservations r
    WHERE r.business_id = o.business_id AND r.order_id = o.id
  );

SELECT COUNT(*) AS pending_orders_with_inconsistent_explicit_reservations
FROM sale_orders o
WHERE o.status = 'PENDING'
  AND COALESCE(o.is_historical, FALSE) = FALSE
  AND EXISTS (
    SELECT 1 FROM sale_order_inventory_reservations r
    WHERE r.business_id = o.business_id AND r.order_id = o.id
  )
  AND (
    EXISTS (
      SELECT 1
      FROM sale_order_items i
      LEFT JOIN sale_order_inventory_reservations r
        ON r.business_id = i.business_id AND r.order_id = i.order_id AND r.product_id = i.product_id
      WHERE i.business_id = o.business_id AND i.order_id = o.id
        AND (r.id IS NULL OR r.status <> 'RESERVED' OR r.quantity <> i.quantity)
    )
    OR EXISTS (
      SELECT 1
      FROM sale_order_inventory_reservations r
      LEFT JOIN sale_order_items i
        ON i.business_id = r.business_id AND i.order_id = r.order_id AND i.product_id = r.product_id
      WHERE r.business_id = o.business_id AND r.order_id = o.id AND i.product_id IS NULL
    )
  );

SELECT COUNT(*) AS reserved_lines_without_pending_order
FROM sale_order_inventory_reservations r
JOIN sale_orders o
  ON o.business_id = r.business_id AND o.id = r.order_id
WHERE r.status = 'RESERVED'
  AND (o.status <> 'PENDING' OR COALESCE(o.is_historical, FALSE) = TRUE);

WITH holds AS (
  SELECT business_id, product_id, quantity AS held_units
  FROM sale_order_inventory_reservations
  WHERE status = 'RESERVED'
  UNION ALL
  SELECT o.business_id, i.product_id, i.quantity AS held_units
  FROM sale_orders o
  JOIN sale_order_items i
    ON i.business_id = o.business_id AND i.order_id = o.id
  WHERE o.status = 'PENDING'
    AND COALESCE(o.is_historical, FALSE) = FALSE
    AND NOT EXISTS (
      SELECT 1 FROM sale_order_inventory_reservations r
      WHERE r.business_id = o.business_id AND r.order_id = o.id
    )
), totals AS (
  SELECT business_id, product_id, SUM(held_units) AS held_units
  FROM holds
  GROUP BY business_id, product_id
)
SELECT COUNT(*) AS products_with_open_holds,
       COALESCE(SUM(CASE WHEN totals.held_units > p.stock THEN 1 ELSE 0 END), 0) AS products_overcommitted_by_open_holds,
       COALESCE(SUM(GREATEST(totals.held_units - p.stock, 0)), 0) AS excess_open_hold_units
FROM totals
JOIN products p
  ON p.business_id = totals.business_id AND p.id = totals.product_id;
