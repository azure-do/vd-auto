PRAGMA foreign_keys = ON;

CREATE TABLE fake_upload_sessions (
  submission_id TEXT PRIMARY KEY REFERENCES submission_intakes(submission_id),
  upload_id TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  expected_object_ref TEXT NOT NULL,
  expected_size_bytes INTEGER NOT NULL CHECK (expected_size_bytes > 0),
  expected_checksum_sha256 TEXT NOT NULL CHECK (length(expected_checksum_sha256) = 64),
  expected_content_type TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED', 'REJECTED')),
  completion_event_id TEXT UNIQUE,
  completed_at TEXT,
  rejection_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'PENDING' AND completion_event_id IS NULL AND completed_at IS NULL AND rejection_code IS NULL)
    OR (status = 'COMPLETED' AND completion_event_id IS NOT NULL AND completed_at IS NOT NULL AND rejection_code IS NULL)
    OR (status = 'REJECTED' AND completion_event_id IS NULL AND completed_at IS NULL AND rejection_code IS NOT NULL)
  )
) STRICT;

CREATE TABLE upload_receipt_events (
  event_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE REFERENCES submission_intakes(submission_id),
  event_type TEXT NOT NULL CHECK (event_type = 'video.uploaded'),
  receipt_fingerprint TEXT NOT NULL CHECK (length(receipt_fingerprint) = 64),
  occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_fake_upload_sessions_status
  ON fake_upload_sessions(status, expires_at);
