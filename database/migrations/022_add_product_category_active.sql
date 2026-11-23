ALTER TABLE product_categories
  ADD COLUMN active TINYINT(1) NOT NULL DEFAULT 1 AFTER normalized_name;
