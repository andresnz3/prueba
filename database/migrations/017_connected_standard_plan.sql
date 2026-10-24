ALTER TABLE business_subscriptions
  DROP CHECK chk_business_subscriptions_plan,
  ADD CONSTRAINT chk_business_subscriptions_plan
    CHECK (plan_code IN ('LOCAL', 'CONECTADO_BASICO', 'CONECTADO_ESTANDAR', 'CONECTADO_PREMIUM'));
