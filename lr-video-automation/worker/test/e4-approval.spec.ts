import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalContractError,
  D1FakeApprovalNotificationAdapter,
  D1FakePublisherAdapter,
  E4FakeApprovalService,
  type ApprovalContentInput,
  type FakeApprovalNotificationDelivery,
  type FakePublisherDelivery,
} from "../src/e4-approval";
import type { JobState, PublicationTarget } from "../src/domain";
import { canonicalFingerprint, canonicalJson, sha256Hex } from "../src/fingerprint";

const BASE = "2026-08-25T00:00:00.000Z";
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const digest = (value: number) => String(value).padStart(64, "0");
const CONTENT: ApprovalContentInput = {
  caption: "ダミー動画の承認文面",
  processedObjectRef: "fake_processed_object",
  processingResultFingerprint: digest(71),
};
const TARGETS: readonly PublicationTarget[] = [
  { destination: "youtube", targetAccountId: "youtube_fake_account" },
  { destination: "instagram", targetAccountId: "instagram_fake_account" },
];
const SNAPSHOT_TRIGGER_SQL = `CREATE TRIGGER trg_approval_requests_snapshot_immutable
BEFORE UPDATE OF approval_request_id, video_job_id, request_fingerprint, content_fingerprint,
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
BEGIN SELECT RAISE(ABORT, 'approval request snapshot is immutable'); END`;
const NOTIFICATION_TRIGGER_SQL = `CREATE TRIGGER trg_fake_approval_notification_snapshot_immutable
BEFORE UPDATE OF notification_id, approval_request_id, operation_token, payload_fingerprint, created_at
ON fake_approval_notification_outbox
WHEN OLD.notification_id IS NOT NEW.notification_id
  OR OLD.approval_request_id IS NOT NEW.approval_request_id
  OR OLD.operation_token IS NOT NEW.operation_token
  OR OLD.payload_fingerprint IS NOT NEW.payload_fingerprint
  OR OLD.created_at IS NOT NEW.created_at
BEGIN SELECT RAISE(ABORT, 'approval notification snapshot is immutable'); END`;
const PUBLISHER_TRIGGER_SQL = `CREATE TRIGGER trg_approval_publisher_snapshot_immutable
BEFORE UPDATE OF publisher_event_id, approval_request_id, video_job_id,
  approved_content_version, publication_targets_json, event_fingerprint, created_at
ON approval_publisher_outbox
WHEN OLD.publisher_event_id IS NOT NEW.publisher_event_id
  OR OLD.approval_request_id IS NOT NEW.approval_request_id
  OR OLD.video_job_id IS NOT NEW.video_job_id
  OR OLD.approved_content_version IS NOT NEW.approved_content_version
  OR OLD.publication_targets_json IS NOT NEW.publication_targets_json
  OR OLD.event_fingerprint IS NOT NEW.event_fingerprint
  OR OLD.created_at IS NOT NEW.created_at
BEGIN SELECT RAISE(ABORT, 'approval publisher snapshot is immutable'); END`;

class MutableClock {
  constructor(private value: string) {}
  now(): Date { return new Date(this.value); }
  set(value: string): void { this.value = value; }
}

let clock: MutableClock;

async function clearDatabase(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM fake_publisher_deliveries"),
    env.DB.prepare("DELETE FROM approval_publisher_outbox"),
    env.DB.prepare("DELETE FROM approval_security_audits"),
    env.DB.prepare("DELETE FROM fake_approval_notification_deliveries"),
    env.DB.prepare("DELETE FROM fake_approval_notification_outbox"),
    env.DB.prepare("DELETE FROM approval_decision_claims"),
    env.DB.prepare("DELETE FROM approval_requests"),
    env.DB.prepare("DELETE FROM fake_approval_allowlist"),
    env.DB.prepare("DELETE FROM dlq_messages"),
    env.DB.prepare("DELETE FROM queue_deliveries"),
    env.DB.prepare("DELETE FROM upload_receipt_events"),
    env.DB.prepare("DELETE FROM completed_upload_checksum_claims"),
    env.DB.prepare("DELETE FROM fake_upload_sessions"),
    env.DB.prepare("DELETE FROM fake_notification_outbox"),
    env.DB.prepare("DELETE FROM intake_audit_logs"),
    env.DB.prepare("DELETE FROM submission_candidate_snapshots"),
    env.DB.prepare("DELETE FROM submission_intakes"),
    env.DB.prepare("DELETE FROM mirror_outbox"),
    env.DB.prepare("DELETE FROM audit_logs"),
    env.DB.prepare("DELETE FROM idempotency_records"),
    env.DB.prepare("DELETE FROM applied_mutations"),
    env.DB.prepare("DELETE FROM video_jobs"),
  ]);
}

async function seedJob(
  suffix: number,
  state: JobState = "WAITING_APPROVAL",
  options: { intakeStatus?: string; uploadStatus?: string; includeReceipt?: boolean; candidateMatches?: boolean } = {},
) {
  const submissionId = uuid(10_000 + suffix);
  const videoJobId = uuid(suffix);
  const uploadId = uuid(20_000 + suffix);
  const eventId = uuid(30_000 + suffix);
  const objectRef = `fake_object_${suffix}`;
  const checksum = digest(100 + suffix);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO submission_intakes (
         submission_id, intended_video_job_id, request_fingerprint,
         subject_fingerprint, teacher_id, lesson_on, status,
         decision_fingerprint, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'teacher_e4_dummy', '2026-08-25', ?, ?, ?, ?)`,
    ).bind(
      submissionId, videoJobId, digest(1 + suffix), digest(2 + suffix),
      options.intakeStatus ?? "RESOLVED", digest(3 + suffix), BASE, BASE,
    ),
    env.DB.prepare(
      `INSERT INTO submission_candidate_snapshots (
         submission_id, class_id, branch_id, studio_id, teacher_id, source_version
       ) VALUES (?, ?, 'branch_e4_dummy', 'studio_e4_dummy', 'teacher_e4_dummy', 1)`,
    ).bind(submissionId, options.candidateMatches === false ? "class_other" : "class_e4_dummy"),
    env.DB.prepare(
      `INSERT INTO fake_upload_sessions (
         submission_id, upload_id, request_fingerprint, expected_object_ref,
         expected_size_bytes, expected_checksum_sha256, expected_content_type,
         expires_at, status, completion_event_id, completed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1024, ?, 'video/mp4', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      submissionId, uploadId, digest(4 + suffix), objectRef, checksum,
      "2026-08-25T00:15:00.000Z", options.uploadStatus ?? "COMPLETED",
      options.uploadStatus === "PENDING" ? null : eventId,
      options.uploadStatus === "PENDING" ? null : BASE,
      BASE, BASE,
    ),
    env.DB.prepare(
      `INSERT INTO video_jobs (
         video_job_id, submission_id, branch_id, studio_id, class_id, teacher_id,
         state, creation_token, creation_fingerprint, created_at, updated_at
       ) VALUES (?, ?, 'branch_e4_dummy', 'studio_e4_dummy', 'class_e4_dummy',
                 'teacher_e4_dummy', ?, ?, ?, ?, ?)`,
    ).bind(videoJobId, submissionId, state, `creation_e4_${suffix}`, digest(5 + suffix), BASE, BASE),
  ]);
  if (options.includeReceipt !== false) {
    await env.DB.prepare(
      `INSERT INTO upload_receipt_events (
         event_id, submission_id, object_ref, event_type, receipt_fingerprint, occurred_at
       ) VALUES (?, ?, ?, 'video.uploaded', ?, ?)`,
    ).bind(eventId, submissionId, objectRef, digest(6 + suffix), BASE).run();
  }
  await env.DB.prepare(
    "UPDATE submission_intakes SET video_job_id = ? WHERE submission_id = ?",
  ).bind(videoJobId, submissionId).run();
  return { videoJobId, submissionId };
}

async function readyService(suffix = 1) {
  const ids = await seedJob(suffix);
  const service = new E4FakeApprovalService(env.DB, clock);
  await service.setApprover({
    approverId: "approver_fake_a", active: true, changedBy: "operator_fake",
  });
  const request = await service.requestApproval({
    videoJobId: ids.videoJobId, content: CONTENT, publicationTargets: TARGETS,
  });
  return { service, request, ...ids };
}

async function postback(
  service: E4FakeApprovalService,
  requestId: string,
  action: "APPROVE" | "REJECT",
  id: number,
  approverId = "approver_fake_a",
) {
  return service.buildFakePostback({
    approvalRequestId: requestId, approverId, action, postbackId: uuid(id),
  });
}

describe("E-4.1 local/fake approval contract", () => {
  beforeEach(async () => {
    await clearDatabase();
    clock = new MutableClock(BASE);
  });

  it("approves only a persisted eligible snapshot and creates one version, audit, publisher event, and target fence", async () => {
    const { service, request, videoJobId } = await readyService();
    const decision = await service.handlePostback(
      await postback(service, request.approvalRequestId, "APPROVE", 40_001),
    );
    expect(decision).toMatchObject({ decision: "APPROVED", duplicate: false });
    expect(decision.approvedContentVersion).toMatch(/^acv_[0-9a-f]{64}$/);
    expect(await service.assertApprovedSnapshot({
      approvalRequestId: request.approvalRequestId,
      content: CONTENT,
      publicationTargets: [...TARGETS].reverse(),
    })).toBe(decision.approvedContentVersion);
    const counts = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM approval_requests WHERE status = 'APPROVED') requests,
        (SELECT COUNT(*) FROM approval_decision_claims) decision_claims,
        (SELECT COUNT(*) FROM audit_logs WHERE action = 'approval.granted'
          AND actor_id = 'approver_fake_a' AND video_job_id = ?) approval_audits,
        (SELECT COUNT(*) FROM approval_publisher_outbox) publisher_events,
        (SELECT COUNT(*) FROM idempotency_records) target_fences,
        (SELECT state FROM video_jobs WHERE video_job_id = ?) job_state`,
    ).bind(videoJobId, videoJobId).first();
    expect(counts).toEqual({
      requests: 1, decision_claims: 1, approval_audits: 1, publisher_events: 1,
      target_fences: 2, job_state: "APPROVED",
    });
    const audit = await env.DB.prepare(
      "SELECT occurred_at, details_json FROM audit_logs WHERE action = 'approval.granted'",
    ).first<{ occurred_at: string; details_json: string }>();
    expect(audit?.occurred_at).toBe(BASE);
    expect(JSON.parse(audit!.details_json)).toMatchObject({
      approved_content_version: decision.approvedContentVersion,
      publication_targets: [TARGETS[1], TARGETS[0]],
    });
    expect(await env.DB.prepare(
      `SELECT COUNT(*) leaks
       FROM audit_logs a
       JOIN fake_approval_notification_outbox n
         ON instr(a.details_json, n.operation_token) > 0
         OR instr(a.actor_id, n.operation_token) > 0
         OR instr(a.action, n.operation_token) > 0`,
    ).first()).toEqual({ leaks: 0 });
  });

  it("returns the same token-free request result for retry and rotates the internal token after expiry", async () => {
    const { videoJobId } = await seedJob(2);
    const service = new E4FakeApprovalService(env.DB, clock);
    const first = await service.requestApproval({
      videoJobId, content: CONTENT, publicationTargets: TARGETS,
    });
    clock.set("2026-08-25T00:01:00.000Z");
    const retry = await service.requestApproval({
      videoJobId, content: CONTENT, publicationTargets: [...TARGETS].reverse(),
    });
    expect(retry).toEqual(first);
    expect("operationToken" in first).toBe(false);
    expect(first.approvalRequestId).not.toContain(first.contentFingerprint);
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM approval_requests").first())
      .toEqual({ count: 1 });

    clock.set("2026-08-25T00:15:01.000Z");
    const renewed = await service.requestApproval({
      videoJobId, content: CONTENT, publicationTargets: TARGETS,
    });
    expect(renewed.approvalRequestId).not.toBe(first.approvalRequestId);
    expect("operationToken" in renewed).toBe(false);
    expect(await env.DB.prepare(
      "SELECT status, COUNT(*) count FROM approval_requests GROUP BY status ORDER BY status",
    ).all()).toMatchObject({ results: [
      { status: "EXPIRED", count: 1 }, { status: "PENDING", count: 1 },
    ] });
    expect(await env.DB.prepare(
      `SELECT status, COUNT(*) count FROM fake_approval_notification_outbox
       GROUP BY status ORDER BY status`,
    ).all()).toMatchObject({ results: [
      { status: "CANCELLED", count: 1 }, { status: "PENDING", count: 1 },
    ] });
    expect(await env.DB.prepare(
      `SELECT
        (SELECT COUNT(DISTINCT operation_token_hash) FROM approval_requests) token_hashes,
        (SELECT COUNT(DISTINCT operation_token) FROM fake_approval_notification_outbox) fake_tokens`,
    ).first()).toEqual({ token_hashes: 2, fake_tokens: 2 });
  });

  it("delivers one fake approval notification and recovers after send-before-ack stop", async () => {
    const { service } = await readyService(3);
    const receiver = new D1FakeApprovalNotificationAdapter(env.DB, async () => {
      throw new Error("simulated response loss after notification acceptance");
    });
    await expect(service.flushFakeApprovalNotifications(receiver))
      .rejects.toThrow("simulated response loss after notification acceptance");
    clock.set("2026-08-25T00:01:01.000Z");
    expect(await service.flushFakeApprovalNotifications(receiver)).toBe(1);
    expect(await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM fake_approval_notification_deliveries) deliveries,
        (SELECT COUNT(*) FROM fake_approval_notification_outbox WHERE status = 'DELIVERED') delivered_outbox`,
    ).first()).toEqual({ deliveries: 1, delivered_outbox: 1 });
  });

  it("expires and cancels an overdue notification at flush without delivering it", async () => {
    const { service } = await readyService(4);
    const receiver = { accept: vi.fn(async () => {}) };
    clock.set("2026-08-25T00:15:00.000Z");
    expect(await service.flushFakeApprovalNotifications(receiver)).toBe(0);
    expect(receiver.accept).not.toHaveBeenCalled();
    expect(await env.DB.prepare(
      `SELECT
        (SELECT status FROM approval_requests) request_status,
        (SELECT status FROM fake_approval_notification_outbox) notification_status,
        (SELECT COUNT(*) FROM fake_approval_notification_deliveries) deliveries`,
    ).first()).toEqual({
      request_status: "EXPIRED", notification_status: "CANCELLED", deliveries: 0,
    });
  });

  it("fails closed when a notification ID is already bound to another payload", async () => {
    const { service } = await readyService(5);
    const notification = await env.DB.prepare(
      "SELECT notification_id FROM fake_approval_notification_outbox",
    ).first<{ notification_id: string }>();
    await env.DB.prepare(
      `INSERT INTO fake_approval_notification_deliveries (
         notification_id, payload_fingerprint, delivered_at
       ) VALUES (?, ?, ?)`,
    ).bind(notification!.notification_id, digest(9991), BASE).run();
    await expect(service.flushFakeApprovalNotifications())
      .rejects.toMatchObject({ code: "FAKE_NOTIFICATION_ID_COLLISION" });
    expect(await env.DB.prepare(
      "SELECT status FROM fake_approval_notification_outbox",
    ).first()).toEqual({ status: "SENDING" });
  });

  it("recomputes the notification fingerprint and rejects a modified delivered payload", async () => {
    const { service } = await readyService(6);
    const receiver = new D1FakeApprovalNotificationAdapter(env.DB);
    const tamperingReceiver = {
      accept: (notification: FakeApprovalNotificationDelivery, acceptedAt: string) =>
        receiver.accept({ ...notification, operationToken: `${notification.operationToken}_changed` }, acceptedAt),
    };
    await expect(service.flushFakeApprovalNotifications(tamperingReceiver))
      .rejects.toMatchObject({ code: "FAKE_NOTIFICATION_PAYLOAD_TAMPERED" });
    expect(await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM fake_approval_notification_deliveries) deliveries,
        (SELECT status FROM fake_approval_notification_outbox) outbox_status`,
    ).first()).toEqual({ deliveries: 0, outbox_status: "SENDING" });
  });

  it("rejects a coherently changed notification outbox after validation and before claim", async () => {
    const { service, request } = await readyService(7);
    const row = await env.DB.prepare(
      `SELECT n.notification_id, r.video_job_id, r.content_fingerprint,
              r.targets_fingerprint, r.expires_at
       FROM fake_approval_notification_outbox n
       JOIN approval_requests r ON r.approval_request_id = n.approval_request_id`,
    ).first<{
      notification_id: string; video_job_id: string; content_fingerprint: string;
      targets_fingerprint: string; expires_at: string;
    }>();
    const changedToken = "fake_token_changed_after_validation";
    const changedPayloadFingerprint = await canonicalFingerprint({
      notification_id: row!.notification_id,
      approval_request_id: request.approvalRequestId,
      operation_token_hash: await sha256Hex(changedToken),
      video_job_id: row!.video_job_id,
      content_fingerprint: row!.content_fingerprint,
      targets_fingerprint: row!.targets_fingerprint,
      expires_at: row!.expires_at,
    });
    try {
      await expect(service.flushFakeApprovalNotifications(undefined, {
        afterValidation: async () => {
          await env.DB.exec("DROP TRIGGER trg_fake_approval_notification_snapshot_immutable");
          await env.DB.prepare(
            `UPDATE fake_approval_notification_outbox
             SET operation_token = ?, payload_fingerprint = ?`,
          ).bind(changedToken, changedPayloadFingerprint).run();
        },
      })).rejects.toMatchObject({ code: "OUTBOX_TAMPERED" });
      expect(await env.DB.prepare(
        `SELECT
          (SELECT COUNT(*) FROM fake_approval_notification_deliveries) deliveries,
          (SELECT status FROM fake_approval_notification_outbox) outbox_status,
          (SELECT COUNT(*) FROM approval_security_audits
            WHERE reason_code = 'OUTBOX_TAMPERED') tamper_audits`,
      ).first()).toEqual({ deliveries: 0, outbox_status: "PENDING", tamper_audits: 1 });
    } finally {
      await env.DB.prepare(NOTIFICATION_TRIGGER_SQL).run();
    }
  });

  it("rejects without creating an approved version or publisher work", async () => {
    const { service, request, videoJobId } = await readyService();
    const decision = await service.handlePostback(
      await postback(service, request.approvalRequestId, "REJECT", 40_002),
    );
    expect(decision).toMatchObject({
      decision: "REJECTED", approvedContentVersion: null, duplicate: false,
    });
    expect(await env.DB.prepare(
      `SELECT state, approved_content_version, retention_state
       FROM video_jobs WHERE video_job_id = ?`,
    ).bind(videoJobId).first()).toEqual({
      state: "REJECTED", approved_content_version: null, retention_state: "RETAINED",
    });
    expect(await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM approval_publisher_outbox) publisher_events,
        (SELECT COUNT(*) FROM idempotency_records) target_fences,
        (SELECT COUNT(*) FROM audit_logs WHERE action = 'approval.rejected') rejection_audits`,
    ).first()).toEqual({ publisher_events: 0, target_fences: 0, rejection_audits: 1 });
  });

  it("allows only active fake allowlist IDs and audits absent, disabled, and malformed actors without storing raw invalid IDs", async () => {
    const { service, request } = await readyService();
    await service.setApprover({
      approverId: "approver_fake_disabled", active: false, changedBy: "operator_fake",
    });
    for (const [approverId, code, id] of [
      ["approver_fake_unknown", "APPROVER_NOT_ALLOWED", 41_001],
      ["approver_fake_disabled", "APPROVER_DISABLED", 41_002],
      ["invalid@example.invalid", "APPROVER_ID_INVALID", 41_003],
    ] as const) {
      const candidate = await postback(
        service, request.approvalRequestId, "APPROVE", id, approverId,
      );
      await expect(service.handlePostback(candidate)).rejects.toMatchObject({ code });
    }
    expect(await env.DB.prepare(
      "SELECT reason_code FROM approval_security_audits ORDER BY occurred_at, reason_code",
    ).all()).toMatchObject({
      results: expect.arrayContaining([
        { reason_code: "APPROVER_NOT_ALLOWED" },
        { reason_code: "APPROVER_DISABLED" },
        { reason_code: "APPROVER_ID_INVALID" },
      ]),
    });
    const serialized = JSON.stringify(await env.DB.prepare(
      "SELECT * FROM approval_security_audits",
    ).all());
    expect(serialized).not.toContain("invalid@example.invalid");
  });

  it("rejects unknown, expired, changed-claim, and cross-job token use", async () => {
    const first = await readyService(11);
    const unknown = await postback(
      first.service, first.request.approvalRequestId, "APPROVE", 42_001,
    );
    unknown.operationToken = "fake_token_unknown";
    await expect(first.service.handlePostback(unknown)).rejects.toMatchObject({ code: "TOKEN_UNKNOWN" });

    const tampered = await postback(
      first.service, first.request.approvalRequestId, "APPROVE", 42_002,
    );
    tampered.targetsFingerprint = digest(999);
    await expect(first.service.handlePostback(tampered)).rejects.toMatchObject({ code: "POSTBACK_TAMPERED" });

    const second = await seedJob(12);
    const crossJob = await postback(
      first.service, first.request.approvalRequestId, "APPROVE", 42_003,
    );
    crossJob.videoJobId = second.videoJobId;
    await expect(first.service.handlePostback(crossJob)).rejects.toMatchObject({ code: "POSTBACK_TAMPERED" });

    clock.set("2026-08-25T00:15:00.000Z");
    const expired = await postback(
      first.service, first.request.approvalRequestId, "APPROVE", 42_004,
    );
    await expect(first.service.handlePostback(expired)).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
    expect(await env.DB.prepare(
      "SELECT status FROM approval_requests WHERE approval_request_id = ?",
    ).bind(first.request.approvalRequestId).first()).toEqual({ status: "EXPIRED" });
  });

  it("returns one decision for replay, multi-click, concurrency, and approve/reject races", async () => {
    const first = await readyService(21);
    const approve = await postback(
      first.service, first.request.approvalRequestId, "APPROVE", 43_001,
    );
    const [a, b, c] = await Promise.all([
      first.service.handlePostback(approve),
      first.service.handlePostback({ ...approve }),
      first.service.handlePostback({ ...approve, postbackId: uuid(43_002) }),
    ]);
    expect([a, b, c].every((result) => result.decision === "APPROVED")).toBe(true);
    const firstCounts = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM audit_logs WHERE action = 'approval.granted') audits,
        (SELECT COUNT(*) FROM approval_publisher_outbox) publisher_events,
        (SELECT COUNT(*) FROM approval_requests WHERE status = 'APPROVED') decisions`,
    ).first();
    expect(firstCounts).toEqual({ audits: 1, publisher_events: 1, decisions: 1 });

    await clearDatabase();
    const race = await readyService(22);
    const [approveResult, rejectResult] = await Promise.all([
      race.service.handlePostback(await postback(
        race.service, race.request.approvalRequestId, "APPROVE", 43_003,
      )),
      race.service.handlePostback(await postback(
        race.service, race.request.approvalRequestId, "REJECT", 43_004,
      )),
    ]);
    expect(approveResult.decision).toBe(rejectResult.decision);
    expect(await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM approval_requests WHERE status IN ('APPROVED', 'REJECTED')) decisions,
        (SELECT COUNT(*) FROM audit_logs WHERE action IN ('approval.granted', 'approval.rejected')) audits`,
    ).first()).toEqual({ decisions: 1, audits: 1 });
  });

  it("returns an exact finalized replay after allowlist revocation but rejects a changed replay", async () => {
    const { service, request } = await readyService(23);
    const original = await postback(
      service, request.approvalRequestId, "APPROVE", 43_101,
    );
    await service.handlePostback(original);
    await service.setApprover({
      approverId: "approver_fake_a", active: false, changedBy: "operator_fake",
    });
    await expect(service.handlePostback({ ...original })).resolves.toMatchObject({
      decision: "APPROVED", duplicate: true,
    });
    await expect(service.handlePostback({
      ...original, postbackId: uuid(43_102),
    })).rejects.toMatchObject({ code: "APPROVER_DISABLED" });
    expect(await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM approval_requests WHERE status = 'APPROVED') decisions,
        (SELECT COUNT(*) FROM audit_logs WHERE action = 'approval.granted') audits,
        (SELECT COUNT(*) FROM approval_publisher_outbox) publisher_events`,
    ).first()).toEqual({ decisions: 1, audits: 1, publisher_events: 1 });
  });

  it("rechecks allowlist atomically when claiming a decision intent", async () => {
    const ids = await seedJob(24);
    const service = new E4FakeApprovalService(env.DB, clock, {
      afterAuthorizationCheck: async () => {
        await env.DB.prepare(
          "UPDATE fake_approval_allowlist SET active = 0 WHERE approver_id = 'approver_fake_a'",
        ).run();
      },
    });
    await service.setApprover({
      approverId: "approver_fake_a", active: true, changedBy: "operator_fake",
    });
    const request = await service.requestApproval({
      videoJobId: ids.videoJobId, content: CONTENT, publicationTargets: TARGETS,
    });
    await expect(service.handlePostback(await postback(
      service, request.approvalRequestId, "APPROVE", 43_201,
    ))).rejects.toMatchObject({ code: "APPROVER_DISABLED" });
    expect(await env.DB.prepare(
      `SELECT
        (SELECT state FROM video_jobs WHERE video_job_id = ?) job_state,
        (SELECT status FROM approval_requests) request_status,
        (SELECT COUNT(*) FROM approval_publisher_outbox) publisher_events,
        (SELECT COUNT(*) FROM approval_security_audits
          WHERE reason_code = 'APPROVER_DISABLED') disabled_audits`,
    ).bind(ids.videoJobId).first()).toEqual({
      job_state: "WAITING_APPROVAL", request_status: "PENDING",
      publisher_events: 0, disabled_audits: 1,
    });
  });

  it("normalizes an expiry flush racing with decision intent to APPROVAL_EXPIRED", async () => {
    const ids = await seedJob(25);
    let service!: E4FakeApprovalService;
    service = new E4FakeApprovalService(env.DB, clock, {
      afterAuthorizationCheck: async () => {
        clock.set("2026-08-25T00:15:00.000Z");
        expect(await service.flushFakeApprovalNotifications()).toBe(0);
      },
    });
    await service.setApprover({
      approverId: "approver_fake_a", active: true, changedBy: "operator_fake",
    });
    const request = await service.requestApproval({
      videoJobId: ids.videoJobId, content: CONTENT, publicationTargets: TARGETS,
    });
    await expect(service.handlePostback(await postback(
      service, request.approvalRequestId, "APPROVE", 43_301,
    ))).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
    expect(await env.DB.prepare(
      `SELECT
        (SELECT state FROM video_jobs WHERE video_job_id = ?) job_state,
        (SELECT status FROM approval_requests) request_status,
        (SELECT COUNT(*) FROM approval_publisher_outbox) publisher_events,
        (SELECT COUNT(*) FROM approval_security_audits
          WHERE reason_code = 'APPROVAL_EXPIRED') expiry_audits`,
    ).bind(ids.videoJobId).first()).toEqual({
      job_state: "WAITING_APPROVAL", request_status: "EXPIRED",
      publisher_events: 0, expiry_audits: 1,
    });
  });

  it("makes every persisted approval snapshot field immutable in D1", async () => {
    const { request } = await readyService(26);
    const mutations = [
      "approval_request_id = 'changed_request'",
      `video_job_id = '${uuid(999_026)}'`,
      "request_fingerprint = printf('%064d', 901)",
      "content_fingerprint = printf('%064d', 902)",
      "targets_fingerprint = printf('%064d', 903)",
      "object_ref = 'changed_object'",
      "checksum_sha256 = printf('%064d', 904)",
      "content_json = json_set(content_json, '$.caption', 'changed')",
      "publication_targets_json = json_set(publication_targets_json, '$[0].targetAccountId', 'changed_account')",
      "operation_token_hash = printf('%064d', 905)",
      "expires_at = '2026-08-25T00:16:00.000Z'",
      "created_at = '2026-08-25T00:00:01.000Z'",
    ];
    for (const mutation of mutations) {
      await expect(env.DB.prepare(
        `UPDATE approval_requests SET ${mutation} WHERE approval_request_id = ?`,
      ).bind(request.approvalRequestId).run())
        .rejects.toThrow("approval request snapshot is immutable");
    }
    expect(await env.DB.prepare(
      "SELECT object_ref, status FROM approval_requests WHERE approval_request_id = ?",
    ).bind(request.approvalRequestId).first()).toEqual({
      object_ref: "fake_object_26", status: "PENDING",
    });
  });

  it("makes notification and publisher outbox payloads immutable while allowing lease updates", async () => {
    const { service, request } = await readyService(261);
    await service.handlePostback(await postback(
      service, request.approvalRequestId, "APPROVE", 43_351,
    ));
    const notificationMutations = [
      "notification_id = 'changed_notification'",
      "approval_request_id = 'changed_request'",
      "operation_token = 'changed_token'",
      "payload_fingerprint = printf('%064d', 911)",
      "created_at = '2026-08-25T00:00:01.000Z'",
    ];
    for (const mutation of notificationMutations) {
      await expect(env.DB.prepare(
        `UPDATE fake_approval_notification_outbox SET ${mutation}`,
      ).run()).rejects.toThrow("approval notification snapshot is immutable");
    }
    const publisherMutations = [
      "publisher_event_id = 'changed_event'",
      "approval_request_id = 'changed_request'",
      `video_job_id = '${uuid(999_261)}'`,
      "approved_content_version = 'acv_changed'",
      "publication_targets_json = json_set(publication_targets_json, '$[0].targetAccountId', 'changed')",
      "event_fingerprint = printf('%064d', 912)",
      "created_at = '2026-08-25T00:00:01.000Z'",
    ];
    for (const mutation of publisherMutations) {
      await expect(env.DB.prepare(
        `UPDATE approval_publisher_outbox SET ${mutation}`,
      ).run()).rejects.toThrow("approval publisher snapshot is immutable");
    }
    await env.DB.prepare(
      "UPDATE approval_publisher_outbox SET attempt_count = attempt_count + 1, updated_at = ?",
    ).bind("2026-08-25T00:00:01.000Z").run();
    expect(await env.DB.prepare(
      "SELECT attempt_count FROM approval_publisher_outbox",
    ).first()).toEqual({ attempt_count: 1 });
  });

  it("rejects a direct PENDING-to-final decision bypass", async () => {
    const { request } = await readyService(262);
    await expect(env.DB.prepare(
      `UPDATE approval_requests SET status = 'APPROVED', decision_postback_id = ?,
         decided_action = 'APPROVE', decided_by = 'approver_fake_a', decided_at = ?,
         approved_content_version = ? WHERE approval_request_id = ?`,
    ).bind(
      uuid(43_352), BASE, `acv_${digest(913)}`, request.approvalRequestId,
    ).run()).rejects.toThrow("approval request decision transition is invalid");
    expect(await env.DB.prepare(
      "SELECT status, decision_postback_id FROM approval_requests",
    ).first()).toEqual({ status: "PENDING", decision_postback_id: null });
  });

  it("rejects a direct PENDING-to-DECIDING update without a decision claim", async () => {
    const { request } = await readyService(263);
    await expect(env.DB.prepare(
      `UPDATE approval_requests SET status = 'DECIDING', decision_postback_id = ?,
         decided_action = 'APPROVE', decided_by = 'unregistered_actor', decided_at = ?,
         approved_content_version = ? WHERE approval_request_id = ?`,
    ).bind(
      uuid(43_353), BASE, `acv_${digest(914)}`, request.approvalRequestId,
    ).run()).rejects.toThrow("approval request decision transition is invalid");
    expect(await env.DB.prepare(
      `SELECT
        (SELECT status FROM approval_requests) status,
        (SELECT COUNT(*) FROM approval_decision_claims) claims`,
    ).first()).toEqual({ status: "PENDING", claims: 0 });
  });

  it("rejects a forged DECIDING row backed by an invalid decision proof", async () => {
    const { service, request, videoJobId } = await readyService(264);
    const event = await postback(service, request.approvalRequestId, "APPROVE", 43_354);
    const row = await env.DB.prepare(
      `SELECT video_job_id, request_fingerprint, content_fingerprint,
              targets_fingerprint, operation_token_hash, object_ref, checksum_sha256
       FROM approval_requests WHERE approval_request_id = ?`,
    ).bind(request.approvalRequestId).first<{
      video_job_id: string; request_fingerprint: string; content_fingerprint: string;
      targets_fingerprint: string; operation_token_hash: string;
      object_ref: string; checksum_sha256: string;
    }>();
    const approvedVersion = `acv_${await canonicalFingerprint({
      video_job_id: row!.video_job_id,
      object_ref: row!.object_ref,
      checksum_sha256: row!.checksum_sha256,
      content_fingerprint: row!.content_fingerprint,
      targets_fingerprint: row!.targets_fingerprint,
    })}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO approval_decision_claims (
           approval_request_id, decision_postback_id, decided_action, decided_by,
           decided_at, approved_content_version, video_job_id, request_fingerprint,
           content_fingerprint, targets_fingerprint, operation_token_hash,
           intent_proof, created_at
         ) VALUES (?, ?, 'APPROVE', 'approver_fake_a', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        request.approvalRequestId, event.postbackId, BASE, approvedVersion,
        row!.video_job_id, row!.request_fingerprint, row!.content_fingerprint,
        row!.targets_fingerprint, row!.operation_token_hash, digest(9998), BASE,
      ),
      env.DB.prepare(
        `UPDATE approval_requests SET status = 'DECIDING', decision_postback_id = ?,
           decided_action = 'APPROVE', decided_by = 'approver_fake_a', decided_at = ?,
           approved_content_version = ? WHERE approval_request_id = ?`,
      ).bind(event.postbackId, BASE, approvedVersion, request.approvalRequestId),
    ]);
    await expect(service.handlePostback(event))
      .rejects.toMatchObject({ code: "SNAPSHOT_TAMPERED" });
    expect(await env.DB.prepare(
      `SELECT
        (SELECT state FROM video_jobs WHERE video_job_id = ?) job_state,
        (SELECT status FROM approval_requests) request_status,
        (SELECT COUNT(*) FROM approval_publisher_outbox) publisher_events,
        (SELECT COUNT(*) FROM approval_security_audits
          WHERE reason_code = 'SNAPSHOT_TAMPERED') tamper_audits`,
    ).bind(videoJobId).first()).toEqual({
      job_state: "WAITING_APPROVAL", request_status: "DECIDING",
      publisher_events: 0, tamper_audits: 1,
    });
  });

  it("recomputes a persisted snapshot and rejects corruption before decision", async () => {
    const { service, request, videoJobId } = await readyService(27);
    const event = await postback(service, request.approvalRequestId, "APPROVE", 43_401);
    const row = await env.DB.prepare(
      `SELECT video_job_id, object_ref, checksum_sha256, targets_fingerprint
       FROM approval_requests WHERE approval_request_id = ?`,
    ).bind(request.approvalRequestId).first<{
      video_job_id: string;
      object_ref: string;
      checksum_sha256: string;
      targets_fingerprint: string;
    }>();
    const changedContent = { ...CONTENT, caption: "整合するよう書き換えたダミー文面" };
    const changedContentFingerprint = await canonicalFingerprint({
      object_ref: row!.object_ref,
      checksum_sha256: row!.checksum_sha256,
      content: changedContent,
    });
    const changedRequestFingerprint = await canonicalFingerprint({
      operation: "approval.request",
      video_job_id: row!.video_job_id,
      content_fingerprint: changedContentFingerprint,
      targets_fingerprint: row!.targets_fingerprint,
    });
    await env.DB.exec("DROP TRIGGER trg_approval_requests_snapshot_immutable");
    try {
      await env.DB.prepare(
        `UPDATE approval_requests
         SET content_json = ?, content_fingerprint = ?, request_fingerprint = ?
         WHERE approval_request_id = ?`,
      ).bind(
        canonicalJson(changedContent), changedContentFingerprint,
        changedRequestFingerprint, request.approvalRequestId,
      ).run();
      await expect(service.handlePostback(event))
        .rejects.toMatchObject({ code: "SNAPSHOT_TAMPERED" });
      expect(await env.DB.prepare(
        `SELECT
          (SELECT state FROM video_jobs WHERE video_job_id = ?) job_state,
          (SELECT status FROM approval_requests) request_status,
          (SELECT COUNT(*) FROM approval_publisher_outbox) publisher_events,
          (SELECT COUNT(*) FROM approval_security_audits
            WHERE reason_code = 'SNAPSHOT_TAMPERED') tamper_audits`,
      ).bind(videoJobId).first()).toEqual({
        job_state: "WAITING_APPROVAL", request_status: "PENDING",
        publisher_events: 0, tamper_audits: 1,
      });
    } finally {
      await env.DB.prepare(SNAPSHOT_TRIGGER_SQL).run();
    }
  });

  it("binds verified snapshot fields into the atomic decision claim", async () => {
    const ids = await seedJob(28);
    let service!: E4FakeApprovalService;
    service = new E4FakeApprovalService(env.DB, clock, {
      afterAuthorizationCheck: async () => {
        await env.DB.exec("DROP TRIGGER trg_approval_requests_snapshot_immutable");
        await env.DB.prepare(
          "UPDATE approval_requests SET object_ref = 'changed_after_check'",
        ).run();
      },
    });
    await service.setApprover({
      approverId: "approver_fake_a", active: true, changedBy: "operator_fake",
    });
    const request = await service.requestApproval({
      videoJobId: ids.videoJobId, content: CONTENT, publicationTargets: TARGETS,
    });
    try {
      await expect(service.handlePostback(await postback(
        service, request.approvalRequestId, "APPROVE", 43_501,
      ))).rejects.toMatchObject({ code: "SNAPSHOT_TAMPERED" });
      expect(await env.DB.prepare(
        `SELECT
          (SELECT state FROM video_jobs WHERE video_job_id = ?) job_state,
          (SELECT status FROM approval_requests) request_status,
          (SELECT COUNT(*) FROM approval_publisher_outbox) publisher_events`,
      ).bind(ids.videoJobId).first()).toEqual({
        job_state: "WAITING_APPROVAL", request_status: "PENDING", publisher_events: 0,
      });
    } finally {
      await env.DB.prepare(SNAPSHOT_TRIGGER_SQL).run();
    }
  });

  it("recovers when execution stops after the job decision and before the publisher event", async () => {
    const ids = await seedJob(31);
    let stop = true;
    const interrupted = new E4FakeApprovalService(env.DB, clock, {
      afterJobDecision: async () => {
        if (stop) { stop = false; throw new Error("simulated stop"); }
      },
    });
    await interrupted.setApprover({ approverId: "approver_fake_a", active: true, changedBy: "operator_fake" });
    const request = await interrupted.requestApproval({
      videoJobId: ids.videoJobId, content: CONTENT, publicationTargets: TARGETS,
    });
    const event = await postback(interrupted, request.approvalRequestId, "APPROVE", 44_001);
    await expect(interrupted.handlePostback(event)).rejects.toThrow("simulated stop");
    expect(await env.DB.prepare("SELECT state FROM video_jobs").first()).toEqual({ state: "APPROVED" });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM approval_publisher_outbox").first()).toEqual({ count: 0 });
    const recovered = await interrupted.handlePostback(event);
    expect(recovered).toMatchObject({ decision: "APPROVED", duplicate: true });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM approval_publisher_outbox").first()).toEqual({ count: 1 });
  });

  it("recovers the persisted winning actor/action after a stop immediately after decision intent", async () => {
    const ids = await seedJob(32);
    let stop = true;
    const interrupted = new E4FakeApprovalService(env.DB, clock, {
      afterDecisionIntent: async () => {
        if (stop) { stop = false; throw new Error("simulated intent stop"); }
      },
    });
    await interrupted.setApprover({ approverId: "approver_fake_a", active: true, changedBy: "operator_fake" });
    await interrupted.setApprover({ approverId: "approver_fake_b", active: true, changedBy: "operator_fake" });
    const request = await interrupted.requestApproval({
      videoJobId: ids.videoJobId, content: CONTENT, publicationTargets: TARGETS,
    });
    const winner = await postback(interrupted, request.approvalRequestId, "APPROVE", 44_101, "approver_fake_a");
    await expect(interrupted.handlePostback(winner)).rejects.toThrow("simulated intent stop");
    await interrupted.setApprover({
      approverId: "approver_fake_a", active: false, changedBy: "operator_fake",
    });
    const loser = await postback(interrupted, request.approvalRequestId, "REJECT", 44_102, "approver_fake_b");
    const recovered = await interrupted.handlePostback(loser);
    expect(recovered.decision).toBe("APPROVED");
    expect(await env.DB.prepare(
      "SELECT decided_action, decided_by, decision_postback_id FROM approval_requests",
    ).first()).toEqual({
      decided_action: "APPROVE", decided_by: "approver_fake_a", decision_postback_id: winner.postbackId,
    });
    expect(await env.DB.prepare(
      "SELECT actor_id FROM audit_logs WHERE action = 'approval.granted'",
    ).first()).toEqual({ actor_id: "approver_fake_a" });
  });

  it("prevents direct winner-intent flips and preserves the first actor and action", async () => {
    const ids = await seedJob(33);
    let flipRejected = false;
    let claimMutationRejected = false;
    const service = new E4FakeApprovalService(env.DB, clock, {
      afterDecisionIntent: async () => {
        try {
          await env.DB.prepare(
            `UPDATE approval_requests SET decided_action = 'REJECT',
               decided_by = 'approver_fake_b', approved_content_version = NULL
             WHERE status = 'DECIDING'`,
          ).run();
        } catch (error) {
          expect(String(error)).toContain("approval request decision transition is invalid");
          flipRejected = true;
        }
        try {
          await env.DB.prepare(
            "UPDATE approval_decision_claims SET decided_by = 'approver_fake_b'",
          ).run();
        } catch (error) {
          expect(String(error)).toContain("approval decision claim is immutable");
          claimMutationRejected = true;
        }
      },
    });
    await service.setApprover({
      approverId: "approver_fake_a", active: true, changedBy: "operator_fake",
    });
    const request = await service.requestApproval({
      videoJobId: ids.videoJobId, content: CONTENT, publicationTargets: TARGETS,
    });
    const result = await service.handlePostback(await postback(
      service, request.approvalRequestId, "APPROVE", 44_201,
    ));
    expect(flipRejected).toBe(true);
    expect(claimMutationRejected).toBe(true);
    expect(result.decision).toBe("APPROVED");
    expect(await env.DB.prepare(
      "SELECT status, decided_action, decided_by FROM approval_requests",
    ).first()).toEqual({
      status: "APPROVED", decided_action: "APPROVE", decided_by: "approver_fake_a",
    });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM approval_publisher_outbox",
    ).first()).toEqual({ count: 1 });
  });

  it("deduplicates the fake publisher side effect after a stop before Queue completion", async () => {
    const { service, request } = await readyService(41);
    await service.handlePostback(await postback(
      service, request.approvalRequestId, "APPROVE", 45_001,
    ));
    const receiver = new D1FakePublisherAdapter(env.DB, async () => {
      throw new Error("simulated response loss after publisher acceptance");
    });
    await expect(service.flushFakePublisherOutbox(receiver))
      .rejects.toThrow("simulated response loss after publisher acceptance");
    clock.set("2026-08-25T00:01:01.000Z");
    expect(await service.flushFakePublisherOutbox(receiver)).toBe(1);
    expect(await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM fake_publisher_deliveries) deliveries,
        (SELECT COUNT(*) FROM approval_publisher_outbox WHERE status = 'DELIVERED') delivered_outbox`,
    ).first()).toEqual({ deliveries: 1, delivered_outbox: 1 });
  });

  it("fails closed when a publisher event ID is already bound to another payload", async () => {
    const { service, request } = await readyService(42);
    await service.handlePostback(await postback(
      service, request.approvalRequestId, "APPROVE", 45_101,
    ));
    const event = await env.DB.prepare(
      "SELECT publisher_event_id FROM approval_publisher_outbox",
    ).first<{ publisher_event_id: string }>();
    await env.DB.prepare(
      `INSERT INTO fake_publisher_deliveries (
         publisher_event_id, event_fingerprint, delivered_at
       ) VALUES (?, ?, ?)`,
    ).bind(event!.publisher_event_id, digest(9992), BASE).run();
    await expect(service.flushFakePublisherOutbox())
      .rejects.toMatchObject({ code: "FAKE_PUBLISHER_EVENT_ID_COLLISION" });
    expect(await env.DB.prepare(
      "SELECT status FROM approval_publisher_outbox",
    ).first()).toEqual({ status: "SENDING" });
  });

  it("recomputes the publisher fingerprint and rejects a modified delivered payload", async () => {
    const { service, request } = await readyService(43);
    await service.handlePostback(await postback(
      service, request.approvalRequestId, "APPROVE", 45_201,
    ));
    const receiver = new D1FakePublisherAdapter(env.DB);
    const tamperingReceiver = {
      accept: (event: FakePublisherDelivery, acceptedAt: string) =>
        receiver.accept({ ...event, videoJobId: uuid(999_999) }, acceptedAt),
    };
    await expect(service.flushFakePublisherOutbox(tamperingReceiver))
      .rejects.toMatchObject({ code: "FAKE_PUBLISHER_PAYLOAD_TAMPERED" });
    expect(await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM fake_publisher_deliveries) deliveries,
        (SELECT status FROM approval_publisher_outbox) outbox_status`,
    ).first()).toEqual({ deliveries: 0, outbox_status: "SENDING" });
  });

  it("rejects a coherently changed publisher outbox after validation and before claim", async () => {
    const { service, request } = await readyService(44);
    await service.handlePostback(await postback(
      service, request.approvalRequestId, "APPROVE", 45_301,
    ));
    const event = await env.DB.prepare(
      `SELECT publisher_event_id, approval_request_id, video_job_id, approved_content_version
       FROM approval_publisher_outbox`,
    ).first<{
      publisher_event_id: string; approval_request_id: string;
      video_job_id: string; approved_content_version: string;
    }>();
    const changedTargets: readonly PublicationTarget[] = [
      { destination: "tiktok", targetAccountId: "tiktok_changed_account" },
    ];
    const changedEventFingerprint = await canonicalFingerprint({
      event_type: "publish.requested",
      publisher_event_id: event!.publisher_event_id,
      approval_request_id: event!.approval_request_id,
      video_job_id: event!.video_job_id,
      approved_content_version: event!.approved_content_version,
      publication_targets: changedTargets,
    });
    try {
      await expect(service.flushFakePublisherOutbox(undefined, {
        afterValidation: async () => {
          await env.DB.exec("DROP TRIGGER trg_approval_publisher_snapshot_immutable");
          await env.DB.prepare(
            `UPDATE approval_publisher_outbox
             SET publication_targets_json = ?, event_fingerprint = ?`,
          ).bind(canonicalJson(changedTargets), changedEventFingerprint).run();
        },
      })).rejects.toMatchObject({ code: "OUTBOX_TAMPERED" });
      expect(await env.DB.prepare(
        `SELECT
          (SELECT COUNT(*) FROM fake_publisher_deliveries) deliveries,
          (SELECT status FROM approval_publisher_outbox) outbox_status,
          (SELECT COUNT(*) FROM approval_security_audits
            WHERE reason_code = 'OUTBOX_TAMPERED') tamper_audits`,
      ).first()).toEqual({ deliveries: 0, outbox_status: "PENDING", tamper_audits: 1 });
    } finally {
      await env.DB.prepare(PUBLISHER_TRIGGER_SQL).run();
    }
  });

  it("requires reapproval for changed content or targets and never reuses the approved version", async () => {
    const { service, request } = await readyService(51);
    await service.handlePostback(await postback(
      service, request.approvalRequestId, "APPROVE", 46_001,
    ));
    await expect(service.assertApprovedSnapshot({
      approvalRequestId: request.approvalRequestId,
      content: { ...CONTENT, caption: "変更後のダミー文面" },
      publicationTargets: TARGETS,
    })).rejects.toMatchObject({ code: "REAPPROVAL_REQUIRED" });
    await expect(service.assertApprovedSnapshot({
      approvalRequestId: request.approvalRequestId,
      content: CONTENT,
      publicationTargets: [{ destination: "youtube", targetAccountId: "youtube_fake_account" }],
    })).rejects.toMatchObject({ code: "REAPPROVAL_REQUIRED" });
    await expect(service.requestApproval({
      videoJobId: request.videoJobId,
      content: { ...CONTENT, caption: "変更後のダミー文面" },
      publicationTargets: TARGETS,
    })).rejects.toMatchObject({ code: "REAPPROVAL_REQUIRED" });
  });

  it("rejects every ineligible job state and incomplete intake/upload prerequisite", async () => {
    const cases: Array<[number, JobState, Parameters<typeof seedJob>[2]]> = [
      [61, "VALIDATION_FAILED", {}],
      [62, "CLASS_UNRESOLVED", {}],
      [63, "PROCESSING", {}],
      [64, "REJECTED", {}],
      [65, "WAITING_APPROVAL", { uploadStatus: "PENDING", includeReceipt: false }],
      [66, "WAITING_APPROVAL", { intakeStatus: "UNRESOLVED" }],
      [67, "WAITING_APPROVAL", { candidateMatches: false }],
    ];
    for (const [suffix, state, options] of cases) {
      const { videoJobId } = await seedJob(suffix, state, options);
      const service = new E4FakeApprovalService(env.DB, clock);
      await expect(service.requestApproval({
        videoJobId, content: CONTENT, publicationTargets: TARGETS,
      })).rejects.toMatchObject({ code: "JOB_NOT_APPROVAL_ELIGIBLE" });
    }
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM approval_requests").first()).toEqual({ count: 0 });
  });

  it("rejects publication controls and malformed target/content contracts before persistence", async () => {
    const { videoJobId } = await seedJob(71);
    const service = new E4FakeApprovalService(env.DB, clock);
    for (const forbidden of [
      { content: { ...CONTENT, privacyStatus: "public" } },
      { content: { ...CONTENT }, publicationTargets: [
        { destination: "youtube", targetAccountId: "youtube_fake_account", publishAt: BASE },
      ] },
      { content: { ...CONTENT }, publicationTargets: [
        { destination: "youtube", targetAccountId: "youtube_fake_account", privacyStatus: "unlisted" },
      ] },
    ]) {
      await expect(service.requestApproval({
        videoJobId,
        content: forbidden.content as ApprovalContentInput,
        publicationTargets: (forbidden.publicationTargets ?? TARGETS) as readonly PublicationTarget[],
      })).rejects.toBeInstanceOf(TypeError);
    }
    await expect(service.requestApproval({
      videoJobId,
      content: { ...CONTENT, processingResultFingerprint: "bad" },
      publicationTargets: TARGETS,
    })).rejects.toBeInstanceOf(TypeError);
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM approval_requests").first()).toEqual({ count: 0 });
  });
});
