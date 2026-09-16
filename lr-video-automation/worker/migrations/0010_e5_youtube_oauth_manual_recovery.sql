PRAGMA foreign_keys = ON;

CREATE TABLE youtube_oauth_audits_recovery (
  oauth_audit_id TEXT PRIMARY KEY,
  oauth_attempt_id TEXT REFERENCES youtube_oauth_attempts(oauth_attempt_id),
  actor_subject_fingerprint TEXT NOT NULL CHECK (length(actor_subject_fingerprint) = 64),
  action TEXT NOT NULL CHECK (action IN (
    'oauth.started', 'oauth.connected', 'oauth.replayed', 'oauth.failed',
    'oauth.refreshed', 'oauth.refresh_failed', 'oauth.revoked',
    'oauth.revoke_failed', 'oauth.readiness_rejected', 'oauth.recovered'
  )),
  reason_code TEXT,
  occurred_at TEXT NOT NULL
) STRICT;

INSERT INTO youtube_oauth_audits_recovery (
  oauth_audit_id, oauth_attempt_id, actor_subject_fingerprint,
  action, reason_code, occurred_at
)
SELECT oauth_audit_id, oauth_attempt_id, actor_subject_fingerprint,
       action, reason_code, occurred_at
FROM youtube_oauth_audits;

DROP TABLE youtube_oauth_audits;
ALTER TABLE youtube_oauth_audits_recovery RENAME TO youtube_oauth_audits;

CREATE INDEX idx_youtube_oauth_audits_attempt
  ON youtube_oauth_audits(oauth_attempt_id, occurred_at);
