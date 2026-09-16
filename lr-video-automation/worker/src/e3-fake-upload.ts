import { assertInternalId, assertUuid, type QueueEvent, type VideoJob } from "./domain";
import { ConcurrentUpdateError, NotFoundError } from "./errors";
import { type ResolvedIntakeReservation } from "./e2-repository";
import { canonicalFingerprint } from "./fingerprint";

const MAX_FAKE_UPLOAD_BYTES = 2_000_000_000;
export const E3_UPLOAD_TTL_MS = 15 * 60 * 1_000;
export type VideoUploadedQueueEvent = Extract<QueueEvent, { event_type: "video.uploaded" }>;

export interface FakeUploadSession {
  submission_id: string;
  upload_id: string;
  request_fingerprint: string;
  expected_object_ref: string;
  expected_size_bytes: number;
  expected_checksum_sha256: string;
  expected_content_type: string;
  expires_at: string;
  status: "PENDING" | "COMPLETED" | "REJECTED";
  completion_event_id: string | null;
  completed_at: string | null;
  rejection_code: string | null;
  created_at: string;
  updated_at: string;
}

export type UploadObjectInspection =
  | { status: "MISSING" | "UNREADABLE" }
  | {
      status: "VERIFIED" | "CORRUPT" | "NON_VIDEO";
      sizeBytes: number;
      checksumSha256: string;
      contentType: string;
    };

/** Replace this fake boundary with R2 HEAD plus media validation in E-3 proper. */
export interface UploadObjectInspector {
  inspect(objectRef: string): Promise<UploadObjectInspection>;
}

export interface UploadIdentityGenerator {
  createUploadId(): string;
  createObjectRef(): string;
}

export interface TrustedClock {
  now(): Date;
}

const secureUploadIdentityGenerator: UploadIdentityGenerator = {
  createUploadId: () => crypto.randomUUID(),
  createObjectRef: () => `fake_object_${crypto.randomUUID().replaceAll("-", "")}`,
};

const systemClock: TrustedClock = { now: () => new Date() };

function assertChecksum(value: string): void {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new TypeError("checksumSha256 must be a SHA-256 digest");
}

function assertVideoContentType(value: string): void {
  if (!/^video\/[a-z0-9.+-]+$/i.test(value)) {
    throw new TypeError("contentType must be a video MIME type without parameters");
  }
}

function assertAcceptanceShape(input: {
  sizeBytes: number;
  checksumSha256: string;
  contentType: string;
}): void {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MAX_FAKE_UPLOAD_BYTES) {
    throw new TypeError(`sizeBytes must be an integer between 1 and ${MAX_FAKE_UPLOAD_BYTES}`);
  }
  assertChecksum(input.checksumSha256);
  assertVideoContentType(input.contentType);
}

function receiptFingerprintInput(session: FakeUploadSession) {
  return {
    event_type: "video.uploaded",
    submission_id: session.submission_id,
    upload_id: session.upload_id,
    object_ref: session.expected_object_ref,
    size_bytes: session.expected_size_bytes,
    checksum_sha256: session.expected_checksum_sha256,
    content_type: session.expected_content_type,
  };
}

/**
 * Local/fake only E-3.1 boundary. IDs and the object reference are generated
 * server-side. Completion trusts only the injected storage/validation boundary.
 */
export class E3FakeUploadService {
  constructor(
    private readonly db: D1Database,
    private readonly inspector: UploadObjectInspector,
    private readonly identities: UploadIdentityGenerator = secureUploadIdentityGenerator,
    private readonly clock: TrustedClock = systemClock,
    /** The adapter name is persisted in the event and checked by the consumer. */
    private readonly callbackActorId = "fake_upload_callback",
  ) {}

  async begin(input: {
    submissionId: string;
    sizeBytes: number;
    checksumSha256: string;
    contentType: string;
  }): Promise<FakeUploadSession> {
    assertUuid(input.submissionId, "submissionId");
    assertAcceptanceShape(input);
    const reservation = await this.requireReservation(input.submissionId);
    const started = this.trustedNow();
    const expiresAt = new Date(started.milliseconds + E3_UPLOAD_TTL_MS).toISOString();
    // Generated values are deliberately absent from this fingerprint: an
    // at-least-once retry of the same begin request must recover the first row.
    const requestFingerprint = await canonicalFingerprint({
      operation: "fake.upload.begin",
      submission_id: input.submissionId,
      intended_video_job_id: reservation.intended_video_job_id,
      size_bytes: input.sizeBytes,
      checksum_sha256: input.checksumSha256.toLowerCase(),
      content_type: input.contentType.toLowerCase(),
    });
    const uploadId = this.identities.createUploadId();
    const objectRef = this.identities.createObjectRef();
    assertUuid(uploadId, "generated uploadId");
    assertInternalId(objectRef, "generated objectRef");
    await this.db.prepare(
      `INSERT INTO fake_upload_sessions (
         submission_id, upload_id, request_fingerprint, expected_object_ref,
         expected_size_bytes, expected_checksum_sha256, expected_content_type,
         expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(submission_id) DO NOTHING`,
    ).bind(
      input.submissionId, uploadId, requestFingerprint, objectRef,
      input.sizeBytes, input.checksumSha256.toLowerCase(), input.contentType.toLowerCase(),
      expiresAt, started.iso, started.iso,
    ).run();
    const session = await this.getSession(input.submissionId);
    if (!session || session.request_fingerprint !== requestFingerprint) {
      throw new ConcurrentUpdateError();
    }
    return session;
  }

  async complete(input: {
    submissionId: string;
    uploadId: string;
    eventId: string;
  }): Promise<VideoUploadedQueueEvent> {
    assertUuid(input.submissionId, "submissionId");
    assertUuid(input.uploadId, "uploadId");
    assertUuid(input.eventId, "eventId");
    await this.requireReservation(input.submissionId);
    const session = await this.getSession(input.submissionId);
    if (!session) throw new NotFoundError("Fake upload session");
    if (session.status === "REJECTED") throw new TypeError(`Upload is rejected: ${session.rejection_code}`);
    if (session.upload_id !== input.uploadId) throw new ConcurrentUpdateError();

    const receiptFingerprint = await canonicalFingerprint(receiptFingerprintInput(session));
    if (session.status === "COMPLETED") {
      // A completed exact redelivery remains valid after expiry and after the
      // source object has been removed, but only if all persisted fences agree.
      if (session.completion_event_id !== input.eventId) throw new ConcurrentUpdateError();
      return this.requireCompletedEvent(session, receiptFingerprint, input.eventId);
    }

    // The expiry instant itself is closed: PENDING work must complete strictly before it.
    const beforeInspection = this.trustedNow();
    const expiresAtMilliseconds = Date.parse(session.expires_at);
    if (!Number.isFinite(expiresAtMilliseconds)) {
      await this.reject(input.submissionId, "UPLOAD_RECEIPT_INVALID_EXPIRY", beforeInspection.iso);
      throw new TypeError("Upload receipt has an invalid expiry");
    }
    if (beforeInspection.milliseconds >= expiresAtMilliseconds) {
      await this.reject(input.submissionId, "UPLOAD_RECEIPT_EXPIRED", beforeInspection.iso);
      throw new TypeError("Upload receipt expired");
    }

    let inspection: UploadObjectInspection;
    try {
      inspection = await this.inspector.inspect(session.expected_object_ref);
    } catch {
      const failedAt = this.trustedNow();
      if (failedAt.milliseconds >= expiresAtMilliseconds) {
        await this.reject(input.submissionId, "UPLOAD_RECEIPT_EXPIRED", failedAt.iso);
        throw new TypeError("Upload receipt expired");
      }
      await this.reject(input.submissionId, "UPLOAD_OBJECT_UNREADABLE", failedAt.iso);
      throw new TypeError("Upload object is unreadable");
    }
    const completedAt = this.trustedNow();
    if (completedAt.milliseconds >= expiresAtMilliseconds) {
      await this.reject(input.submissionId, "UPLOAD_RECEIPT_EXPIRED", completedAt.iso);
      throw new TypeError("Upload receipt expired");
    }
    if (inspection.status !== "VERIFIED") {
      const rejectionCode = {
        MISSING: "UPLOAD_OBJECT_MISSING",
        UNREADABLE: "UPLOAD_OBJECT_UNREADABLE",
        CORRUPT: "UPLOAD_OBJECT_CORRUPT",
        NON_VIDEO: "UPLOAD_OBJECT_NON_VIDEO",
      }[inspection.status];
      await this.reject(input.submissionId, rejectionCode, completedAt.iso);
      throw new TypeError(`Upload object validation failed: ${inspection.status}`);
    }
    try {
      assertAcceptanceShape(inspection);
    } catch {
      await this.reject(input.submissionId, "UPLOAD_OBJECT_INVALID_METADATA", completedAt.iso);
      throw new TypeError("Upload object metadata is invalid");
    }
    const sameReceipt = session.expected_size_bytes === inspection.sizeBytes
      && session.expected_checksum_sha256 === inspection.checksumSha256.toLowerCase()
      && session.expected_content_type === inspection.contentType.toLowerCase();
    if (!sameReceipt) {
      await this.reject(input.submissionId, "UPLOAD_RECEIPT_MISMATCH", completedAt.iso);
      throw new TypeError("Inspected upload object does not match its acceptance contract");
    }

    await this.db.batch([
      this.db.prepare(
        `INSERT INTO completed_upload_checksum_claims (
           checksum_sha256, owner_submission_id, claimed_at
         ) SELECT expected_checksum_sha256, submission_id, ?
           FROM fake_upload_sessions
           WHERE submission_id = ? AND upload_id = ? AND status = 'PENDING'
         ON CONFLICT(checksum_sha256) DO NOTHING`,
      ).bind(completedAt.iso, input.submissionId, input.uploadId),
      this.db.prepare(
        `UPDATE fake_upload_sessions
         SET status = 'COMPLETED', completion_event_id = ?, completed_at = ?, updated_at = ?
         WHERE submission_id = ? AND status = 'PENDING' AND upload_id = ?
           AND EXISTS (
             SELECT 1 FROM completed_upload_checksum_claims c
             WHERE c.checksum_sha256 = fake_upload_sessions.expected_checksum_sha256
               AND c.owner_submission_id = fake_upload_sessions.submission_id
           )`,
      ).bind(input.eventId, completedAt.iso, completedAt.iso, input.submissionId, input.uploadId),
      this.db.prepare(
        `INSERT INTO upload_receipt_events (
           event_id, submission_id, object_ref, event_type, receipt_fingerprint, occurred_at
         ) SELECT ?, ?, ?, 'video.uploaded', ?, ?
           WHERE EXISTS (
             SELECT 1 FROM fake_upload_sessions
             WHERE submission_id = ? AND status = 'COMPLETED' AND completion_event_id = ?
           )
         ON CONFLICT(submission_id) DO NOTHING`,
      ).bind(
        input.eventId, input.submissionId, session.expected_object_ref,
        receiptFingerprint, completedAt.iso, input.submissionId, input.eventId,
      ),
    ]);
    const completed = await this.getSession(input.submissionId);
    if (completed?.status === "PENDING"
      && await this.checksumClaimedByAnother(session.expected_checksum_sha256, input.submissionId)) {
      await this.reject(input.submissionId, "UPLOAD_DUPLICATE_CHECKSUM", completedAt.iso);
      throw new TypeError("Upload duplicates a completed video");
    }
    if (!completed || completed.status !== "COMPLETED" || completed.completion_event_id !== input.eventId) {
      throw new ConcurrentUpdateError();
    }
    return this.requireCompletedEvent(completed, receiptFingerprint, input.eventId);
  }

  async getSession(submissionId: string): Promise<FakeUploadSession | null> {
    assertUuid(submissionId, "submissionId");
    return this.db.prepare("SELECT * FROM fake_upload_sessions WHERE submission_id = ?")
      .bind(submissionId).first<FakeUploadSession>();
  }

  private async requireCompletedEvent(
    session: FakeUploadSession,
    receiptFingerprint: string,
    eventId: string,
  ): Promise<VideoUploadedQueueEvent> {
    const event = await this.db.prepare(
      `SELECT event_id, submission_id, object_ref, event_type, receipt_fingerprint, occurred_at
       FROM upload_receipt_events WHERE submission_id = ?`,
    ).bind(session.submission_id).first<{
      event_id: string;
      submission_id: string;
      object_ref: string;
      event_type: string;
      receipt_fingerprint: string;
      occurred_at: string;
    }>();
    if (
      event?.event_id !== eventId
      || event.receipt_fingerprint !== receiptFingerprint
      || event.event_type !== "video.uploaded"
      || event.submission_id !== session.submission_id
      || event.object_ref !== session.expected_object_ref
    ) throw new ConcurrentUpdateError();
    return {
      version: 1,
      event_id: event.event_id,
      event_type: "video.uploaded",
      occurred_at: event.occurred_at,
      payload: {
        submission_id: event.submission_id,
        object_ref: event.object_ref,
        actor_id: this.callbackActorId,
      },
    };
  }

  private async requireReservation(submissionId: string): Promise<ResolvedIntakeReservation> {
    const rows = await this.db.prepare(
      `SELECT i.submission_id, i.intended_video_job_id,
              c.class_id, c.branch_id, c.studio_id, c.teacher_id, c.source_version
       FROM submission_intakes i
       JOIN submission_candidate_snapshots c ON c.submission_id = i.submission_id
       WHERE i.submission_id = ? AND i.status = 'RESOLVED'
         AND (i.video_job_id IS NULL OR i.video_job_id = i.intended_video_job_id)
       ORDER BY c.class_id`,
    ).bind(submissionId).all<ResolvedIntakeReservation>();
    if (rows.results.length > 1) throw new ConcurrentUpdateError();
    const reservation = rows.results[0] ?? null;
    if (!reservation) throw new NotFoundError("Resolved upload intake reservation");
    return reservation;
  }

  private trustedNow(): { milliseconds: number; iso: string } {
    const milliseconds = this.clock.now().getTime();
    if (!Number.isFinite(milliseconds)) throw new TypeError("Trusted clock returned an invalid time");
    return { milliseconds, iso: new Date(milliseconds).toISOString() };
  }

  private async checksumClaimedByAnother(checksum: string, submissionId: string): Promise<boolean> {
    const row = await this.db.prepare(
      `SELECT owner_submission_id FROM completed_upload_checksum_claims
       WHERE checksum_sha256 = ? AND owner_submission_id <> ?`,
    ).bind(checksum, submissionId).first<{ owner_submission_id: string }>();
    return !!row;
  }

  private async reject(submissionId: string, reason: string, now: string): Promise<void> {
    await this.db.prepare(
      `UPDATE fake_upload_sessions
       SET status = 'REJECTED', rejection_code = ?, updated_at = ?
       WHERE submission_id = ? AND status = 'PENDING'`,
    ).bind(reason, now, submissionId).run();
  }
}

/** Creates the job only from a previously committed, fully verified receipt event. */
export class E3UploadReceiptConsumer {
  constructor(
    private readonly db: D1Database,
    private readonly trustedCallbackActors: ReadonlySet<string> = new Set(["fake_upload_callback"]),
  ) {}

  async consume(event: VideoUploadedQueueEvent): Promise<VideoJob> {
    if (!this.trustedCallbackActors.has(event.payload.actor_id)) {
      throw new TypeError("video.uploaded actor is not trusted");
    }
    const receipt = await this.db.prepare(
      `SELECT event_id, submission_id, object_ref, event_type, receipt_fingerprint, occurred_at
       FROM upload_receipt_events WHERE event_id = ?`,
    ).bind(event.event_id).first<{
      event_id: string;
      submission_id: string;
      object_ref: string;
      event_type: string;
      receipt_fingerprint: string;
      occurred_at: string;
    }>();
    if (!receipt) throw new NotFoundError("Upload receipt event");
    if (
      receipt.event_type !== "video.uploaded"
      || receipt.submission_id !== event.payload.submission_id
      || receipt.object_ref !== event.payload.object_ref
      || receipt.occurred_at !== event.occurred_at
    ) throw new ConcurrentUpdateError();

    const session = await this.db.prepare(
      "SELECT * FROM fake_upload_sessions WHERE submission_id = ?",
    ).bind(event.payload.submission_id).first<FakeUploadSession>();
    if (
      !session
      || session.status !== "COMPLETED"
      || session.completion_event_id !== event.event_id
      || session.expected_object_ref !== event.payload.object_ref
    ) throw new ConcurrentUpdateError();
    const receiptFingerprint = await canonicalFingerprint(receiptFingerprintInput(session));
    if (receipt.receipt_fingerprint !== receiptFingerprint) throw new ConcurrentUpdateError();

    const reservation = await this.requireReservation(event.payload.submission_id);
    const operationToken = `upload_${event.event_id.replaceAll("-", "")}`;
    const auditId = `audit_${event.event_id.replaceAll("-", "")}`;
    const mirrorId = `mirror_${event.event_id.replaceAll("-", "")}`;
    const mirrorPayload = JSON.stringify({
      submission_id: event.payload.submission_id,
      video_job_id: reservation.intended_video_job_id,
      event_type: "video.uploaded",
      object_ref: event.payload.object_ref,
    });
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO video_jobs (
           video_job_id, submission_id, branch_id, studio_id, class_id, teacher_id,
           state, creation_token, creation_fingerprint, created_at, updated_at
         ) SELECT i.intended_video_job_id, i.submission_id, c.branch_id, c.studio_id,
                  c.class_id, c.teacher_id, 'RECEIVED', ?, e.receipt_fingerprint, ?, ?
           FROM submission_intakes i
           JOIN submission_candidate_snapshots c ON c.submission_id = i.submission_id
           JOIN fake_upload_sessions s ON s.submission_id = i.submission_id
           JOIN upload_receipt_events e ON e.submission_id = i.submission_id
           WHERE i.submission_id = ? AND i.status = 'RESOLVED'
             AND (i.video_job_id IS NULL OR i.video_job_id = i.intended_video_job_id)
             AND s.status = 'COMPLETED' AND s.completion_event_id = ?
             AND s.expected_object_ref = ?
             AND e.event_id = ? AND e.event_type = 'video.uploaded'
             AND e.object_ref = s.expected_object_ref AND e.receipt_fingerprint = ?
           ON CONFLICT(video_job_id) DO NOTHING`,
      ).bind(
        operationToken, event.occurred_at, event.occurred_at,
        event.payload.submission_id, event.event_id, event.payload.object_ref,
        event.event_id, receiptFingerprint,
      ),
      this.db.prepare(
        `UPDATE submission_intakes
         SET video_job_id = intended_video_job_id, updated_at = ?
         WHERE submission_id = ? AND status = 'RESOLVED' AND video_job_id IS NULL
           AND EXISTS (
             SELECT 1 FROM video_jobs
             WHERE video_job_id = submission_intakes.intended_video_job_id
               AND submission_id = submission_intakes.submission_id
               AND creation_fingerprint = ?
           )`,
      ).bind(event.occurred_at, event.payload.submission_id, receiptFingerprint),
      this.db.prepare(
        `INSERT INTO audit_logs (
           audit_id, video_job_id, actor_type, actor_id, action, from_state, to_state,
           details_json, occurred_at
         ) SELECT ?, video_job_id, 'system', ?, 'job.created', NULL, 'RECEIVED', ?, ?
           FROM video_jobs WHERE video_job_id = ? AND creation_token = ?
           ON CONFLICT(audit_id) DO NOTHING`,
      ).bind(
        auditId, event.payload.actor_id,
        JSON.stringify({ object_ref: event.payload.object_ref, event_id: event.event_id }),
        event.occurred_at, reservation.intended_video_job_id, operationToken,
      ),
      this.db.prepare(
        `INSERT INTO mirror_outbox (
           mirror_event_id, video_job_id, event_type, payload_json, available_at, created_at, updated_at
         ) SELECT ?, video_job_id, 'video.uploaded', ?, ?, ?, ?
           FROM video_jobs WHERE video_job_id = ? AND creation_token = ?
           ON CONFLICT(mirror_event_id) DO NOTHING`,
      ).bind(
        mirrorId, mirrorPayload, event.occurred_at, event.occurred_at, event.occurred_at,
        reservation.intended_video_job_id, operationToken,
      ),
    ]);
    const job = await this.db.prepare("SELECT * FROM video_jobs WHERE video_job_id = ?")
      .bind(reservation.intended_video_job_id).first<VideoJob>();
    if (
      !job
      || job.submission_id !== event.payload.submission_id
      || job.creation_fingerprint !== receiptFingerprint
    ) throw new ConcurrentUpdateError();
    return job;
  }

  private async requireReservation(submissionId: string): Promise<ResolvedIntakeReservation> {
    const rows = await this.db.prepare(
      `SELECT i.submission_id, i.intended_video_job_id,
              c.class_id, c.branch_id, c.studio_id, c.teacher_id, c.source_version
       FROM submission_intakes i
       JOIN submission_candidate_snapshots c ON c.submission_id = i.submission_id
       WHERE i.submission_id = ? AND i.status = 'RESOLVED'
         AND (i.video_job_id IS NULL OR i.video_job_id = i.intended_video_job_id)
       ORDER BY c.class_id`,
    ).bind(submissionId).all<ResolvedIntakeReservation>();
    if (rows.results.length !== 1) throw new ConcurrentUpdateError();
    return rows.results[0]!;
  }
}
