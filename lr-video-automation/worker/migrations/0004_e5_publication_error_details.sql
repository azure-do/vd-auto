PRAGMA foreign_keys = ON;

ALTER TABLE idempotency_records
  ADD COLUMN error_code TEXT CHECK (
    error_code IS NULL OR (
      length(error_code) BETWEEN 1 AND 64
      AND substr(error_code, 1, 1) GLOB '[A-Z]'
      AND error_code NOT GLOB '*[^A-Z0-9_]*'
    )
  );

ALTER TABLE idempotency_records
  ADD COLUMN provider_reason_code TEXT CHECK (
    provider_reason_code IS NULL OR (
      length(provider_reason_code) BETWEEN 1 AND 64
      AND substr(provider_reason_code, 1, 1) GLOB '[A-Z]'
      AND provider_reason_code NOT GLOB '*[^A-Z0-9_]*'
    )
  );

ALTER TABLE idempotency_records
  ADD COLUMN retryable INTEGER CHECK (retryable IS NULL OR retryable IN (0, 1));
