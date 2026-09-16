PRAGMA foreign_keys = ON;

ALTER TABLE idempotency_records
  ADD COLUMN yt_committed_offset INTEGER NOT NULL DEFAULT 0
  CHECK (yt_committed_offset >= 0);

ALTER TABLE idempotency_records
  ADD COLUMN yt_video_id TEXT
  CHECK (
    yt_video_id IS NULL OR (
      length(yt_video_id) = 11
      AND yt_video_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  );

ALTER TABLE idempotency_records
  ADD COLUMN yt_session_state TEXT NOT NULL DEFAULT 'NONE'
  CHECK (yt_session_state IN ('NONE', 'ACTIVE', 'UNUSABLE'));

ALTER TABLE idempotency_records
  ADD COLUMN yt_reconciled_at TEXT;

CREATE TABLE youtube_publication_attempts (
  idempotency_key TEXT NOT NULL
    REFERENCES idempotency_records(idempotency_key) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  fence_token TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN (
    'SIDE_EFFECT_ALLOWED', 'UPLOADING', 'OUTCOME_UNKNOWN',
    'RECONCILIATION_REQUIRED', 'SUCCEEDED', 'FAILED', 'SUPERSEDED'
  )),
  committed_offset INTEGER NOT NULL DEFAULT 0 CHECK (committed_offset >= 0),
  video_id TEXT CHECK (
    video_id IS NULL OR (
      length(video_id) = 11
      AND video_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (idempotency_key, attempt_no)
) STRICT;

CREATE INDEX idx_youtube_publication_attempt_state
  ON youtube_publication_attempts(state, updated_at);

CREATE TABLE youtube_reconciliation_observations (
  observation_token TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL
    REFERENCES idempotency_records(idempotency_key) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  result TEXT NOT NULL CHECK (result IN ('IN_FLIGHT', 'TIMED_OUT', 'FOUND', 'NONE')),
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE INDEX idx_youtube_reconciliation_observation_state
  ON youtube_reconciliation_observations(
    idempotency_key, attempt_no, result, expires_at, completed_at
  );
