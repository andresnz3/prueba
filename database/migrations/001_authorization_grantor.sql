-- Aplicar una sola vez en la base seleccionada, antes de habilitar autenticacion.
-- No se cambia schema.sql. Los permisos antiguos sin otorgante no seran validos.
ALTER TABLE session_authorizations
  ADD COLUMN granted_by_user_id BIGINT UNSIGNED NULL AFTER session_id,
  ADD KEY idx_authorizations_grantor (business_id, granted_by_user_id),
  ADD CONSTRAINT fk_authorizations_grantor
    FOREIGN KEY (business_id, granted_by_user_id) REFERENCES users (business_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;
