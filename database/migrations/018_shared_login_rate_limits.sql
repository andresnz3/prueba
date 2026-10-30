CREATE TABLE auth_login_rate_limits (
  bucket_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempts SMALLINT UNSIGNED NOT NULL,
  window_started_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (bucket_hash),
  KEY idx_auth_login_rate_limits_updated (updated_at),
  CONSTRAINT chk_auth_login_rate_limits_attempts CHECK (attempts BETWEEN 1 AND 1001)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
