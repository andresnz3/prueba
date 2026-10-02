-- MySQL 8.0+ schema for the multi-business POS.
-- This creates an empty database; no real credentials or sample business data.

CREATE DATABASE IF NOT EXISTS pos_multitenant
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE pos_multitenant;

CREATE TABLE businesses (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(160) NOT NULL,
  phone VARCHAR(40) NULL,
  address VARCHAR(255) NULL,
  status ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_businesses_status (status)
) ENGINE=InnoDB;

CREATE TABLE users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  username VARCHAR(100) NOT NULL,
  full_name VARCHAR(160) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('ADMIN', 'VENDEDOR') NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  last_login_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_business_username (business_id, username),
  UNIQUE KEY uq_users_business_id_id (business_id, id),
  KEY idx_users_business_active (business_id, active),
  CONSTRAINT fk_users_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at DATETIME(3) NULL,
  ip_address VARCHAR(45) NULL,
  user_agent VARCHAR(512) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_token_hash (token_hash),
  UNIQUE KEY uq_sessions_business_id_id (business_id, id),
  KEY idx_sessions_user_expiry (business_id, user_id, expires_at),
  KEY idx_sessions_expiry_revoked (expires_at, revoked_at),
  CONSTRAINT fk_sessions_user
    FOREIGN KEY (business_id, user_id) REFERENCES users (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE session_authorizations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  session_id BIGINT UNSIGNED NOT NULL,
  module VARCHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_session_authorizations_session_module (business_id, session_id, module, expires_at),
  KEY idx_session_authorizations_expiry (business_id, expires_at),
  CONSTRAINT fk_session_authorizations_session
    FOREIGN KEY (business_id, session_id) REFERENCES sessions (business_id, id)
    ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  barcode VARCHAR(100) NOT NULL,
  name VARCHAR(180) NOT NULL,
  category VARCHAR(100) NOT NULL,
  cost DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  retail_margin DECIMAL(7,4) NOT NULL DEFAULT 0.0000,
  wholesale_margin DECIMAL(7,4) NOT NULL DEFAULT 0.0000,
  retail_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  wholesale_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  stock DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  min_stock DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  tax_rate DECIMAL(7,4) NOT NULL DEFAULT 0.0000,
  image TEXT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_products_business_barcode (business_id, barcode),
  UNIQUE KEY uq_products_business_id_id (business_id, id),
  KEY idx_products_business_name (business_id, name),
  KEY idx_products_business_category (business_id, category),
  KEY idx_products_business_active (business_id, active, deleted),
  CONSTRAINT chk_products_cost CHECK (cost >= 0),
  CONSTRAINT chk_products_prices CHECK (retail_price >= 0 AND wholesale_price >= 0),
  CONSTRAINT chk_products_stock CHECK (stock >= 0 AND min_stock >= 0),
  CONSTRAINT fk_products_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE clients (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(180) NOT NULL,
  phone VARCHAR(40) NULL,
  ruc VARCHAR(64) NULL,
  address VARCHAR(255) NULL,
  credit_limit DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  opening_balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_clients_business_id_id (business_id, id),
  KEY idx_clients_business_name (business_id, name),
  KEY idx_clients_business_phone (business_id, phone),
  KEY idx_clients_business_active (business_id, active),
  CONSTRAINT chk_clients_balances CHECK (credit_limit >= 0 AND opening_balance >= 0),
  CONSTRAINT fk_clients_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE suppliers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(180) NOT NULL,
  contact VARCHAR(160) NULL,
  phone VARCHAR(40) NULL,
  ruc VARCHAR(64) NULL,
  address VARCHAR(255) NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_suppliers_business_id_id (business_id, id),
  KEY idx_suppliers_business_name (business_id, name),
  KEY idx_suppliers_business_phone (business_id, phone),
  KEY idx_suppliers_business_active (business_id, active),
  CONSTRAINT fk_suppliers_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE cash_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  opened_by BIGINT UNSIGNED NOT NULL,
  opening_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  opened_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  closed_by BIGINT UNSIGNED NULL,
  counted_amount DECIMAL(12,2) NULL,
  expected_amount DECIMAL(12,2) NULL,
  difference DECIMAL(12,2) NULL,
  closed_at DATETIME(3) NULL,
  status ENUM('OPEN', 'CLOSED') NOT NULL DEFAULT 'OPEN',
  PRIMARY KEY (id),
  UNIQUE KEY uq_cash_sessions_business_id_id (business_id, id),
  KEY idx_cash_sessions_business_status_date (business_id, status, opened_at),
  KEY idx_cash_sessions_business_closed_at (business_id, closed_at),
  CONSTRAINT chk_cash_sessions_amounts
    CHECK (
      opening_amount >= 0
      AND (counted_amount IS NULL OR counted_amount >= 0)
      AND (expected_amount IS NULL OR expected_amount >= 0)
    ),
  CONSTRAINT fk_cash_sessions_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_cash_sessions_opened_by
    FOREIGN KEY (business_id, opened_by) REFERENCES users (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_cash_sessions_closed_by
    FOREIGN KEY (business_id, closed_by) REFERENCES users (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE sales (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  client_id BIGINT UNSIGNED NULL,
  cash_session_id BIGINT UNSIGNED NULL,
  invoice_number VARCHAR(64) NOT NULL,
  sale_type ENUM('CASH', 'CREDIT') NOT NULL,
  payment_method ENUM('CASH', 'CARD', 'TRANSFER', 'CREDIT') NOT NULL,
  subtotal DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  discount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  discount_percent DECIMAL(7,4) NOT NULL DEFAULT 0.0000,
  tax DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  status ENUM('COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'COMPLETED',
  cash_status ENUM('NOT_APPLICABLE', 'PENDING', 'CONFIRMED') NOT NULL DEFAULT 'NOT_APPLICABLE',
  sale_price_type ENUM('RETAIL', 'WHOLESALE') NOT NULL DEFAULT 'RETAIL',
  detail VARCHAR(500) NULL,
  due_at DATETIME(3) NULL,
  cancelled_at DATETIME(3) NULL,
  cancelled_by BIGINT UNSIGNED NULL,
  cancel_reason VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sales_business_invoice (business_id, invoice_number),
  UNIQUE KEY uq_sales_business_id_id (business_id, id),
  UNIQUE KEY uq_sales_business_id_client (business_id, id, client_id),
  KEY idx_sales_business_created (business_id, created_at),
  KEY idx_sales_business_user_date (business_id, user_id, created_at),
  KEY idx_sales_business_client_date (business_id, client_id, created_at),
  KEY idx_sales_business_status_date (business_id, status, created_at),
  KEY idx_sales_business_cash_session (business_id, cash_session_id),
  CONSTRAINT chk_sales_amounts CHECK (subtotal >= 0 AND discount >= 0 AND tax >= 0 AND total >= 0),
  CONSTRAINT chk_sales_payment_type CHECK (
    (sale_type = 'CREDIT' AND payment_method = 'CREDIT' AND client_id IS NOT NULL)
    OR
    (sale_type = 'CASH' AND payment_method <> 'CREDIT')
  ),
  CONSTRAINT fk_sales_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_sales_user
    FOREIGN KEY (business_id, user_id) REFERENCES users (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_sales_client
    FOREIGN KEY (business_id, client_id) REFERENCES clients (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_sales_cash_session
    FOREIGN KEY (business_id, cash_session_id) REFERENCES cash_sessions (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_sales_cancelled_by
    FOREIGN KEY (business_id, cancelled_by) REFERENCES users (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE sale_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  sale_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  product_name VARCHAR(180) NOT NULL,
  barcode VARCHAR(100) NULL,
  quantity DECIMAL(12,3) NOT NULL,
  unit_price DECIMAL(12,2) NOT NULL,
  tax_rate DECIMAL(7,4) NOT NULL DEFAULT 0.0000,
  discount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  subtotal DECIMAL(12,2) NOT NULL,
  total DECIMAL(12,2) NOT NULL,
  cost_at_sale DECIMAL(12,2) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sale_items_business_id_id (business_id, id),
  KEY idx_sale_items_business_sale (business_id, sale_id),
  KEY idx_sale_items_business_product (business_id, product_id),
  CONSTRAINT chk_sale_items_values
    CHECK (
      quantity > 0 AND unit_price >= 0 AND discount >= 0
      AND subtotal >= 0 AND total >= 0 AND cost_at_sale >= 0
    ),
  CONSTRAINT fk_sale_items_sale
    FOREIGN KEY (business_id, sale_id) REFERENCES sales (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_sale_items_product
    FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE purchases (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  supplier_id BIGINT UNSIGNED NULL,
  supplier_name VARCHAR(180) NOT NULL,
  invoice_number VARCHAR(100) NOT NULL,
  purchase_type ENUM('CASH', 'CREDIT') NOT NULL,
  subtotal DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  tax DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  due_at DATETIME(3) NULL,
  status ENUM('COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'COMPLETED',
  cancelled_at DATETIME(3) NULL,
  cancelled_by BIGINT UNSIGNED NULL,
  cancel_reason VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_purchases_business_supplier_invoice (business_id, supplier_name, invoice_number),
  UNIQUE KEY uq_purchases_business_id_id (business_id, id),
  UNIQUE KEY uq_purchases_business_id_supplier (business_id, id, supplier_id),
  KEY idx_purchases_business_created (business_id, created_at),
  KEY idx_purchases_business_supplier_date (business_id, supplier_id, created_at),
  KEY idx_purchases_business_status_due (business_id, status, due_at),
  CONSTRAINT chk_purchases_amounts CHECK (subtotal >= 0 AND tax >= 0 AND total >= 0),
  CONSTRAINT fk_purchases_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_purchases_user
    FOREIGN KEY (business_id, user_id) REFERENCES users (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_purchases_supplier
    FOREIGN KEY (business_id, supplier_id) REFERENCES suppliers (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_purchases_cancelled_by
    FOREIGN KEY (business_id, cancelled_by) REFERENCES users (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE purchase_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  purchase_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  product_name VARCHAR(180) NOT NULL,
  quantity DECIMAL(12,3) NOT NULL,
  unit_cost DECIMAL(12,2) NOT NULL,
  subtotal DECIMAL(12,2) NOT NULL,
  total DECIMAL(12,2) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_purchase_items_business_id_id (business_id, id),
  KEY idx_purchase_items_business_purchase (business_id, purchase_id),
  KEY idx_purchase_items_business_product (business_id, product_id),
  CONSTRAINT chk_purchase_items_values
    CHECK (quantity > 0 AND unit_cost >= 0 AND subtotal >= 0 AND total >= 0),
  CONSTRAINT fk_purchase_items_purchase
    FOREIGN KEY (business_id, purchase_id) REFERENCES purchases (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_purchase_items_product
    FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE customer_payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  client_id BIGINT UNSIGNED NOT NULL,
  sale_id BIGINT UNSIGNED NULL,
  cash_session_id BIGINT UNSIGNED NULL,
  amount DECIMAL(12,2) NOT NULL,
  payment_method ENUM('CASH', 'CARD', 'TRANSFER', 'OTHER') NOT NULL,
  status ENUM('POSTED', 'VOID') NOT NULL DEFAULT 'POSTED',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  cancelled_at DATETIME(3) NULL,
  cancelled_by BIGINT UNSIGNED NULL,
  cancel_reason VARCHAR(500) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_payments_business_id_id (business_id, id),
  KEY idx_customer_payments_business_client_date (business_id, client_id, created_at),
  KEY idx_customer_payments_business_sale (business_id, sale_id),
  KEY idx_customer_payments_business_session (business_id, cash_session_id),
  KEY idx_customer_payments_business_status_date (business_id, status, created_at),
  CONSTRAINT chk_customer_payments_amount CHECK (amount > 0),
  CONSTRAINT fk_customer_payments_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_customer_payments_user
    FOREIGN KEY (business_id, user_id) REFERENCES users (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_customer_payments_client
    FOREIGN KEY (business_id, client_id) REFERENCES clients (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_customer_payments_sale_client
    FOREIGN KEY (business_id, sale_id, client_id)
    REFERENCES sales (business_id, id, client_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_customer_payments_cash_session
    FOREIGN KEY (business_id, cash_session_id) REFERENCES cash_sessions (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_customer_payments_cancelled_by
    FOREIGN KEY (business_id, cancelled_by) REFERENCES users (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE supplier_payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  supplier_id BIGINT UNSIGNED NOT NULL,
  purchase_id BIGINT UNSIGNED NULL,
  cash_session_id BIGINT UNSIGNED NULL,
  amount DECIMAL(12,2) NOT NULL,
  payment_method ENUM('CASH', 'CARD', 'TRANSFER', 'OTHER') NOT NULL,
  status ENUM('POSTED', 'VOID') NOT NULL DEFAULT 'POSTED',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  cancelled_at DATETIME(3) NULL,
  cancelled_by BIGINT UNSIGNED NULL,
  cancel_reason VARCHAR(500) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_supplier_payments_business_id_id (business_id, id),
  KEY idx_supplier_payments_business_supplier_date (business_id, supplier_id, created_at),
  KEY idx_supplier_payments_business_purchase (business_id, purchase_id),
  KEY idx_supplier_payments_business_session (business_id, cash_session_id),
  KEY idx_supplier_payments_business_status_date (business_id, status, created_at),
  CONSTRAINT chk_supplier_payments_amount CHECK (amount > 0),
  CONSTRAINT fk_supplier_payments_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_supplier_payments_user
    FOREIGN KEY (business_id, user_id) REFERENCES users (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_supplier_payments_supplier
    FOREIGN KEY (business_id, supplier_id) REFERENCES suppliers (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_supplier_payments_purchase_supplier
    FOREIGN KEY (business_id, purchase_id, supplier_id)
    REFERENCES purchases (business_id, id, supplier_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_supplier_payments_cash_session
    FOREIGN KEY (business_id, cash_session_id) REFERENCES cash_sessions (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_supplier_payments_cancelled_by
    FOREIGN KEY (business_id, cancelled_by) REFERENCES users (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE inventory_movements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  type ENUM(
    'PURCHASE',
    'SALE',
    'WASTE',
    'ADJUSTMENT',
    'SALE_CANCEL',
    'PURCHASE_CANCEL',
    'INITIAL',
    'MANUAL_EDIT'
  ) NOT NULL,
  quantity DECIMAL(12,3) NOT NULL,
  stock_after DECIMAL(12,3) NULL,
  reference_type VARCHAR(40) NULL,
  reference_id BIGINT UNSIGNED NULL,
  reason VARCHAR(500) NULL,
  unit_cost DECIMAL(12,2) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_movements_business_id_id (business_id, id),
  KEY idx_inventory_movements_business_product_date (business_id, product_id, created_at),
  KEY idx_inventory_movements_business_user_date (business_id, user_id, created_at),
  KEY idx_inventory_movements_business_reference (business_id, reference_type, reference_id),
  CONSTRAINT chk_inventory_movements_quantity CHECK (quantity <> 0),
  CONSTRAINT fk_inventory_movements_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_inventory_movements_product
    FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_inventory_movements_user
    FOREIGN KEY (business_id, user_id) REFERENCES users (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE expenses (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  cash_session_id BIGINT UNSIGNED NULL,
  description VARCHAR(500) NOT NULL,
  category VARCHAR(100) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  payment_method ENUM('CASH', 'BANK', 'PENDING') NOT NULL,
  receipt_reference VARCHAR(100) NULL,
  status ENUM('POSTED', 'VOID') NOT NULL DEFAULT 'POSTED',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  cancelled_at DATETIME(3) NULL,
  cancelled_by BIGINT UNSIGNED NULL,
  cancel_reason VARCHAR(500) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_expenses_business_id_id (business_id, id),
  KEY idx_expenses_business_date (business_id, created_at),
  KEY idx_expenses_business_category_date (business_id, category, created_at),
  KEY idx_expenses_business_status_date (business_id, status, created_at),
  KEY idx_expenses_business_cash_session (business_id, cash_session_id),
  CONSTRAINT chk_expenses_amount CHECK (amount > 0),
  CONSTRAINT fk_expenses_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_expenses_user
    FOREIGN KEY (business_id, user_id) REFERENCES users (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_expenses_cash_session
    FOREIGN KEY (business_id, cash_session_id) REFERENCES cash_sessions (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_expenses_cancelled_by
    FOREIGN KEY (business_id, cancelled_by) REFERENCES users (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE cash_movements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  cash_session_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  type ENUM(
    'SALE',
    'CUSTOMER_PAYMENT',
    'SUPPLIER_PAYMENT',
    'EXPENSE',
    'MANUAL_ENTRY',
    'MANUAL_EXIT',
    'REVERSAL'
  ) NOT NULL,
  direction ENUM('IN', 'OUT') NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  reference_type VARCHAR(40) NULL,
  reference_id BIGINT UNSIGNED NULL,
  sale_id BIGINT UNSIGNED NULL,
  customer_payment_id BIGINT UNSIGNED NULL,
  supplier_payment_id BIGINT UNSIGNED NULL,
  expense_id BIGINT UNSIGNED NULL,
  reversal_of_movement_id BIGINT UNSIGNED NULL,
  description VARCHAR(500) NOT NULL,
  status ENUM('PENDING', 'CONFIRMED', 'VOID') NOT NULL DEFAULT 'CONFIRMED',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_cash_movements_business_id_id (business_id, id),
  KEY idx_cash_movements_business_session_date (business_id, cash_session_id, created_at),
  KEY idx_cash_movements_business_type_date (business_id, type, created_at),
  KEY idx_cash_movements_business_reference (business_id, reference_type, reference_id),
  KEY idx_cash_movements_business_sale (business_id, sale_id),
  KEY idx_cash_movements_business_customer_payment (business_id, customer_payment_id),
  KEY idx_cash_movements_business_supplier_payment (business_id, supplier_payment_id),
  KEY idx_cash_movements_business_expense (business_id, expense_id),
  CONSTRAINT chk_cash_movements_amount CHECK (amount > 0),
  CONSTRAINT chk_cash_movements_single_reference CHECK (
    (sale_id IS NOT NULL)
    + (customer_payment_id IS NOT NULL)
    + (supplier_payment_id IS NOT NULL)
    + (expense_id IS NOT NULL) <= 1
  ),
  CONSTRAINT fk_cash_movements_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_cash_movements_session
    FOREIGN KEY (business_id, cash_session_id) REFERENCES cash_sessions (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_cash_movements_user
    FOREIGN KEY (business_id, user_id) REFERENCES users (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_cash_movements_sale
    FOREIGN KEY (business_id, sale_id) REFERENCES sales (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_cash_movements_customer_payment
    FOREIGN KEY (business_id, customer_payment_id)
    REFERENCES customer_payments (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_cash_movements_supplier_payment
    FOREIGN KEY (business_id, supplier_payment_id)
    REFERENCES supplier_payments (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_cash_movements_expense
    FOREIGN KEY (business_id, expense_id) REFERENCES expenses (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_cash_movements_reversal
    FOREIGN KEY (business_id, reversal_of_movement_id)
    REFERENCES cash_movements (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  action VARCHAR(40) NOT NULL,
  entity VARCHAR(64) NOT NULL,
  entity_id VARCHAR(100) NULL,
  details JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_audit_logs_business_id_id (business_id, id),
  KEY idx_audit_logs_business_date (business_id, created_at),
  KEY idx_audit_logs_business_user_date (business_id, user_id, created_at),
  KEY idx_audit_logs_business_entity (business_id, entity, entity_id),
  KEY idx_audit_logs_business_action_date (business_id, action, created_at),
  CONSTRAINT fk_audit_logs_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_audit_logs_user
    FOREIGN KEY (business_id, user_id) REFERENCES users (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE business_settings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  business_name VARCHAR(160) NOT NULL,
  ruc VARCHAR(64) NULL,
  phone VARCHAR(40) NULL,
  address VARCHAR(255) NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'C$',
  logo TEXT NULL,
  invoice_prefix VARCHAR(32) NOT NULL DEFAULT '',
  retail_margin_default DECIMAL(7,4) NOT NULL DEFAULT 0.0000,
  wholesale_margin_default DECIMAL(7,4) NOT NULL DEFAULT 0.0000,
  min_stock_default DECIMAL(12,3) NOT NULL DEFAULT 5.000,
  tax_rate_default DECIMAL(7,4) NOT NULL DEFAULT 0.0000,
  ticket_header VARCHAR(500) NULL,
  ticket_footer VARCHAR(500) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_business_settings_business (business_id),
  CONSTRAINT chk_business_settings_defaults
    CHECK (min_stock_default >= 0),
  CONSTRAINT fk_business_settings_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE document_sequences (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  document_type VARCHAR(40) NOT NULL,
  prefix VARCHAR(32) NOT NULL DEFAULT '',
  current_number BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_document_sequences_business_type (business_id, document_type),
  CONSTRAINT fk_document_sequences_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;
