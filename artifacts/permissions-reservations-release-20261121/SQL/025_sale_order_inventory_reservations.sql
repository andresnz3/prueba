CREATE TABLE sale_order_inventory_reservations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  order_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  quantity DECIMAL(12,3) NOT NULL,
  status ENUM('RESERVED','CONSUMED','RELEASED') NOT NULL DEFAULT 'RESERVED',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sale_order_inventory_reservation_line (business_id, order_id, product_id),
  KEY ix_sale_order_inventory_reservation_product (business_id, product_id, status, order_id),
  CONSTRAINT chk_sale_order_inventory_reservation_quantity CHECK (quantity > 0),
  CONSTRAINT fk_sale_order_inventory_reservation_order FOREIGN KEY (business_id, order_id) REFERENCES sale_orders (business_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_sale_order_inventory_reservation_product FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;
