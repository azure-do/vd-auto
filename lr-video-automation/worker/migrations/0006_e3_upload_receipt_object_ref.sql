PRAGMA foreign_keys = OFF;

CREATE TABLE upload_receipt_events_v2 (
  event_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE REFERENCES submission_intakes(submission_id),
  object_ref TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type = 'video.uploaded'),
  receipt_fingerprint TEXT NOT NULL CHECK (length(receipt_fingerprint) = 64),
  occurred_at TEXT NOT NULL
) STRICT;

-- A CHECK violation aborts the migration instead of silently dropping any
-- legacy receipt whose session is missing or otherwise cannot be backfilled.
CREATE TABLE e3_receipt_backfill_guard (
  all_rows_backfillable INTEGER NOT NULL CHECK (all_rows_backfillable = 1)
) STRICT;

INSERT INTO e3_receipt_backfill_guard (all_rows_backfillable)
SELECT CASE
  WHEN (SELECT COUNT(*) FROM upload_receipt_events) = (
    SELECT COUNT(*)
    FROM upload_receipt_events e
    JOIN fake_upload_sessions s ON s.submission_id = e.submission_id
  ) THEN 1
  ELSE 0
END;

INSERT INTO upload_receipt_events_v2 (
  event_id, submission_id, object_ref, event_type, receipt_fingerprint, occurred_at
)
SELECT
  e.event_id, e.submission_id, s.expected_object_ref, e.event_type,
  e.receipt_fingerprint, e.occurred_at
FROM upload_receipt_events e
JOIN fake_upload_sessions s ON s.submission_id = e.submission_id;

DROP TABLE e3_receipt_backfill_guard;
DROP TABLE upload_receipt_events;
ALTER TABLE upload_receipt_events_v2 RENAME TO upload_receipt_events;

PRAGMA foreign_keys = ON;
