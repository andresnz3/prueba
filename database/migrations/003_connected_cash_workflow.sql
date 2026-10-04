-- Connected cash workflow: non-cash reconciliation and optional cashier queue.
-- Apply only after explicit approval. Never modify database/schema.sql.
ALTER TABLE businesses
  ADD COLUMN sales_flow ENUM('DIRECT', 'CENTRALIZED') NOT NULL DEFAULT 'DIRECT';

ALTER TABLE sales
  ADD COLUMN cashier_user_id BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_sales_cashier FOREIGN KEY (business_id, cashier_user_id)
    REFERENCES users (business_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE cash_movements
  ADD COLUMN confirmed_by_user_id BIGINT UNSIGNED NULL,
  ADD COLUMN confirmed_at DATETIME(3) NULL,
  ADD CONSTRAINT fk_cash_movement_confirmed_by FOREIGN KEY (business_id, confirmed_by_user_id)
    REFERENCES users (business_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE sale_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  created_by_user_id BIGINT UNSIGNED NOT NULL,
  status ENUM('PENDING', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
  sale_id BIGINT UNSIGNED NULL,
  price_type ENUM('RETAIL', 'WHOLESALE') NOT NULL,
  discount_percent DECIMAL(7,4) NOT NULL,
  estimated_subtotal DECIMAL(12,2) NOT NULL,
  estimated_discount DECIMAL(12,2) NOT NULL,
  estimated_total DECIMAL(12,2) NOT NULL,
  detail VARCHAR(500) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  completed_by_user_id BIGINT UNSIGNED NULL,
  cancelled_at DATETIME(3) NULL,
  cancelled_by_user_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (business_id, id),
  UNIQUE KEY uq_sale_orders_global_id (id),
  KEY ix_sale_orders_queue (business_id, status, id),
  CONSTRAINT fk_sale_orders_business FOREIGN KEY (business_id)
    REFERENCES businesses (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_sale_orders_creator FOREIGN KEY (business_id, created_by_user_id)
    REFERENCES users (business_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_sale_orders_completed_by FOREIGN KEY (business_id, completed_by_user_id)
    REFERENCES users (business_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_sale_orders_cancelled_by FOREIGN KEY (business_id, cancelled_by_user_id)
    REFERENCES users (business_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_sale_orders_sale FOREIGN KEY (business_id, sale_id)
    REFERENCES sales (business_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE sale_order_items (
  business_id BIGINT UNSIGNED NOT NULL,
  order_id BIGINT UNSIGNED NOT NULL,
  line_number SMALLINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  product_name VARCHAR(160) NOT NULL,
  barcode VARCHAR(64) NULL,
  quantity DECIMAL(12,3) NOT NULL,
  estimated_unit_price DECIMAL(12,2) NOT NULL,
  estimated_subtotal DECIMAL(12,2) NOT NULL,
  PRIMARY KEY (business_id, order_id, line_number),
  CONSTRAINT fk_sale_order_items_order FOREIGN KEY (business_id, order_id)
    REFERENCES sale_orders (business_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_sale_order_items_product FOREIGN KEY (business_id, product_id)
    REFERENCES products (business_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;
