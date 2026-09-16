PRAGMA foreign_keys = ON;

CREATE TABLE video_jobs (
  video_job_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE,
  branch_id TEXT NOT NULL,
  studio_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (state IN (
    'RECEIVED', 'VALIDATING', 'VALIDATION_FAILED', 'CLASS_UNRESOLVED',
    'PROCESSING', 'WAITING_APPROVAL', 'REJECTED', 'APPROVED',
    'PUBLISHING', 'PARTIALLY_PUBLISHED', 'PUBLISHED', 'FAILED'
  )),
  approved_content_version TEXT,
  youtube_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (youtube_status IN (
    'PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'SKIPPED',
    'OUTCOME_UNKNOWN', 'RECONCILIATION_REQUIRED'
  )),
  instagram_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (instagram_status IN (
    'PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'SKIPPED'
  )),
  tiktok_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (tiktok_status IN (
    'PENDING', 'READY_FOR_MANUAL_POST', 'HANDED_OFF',
    'CONFIRMED_PUBLISHED', 'FAILED', 'SKIPPED'
  )),
  retention_state TEXT NOT NULL DEFAULT 'HOLD' CHECK (retention_state IN (
    'HOLD', 'RETAINED', 'DUE_FOR_DELETION', 'DELETED'
  )),
  retention_start_at TEXT,
  delete_due_at TEXT,
  creation_token TEXT NOT NULL UNIQUE,
  creation_fingerprint TEXT NOT NULL CHECK (length(creation_fingerprint) = 64),
  last_mutation_token TEXT,
  row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_video_jobs_state ON video_jobs(state, updated_at);
CREATE INDEX idx_video_jobs_retention_due
  ON video_jobs(retention_state, delete_due_at);

CREATE TABLE idempotency_records (
  idempotency_key TEXT PRIMARY KEY,
  video_job_id TEXT NOT NULL REFERENCES video_jobs(video_job_id),
  destination TEXT NOT NULL CHECK (destination IN ('youtube', 'instagram', 'tiktok')),
  target_account_id TEXT NOT NULL,
  approved_content_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING', 'CLAIMED', 'SUCCEEDED', 'FAILED', 'OUTCOME_UNKNOWN',
    'RECONCILIATION_REQUIRED', 'HANDED_OFF'
  )),
  attempt_no INTEGER NOT NULL DEFAULT 1 CHECK (attempt_no > 0),
  result_ref TEXT,
  last_mutation_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(video_job_id, destination, target_account_id, approved_content_version)
) STRICT;

CREATE INDEX idx_idempotency_job ON idempotency_records(video_job_id);

CREATE TABLE applied_mutations (
  mutation_token TEXT PRIMARY KEY,
  video_job_id TEXT NOT NULL REFERENCES video_jobs(video_job_id),
  mutation_type TEXT NOT NULL,
  operation_fingerprint TEXT NOT NULL CHECK (length(operation_fingerprint) = 64),
  result_row_version INTEGER NOT NULL CHECK (result_row_version >= 0),
  applied_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_applied_mutations_job ON applied_mutations(video_job_id, applied_at);

CREATE TABLE audit_logs (
  audit_id TEXT PRIMARY KEY,
  video_job_id TEXT REFERENCES video_jobs(video_job_id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'teacher', 'approver', 'operator')),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_audit_job_time ON audit_logs(video_job_id, occurred_at);

CREATE TABLE mirror_outbox (
  mirror_event_id TEXT PRIMARY KEY,
  video_job_id TEXT NOT NULL REFERENCES video_jobs(video_job_id),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TEXT NOT NULL,
  delivered_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_mirror_outbox_pending
  ON mirror_outbox(status, available_at, created_at);

CREATE TABLE queue_deliveries (
  event_id TEXT PRIMARY KEY,
  last_message_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  video_job_id TEXT,
  event_fingerprint TEXT NOT NULL CHECK (length(event_fingerprint) = 64),
  status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'PROCESSED', 'FAILED', 'QUARANTINED')),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  lease_token TEXT,
  lease_expires_at TEXT,
  last_error_code TEXT,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_queue_deliveries_message ON queue_deliveries(last_message_id);

CREATE TABLE dlq_messages (
  dlq_message_id TEXT PRIMARY KEY,
  original_message_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
  payload_byte_size INTEGER NOT NULL CHECK (payload_byte_size >= 0),
  payload_type TEXT NOT NULL,
  quarantine_reason TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING', 'REPLAYING', 'REPLAYED', 'QUARANTINED')
  ),
  captured_at TEXT NOT NULL,
  replayed_at TEXT,
  replayed_by TEXT,
  replay_lease_token TEXT,
  replay_lease_expires_at TEXT,
  last_error_code TEXT
) STRICT;

CREATE INDEX idx_dlq_pending ON dlq_messages(status, captured_at);
