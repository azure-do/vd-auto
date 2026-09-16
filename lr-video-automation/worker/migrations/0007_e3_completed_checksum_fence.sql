PRAGMA foreign_keys = ON;

-- Preserve every legacy session/receipt/job exactly as recorded. This separate
-- ownership fence controls only which submission may newly complete a checksum.
CREATE TABLE completed_upload_checksum_claims (
  checksum_sha256 TEXT PRIMARY KEY CHECK (length(checksum_sha256) = 64),
  owner_submission_id TEXT NOT NULL UNIQUE REFERENCES fake_upload_sessions(submission_id),
  claimed_at TEXT NOT NULL
) STRICT;

-- Legacy data may already contain duplicates. Pick one deterministic owner for
-- future claims without changing or deleting any historical row.
INSERT INTO completed_upload_checksum_claims (
  checksum_sha256, owner_submission_id, claimed_at
)
SELECT s.expected_checksum_sha256, s.submission_id, s.completed_at
FROM fake_upload_sessions s
JOIN (
  SELECT expected_checksum_sha256, MIN(submission_id) AS owner_submission_id
  FROM fake_upload_sessions
  WHERE status = 'COMPLETED'
  GROUP BY expected_checksum_sha256
) owners
  ON owners.expected_checksum_sha256 = s.expected_checksum_sha256
 AND owners.owner_submission_id = s.submission_id;
