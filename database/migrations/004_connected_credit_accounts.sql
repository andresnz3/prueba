-- Connected customers, receivables, and credit orders. Apply only after explicit approval.
-- Never edit database/schema.sql.
ALTER TABLE clients
  ADD COLUMN credit_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  ADD CONSTRAINT chk_clients_credit_days CHECK (credit_days BETWEEN 1 AND 3650);

ALTER TABLE sale_orders
  ADD COLUMN client_id BIGINT UNSIGNED NULL,
  ADD COLUMN credit_days SMALLINT UNSIGNED NULL,
  ADD CONSTRAINT chk_sale_orders_credit_client CHECK (
    (client_id IS NULL AND credit_days IS NULL)
    OR (client_id IS NOT NULL AND credit_days BETWEEN 1 AND 3650)
  ),
  ADD CONSTRAINT fk_sale_orders_client FOREIGN KEY (business_id, client_id)
    REFERENCES clients (business_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE customer_payments
  MODIFY COLUMN status ENUM('PENDING', 'POSTED', 'VOID') NOT NULL DEFAULT 'POSTED';
