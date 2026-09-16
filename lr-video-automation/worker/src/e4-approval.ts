import {
  assertInternalId,
  assertUuid,
  type MediaDestination,
  type PublicationTarget,
  type VideoJob,
} from "./domain";
import { DomainError } from "./errors";
import { canonicalFingerprint, canonicalJson, sha256Hex } from "./fingerprint";
import { JobRepository } from "./repository";

const APPROVAL_TTL_MS = 15 * 60 * 1_000;
const OUTBOX_LEASE_MS = 60 * 1_000;
const DESTINATIONS: readonly MediaDestination[] = ["youtube", "instagram", "tiktok"];

export interface ApprovalContentInput {
  caption: string;
  processedObjectRef?: string;
  processingResultFingerprint?: string;
}

export interface ApprovalRequestResult {
  approvalRequestId: string;
  videoJobId: string;
  contentFingerprint: string;
  targetsFingerprint: string;
  expiresAt: string;
}

export interface FakeApprovalPostback {
  postbackId: string;
  approvalRequestId: string;
  operationToken: string;
  videoJobId: string;
  contentFingerprint: string;
  targetsFingerprint: string;
  approverId: string;
  action: "APPROVE" | "REJECT";
}

export interface ApprovalDecisionResult {
  approvalRequestId: string;
  videoJobId: string;
  decision: "APPROVED" | "REJECTED";
  approvedContentVersion: string | null;
  publicationTargets: readonly PublicationTarget[];
  duplicate: boolean;
}

interface TrustedClock { now(): Date }
const systemClock: TrustedClock = { now: () => new Date() };

export interface FakeApprovalNotificationDelivery {
  notificationId: string;
  approvalRequestId: string;
  operationToken: string;
  videoJobId: string;
  contentFingerprint: string;
  targetsFingerprint: string;
  expiresAt: string;
  payloadFingerprint: string;
}

export interface FakePublisherDelivery {
  publisherEventId: string;
  approvalRequestId: string;
  videoJobId: string;
  approvedContentVersion: string;
  publicationTargets: readonly PublicationTarget[];
  eventFingerprint: string;
}

/** Receiving-side fake. Stable IDs are the idempotency contract, not sender timing. */
export class D1FakeApprovalNotificationAdapter {
  constructor(
    private readonly db: D1Database,
    private readonly afterAccepted?: () => Promise<void>,
  ) {}

  async accept(notification: FakeApprovalNotificationDelivery, acceptedAt: string): Promise<void> {
    const actualFingerprint = await approvalNotificationFingerprint({
      notificationId: notification.notificationId,
      approvalRequestId: notification.approvalRequestId,
      operationTokenHash: await sha256Hex(notification.operationToken),
      videoJobId: notification.videoJobId,
      contentFingerprint: notification.contentFingerprint,
      targetsFingerprint: notification.targetsFingerprint,
      expiresAt: notification.expiresAt,
    });
    if (actualFingerprint !== notification.payloadFingerprint) {
      throw new ApprovalContractError("FAKE_NOTIFICATION_PAYLOAD_TAMPERED");
    }
    const result = await this.db.prepare(
      `INSERT INTO fake_approval_notification_deliveries (
         notification_id, payload_fingerprint, delivered_at
       ) VALUES (?, ?, ?) ON CONFLICT(notification_id) DO NOTHING`,
    ).bind(notification.notificationId, notification.payloadFingerprint, acceptedAt).run();
    const persisted = await this.db.prepare(
      `SELECT payload_fingerprint FROM fake_approval_notification_deliveries
       WHERE notification_id = ?`,
    ).bind(notification.notificationId).first<{ payload_fingerprint: string }>();
    if (persisted?.payload_fingerprint !== notification.payloadFingerprint) {
      throw new ApprovalContractError("FAKE_NOTIFICATION_ID_COLLISION");
    }
    if ((result.meta.changes ?? 0) === 1 && this.afterAccepted) {
      await this.afterAccepted();
    }
  }
}

/** Receiving-side fake publisher with the same stable-event-ID contract. */
export class D1FakePublisherAdapter {
  constructor(
    private readonly db: D1Database,
    private readonly afterAccepted?: () => Promise<void>,
  ) {}

  async accept(event: FakePublisherDelivery, acceptedAt: string): Promise<void> {
    const actualFingerprint = await publisherEventFingerprint({
      publisherEventId: event.publisherEventId,
      approvalRequestId: event.approvalRequestId,
      videoJobId: event.videoJobId,
      approvedContentVersion: event.approvedContentVersion,
      publicationTargets: event.publicationTargets,
    });
    if (actualFingerprint !== event.eventFingerprint) {
      throw new ApprovalContractError("FAKE_PUBLISHER_PAYLOAD_TAMPERED");
    }
    const result = await this.db.prepare(
      `INSERT INTO fake_publisher_deliveries (
         publisher_event_id, event_fingerprint, delivered_at
       ) VALUES (?, ?, ?) ON CONFLICT(publisher_event_id) DO NOTHING`,
    ).bind(event.publisherEventId, event.eventFingerprint, acceptedAt).run();
    const persisted = await this.db.prepare(
      `SELECT event_fingerprint FROM fake_publisher_deliveries
       WHERE publisher_event_id = ?`,
    ).bind(event.publisherEventId).first<{ event_fingerprint: string }>();
    if (persisted?.event_fingerprint !== event.eventFingerprint) {
      throw new ApprovalContractError("FAKE_PUBLISHER_EVENT_ID_COLLISION");
    }
    if ((result.meta.changes ?? 0) === 1 && this.afterAccepted) {
      await this.afterAccepted();
    }
  }
}

interface ApprovalRequestRow {
  approval_request_id: string;
  video_job_id: string;
  request_fingerprint: string;
  content_fingerprint: string;
  targets_fingerprint: string;
  object_ref: string;
  checksum_sha256: string;
  content_json: string;
  publication_targets_json: string;
  operation_token_hash: string;
  expires_at: string;
  status: "PENDING" | "DECIDING" | "APPROVED" | "REJECTED" | "EXPIRED";
  decision_postback_id: string | null;
  decided_action: "APPROVE" | "REJECT" | null;
  decided_by: string | null;
  decided_at: string | null;
  approved_content_version: string | null;
  created_at: string;
  updated_at: string;
}

interface ApprovalDecisionClaimRow {
  approval_request_id: string;
  decision_postback_id: string;
  decided_action: "APPROVE" | "REJECT";
  decided_by: string;
  decided_at: string;
  approved_content_version: string | null;
  video_job_id: string;
  request_fingerprint: string;
  content_fingerprint: string;
  targets_fingerprint: string;
  operation_token_hash: string;
  intent_proof: string;
  created_at: string;
}

interface NotificationOutboxCandidate {
  notification_id: string;
  approval_request_id: string;
  operation_token: string;
  payload_fingerprint: string;
  video_job_id: string;
  content_fingerprint: string;
  targets_fingerprint: string;
  expires_at: string;
}

interface PublisherOutboxCandidate {
  publisher_event_id: string;
  approval_request_id: string;
  video_job_id: string;
  approved_content_version: string;
  publication_targets_json: string;
  event_fingerprint: string;
}

interface EligibleJobRow {
  video_job_id: string;
  state: string;
  object_ref: string;
  checksum_sha256: string;
  eligible: number;
}

export class ApprovalContractError extends DomainError {
  constructor(code: string, retryable = false) {
    super("The fake approval contract rejected the operation", code, retryable);
  }
}

function now(clock: TrustedClock): { iso: string; milliseconds: number } {
  const value = clock.now();
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) throw new TypeError("Clock returned an invalid date");
  return { iso: value.toISOString(), milliseconds };
}

function normalizeContent(input: ApprovalContentInput): Required<ApprovalContentInput> {
  const contentKeys = Object.keys(input);
  if (contentKeys.some((key) => ![
    "caption", "processedObjectRef", "processingResultFingerprint",
  ].includes(key))) {
    throw new TypeError("content contains an unsupported field");
  }
  if (typeof input.caption !== "string" || input.caption.length < 1 || input.caption.length > 2_000) {
    throw new TypeError("caption must contain 1 to 2000 characters");
  }
  const processedObjectRef = input.processedObjectRef ?? "none";
  assertInternalId(processedObjectRef, "processedObjectRef");
  const processingResultFingerprint = input.processingResultFingerprint ?? "0".repeat(64);
  if (!/^[0-9a-f]{64}$/.test(processingResultFingerprint)) {
    throw new TypeError("processingResultFingerprint must be a lowercase SHA-256 digest");
  }
  return { caption: input.caption, processedObjectRef, processingResultFingerprint };
}

function normalizeTargets(input: readonly PublicationTarget[]): PublicationTarget[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > DESTINATIONS.length) {
    throw new TypeError("publicationTargets must contain one to three targets");
  }
  const seen = new Set<string>();
  const normalized = input.map((target) => {
    if (Object.keys(target).some((key) => !["destination", "targetAccountId"].includes(key))) {
      throw new TypeError("publication target contains an unsupported field");
    }
    if (!DESTINATIONS.includes(target.destination)) throw new TypeError("destination is invalid");
    assertInternalId(target.targetAccountId, "targetAccountId");
    const key = `${target.destination}:${target.targetAccountId}`;
    if (seen.has(key)) throw new TypeError("publicationTargets must be unique");
    seen.add(key);
    return { destination: target.destination, targetAccountId: target.targetAccountId };
  });
  return normalized.sort((left, right) =>
    `${left.destination}:${left.targetAccountId}`.localeCompare(
      `${right.destination}:${right.targetAccountId}`,
    ));
}

async function approvalNotificationFingerprint(input: {
  notificationId: string;
  approvalRequestId: string;
  operationTokenHash: string;
  videoJobId: string;
  contentFingerprint: string;
  targetsFingerprint: string;
  expiresAt: string;
}): Promise<string> {
  return canonicalFingerprint({
    notification_id: input.notificationId,
    approval_request_id: input.approvalRequestId,
    operation_token_hash: input.operationTokenHash,
    video_job_id: input.videoJobId,
    content_fingerprint: input.contentFingerprint,
    targets_fingerprint: input.targetsFingerprint,
    expires_at: input.expiresAt,
  });
}

async function publisherEventFingerprint(input: {
  publisherEventId: string;
  approvalRequestId: string;
  videoJobId: string;
  approvedContentVersion: string;
  publicationTargets: readonly PublicationTarget[];
}): Promise<string> {
  return canonicalFingerprint({
    event_type: "publish.requested",
    publisher_event_id: input.publisherEventId,
    approval_request_id: input.approvalRequestId,
    video_job_id: input.videoJobId,
    approved_content_version: input.approvedContentVersion,
    publication_targets: normalizeTargets(input.publicationTargets),
  });
}

async function decisionIntentProof(input: {
  approvalRequestId: string;
  decisionPostbackId: string;
  decidedAction: "APPROVE" | "REJECT";
  decidedBy: string;
  decidedAt: string;
  approvedContentVersion: string | null;
  videoJobId: string;
  requestFingerprint: string;
  contentFingerprint: string;
  targetsFingerprint: string;
  operationTokenHash: string;
}): Promise<string> {
  return canonicalFingerprint({
    operation: "approval.decision.claim",
    approval_request_id: input.approvalRequestId,
    decision_postback_id: input.decisionPostbackId,
    decided_action: input.decidedAction,
    decided_by: input.decidedBy,
    decided_at: input.decidedAt,
    approved_content_version: input.approvedContentVersion,
    video_job_id: input.videoJobId,
    request_fingerprint: input.requestFingerprint,
    content_fingerprint: input.contentFingerprint,
    targets_fingerprint: input.targetsFingerprint,
    operation_token_hash: input.operationTokenHash,
  });
}

function parseTargets(row: ApprovalRequestRow): PublicationTarget[] {
  return JSON.parse(row.publication_targets_json) as PublicationTarget[];
}

export class E4FakeApprovalService {
  private readonly jobs: JobRepository;

  constructor(
    private readonly db: D1Database,
    private readonly clock: TrustedClock = systemClock,
    private readonly interruption?: {
      afterAuthorizationCheck?(): Promise<void>;
      afterDecisionIntent?(): Promise<void>;
      afterJobDecision?(): Promise<void>;
    },
  ) {
    this.jobs = new JobRepository(db);
  }

  async setApprover(input: {
    approverId: string;
    active: boolean;
    changedBy: string;
  }): Promise<void> {
    assertInternalId(input.approverId, "approverId");
    assertInternalId(input.changedBy, "changedBy");
    const timestamp = now(this.clock).iso;
    await this.db.prepare(
      `INSERT INTO fake_approval_allowlist (
         approver_id, active, changed_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(approver_id) DO UPDATE SET
         active = excluded.active, changed_by = excluded.changed_by,
         updated_at = excluded.updated_at`,
    ).bind(
      input.approverId, input.active ? 1 : 0, input.changedBy, timestamp, timestamp,
    ).run();
  }

  async requestApproval(input: {
    videoJobId: string;
    content: ApprovalContentInput;
    publicationTargets: readonly PublicationTarget[];
  }): Promise<ApprovalRequestResult> {
    assertUuid(input.videoJobId, "videoJobId");
    const content = normalizeContent(input.content);
    const targets = normalizeTargets(input.publicationTargets);
    const eligible = await this.eligibleJob(input.videoJobId);
    if (!eligible || eligible.state !== "WAITING_APPROVAL" || eligible.eligible !== 1) {
      const existing = await this.getRequestForJob(input.videoJobId);
      if (existing?.status === "APPROVED") throw new ApprovalContractError("REAPPROVAL_REQUIRED");
      throw new ApprovalContractError("JOB_NOT_APPROVAL_ELIGIBLE");
    }
    const created = now(this.clock);
    const contentFingerprint = await canonicalFingerprint({
      object_ref: eligible.object_ref,
      checksum_sha256: eligible.checksum_sha256,
      content,
    });
    const targetsFingerprint = await canonicalFingerprint(targets);
    const requestFingerprint = await canonicalFingerprint({
      operation: "approval.request",
      video_job_id: input.videoJobId,
      content_fingerprint: contentFingerprint,
      targets_fingerprint: targetsFingerprint,
    });
    const active = await this.getActiveRequestForJob(input.videoJobId);
    if (active) {
      if (active.status === "PENDING" && created.milliseconds >= Date.parse(active.expires_at)) {
        await this.db.batch([
          this.db.prepare(
            `UPDATE approval_requests SET status = 'EXPIRED', updated_at = ?
             WHERE approval_request_id = ? AND status = 'PENDING' AND expires_at <= ?`,
          ).bind(created.iso, active.approval_request_id, created.iso),
          this.db.prepare(
            `UPDATE fake_approval_notification_outbox
             SET status = 'CANCELLED', lease_token = NULL, lease_expires_at = NULL,
                 updated_at = ?
             WHERE approval_request_id = ? AND status IN ('PENDING', 'SENDING')`,
          ).bind(created.iso, active.approval_request_id),
        ]);
      } else {
        if (active.request_fingerprint !== requestFingerprint) {
          throw new ApprovalContractError("APPROVAL_REQUEST_CHANGED");
        }
        return {
          approvalRequestId: active.approval_request_id,
          videoJobId: active.video_job_id,
          contentFingerprint: active.content_fingerprint,
          targetsFingerprint: active.targets_fingerprint,
          expiresAt: active.expires_at,
        };
      }
    }
    const expiresAt = new Date(created.milliseconds + APPROVAL_TTL_MS).toISOString();
    const operationToken = `fake_token_${crypto.randomUUID()}_${crypto.randomUUID()}`;
    const operationTokenHash = await sha256Hex(operationToken);
    const approvalRequestId = `e4_request_${crypto.randomUUID()}`;
    const notificationId = `e4_notification_${crypto.randomUUID()}`;
    const payloadFingerprint = await approvalNotificationFingerprint({
      notificationId,
      approvalRequestId,
      operationTokenHash,
      videoJobId: input.videoJobId,
      contentFingerprint,
      targetsFingerprint,
      expiresAt,
    });
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO approval_requests (
           approval_request_id, video_job_id, request_fingerprint,
           content_fingerprint, targets_fingerprint, object_ref, checksum_sha256,
           content_json, publication_targets_json, operation_token_hash,
           expires_at, created_at, updated_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM video_jobs WHERE video_job_id = ? AND state = 'WAITING_APPROVAL'
           )
         ON CONFLICT DO NOTHING`,
      ).bind(
        approvalRequestId, input.videoJobId, requestFingerprint,
        contentFingerprint, targetsFingerprint, eligible.object_ref, eligible.checksum_sha256,
        canonicalJson(content), canonicalJson(targets), operationTokenHash,
        expiresAt, created.iso, created.iso, input.videoJobId,
      ),
      this.db.prepare(
        `INSERT INTO fake_approval_notification_outbox (
           notification_id, approval_request_id, operation_token, payload_fingerprint,
           created_at, updated_at
         ) SELECT ?, approval_request_id, ?, ?, ?, ?
           FROM approval_requests WHERE approval_request_id = ?
         ON CONFLICT(approval_request_id) DO NOTHING`,
      ).bind(
        notificationId, operationToken, payloadFingerprint,
        created.iso, created.iso, approvalRequestId,
      ),
      this.db.prepare(
        `INSERT INTO audit_logs (
           audit_id, video_job_id, actor_type, actor_id, action,
           from_state, to_state, details_json, occurred_at
         ) SELECT ?, video_job_id, 'system', 'fake_approval_worker',
           'approval.requested', 'WAITING_APPROVAL', 'WAITING_APPROVAL', ?, ?
           FROM approval_requests WHERE approval_request_id = ?
         ON CONFLICT(audit_id) DO NOTHING`,
      ).bind(
        `audit_${approvalRequestId}`,
        canonicalJson({
          approval_request_id: approvalRequestId,
          content_fingerprint: contentFingerprint,
          targets_fingerprint: targetsFingerprint,
          expires_at: expiresAt,
        }),
        created.iso,
        approvalRequestId,
      ),
    ]);
    let persisted = await this.getRequest(approvalRequestId);
    if (!persisted) {
      // A concurrent identical request may have won the partial unique index.
      persisted = await this.getActiveRequestForJob(input.videoJobId);
    }
    if (!persisted) throw new ApprovalContractError("CONCURRENT_UPDATE", true);
    if (persisted.request_fingerprint !== requestFingerprint) {
      throw new ApprovalContractError("APPROVAL_REQUEST_CHANGED");
    }
    return {
      approvalRequestId: persisted.approval_request_id,
      videoJobId: input.videoJobId,
      contentFingerprint,
      targetsFingerprint,
      expiresAt: persisted.expires_at,
    };
  }

  async buildFakePostback(input: {
    approvalRequestId: string;
    approverId: string;
    action: "APPROVE" | "REJECT";
    postbackId: string;
  }): Promise<FakeApprovalPostback> {
    const request = await this.getRequest(input.approvalRequestId);
    if (!request) throw new ApprovalContractError("APPROVAL_REQUEST_NOT_FOUND");
    return {
      postbackId: input.postbackId,
      approvalRequestId: request.approval_request_id,
      operationToken: await this.fakeOperationToken(request.approval_request_id),
      videoJobId: request.video_job_id,
      contentFingerprint: request.content_fingerprint,
      targetsFingerprint: request.targets_fingerprint,
      approverId: input.approverId,
      action: input.action,
    };
  }

  async handlePostback(postback: FakeApprovalPostback): Promise<ApprovalDecisionResult> {
    const timestamp = now(this.clock);
    assertUuid(postback.postbackId, "postbackId");
    const actorFingerprint = await sha256Hex(String(postback.approverId));
    try {
      assertInternalId(postback.approverId, "approverId");
    } catch {
      await this.securityAudit(null, actorFingerprint, "APPROVER_ID_INVALID", timestamp.iso);
      throw new ApprovalContractError("APPROVER_ID_INVALID");
    }
    if (postback.action !== "APPROVE" && postback.action !== "REJECT") {
      throw new ApprovalContractError("POSTBACK_TAMPERED");
    }
    const tokenHash = await sha256Hex(String(postback.operationToken));
    const request = await this.db.prepare(
      "SELECT * FROM approval_requests WHERE operation_token_hash = ?",
    ).bind(tokenHash).first<ApprovalRequestRow>();
    if (!request) {
      await this.securityAudit(null, actorFingerprint, "TOKEN_UNKNOWN", timestamp.iso);
      throw new ApprovalContractError("TOKEN_UNKNOWN");
    }
    await this.assertSnapshotIntegrity(request, actorFingerprint, timestamp.iso);
    if (request.status === "DECIDING"
      || request.status === "APPROVED"
      || request.status === "REJECTED") {
      await this.assertDecisionClaimIntegrity(request, actorFingerprint, timestamp.iso);
    }
    const claimsMatch = request.approval_request_id === postback.approvalRequestId
      && request.video_job_id === postback.videoJobId
      && request.content_fingerprint === postback.contentFingerprint
      && request.targets_fingerprint === postback.targetsFingerprint;
    if (!claimsMatch) {
      await this.securityAudit(
        request.approval_request_id, actorFingerprint, "POSTBACK_TAMPERED", timestamp.iso,
      );
      throw new ApprovalContractError("POSTBACK_TAMPERED");
    }
    const exactFinalReplay = (request.status === "APPROVED" || request.status === "REJECTED")
      && request.decision_postback_id === postback.postbackId
      && request.decided_by === postback.approverId
      && request.decided_action === postback.action;
    if (exactFinalReplay) return this.decisionResult(request, true);
    // DECIDING is not a new authorization decision. The winning actor/action
    // was already authenticated and durably claimed, so recovery must use only
    // that persisted intent even if allowlist membership changes afterwards.
    if (request.status === "DECIDING") {
      return this.resumeDecision(request, true);
    }
    const allow = await this.db.prepare(
      "SELECT active FROM fake_approval_allowlist WHERE approver_id = ?",
    ).bind(postback.approverId).first<{ active: number }>();
    if (!allow) {
      await this.securityAudit(
        request.approval_request_id, actorFingerprint, "APPROVER_NOT_ALLOWED", timestamp.iso,
      );
      throw new ApprovalContractError("APPROVER_NOT_ALLOWED");
    }
    if (allow.active !== 1) {
      await this.securityAudit(
        request.approval_request_id, actorFingerprint, "APPROVER_DISABLED", timestamp.iso,
      );
      throw new ApprovalContractError("APPROVER_DISABLED");
    }
    if (this.interruption?.afterAuthorizationCheck) {
      await this.interruption.afterAuthorizationCheck();
    }
    if (request.status === "EXPIRED"
      || (request.status === "PENDING" && timestamp.milliseconds >= Date.parse(request.expires_at))) {
      await this.db.batch([
        this.db.prepare(
          `UPDATE approval_requests SET status = 'EXPIRED', updated_at = ?
           WHERE approval_request_id = ? AND status = 'PENDING'`,
        ).bind(timestamp.iso, request.approval_request_id),
        this.db.prepare(
          `UPDATE fake_approval_notification_outbox
           SET status = 'CANCELLED', lease_token = NULL, lease_expires_at = NULL,
               updated_at = ?
           WHERE approval_request_id = ? AND status IN ('PENDING', 'SENDING')`,
        ).bind(timestamp.iso, request.approval_request_id),
      ]);
      await this.securityAudit(
        request.approval_request_id, actorFingerprint, "APPROVAL_EXPIRED", timestamp.iso,
      );
      throw new ApprovalContractError("APPROVAL_EXPIRED");
    }
    if (request.status === "APPROVED" || request.status === "REJECTED") {
      if ((request.status === "APPROVED") !== (postback.action === "APPROVE")) {
        await this.securityAudit(
          request.approval_request_id, actorFingerprint, "DECISION_CONFLICT", timestamp.iso,
        );
      }
      return this.decisionResult(request, true);
    }
    const usedPostback = await this.db.prepare(
      `SELECT approval_request_id FROM approval_requests
       WHERE decision_postback_id = ? AND approval_request_id <> ?`,
    ).bind(postback.postbackId, request.approval_request_id)
      .first<{ approval_request_id: string }>();
    if (usedPostback) {
      await this.securityAudit(
        request.approval_request_id, actorFingerprint, "POSTBACK_TAMPERED", timestamp.iso,
      );
      throw new ApprovalContractError("POSTBACK_TAMPERED");
    }
    const approvedContentVersion = `acv_${await canonicalFingerprint({
      video_job_id: request.video_job_id,
      object_ref: request.object_ref,
      checksum_sha256: request.checksum_sha256,
      content_fingerprint: request.content_fingerprint,
      targets_fingerprint: request.targets_fingerprint,
    })}`;
    const claimedVersion = postback.action === "APPROVE" ? approvedContentVersion : null;
    const intentProof = await decisionIntentProof({
      approvalRequestId: request.approval_request_id,
      decisionPostbackId: postback.postbackId,
      decidedAction: postback.action,
      decidedBy: postback.approverId,
      decidedAt: timestamp.iso,
      approvedContentVersion: claimedVersion,
      videoJobId: request.video_job_id,
      requestFingerprint: request.request_fingerprint,
      contentFingerprint: request.content_fingerprint,
      targetsFingerprint: request.targets_fingerprint,
      operationTokenHash: request.operation_token_hash,
    });
    const intentResults = await this.db.batch([
      this.db.prepare(
        `INSERT INTO approval_decision_claims (
           approval_request_id, decision_postback_id, decided_action, decided_by,
           decided_at, approved_content_version, video_job_id, request_fingerprint,
           content_fingerprint, targets_fingerprint, operation_token_hash,
           intent_proof, created_at
         ) SELECT ?, ?, ?, ?, ?, ?, video_job_id, request_fingerprint,
                  content_fingerprint, targets_fingerprint, operation_token_hash, ?, ?
           FROM approval_requests
           WHERE approval_request_id = ? AND status = 'PENDING'
             AND video_job_id = ? AND request_fingerprint = ?
             AND content_fingerprint = ? AND targets_fingerprint = ?
             AND object_ref = ? AND checksum_sha256 = ?
             AND content_json = ? AND publication_targets_json = ?
             AND operation_token_hash = ? AND expires_at = ?
             AND EXISTS (
               SELECT 1 FROM fake_approval_allowlist
               WHERE approver_id = ? AND active = 1
             )
         ON CONFLICT DO NOTHING`,
      ).bind(
        request.approval_request_id, postback.postbackId, postback.action,
        postback.approverId, timestamp.iso, claimedVersion, intentProof, timestamp.iso,
        request.approval_request_id, request.video_job_id, request.request_fingerprint,
        request.content_fingerprint, request.targets_fingerprint,
        request.object_ref, request.checksum_sha256,
        request.content_json, request.publication_targets_json,
        request.operation_token_hash, request.expires_at, postback.approverId,
      ),
      this.db.prepare(
        `UPDATE approval_requests SET
           status = 'DECIDING', decision_postback_id = ?, decided_action = ?,
           decided_by = ?, decided_at = ?, approved_content_version = ?, updated_at = ?
         WHERE approval_request_id = ? AND status = 'PENDING'
           AND video_job_id = ? AND request_fingerprint = ?
           AND content_fingerprint = ? AND targets_fingerprint = ?
           AND object_ref = ? AND checksum_sha256 = ?
           AND content_json = ? AND publication_targets_json = ?
           AND operation_token_hash = ? AND expires_at = ?
           AND EXISTS (
             SELECT 1 FROM approval_decision_claims c
             WHERE c.approval_request_id = approval_requests.approval_request_id
               AND c.decision_postback_id = ? AND c.decided_action = ?
               AND c.decided_by = ? AND c.decided_at = ?
               AND c.approved_content_version IS ? AND c.intent_proof = ?
           )
           AND EXISTS (
             SELECT 1 FROM fake_approval_allowlist
             WHERE approver_id = ? AND active = 1
           )`,
      ).bind(
        postback.postbackId, postback.action, postback.approverId, timestamp.iso,
        postback.action === "APPROVE" ? approvedContentVersion : null,
        timestamp.iso, request.approval_request_id,
        request.video_job_id, request.request_fingerprint,
        request.content_fingerprint, request.targets_fingerprint,
        request.object_ref, request.checksum_sha256,
        request.content_json, request.publication_targets_json,
        request.operation_token_hash, request.expires_at,
        postback.postbackId, postback.action, postback.approverId,
        timestamp.iso, claimedVersion, intentProof,
        postback.approverId,
      ),
      this.db.prepare(
        `UPDATE fake_approval_notification_outbox
         SET status = 'CANCELLED', lease_token = NULL, lease_expires_at = NULL,
             updated_at = ?
         WHERE approval_request_id = ? AND status IN ('PENDING', 'SENDING')
           AND EXISTS (
             SELECT 1 FROM approval_requests
             WHERE approval_request_id = ? AND status = 'DECIDING'
           )`,
      ).bind(timestamp.iso, request.approval_request_id, request.approval_request_id),
    ]);
    const claimed = await this.getRequest(request.approval_request_id);
    if (!claimed) throw new ApprovalContractError("CONCURRENT_UPDATE", true);
    await this.assertSnapshotIntegrity(claimed, actorFingerprint, timestamp.iso);
    if (claimed.status === "EXPIRED") {
      await this.securityAudit(
        request.approval_request_id, actorFingerprint, "APPROVAL_EXPIRED", timestamp.iso,
      );
      throw new ApprovalContractError("APPROVAL_EXPIRED");
    }
    if (claimed.status === "PENDING") {
      const latestAllow = await this.db.prepare(
        "SELECT active FROM fake_approval_allowlist WHERE approver_id = ?",
      ).bind(postback.approverId).first<{ active: number }>();
      const reason = latestAllow ? "APPROVER_DISABLED" : "APPROVER_NOT_ALLOWED";
      await this.securityAudit(
        request.approval_request_id, actorFingerprint, reason, timestamp.iso,
      );
      throw new ApprovalContractError(reason);
    }
    await this.assertDecisionClaimIntegrity(claimed, actorFingerprint, timestamp.iso);
    const won = (intentResults[1]?.meta.changes ?? 0) === 1;
    if (!won && claimed.decided_action !== postback.action) {
      await this.securityAudit(
        request.approval_request_id, actorFingerprint, "DECISION_CONFLICT", timestamp.iso,
      );
    }
    if (won && this.interruption?.afterDecisionIntent) {
      await this.interruption.afterDecisionIntent();
    }
    return this.resumeDecision(claimed, !won);
  }

  async assertApprovedSnapshot(input: {
    approvalRequestId: string;
    content: ApprovalContentInput;
    publicationTargets: readonly PublicationTarget[];
  }): Promise<string> {
    const request = await this.getRequest(input.approvalRequestId);
    if (!request || request.status !== "APPROVED" || !request.approved_content_version) {
      throw new ApprovalContractError("APPROVAL_REQUIRED");
    }
    await this.assertSnapshotIntegrity(
      request, await sha256Hex("fake_approval_worker"), now(this.clock).iso,
    );
    const contentFingerprint = await canonicalFingerprint({
      object_ref: request.object_ref,
      checksum_sha256: request.checksum_sha256,
      content: normalizeContent(input.content),
    });
    const targetsFingerprint = await canonicalFingerprint(normalizeTargets(input.publicationTargets));
    if (
      contentFingerprint !== request.content_fingerprint
      || targetsFingerprint !== request.targets_fingerprint
    ) throw new ApprovalContractError("REAPPROVAL_REQUIRED");
    return request.approved_content_version;
  }

  async flushFakeApprovalNotifications(
    receiver: Pick<D1FakeApprovalNotificationAdapter, "accept">
      = new D1FakeApprovalNotificationAdapter(this.db),
    interruption?: { afterValidation?(): Promise<void>; afterSideEffect?(): Promise<void> },
  ): Promise<number> {
    const timestamp = now(this.clock);
    await this.db.batch([
      this.db.prepare(
        `UPDATE approval_requests
         SET status = 'EXPIRED', updated_at = ?
         WHERE status = 'PENDING' AND expires_at <= ?`,
      ).bind(timestamp.iso, timestamp.iso),
      this.db.prepare(
        `UPDATE fake_approval_notification_outbox
         SET status = 'CANCELLED', lease_token = NULL, lease_expires_at = NULL,
             updated_at = ?
         WHERE status IN ('PENDING', 'SENDING')
           AND EXISTS (
             SELECT 1 FROM approval_requests r
             WHERE r.approval_request_id = fake_approval_notification_outbox.approval_request_id
               AND r.status = 'EXPIRED'
           )`,
      ).bind(timestamp.iso),
    ]);
    const candidate = await this.db.prepare(
      `SELECT n.notification_id, n.approval_request_id, n.operation_token,
              n.payload_fingerprint, r.video_job_id, r.content_fingerprint,
              r.targets_fingerprint, r.expires_at
       FROM fake_approval_notification_outbox n
       JOIN approval_requests r ON r.approval_request_id = n.approval_request_id
       WHERE r.status = 'PENDING' AND r.expires_at > ?
         AND (n.status = 'PENDING'
          OR (n.status = 'SENDING' AND n.lease_expires_at <= ?))
       ORDER BY n.created_at LIMIT 1`,
    ).bind(timestamp.iso, timestamp.iso).first<NotificationOutboxCandidate>();
    if (!candidate) return 0;
    await this.assertNotificationOutboxIntegrity(candidate, timestamp.iso);
    if (interruption?.afterValidation) await interruption.afterValidation();
    const leaseToken = `lease_${crypto.randomUUID()}`;
    const leaseExpiresAt = new Date(timestamp.milliseconds + OUTBOX_LEASE_MS).toISOString();
    const claim = await this.db.prepare(
      `UPDATE fake_approval_notification_outbox
       SET status = 'SENDING', attempt_count = attempt_count + 1,
           lease_token = ?, lease_expires_at = ?, updated_at = ?
       WHERE notification_id = ?
         AND approval_request_id = ? AND operation_token = ? AND payload_fingerprint = ?
         AND (status = 'PENDING' OR (status = 'SENDING' AND lease_expires_at <= ?))`,
    ).bind(
      leaseToken, leaseExpiresAt, timestamp.iso, candidate.notification_id,
      candidate.approval_request_id, candidate.operation_token,
      candidate.payload_fingerprint, timestamp.iso,
    ).run();
    if ((claim.meta.changes ?? 0) !== 1) {
      const latest = await this.notificationCandidate(candidate.approval_request_id);
      if (latest) await this.assertNotificationOutboxIntegrity(latest, timestamp.iso);
      return 0;
    }
    await receiver.accept({
      notificationId: candidate.notification_id,
      approvalRequestId: candidate.approval_request_id,
      operationToken: candidate.operation_token,
      videoJobId: candidate.video_job_id,
      contentFingerprint: candidate.content_fingerprint,
      targetsFingerprint: candidate.targets_fingerprint,
      expiresAt: candidate.expires_at,
      payloadFingerprint: candidate.payload_fingerprint,
    }, timestamp.iso);
    if (interruption?.afterSideEffect) await interruption.afterSideEffect();
    await this.db.prepare(
      `UPDATE fake_approval_notification_outbox
       SET status = 'DELIVERED', lease_token = NULL, lease_expires_at = NULL,
           delivered_at = ?, updated_at = ?
       WHERE notification_id = ? AND status = 'SENDING' AND lease_token = ?`,
    ).bind(timestamp.iso, timestamp.iso, candidate.notification_id, leaseToken).run();
    return 1;
  }

  async flushFakePublisherOutbox(
    receiver: Pick<D1FakePublisherAdapter, "accept">
      = new D1FakePublisherAdapter(this.db),
    interruption?: { afterValidation?(): Promise<void>; afterSideEffect?(): Promise<void> },
  ): Promise<number> {
    const timestamp = now(this.clock);
    const candidate = await this.db.prepare(
      `SELECT publisher_event_id, approval_request_id, video_job_id, approved_content_version,
              publication_targets_json, event_fingerprint
       FROM approval_publisher_outbox
       WHERE status = 'PENDING'
          OR (status = 'SENDING' AND lease_expires_at <= ?)
       ORDER BY created_at LIMIT 1`,
    ).bind(timestamp.iso).first<PublisherOutboxCandidate>();
    if (!candidate) return 0;
    await this.assertPublisherOutboxIntegrity(candidate, timestamp.iso);
    if (interruption?.afterValidation) await interruption.afterValidation();
    const leaseToken = `lease_${crypto.randomUUID()}`;
    const leaseExpiresAt = new Date(timestamp.milliseconds + OUTBOX_LEASE_MS).toISOString();
    const claim = await this.db.prepare(
      `UPDATE approval_publisher_outbox
       SET status = 'SENDING', attempt_count = attempt_count + 1,
           lease_token = ?, lease_expires_at = ?, updated_at = ?
       WHERE publisher_event_id = ?
         AND approval_request_id = ? AND video_job_id = ?
         AND approved_content_version = ? AND publication_targets_json = ?
         AND event_fingerprint = ?
         AND (status = 'PENDING' OR (status = 'SENDING' AND lease_expires_at <= ?))`,
    ).bind(
      leaseToken, leaseExpiresAt, timestamp.iso, candidate.publisher_event_id,
      candidate.approval_request_id, candidate.video_job_id,
      candidate.approved_content_version, candidate.publication_targets_json,
      candidate.event_fingerprint, timestamp.iso,
    ).run();
    if ((claim.meta.changes ?? 0) !== 1) {
      const latest = await this.publisherCandidate(candidate.approval_request_id);
      if (latest) await this.assertPublisherOutboxIntegrity(latest, timestamp.iso);
      return 0;
    }
    await receiver.accept({
      publisherEventId: candidate.publisher_event_id,
      approvalRequestId: candidate.approval_request_id,
      videoJobId: candidate.video_job_id,
      approvedContentVersion: candidate.approved_content_version,
      publicationTargets: JSON.parse(candidate.publication_targets_json) as PublicationTarget[],
      eventFingerprint: candidate.event_fingerprint,
    }, timestamp.iso);
    if (interruption?.afterSideEffect) await interruption.afterSideEffect();
    await this.db.prepare(
      `UPDATE approval_publisher_outbox
       SET status = 'DELIVERED', lease_token = NULL, lease_expires_at = NULL,
           delivered_at = ?, updated_at = ?
       WHERE publisher_event_id = ? AND status = 'SENDING' AND lease_token = ?`,
    ).bind(timestamp.iso, timestamp.iso, candidate.publisher_event_id, leaseToken).run();
    return 1;
  }

  private async notificationCandidate(
    approvalRequestId: string,
  ): Promise<NotificationOutboxCandidate | null> {
    return this.db.prepare(
      `SELECT n.notification_id, n.approval_request_id, n.operation_token,
              n.payload_fingerprint, r.video_job_id, r.content_fingerprint,
              r.targets_fingerprint, r.expires_at
       FROM fake_approval_notification_outbox n
       JOIN approval_requests r ON r.approval_request_id = n.approval_request_id
       WHERE n.approval_request_id = ?`,
    ).bind(approvalRequestId).first<NotificationOutboxCandidate>();
  }

  private async assertNotificationOutboxIntegrity(
    candidate: NotificationOutboxCandidate,
    occurredAt: string,
  ): Promise<void> {
    let valid = false;
    try {
      const request = await this.getRequest(candidate.approval_request_id);
      const operationTokenHash = await sha256Hex(candidate.operation_token);
      const payloadFingerprint = await approvalNotificationFingerprint({
        notificationId: candidate.notification_id,
        approvalRequestId: candidate.approval_request_id,
        operationTokenHash,
        videoJobId: candidate.video_job_id,
        contentFingerprint: candidate.content_fingerprint,
        targetsFingerprint: candidate.targets_fingerprint,
        expiresAt: candidate.expires_at,
      });
      valid = request !== null
        && request.video_job_id === candidate.video_job_id
        && request.content_fingerprint === candidate.content_fingerprint
        && request.targets_fingerprint === candidate.targets_fingerprint
        && request.expires_at === candidate.expires_at
        && request.operation_token_hash === operationTokenHash
        && candidate.payload_fingerprint === payloadFingerprint;
    } catch {
      valid = false;
    }
    if (!valid) {
      await this.securityAudit(
        candidate.approval_request_id,
        await sha256Hex("fake_approval_notification_worker"),
        "OUTBOX_TAMPERED",
        occurredAt,
      );
      throw new ApprovalContractError("OUTBOX_TAMPERED");
    }
  }

  private async publisherCandidate(
    approvalRequestId: string,
  ): Promise<PublisherOutboxCandidate | null> {
    return this.db.prepare(
      `SELECT publisher_event_id, approval_request_id, video_job_id,
              approved_content_version, publication_targets_json, event_fingerprint
       FROM approval_publisher_outbox WHERE approval_request_id = ?`,
    ).bind(approvalRequestId).first<PublisherOutboxCandidate>();
  }

  private async assertPublisherOutboxIntegrity(
    candidate: PublisherOutboxCandidate,
    occurredAt: string,
  ): Promise<void> {
    let valid = false;
    try {
      const request = await this.getRequest(candidate.approval_request_id);
      if (request) {
        await this.assertSnapshotIntegrity(
          request, await sha256Hex("fake_publisher_worker"), occurredAt,
        );
        const candidateTargets = normalizeTargets(
          JSON.parse(candidate.publication_targets_json) as PublicationTarget[],
        );
        const requestTargets = normalizeTargets(parseTargets(request));
        const eventFingerprint = await publisherEventFingerprint({
          publisherEventId: candidate.publisher_event_id,
          approvalRequestId: candidate.approval_request_id,
          videoJobId: candidate.video_job_id,
          approvedContentVersion: candidate.approved_content_version,
          publicationTargets: candidateTargets,
        });
        valid = request.status === "APPROVED"
          && request.video_job_id === candidate.video_job_id
          && request.approved_content_version === candidate.approved_content_version
          && canonicalJson(requestTargets) === canonicalJson(candidateTargets)
          && candidate.event_fingerprint === eventFingerprint;
      }
    } catch {
      valid = false;
    }
    if (!valid) {
      await this.securityAudit(
        candidate.approval_request_id,
        await sha256Hex("fake_publisher_worker"),
        "OUTBOX_TAMPERED",
        occurredAt,
      );
      throw new ApprovalContractError("OUTBOX_TAMPERED");
    }
  }

  private async eligibleJob(videoJobId: string): Promise<EligibleJobRow | null> {
    return this.db.prepare(
      `SELECT j.video_job_id, j.state, r.object_ref,
              s.expected_checksum_sha256 AS checksum_sha256,
              CASE WHEN i.status = 'RESOLVED'
                AND i.intended_video_job_id = j.video_job_id
                AND i.video_job_id = j.video_job_id
                AND s.status = 'COMPLETED'
                AND s.completion_event_id = r.event_id
                AND s.expected_object_ref = r.object_ref
                AND EXISTS (
                  SELECT 1 FROM submission_candidate_snapshots c
                  WHERE c.submission_id = i.submission_id
                    AND c.class_id = j.class_id AND c.branch_id = j.branch_id
                    AND c.studio_id = j.studio_id AND c.teacher_id = j.teacher_id
                ) THEN 1 ELSE 0 END AS eligible
       FROM video_jobs j
       LEFT JOIN submission_intakes i ON i.submission_id = j.submission_id
       LEFT JOIN fake_upload_sessions s ON s.submission_id = j.submission_id
       LEFT JOIN upload_receipt_events r ON r.submission_id = j.submission_id
       WHERE j.video_job_id = ?`,
    ).bind(videoJobId).first<EligibleJobRow>();
  }

  private async getRequest(approvalRequestId: string): Promise<ApprovalRequestRow | null> {
    return this.db.prepare(
      "SELECT * FROM approval_requests WHERE approval_request_id = ?",
    ).bind(approvalRequestId).first<ApprovalRequestRow>();
  }

  private async getDecisionClaim(
    approvalRequestId: string,
  ): Promise<ApprovalDecisionClaimRow | null> {
    return this.db.prepare(
      "SELECT * FROM approval_decision_claims WHERE approval_request_id = ?",
    ).bind(approvalRequestId).first<ApprovalDecisionClaimRow>();
  }

  private async assertDecisionClaimIntegrity(
    request: ApprovalRequestRow,
    actorFingerprint: string,
    occurredAt: string,
  ): Promise<void> {
    let valid = false;
    try {
      const claim = await this.getDecisionClaim(request.approval_request_id);
      if (claim && request.decision_postback_id && request.decided_action
        && request.decided_by && request.decided_at) {
        const proof = await decisionIntentProof({
          approvalRequestId: claim.approval_request_id,
          decisionPostbackId: claim.decision_postback_id,
          decidedAction: claim.decided_action,
          decidedBy: claim.decided_by,
          decidedAt: claim.decided_at,
          approvedContentVersion: claim.approved_content_version,
          videoJobId: claim.video_job_id,
          requestFingerprint: claim.request_fingerprint,
          contentFingerprint: claim.content_fingerprint,
          targetsFingerprint: claim.targets_fingerprint,
          operationTokenHash: claim.operation_token_hash,
        });
        valid = claim.decision_postback_id === request.decision_postback_id
          && claim.decided_action === request.decided_action
          && claim.decided_by === request.decided_by
          && claim.decided_at === request.decided_at
          && claim.approved_content_version === request.approved_content_version
          && claim.video_job_id === request.video_job_id
          && claim.request_fingerprint === request.request_fingerprint
          && claim.content_fingerprint === request.content_fingerprint
          && claim.targets_fingerprint === request.targets_fingerprint
          && claim.operation_token_hash === request.operation_token_hash
          && claim.intent_proof === proof;
      }
    } catch {
      valid = false;
    }
    if (!valid) {
      await this.securityAudit(
        request.approval_request_id, actorFingerprint, "SNAPSHOT_TAMPERED", occurredAt,
      );
      throw new ApprovalContractError("SNAPSHOT_TAMPERED");
    }
  }

  private async getRequestForJob(videoJobId: string): Promise<ApprovalRequestRow | null> {
    return this.db.prepare(
      "SELECT * FROM approval_requests WHERE video_job_id = ? ORDER BY created_at DESC LIMIT 1",
    ).bind(videoJobId).first<ApprovalRequestRow>();
  }

  private async getActiveRequestForJob(videoJobId: string): Promise<ApprovalRequestRow | null> {
    return this.db.prepare(
      `SELECT * FROM approval_requests
       WHERE video_job_id = ? AND status IN ('PENDING', 'DECIDING')
       ORDER BY created_at DESC LIMIT 1`,
    ).bind(videoJobId).first<ApprovalRequestRow>();
  }

  private async fakeOperationToken(approvalRequestId: string): Promise<string> {
    const row = await this.db.prepare(
      `SELECT operation_token FROM fake_approval_notification_outbox
       WHERE approval_request_id = ?`,
    ).bind(approvalRequestId).first<{ operation_token: string }>();
    if (!row) throw new ApprovalContractError("FAKE_NOTIFICATION_NOT_FOUND", true);
    return row.operation_token;
  }

  private async resumeDecision(
    request: ApprovalRequestRow,
    duplicate: boolean,
  ): Promise<ApprovalDecisionResult> {
    await this.assertSnapshotIntegrity(
      request,
      await sha256Hex(request.decided_by ?? "fake_approval_worker"),
      now(this.clock).iso,
    );
    await this.assertDecisionClaimIntegrity(
      request,
      await sha256Hex(request.decided_by ?? "fake_approval_worker"),
      now(this.clock).iso,
    );
    if (
      request.status !== "DECIDING"
      || !request.decided_action
      || !request.decided_by
      || !request.decided_at
      || !request.decision_postback_id
    ) {
      if (request.status === "APPROVED" || request.status === "REJECTED") {
        return this.decisionResult(request, true);
      }
      throw new ApprovalContractError("APPROVAL_NOT_DECIDED");
    }
    const action = request.decided_action;
    const mutationToken = `e4_${action.toLowerCase()}_${request.approval_request_id}`;
    try {
      await this.jobs.transitionJob({
        videoJobId: request.video_job_id,
        expectedState: "WAITING_APPROVAL",
        nextState: action === "APPROVE" ? "APPROVED" : "REJECTED",
        ...(action === "APPROVE"
          ? {
              approvedContentVersion: request.approved_content_version!,
              publicationTargets: parseTargets(request),
            }
          : {}),
        actor: { type: "approver", id: request.decided_by },
        now: request.decided_at,
        mutationToken,
      });
    } catch (error) {
      const job = await this.jobs.getVideoJob(request.video_job_id);
      if (!job || job.last_mutation_token !== mutationToken) throw error;
    }
    if (this.interruption?.afterJobDecision) await this.interruption.afterJobDecision();
    await this.finalizeDecision(request);
    const finalized = await this.getRequest(request.approval_request_id);
    if (!finalized || (finalized.status !== "APPROVED" && finalized.status !== "REJECTED")) {
      throw new ApprovalContractError("CONCURRENT_UPDATE", true);
    }
    return this.decisionResult(finalized, duplicate);
  }

  private async finalizeDecision(request: ApprovalRequestRow): Promise<void> {
    await this.assertSnapshotIntegrity(
      request,
      await sha256Hex(request.decided_by ?? "fake_approval_worker"),
      request.decided_at ?? now(this.clock).iso,
    );
    await this.assertDecisionClaimIntegrity(
      request,
      await sha256Hex(request.decided_by ?? "fake_approval_worker"),
      request.decided_at ?? now(this.clock).iso,
    );
    const action = request.decided_action!;
    const status = action === "APPROVE" ? "APPROVED" : "REJECTED";
    const job = await this.jobs.getVideoJob(request.video_job_id);
    const expectedMutation = `e4_${action.toLowerCase()}_${request.approval_request_id}`;
    if (!job || job.last_mutation_token !== expectedMutation) {
      throw new ApprovalContractError("DECISION_CONFLICT");
    }
    const approvedContentVersion = request.approved_content_version;
    const auditId = `e4_audit_${request.approval_request_id}`;
    const publisherEventId = `e4_publish_${request.approval_request_id}`;
    const eventFingerprint = await publisherEventFingerprint({
      publisherEventId,
      approvalRequestId: request.approval_request_id,
      videoJobId: request.video_job_id,
      approvedContentVersion: approvedContentVersion!,
      publicationTargets: parseTargets(request),
    });
    await this.db.batch([
      this.db.prepare(
        `UPDATE approval_requests SET
           status = ?, updated_at = decided_at
         WHERE approval_request_id = ? AND status = 'DECIDING'`,
      ).bind(
        status, request.approval_request_id,
      ),
      this.db.prepare(
        `INSERT INTO audit_logs (
           audit_id, video_job_id, actor_type, actor_id, action,
           from_state, to_state, details_json, occurred_at
         ) SELECT ?, video_job_id, 'approver', decided_by, ?,
                  'WAITING_APPROVAL', ?, ?, decided_at
           FROM approval_requests
           WHERE approval_request_id = ? AND status = ?
         ON CONFLICT(audit_id) DO NOTHING`,
      ).bind(
        auditId,
        action === "APPROVE" ? "approval.granted" : "approval.rejected",
        status,
        canonicalJson({
          approval_request_id: request.approval_request_id,
          approved_content_version: action === "APPROVE" ? approvedContentVersion : null,
          publication_targets: parseTargets(request),
        }),
        request.approval_request_id,
        status,
      ),
      this.db.prepare(
        `INSERT INTO approval_publisher_outbox (
           publisher_event_id, approval_request_id, video_job_id,
           approved_content_version, publication_targets_json,
           event_fingerprint, created_at, updated_at
         ) SELECT ?, approval_request_id, video_job_id, approved_content_version,
                  publication_targets_json, ?, decided_at, decided_at
           FROM approval_requests
           WHERE approval_request_id = ? AND status = 'APPROVED'
         ON CONFLICT(approval_request_id) DO NOTHING`,
      ).bind(
        publisherEventId, eventFingerprint, request.approval_request_id,
      ),
    ]);
  }

  private decisionResult(request: ApprovalRequestRow, duplicate: boolean): ApprovalDecisionResult {
    if (request.status !== "APPROVED" && request.status !== "REJECTED") {
      throw new ApprovalContractError("APPROVAL_NOT_DECIDED");
    }
    return {
      approvalRequestId: request.approval_request_id,
      videoJobId: request.video_job_id,
      decision: request.status,
      approvedContentVersion: request.approved_content_version,
      publicationTargets: parseTargets(request),
      duplicate,
    };
  }

  private async assertSnapshotIntegrity(
    request: ApprovalRequestRow,
    actorFingerprint: string,
    occurredAt: string,
  ): Promise<void> {
    try {
      const parsedContent = JSON.parse(request.content_json) as ApprovalContentInput;
      const content = normalizeContent(parsedContent);
      const parsedTargets = JSON.parse(request.publication_targets_json) as PublicationTarget[];
      const targets = normalizeTargets(parsedTargets);
      const contentFingerprint = await canonicalFingerprint({
        object_ref: request.object_ref,
        checksum_sha256: request.checksum_sha256,
        content,
      });
      const targetsFingerprint = await canonicalFingerprint(targets);
      const requestFingerprint = await canonicalFingerprint({
        operation: "approval.request",
        video_job_id: request.video_job_id,
        content_fingerprint: contentFingerprint,
        targets_fingerprint: targetsFingerprint,
      });
      const approvedContentVersion = `acv_${await canonicalFingerprint({
        video_job_id: request.video_job_id,
        object_ref: request.object_ref,
        checksum_sha256: request.checksum_sha256,
        content_fingerprint: contentFingerprint,
        targets_fingerprint: targetsFingerprint,
      })}`;
      const versionMatches = request.approved_content_version === null
        || request.approved_content_version === approvedContentVersion;
      const notification = await this.db.prepare(
        `SELECT notification_id, operation_token, payload_fingerprint
         FROM fake_approval_notification_outbox WHERE approval_request_id = ?`,
      ).bind(request.approval_request_id).first<{
        notification_id: string;
        operation_token: string;
        payload_fingerprint: string;
      }>();
      if (!notification) throw new Error("approval notification snapshot is missing");
      const operationTokenHash = await sha256Hex(notification.operation_token);
      const payloadFingerprint = await approvalNotificationFingerprint({
        notificationId: notification.notification_id,
        approvalRequestId: request.approval_request_id,
        operationTokenHash,
        videoJobId: request.video_job_id,
        contentFingerprint,
        targetsFingerprint,
        expiresAt: request.expires_at,
      });
      if (
        request.content_fingerprint !== contentFingerprint
        || request.targets_fingerprint !== targetsFingerprint
        || request.request_fingerprint !== requestFingerprint
        || request.operation_token_hash !== operationTokenHash
        || notification.payload_fingerprint !== payloadFingerprint
        || !versionMatches
      ) {
        throw new Error("snapshot fingerprint mismatch");
      }
    } catch {
      await this.securityAudit(
        request.approval_request_id, actorFingerprint, "SNAPSHOT_TAMPERED", occurredAt,
      );
      throw new ApprovalContractError("SNAPSHOT_TAMPERED");
    }
  }

  private async securityAudit(
    approvalRequestId: string | null,
    actorFingerprint: string,
    reasonCode: string,
    occurredAt: string,
  ): Promise<void> {
    await this.db.prepare(
      `INSERT INTO approval_security_audits (
         security_audit_id, approval_request_id, actor_fingerprint,
         reason_code, occurred_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      `security_${crypto.randomUUID()}`,
      approvalRequestId,
      actorFingerprint,
      reasonCode,
      occurredAt,
    ).run();
  }
}
