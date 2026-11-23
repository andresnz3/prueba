ALTER TABLE sales
  ADD COLUMN customer_name VARCHAR(160) NULL AFTER client_id;

ALTER TABLE sale_orders
  ADD COLUMN customer_name VARCHAR(160) NULL AFTER client_id;

UPDATE sales s
LEFT JOIN clients c ON c.business_id = s.business_id AND c.id = s.client_id
SET s.customer_name = c.name
WHERE s.client_id IS NOT NULL AND s.customer_name IS NULL;

UPDATE sale_orders o
LEFT JOIN clients c ON c.business_id = o.business_id AND c.id = o.client_id
SET o.customer_name = c.name
WHERE o.client_id IS NOT NULL AND o.customer_name IS NULL;
