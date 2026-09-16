PRAGMA foreign_keys = ON;

CREATE TABLE teacher_identity_bindings (
  teacher_id TEXT PRIMARY KEY,
  subject_fingerprint TEXT NOT NULL UNIQUE CHECK (length(subject_fingerprint) = 64),
  bound_at TEXT NOT NULL,
  bound_by TEXT NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0)
) STRICT;

CREATE TABLE teacher_identity_audits (
  identity_audit_id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('BOUND', 'BIND_REJECTED', 'UNBOUND')),
  actor_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_teacher_identity_audits_teacher
  ON teacher_identity_audits(teacher_id, occurred_at);

CREATE TABLE class_read_model_head (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  active_source_version INTEGER,
  read_status TEXT NOT NULL DEFAULT 'UNAVAILABLE' CHECK (
    read_status IN ('AVAILABLE', 'UNAVAILABLE')
  ),
  failure_code TEXT,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO class_read_model_head (
  singleton_id, active_source_version, read_status, updated_at
) VALUES (1, NULL, 'UNAVAILABLE', '1970-01-01T00:00:00.000Z');

CREATE TABLE class_read_model_versions (
  source_version INTEGER PRIMARY KEY CHECK (source_version > 0),
  fetched_at TEXT NOT NULL,
  ttl_seconds INTEGER NOT NULL CHECK (ttl_seconds > 0),
  content_fingerprint TEXT NOT NULL CHECK (length(content_fingerprint) = 64),
  imported_at TEXT NOT NULL
) STRICT;

CREATE TABLE class_read_model_entries (
  source_version INTEGER NOT NULL REFERENCES class_read_model_versions(source_version),
  class_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  studio_id TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  teacher_email_fingerprint TEXT NOT NULL CHECK (length(teacher_email_fingerprint) = 64),
  lesson_on TEXT NOT NULL,
  PRIMARY KEY (source_version, class_id, teacher_id, lesson_on)
) STRICT;

CREATE INDEX idx_class_read_model_match
  ON class_read_model_entries(source_version, teacher_id, lesson_on);

CREATE INDEX idx_class_read_model_initial_identity
  ON class_read_model_entries(source_version, teacher_email_fingerprint, teacher_id);

CREATE TABLE submission_intakes (
  submission_id TEXT PRIMARY KEY,
  intended_video_job_id TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  subject_fingerprint TEXT NOT NULL CHECK (length(subject_fingerprint) = 64),
  teacher_id TEXT NOT NULL,
  lesson_on TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'PENDING', 'JOB_CREATING', 'RESOLVED', 'SELECTION_REQUIRED', 'UNRESOLVED'
  )),
  reason_code TEXT,
  source_version INTEGER,
  decision_fingerprint TEXT CHECK (
    decision_fingerprint IS NULL OR length(decision_fingerprint) = 64
  ),
  video_job_id TEXT REFERENCES video_jobs(video_job_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_submission_intakes_status
  ON submission_intakes(status, updated_at);

CREATE TABLE submission_candidate_snapshots (
  submission_id TEXT NOT NULL REFERENCES submission_intakes(submission_id) ON DELETE CASCADE,
  class_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  studio_id TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  PRIMARY KEY (submission_id, class_id, teacher_id)
) STRICT;

CREATE TABLE intake_audit_logs (
  intake_audit_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submission_intakes(submission_id),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason_code TEXT,
  occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_intake_audits_submission
  ON intake_audit_logs(submission_id, occurred_at);

CREATE TABLE fake_notification_outbox (
  notification_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submission_intakes(submission_id),
  decision_fingerprint TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DELIVERED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(submission_id, decision_fingerprint)
) STRICT;

CREATE INDEX idx_fake_notification_pending
  ON fake_notification_outbox(status, created_at);
