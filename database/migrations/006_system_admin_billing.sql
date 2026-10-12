CREATE TABLE business_subscriptions (
  business_id BIGINT UNSIGNED NOT NULL,
  plan_code VARCHAR(32) NOT NULL,
  next_due_date DATE NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (business_id),
  CONSTRAINT chk_business_subscriptions_plan CHECK (plan_code IN ('LOCAL', 'CONECTADO_BASICO', 'CONECTADO_PREMIUM')),
  CONSTRAINT chk_business_subscriptions_local_due CHECK (plan_code <> 'LOCAL' OR next_due_date IS NULL),
  CONSTRAINT fk_business_subscriptions_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE business_subscription_payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  payment_date DATE NOT NULL,
  created_by_user_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_business_subscription_payments_history (business_id, payment_date, id),
  CONSTRAINT chk_business_subscription_payments_amount CHECK (amount > 0),
  CONSTRAINT fk_business_subscription_payments_business
    FOREIGN KEY (business_id) REFERENCES businesses (id)
    ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB;
