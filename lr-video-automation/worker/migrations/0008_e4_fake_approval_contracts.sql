PRAGMA foreign_keys = ON;

CREATE TABLE fake_approval_allowlist (
  approver_id TEXT PRIMARY KEY,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  changed_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE approval_requests (
  approval_request_id TEXT PRIMARY KEY,
  video_job_id TEXT NOT NULL REFERENCES video_jobs(video_job_id),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  content_fingerprint TEXT NOT NULL CHECK (length(content_fingerprint) = 64),
  targets_fingerprint TEXT NOT NULL CHECK (length(targets_fingerprint) = 64),
  object_ref TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  publication_targets_json TEXT NOT NULL CHECK (json_valid(publication_targets_json)),
  operation_token_hash TEXT NOT NULL UNIQUE CHECK (length(operation_token_hash) = 64),
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING', 'DECIDING', 'APPROVED', 'REJECTED', 'EXPIRED')
  ),
  decision_postback_id TEXT UNIQUE,
  decided_action TEXT CHECK (decided_action IS NULL OR decided_action IN ('APPROVE', 'REJECT')),
  decided_by TEXT,
  decided_at TEXT,
  approved_content_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'PENDING' AND decision_postback_id IS NULL AND decided_action IS NULL
      AND decided_by IS NULL AND decided_at IS NULL AND approved_content_version IS NULL)
    OR (status = 'EXPIRED' AND decision_postback_id IS NULL AND decided_action IS NULL
      AND decided_by IS NULL AND decided_at IS NULL AND approved_content_version IS NULL)
    OR (status = 'DECIDING' AND decision_postback_id IS NOT NULL AND decided_action IS NOT NULL
      AND decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND ((decided_action = 'APPROVE' AND approved_content_version IS NOT NULL)
        OR (decided_action = 'REJECT' AND approved_content_version IS NULL)))
    OR (status = 'APPROVED' AND decision_postback_id IS NOT NULL AND decided_action = 'APPROVE'
      AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND approved_content_version IS NOT NULL)
    OR (status = 'REJECTED' AND decision_postback_id IS NOT NULL AND decided_action = 'REJECT'
      AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND approved_content_version IS NULL)
  )
) STRICT;

CREATE INDEX idx_approval_requests_status
  ON approval_requests(status, expires_at, created_at);

CREATE UNIQUE INDEX idx_approval_requests_one_active_job
  ON approval_requests(video_job_id) WHERE status IN ('PENDING', 'DECIDING');

CREATE TRIGGER trg_approval_requests_snapshot_immutable
BEFORE UPDATE OF
  approval_request_id, video_job_id, request_fingerprint, content_fingerprint,
  targets_fingerprint, object_ref, checksum_sha256, content_json,
  publication_targets_json, operation_token_hash, expires_at, created_at
ON approval_requests
WHEN OLD.approval_request_id IS NOT NEW.approval_request_id
  OR OLD.video_job_id IS NOT NEW.video_job_id
  OR OLD.request_fingerprint IS NOT NEW.request_fingerprint
  OR OLD.content_fingerprint IS NOT NEW.content_fingerprint
  OR OLD.targets_fingerprint IS NOT NEW.targets_fingerprint
  OR OLD.object_ref IS NOT NEW.object_ref
  OR OLD.checksum_sha256 IS NOT NEW.checksum_sha256
  OR OLD.content_json IS NOT NEW.content_json
  OR OLD.publication_targets_json IS NOT NEW.publication_targets_json
  OR OLD.operation_token_hash IS NOT NEW.operation_token_hash
  OR OLD.expires_at IS NOT NEW.expires_at
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'approval request snapshot is immutable');
END;

CREATE TABLE approval_decision_claims (
  approval_request_id TEXT PRIMARY KEY REFERENCES approval_requests(approval_request_id),
  decision_postback_id TEXT NOT NULL UNIQUE,
  decided_action TEXT NOT NULL CHECK (decided_action IN ('APPROVE', 'REJECT')),
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  approved_content_version TEXT,
  video_job_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  content_fingerprint TEXT NOT NULL CHECK (length(content_fingerprint) = 64),
  targets_fingerprint TEXT NOT NULL CHECK (length(targets_fingerprint) = 64),
  operation_token_hash TEXT NOT NULL CHECK (length(operation_token_hash) = 64),
  intent_proof TEXT NOT NULL CHECK (length(intent_proof) = 64),
  created_at TEXT NOT NULL,
  CHECK (
    (decided_action = 'APPROVE' AND approved_content_version IS NOT NULL)
    OR (decided_action = 'REJECT' AND approved_content_version IS NULL)
  )
) STRICT;

CREATE TRIGGER trg_approval_decision_claims_immutable
BEFORE UPDATE ON approval_decision_claims
BEGIN
  SELECT RAISE(ABORT, 'approval decision claim is immutable');
END;

CREATE TRIGGER trg_approval_requests_decision_guard
BEFORE UPDATE OF
  status, decision_postback_id, decided_action, decided_by, decided_at,
  approved_content_version
ON approval_requests
WHEN NOT (
  (NEW.status = OLD.status
    AND NEW.decision_postback_id IS OLD.decision_postback_id
    AND NEW.decided_action IS OLD.decided_action
    AND NEW.decided_by IS OLD.decided_by
    AND NEW.decided_at IS OLD.decided_at
    AND NEW.approved_content_version IS OLD.approved_content_version)
  OR (OLD.status = 'PENDING' AND NEW.status = 'EXPIRED'
    AND NEW.decision_postback_id IS NULL AND NEW.decided_action IS NULL
    AND NEW.decided_by IS NULL AND NEW.decided_at IS NULL
    AND NEW.approved_content_version IS NULL)
  OR (OLD.status = 'PENDING' AND NEW.status = 'DECIDING'
    AND OLD.decision_postback_id IS NULL AND OLD.decided_action IS NULL
    AND OLD.decided_by IS NULL AND OLD.decided_at IS NULL
    AND OLD.approved_content_version IS NULL
    AND NEW.decision_postback_id IS NOT NULL AND NEW.decided_action IS NOT NULL
    AND NEW.decided_by IS NOT NULL AND NEW.decided_at IS NOT NULL
    AND ((NEW.decided_action = 'APPROVE' AND NEW.approved_content_version IS NOT NULL)
      OR (NEW.decided_action = 'REJECT' AND NEW.approved_content_version IS NULL))
    AND EXISTS (
      SELECT 1 FROM approval_decision_claims c
      WHERE c.approval_request_id = OLD.approval_request_id
        AND c.decision_postback_id = NEW.decision_postback_id
        AND c.decided_action = NEW.decided_action
        AND c.decided_by = NEW.decided_by
        AND c.decided_at = NEW.decided_at
        AND c.approved_content_version IS NEW.approved_content_version
        AND c.video_job_id = OLD.video_job_id
        AND c.request_fingerprint = OLD.request_fingerprint
        AND c.content_fingerprint = OLD.content_fingerprint
        AND c.targets_fingerprint = OLD.targets_fingerprint
        AND c.operation_token_hash = OLD.operation_token_hash
    ))
  OR (OLD.status = 'DECIDING'
    AND ((OLD.decided_action = 'APPROVE' AND NEW.status = 'APPROVED')
      OR (OLD.decided_action = 'REJECT' AND NEW.status = 'REJECTED'))
    AND NEW.decision_postback_id IS OLD.decision_postback_id
    AND NEW.decided_action IS OLD.decided_action
    AND NEW.decided_by IS OLD.decided_by
    AND NEW.decided_at IS OLD.decided_at
    AND NEW.approved_content_version IS OLD.approved_content_version)
)
BEGIN
  SELECT RAISE(ABORT, 'approval request decision transition is invalid');
END;

CREATE TABLE fake_approval_notification_outbox (
  notification_id TEXT PRIMARY KEY,
  approval_request_id TEXT NOT NULL UNIQUE REFERENCES approval_requests(approval_request_id),
  operation_token TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL CHECK (length(payload_fingerprint) = 64),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING', 'SENDING', 'DELIVERED', 'CANCELLED')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token TEXT,
  lease_expires_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'SENDING' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status IN ('PENDING', 'DELIVERED', 'CANCELLED')
      AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
) STRICT;

CREATE INDEX idx_fake_approval_notifications_pending
  ON fake_approval_notification_outbox(status, created_at);

CREATE TRIGGER trg_fake_approval_notification_snapshot_immutable
BEFORE UPDATE OF
  notification_id, approval_request_id, operation_token, payload_fingerprint, created_at
ON fake_approval_notification_outbox
WHEN OLD.notification_id IS NOT NEW.notification_id
  OR OLD.approval_request_id IS NOT NEW.approval_request_id
  OR OLD.operation_token IS NOT NEW.operation_token
  OR OLD.payload_fingerprint IS NOT NEW.payload_fingerprint
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'approval notification snapshot is immutable');
END;

CREATE TABLE fake_approval_notification_deliveries (
  notification_id TEXT PRIMARY KEY REFERENCES fake_approval_notification_outbox(notification_id),
  payload_fingerprint TEXT NOT NULL CHECK (length(payload_fingerprint) = 64),
  delivered_at TEXT NOT NULL
) STRICT;

CREATE TABLE approval_security_audits (
  security_audit_id TEXT PRIMARY KEY,
  approval_request_id TEXT REFERENCES approval_requests(approval_request_id),
  actor_fingerprint TEXT NOT NULL CHECK (length(actor_fingerprint) = 64),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'APPROVER_ID_INVALID', 'APPROVER_NOT_ALLOWED', 'APPROVER_DISABLED',
    'TOKEN_UNKNOWN', 'POSTBACK_TAMPERED', 'APPROVAL_EXPIRED', 'DECISION_CONFLICT',
    'SNAPSHOT_TAMPERED', 'OUTBOX_TAMPERED'
  )),
  occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_approval_security_audits_request
  ON approval_security_audits(approval_request_id, occurred_at);

CREATE TABLE approval_publisher_outbox (
  publisher_event_id TEXT PRIMARY KEY,
  approval_request_id TEXT NOT NULL UNIQUE REFERENCES approval_requests(approval_request_id),
  video_job_id TEXT NOT NULL REFERENCES video_jobs(video_job_id),
  approved_content_version TEXT NOT NULL,
  publication_targets_json TEXT NOT NULL CHECK (json_valid(publication_targets_json)),
  event_fingerprint TEXT NOT NULL UNIQUE CHECK (length(event_fingerprint) = 64),
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
    OR (status IN ('PENDING', 'DELIVERED') AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
) STRICT;

CREATE INDEX idx_approval_publisher_outbox_pending
  ON approval_publisher_outbox(status, created_at);

CREATE TRIGGER trg_approval_publisher_snapshot_immutable
BEFORE UPDATE OF
  publisher_event_id, approval_request_id, video_job_id,
  approved_content_version, publication_targets_json, event_fingerprint, created_at
ON approval_publisher_outbox
WHEN OLD.publisher_event_id IS NOT NEW.publisher_event_id
  OR OLD.approval_request_id IS NOT NEW.approval_request_id
  OR OLD.video_job_id IS NOT NEW.video_job_id
  OR OLD.approved_content_version IS NOT NEW.approved_content_version
  OR OLD.publication_targets_json IS NOT NEW.publication_targets_json
  OR OLD.event_fingerprint IS NOT NEW.event_fingerprint
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'approval publisher snapshot is immutable');
END;

CREATE TABLE fake_publisher_deliveries (
  publisher_event_id TEXT PRIMARY KEY REFERENCES approval_publisher_outbox(publisher_event_id),
  event_fingerprint TEXT NOT NULL CHECK (length(event_fingerprint) = 64),
  delivered_at TEXT NOT NULL
) STRICT;
