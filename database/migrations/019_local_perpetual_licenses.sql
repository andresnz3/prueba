CREATE TABLE local_licenses (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  customer_name VARCHAR(160) NOT NULL,
  customer_reference VARCHAR(120) NULL,
  status ENUM('PENDING','ACTIVE','REVOKED') NOT NULL DEFAULT 'PENDING',
  active_installation_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  active_public_key JSON NULL,
  issued_by_user_id BIGINT UNSIGNED NOT NULL,
  issued_by_username VARCHAR(100) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  activated_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  revoked_by_user_id BIGINT UNSIGNED NULL,
  revocation_reason VARCHAR(500) NULL,
  transfer_count INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_local_licenses_code_hash (code_hash),
  KEY idx_local_licenses_status_created (status, created_at),
  KEY idx_local_licenses_customer (customer_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE local_license_installations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  license_id BIGINT UNSIGNED NOT NULL,
  installation_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  public_key JSON NOT NULL,
  public_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state ENUM('ACTIVE','TRANSFERRED','REVOKED') NOT NULL,
  activated_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NULL,
  ended_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_local_license_installation (license_id, installation_hash),
  KEY idx_local_license_installation_state (license_id, state),
  CONSTRAINT fk_local_license_installation_license FOREIGN KEY (license_id) REFERENCES local_licenses(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE local_license_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  license_id BIGINT UNSIGNED NOT NULL,
  event_type ENUM('ISSUED','ACTIVATED','TRANSFERRED','REVOKED','STATUS_CHECKED') NOT NULL,
  actor_user_id BIGINT UNSIGNED NULL,
  actor_username VARCHAR(100) NULL,
  reason VARCHAR(500) NULL,
  details JSON NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_local_license_events_license_date (license_id, created_at),
  CONSTRAINT fk_local_license_event_license FOREIGN KEY (license_id) REFERENCES local_licenses(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE local_license_challenges (
  challenge_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  challenge_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  purpose ENUM('ACTIVATE','STATUS') NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  PRIMARY KEY (challenge_id),
  KEY idx_local_license_challenges_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE local_license_rate_limits (
  bucket_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempts SMALLINT UNSIGNED NOT NULL,
  window_started_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (bucket_hash),
  KEY idx_local_license_rate_limits_updated (updated_at),
  CONSTRAINT chk_local_license_rate_limits_attempts CHECK (attempts BETWEEN 1 AND 1001)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
