PRAGMA foreign_keys = OFF;

ALTER TABLE submission_intakes
  ADD COLUMN decision_version INTEGER NOT NULL DEFAULT 0 CHECK (decision_version >= 0);

CREATE TABLE fake_notification_outbox_v2 (
  notification_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submission_intakes(submission_id),
  decision_fingerprint TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING', 'SENDING', 'DELIVERED')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token TEXT,
  lease_expires_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'SENDING' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status IN ('PENDING', 'DELIVERED') AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  UNIQUE(submission_id, decision_fingerprint)
) STRICT;

INSERT INTO fake_notification_outbox_v2 (
  notification_id, submission_id, decision_fingerprint, reason_code,
  status, attempt_count, delivered_at, created_at, updated_at
)
SELECT
  notification_id, submission_id, decision_fingerprint, reason_code,
  status, attempt_count, delivered_at, created_at, updated_at
FROM fake_notification_outbox;

DROP TABLE fake_notification_outbox;
ALTER TABLE fake_notification_outbox_v2 RENAME TO fake_notification_outbox;

CREATE INDEX idx_fake_notification_pending
  ON fake_notification_outbox(status, created_at);

PRAGMA foreign_keys = ON;
