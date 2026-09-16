PRAGMA foreign_keys = ON;

CREATE TABLE youtube_oauth_control (
  control_id INTEGER PRIMARY KEY CHECK (control_id = 1),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  operation TEXT NOT NULL CHECK (operation IN ('READY', 'STARTING', 'CALLBACK', 'VERIFYING', 'REFRESHING', 'REVOKING', 'ERROR')),
  operation_owner TEXT CHECK (operation_owner IS NULL OR length(operation_owner) BETWEEN 16 AND 128),
  operation_expires_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((operation IN ('READY', 'ERROR') AND operation_owner IS NULL AND operation_expires_at IS NULL)
    OR (operation IN ('STARTING', 'CALLBACK', 'VERIFYING', 'REFRESHING', 'REVOKING')
      AND operation_owner IS NOT NULL AND operation_expires_at IS NOT NULL))
) STRICT;

INSERT INTO youtube_oauth_control(control_id, generation, operation, operation_owner, operation_expires_at, updated_at)
VALUES (1, 0, 'READY', NULL, NULL, '1970-01-01T00:00:00.000Z');

CREATE TABLE youtube_oauth_attempts (
  oauth_attempt_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL CHECK (generation > 0),
  state_hash TEXT NOT NULL UNIQUE CHECK (length(state_hash) = 64),
  pkce_verifier_ciphertext TEXT NOT NULL,
  requested_scope TEXT NOT NULL CHECK (
    requested_scope = 'https://www.googleapis.com/auth/youtube.readonly'
  ),
  status TEXT NOT NULL CHECK (
    status IN ('PENDING', 'CONSUMING', 'COMPLETED', 'FAILED', 'EXPIRED')
  ),
  failure_code TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'PENDING' AND consumed_at IS NULL AND failure_code IS NULL)
    OR (status = 'CONSUMING' AND consumed_at IS NOT NULL AND failure_code IS NULL)
    OR (status = 'COMPLETED' AND consumed_at IS NOT NULL AND failure_code IS NULL)
    OR (status IN ('FAILED', 'EXPIRED') AND failure_code IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_youtube_oauth_attempts_status_expiry
  ON youtube_oauth_attempts(status, expires_at);

CREATE UNIQUE INDEX idx_youtube_oauth_single_active_attempt
  ON youtube_oauth_attempts((1)) WHERE status IN ('PENDING', 'CONSUMING');

CREATE TABLE youtube_oauth_credentials (
  credential_id INTEGER PRIMARY KEY CHECK (credential_id = 1),
  generation INTEGER NOT NULL CHECK (generation > 0),
  status TEXT NOT NULL CHECK (
    status IN ('CONNECTED', 'REFRESHING', 'REVOKING', 'REVOKED', 'ERROR')
  ),
  access_token_ciphertext TEXT,
  refresh_token_ciphertext TEXT,
  token_expires_at TEXT,
  granted_scope TEXT NOT NULL CHECK (
    granted_scope = 'https://www.googleapis.com/auth/youtube.readonly'
  ),
  expected_channel_fingerprint TEXT NOT NULL CHECK (
    length(expected_channel_fingerprint) = 64
  ),
  verified_channel_fingerprint TEXT CHECK (
    verified_channel_fingerprint IS NULL OR length(verified_channel_fingerprint) = 64
  ),
  verified_at TEXT,
  operation_expires_at TEXT,
  last_error_code TEXT,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status IN ('CONNECTED', 'REFRESHING', 'REVOKING')
      AND access_token_ciphertext IS NOT NULL
      AND refresh_token_ciphertext IS NOT NULL
      AND token_expires_at IS NOT NULL
      AND verified_channel_fingerprint IS NOT NULL
      AND verified_channel_fingerprint = expected_channel_fingerprint
      AND verified_at IS NOT NULL)
    OR (status IN ('REVOKED', 'ERROR')
      AND access_token_ciphertext IS NULL
      AND refresh_token_ciphertext IS NULL
      AND token_expires_at IS NULL)
  ),
  CHECK ((status IN ('REFRESHING', 'REVOKING') AND operation_expires_at IS NOT NULL)
    OR (status NOT IN ('REFRESHING', 'REVOKING') AND operation_expires_at IS NULL))
) STRICT;

CREATE TABLE youtube_oauth_audits (
  oauth_audit_id TEXT PRIMARY KEY,
  oauth_attempt_id TEXT REFERENCES youtube_oauth_attempts(oauth_attempt_id),
  actor_subject_fingerprint TEXT NOT NULL CHECK (length(actor_subject_fingerprint) = 64),
  action TEXT NOT NULL CHECK (action IN (
    'oauth.started', 'oauth.connected', 'oauth.replayed', 'oauth.failed',
    'oauth.refreshed', 'oauth.refresh_failed', 'oauth.revoked',
    'oauth.revoke_failed', 'oauth.readiness_rejected'
  )),
  reason_code TEXT,
  occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_youtube_oauth_audits_attempt
  ON youtube_oauth_audits(oauth_attempt_id, occurred_at);
