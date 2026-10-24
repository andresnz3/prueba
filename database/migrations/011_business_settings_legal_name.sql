-- Store the legal name separately from the display/commercial name.
-- Adding this nullable column preserves every existing business setting.
ALTER TABLE business_settings
  ADD COLUMN legal_name VARCHAR(160) NULL,
  ALGORITHM=INSTANT;
