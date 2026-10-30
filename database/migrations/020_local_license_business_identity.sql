ALTER TABLE local_licenses
  ADD COLUMN local_business_id_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER active_installation_hash,
  ADD KEY idx_local_licenses_business_id_hash (local_business_id_hash);

ALTER TABLE local_license_installations
  ADD COLUMN local_business_id_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER installation_hash,
  ADD KEY idx_local_license_installations_business_id_hash (local_business_id_hash);
