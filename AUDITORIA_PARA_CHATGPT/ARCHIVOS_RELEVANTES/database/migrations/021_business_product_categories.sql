CREATE TABLE product_categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(100) NOT NULL,
  normalized_name VARCHAR(100) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_product_categories_business_name (business_id, normalized_name),
  KEY idx_product_categories_business_id (business_id, id),
  CONSTRAINT fk_product_categories_business FOREIGN KEY (business_id) REFERENCES businesses (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT IGNORE INTO product_categories (business_id, name, normalized_name)
SELECT id, 'Abarrotes', 'abarrotes' FROM businesses;
INSERT IGNORE INTO product_categories (business_id, name, normalized_name)
SELECT id, 'Bebidas', 'bebidas' FROM businesses;
INSERT IGNORE INTO product_categories (business_id, name, normalized_name)
SELECT id, 'Snacks', 'snacks' FROM businesses;
INSERT IGNORE INTO product_categories (business_id, name, normalized_name)
SELECT id, 'Limpieza', 'limpieza' FROM businesses;
INSERT IGNORE INTO product_categories (business_id, name, normalized_name)
SELECT business_id, TRIM(category), LOWER(REGEXP_REPLACE(TRIM(category), '[[:space:]]+', ' '))
FROM products
WHERE TRIM(category) <> '';
