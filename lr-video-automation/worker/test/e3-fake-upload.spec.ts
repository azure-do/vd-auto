import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { E2Repository, type ClassReadModelEntryInput } from "../src/e2-repository";
import { E2LocalService } from "../src/e2-service";
import { normalizeQueueEvent, type QueueEvent } from "../src/domain";
import {
  E3_UPLOAD_TTL_MS,
  E3FakeUploadService,
  E3UploadReceiptConsumer,
  type TrustedClock,
  type UploadObjectInspection,
  type UploadObjectInspector,
  type VideoUploadedQueueEvent,
} from "../src/e3-fake-upload";
import { canonicalFingerprint, sha256Hex } from "../src/fingerprint";
import { handleQueueBatch } from "../src/queue";
import { JobRepository } from "../src/repository";
import { createLocalIdentityFixture } from "./e2-test-identity";
import { E3R2UploadService, R2_CALLBACK_ACTOR, presignR2Put } from "../src/e3-r2-upload";
import {
  e3UploadErrorResponse,
  enqueueCompletedUploadEvent,
  UploadQueueUnavailableError,
} from "../src/index";

const NOW = "2026-08-20T00:00:00.000Z";
const LATER = "2026-08-20T00:01:00.000Z";
const EXPIRES = "2026-08-20T00:16:00.000Z";
const JUST_BEFORE_EXPIRY = "2026-08-20T00:15:59.999Z";
const AFTER_EXPIRY = "2026-08-20T00:17:00.000Z";
const LESSON_ON = "2026-08-20";
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const checksum = "a".repeat(64);
type VerifiedInspection = {
  status: "VERIFIED";
  sizeBytes: number;
  checksumSha256: string;
  contentType: string;
};
const verified = (override: Partial<VerifiedInspection> = {}): VerifiedInspection => ({
  status: "VERIFIED" as const,
  sizeBytes: 1_024,
  checksumSha256: checksum,
  contentType: "video/mp4",
  ...override,
});

class FakeUploadObjectInspector implements UploadObjectInspector {
  readonly objects = new Map<string, UploadObjectInspection | Error>();
  readonly calls: string[] = [];

  async inspect(objectRef: string): Promise<UploadObjectInspection> {
    this.calls.push(objectRef);
    const result = this.objects.get(objectRef) ?? { status: "MISSING" as const };
    if (result instanceof Error) throw result;
    return result;
  }
}

class MutableClock implements TrustedClock {
  constructor(private current: string) {}
  now(): Date { return new Date(this.current); }
  set(current: string): void { this.current = current; }
}

let clock: MutableClock;

function uploadService(inspector: UploadObjectInspector): E3FakeUploadService {
  return new E3FakeUploadService(env.DB, inspector, undefined, clock);
}

function fakeMessage(id: string, body: unknown): Message<unknown> {
  return {
    id,
    timestamp: clock.now(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function fakeBatch(messages: Message<unknown>[]): MessageBatch<unknown> {
  return {
    queue: "lr-video-jobs",
    messages,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
}

async function deliver(body: unknown, messageId: string): Promise<Message<unknown>> {
  const message = fakeMessage(messageId, body);
  await handleQueueBatch(fakeBatch([message]), env, () => clock.now());
  return message;
}

async function clearDatabase(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM dlq_messages"),
    env.DB.prepare("DELETE FROM queue_deliveries"),
    env.DB.prepare("DELETE FROM upload_receipt_events"),
    env.DB.prepare("DELETE FROM completed_upload_checksum_claims"),
    env.DB.prepare("DELETE FROM fake_upload_sessions"),
    env.DB.prepare("DELETE FROM fake_notification_outbox"),
    env.DB.prepare("DELETE FROM intake_audit_logs"),
    env.DB.prepare("DELETE FROM submission_candidate_snapshots"),
    env.DB.prepare("DELETE FROM submission_intakes"),
    env.DB.prepare("DELETE FROM teacher_identity_audits"),
    env.DB.prepare("DELETE FROM teacher_identity_bindings"),
    env.DB.prepare("DELETE FROM class_read_model_entries"),
    env.DB.prepare("DELETE FROM class_read_model_versions"),
    env.DB.prepare("DELETE FROM mirror_outbox"),
    env.DB.prepare("DELETE FROM audit_logs"),
    env.DB.prepare("DELETE FROM idempotency_records"),
    env.DB.prepare("DELETE FROM applied_mutations"),
    env.DB.prepare("DELETE FROM video_jobs"),
    env.DB.prepare(
      `UPDATE class_read_model_head
       SET active_source_version = NULL, read_status = 'UNAVAILABLE', failure_code = NULL,
           updated_at = '1970-01-01T00:00:00.000Z' WHERE singleton_id = 1`,
    ),
  ]);
}

async function resolvedSubmission(submissionId: string): Promise<void> {
  const fixture = await createLocalIdentityFixture(NOW);
  const email = fixture.makeEmail();
  const entry: ClassReadModelEntryInput = {
    classId: "class_e3_dummy", branchId: "branch_e3_dummy", studioId: "studio_e3_dummy",
    teacherId: "teacher_e3_dummy", teacherEmailFingerprint: await sha256Hex(email.toLowerCase()),
    lessonOn: LESSON_ON,
  };
  const repository = new E2Repository(env.DB);
  await repository.importClassReadModel({
    sourceVersion: 1, fetchedAt: NOW, ttlSeconds: 3_600, entries: [entry], now: NOW,
  });
  const service = new E2LocalService(repository, fixture.config);
  await service.submit({ idToken: await fixture.sign({ email }), submissionId, lessonOn: LESSON_ON, now: LATER });
}

async function resolvedSubmissions(submissionIds: readonly string[]): Promise<void> {
  const fixture = await createLocalIdentityFixture(NOW);
  const email = fixture.makeEmail();
  const repository = new E2Repository(env.DB);
  await repository.importClassReadModel({
    sourceVersion: 1,
    fetchedAt: NOW,
    ttlSeconds: 3_600,
    entries: [{
      classId: "class_e3_dummy",
      branchId: "branch_e3_dummy",
      studioId: "studio_e3_dummy",
      teacherId: "teacher_e3_dummy",
      teacherEmailFingerprint: await sha256Hex(email.toLowerCase()),
      lessonOn: LESSON_ON,
    }],
    now: NOW,
  });
  const service = new E2LocalService(repository, fixture.config);
  const idToken = await fixture.sign({ email });
  for (const submissionId of submissionIds) {
    await service.submit({ idToken, submissionId, lessonOn: LESSON_ON, now: LATER });
  }
}

function beginInput(submissionId: string) {
  return {
    submissionId, sizeBytes: 1_024, checksumSha256: checksum,
    contentType: "video/mp4",
  };
}

function callback(session: { submission_id: string; upload_id: string }, eventId: string) {
  return { submissionId: session.submission_id, uploadId: session.upload_id, eventId };
}

async function queueFingerprint(event: QueueEvent): Promise<string> {
  return canonicalFingerprint({
    event_type: event.event_type,
    video_job_id: null,
    occurred_at: event.occurred_at,
    payload: event.payload,
  });
}

async function completedUpload(id: number) {
  const submissionId = uuid(id);
  await resolvedSubmission(submissionId);
  const inspector = new FakeUploadObjectInspector();
  const service = uploadService(inspector);
  const session = await service.begin(beginInput(submissionId));
  inspector.objects.set(session.expected_object_ref, verified());
  const event = await service.complete(callback(session, uuid(id + 2_000)));
  return { submissionId, service, session, event };
}

describe("E-3.1 fake upload receipt contract", () => {
  beforeEach(async () => {
    await clearDatabase();
    clock = new MutableClock(LATER);
  });

  it("normalizes the formal video.uploaded QueueEvent without losing its reversible references", () => {
    const normalized = normalizeQueueEvent({
      version: 1,
      event_id: uuid(3001),
      event_type: "video.uploaded",
      occurred_at: "2026-08-20T09:01:00.000+09:00",
      payload: {
        submission_id: uuid(1001),
        object_ref: "fake_object_reversible_01",
        actor_id: "fake_upload_callback",
        ignored: "removed",
      },
    });
    expect(normalized).toEqual({
      version: 1,
      event_id: uuid(3001),
      event_type: "video.uploaded",
      occurred_at: LATER,
      payload: {
        submission_id: uuid(1001),
        object_ref: "fake_object_reversible_01",
        actor_id: "fake_upload_callback",
      },
    });
  });

  it("generates uncaller-controlled opaque IDs and different begin calls get different IDs", async () => {
    const firstSubmissionId = uuid(1101);
    await resolvedSubmission(firstSubmissionId);
    const firstInspector = new FakeUploadObjectInspector();
    const firstService = uploadService(firstInspector);
    const malicious = {
      ...beginInput(firstSubmissionId),
      uploadId: uuid(9991),
      objectRef: "caller_chosen_object",
      now: "1970-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const first = await firstService.begin(malicious);
    expect(first.upload_id).not.toBe(malicious.uploadId);
    expect(first.expected_object_ref).not.toBe(malicious.objectRef);
    expect(first.upload_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.expected_object_ref).toMatch(/^fake_object_[0-9a-f]{32}$/);
    expect(first.created_at).toBe(LATER);
    expect(first.updated_at).toBe(LATER);
    expect(first.expires_at).toBe(EXPIRES);
    expect(Date.parse(first.expires_at) - Date.parse(first.created_at)).toBe(E3_UPLOAD_TTL_MS);

    await clearDatabase();
    const secondSubmissionId = uuid(1102);
    await resolvedSubmission(secondSubmissionId);
    const second = await uploadService(new FakeUploadObjectInspector())
      .begin(beginInput(secondSubmissionId));
    expect(second.upload_id).not.toBe(first.upload_id);
    expect(second.expected_object_ref).not.toBe(first.expected_object_ref);
  });

  it("returns the original session for repeated and concurrent identical begin requests", async () => {
    const submissionId = uuid(1151);
    await resolvedSubmission(submissionId);
    const service = uploadService(new FakeUploadObjectInspector());
    const [first, second] = await Promise.all([
      service.begin(beginInput(submissionId)),
      service.begin(beginInput(submissionId)),
    ]);
    clock.set("2026-08-20T00:02:00.000Z");
    const replay = await service.begin(beginInput(submissionId));
    expect(second.upload_id).toBe(first.upload_id);
    expect(replay.expected_object_ref).toBe(first.expected_object_ref);
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM fake_upload_sessions").first()).toEqual({ count: 1 });
    await expect(service.begin({ ...beginInput(submissionId), sizeBytes: 1_025 }))
      .rejects.toThrow("changed");
  });

  it("rejects a non-video acceptance contract before creating a session", async () => {
    const submissionId = uuid(1171);
    await resolvedSubmission(submissionId);
    const service = uploadService(new FakeUploadObjectInspector());
    await expect(service.begin({ ...beginInput(submissionId), contentType: "text/plain" }))
      .rejects.toThrow("video MIME");
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM fake_upload_sessions").first()).toEqual({ count: 0 });
  });

  it("creates exactly one RECEIVED job from inspected storage and replays it after expiry", async () => {
    const submissionId = uuid(1201);
    await resolvedSubmission(submissionId);
    const inspector = new FakeUploadObjectInspector();
    const service = uploadService(inspector);
    const session = await service.begin(beginInput(submissionId));
    inspector.objects.set(session.expected_object_ref, verified());
    const eventId = uuid(3201);
    const callbackWithUntrustedTime = {
      ...callback(session, eventId),
      now: "2099-01-01T00:00:00.000Z",
    };
    const firstEvent = await service.complete(callbackWithUntrustedTime);
    expect(await service.getSession(submissionId)).toMatchObject({ completed_at: LATER });
    expect(firstEvent).toMatchObject({
      event_type: "video.uploaded",
      payload: { submission_id: submissionId, object_ref: session.expected_object_ref },
    });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM video_jobs").first()).toEqual({ count: 0 });
    const firstDelivery = await deliver(firstEvent, "message_e3_first");
    expect(firstDelivery.ack).toHaveBeenCalledOnce();
    inspector.objects.delete(session.expected_object_ref);
    clock.set(AFTER_EXPIRY);
    const replayEvent = await service.complete(callback(session, eventId));
    expect(replayEvent).toEqual(firstEvent);
    const replayDelivery = await deliver(replayEvent, "message_e3_replay");
    expect(replayDelivery.ack).toHaveBeenCalledOnce();
    expect(inspector.calls).toEqual([session.expected_object_ref]);
    expect(await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM video_jobs) jobs,
              (SELECT COUNT(*) FROM upload_receipt_events) events,
              (SELECT COUNT(*) FROM audit_logs WHERE action = 'job.created') audits,
              (SELECT e.object_ref = s.expected_object_ref
                 FROM upload_receipt_events e
                 JOIN fake_upload_sessions s ON s.submission_id = e.submission_id) object_matches,
              (SELECT e.receipt_fingerprint = v.creation_fingerprint
                 FROM upload_receipt_events e
                 JOIN video_jobs v ON v.submission_id = e.submission_id) fingerprint_matches`,
    ).first()).toEqual({ jobs: 1, events: 1, audits: 1, object_matches: 1, fingerprint_matches: 1 });
  });

  it("uses the same receipt fence for an R2 callback and accepts Queue redelivery once", async () => {
    const submissionId = uuid(1211);
    await resolvedSubmission(submissionId);
    const inspector = new FakeUploadObjectInspector();
    const service = new E3R2UploadService(env.DB, inspector, {
      accountId: "00000000000000000000000000000000",
      accessKeyId: "DEVACCESSKEYID", secretAccessKey: "development-only-test-secret", bucketName: "lr-video-automation-dev-20260824",
    }, clock);
    const started = await service.begin(beginInput(submissionId));
    expect(started.session.expected_object_ref).toMatch(/^r2_object_/);
    expect(started.upload.requiredHeaders).toMatchObject({ "content-type": "video/mp4" });
    expect(started.upload.requiredHeaders["content-length"]).toBeUndefined();
    inspector.objects.set(started.session.expected_object_ref, verified());
    const event = await service.complete({
      submissionId, uploadId: started.session.upload_id, eventId: uuid(3211),
    });
    expect(event.payload.actor_id).toBe(R2_CALLBACK_ACTOR);
    const first = await deliver(event, "message_r2_first");
    const replay = await deliver(event, "message_r2_replay");
    expect(first.ack).toHaveBeenCalledOnce();
    expect(replay.ack).toHaveBeenCalledOnce();
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM video_jobs").first()).toEqual({ count: 1 });
  });

  it("presigns only the bounded PUT headers and a 15-minute-or-shorter expiry", async () => {
    const result = await presignR2Put({
      accountId: "00000000000000000000000000000000",
      accessKeyId: "DEVACCESSKEYID", secretAccessKey: "development-only-test-secret", bucketName: "lr-video-automation-dev-20260824",
    }, "r2_object_test", {
      contentType: "video/mp4", sizeBytes: 1024, checksumSha256: checksum,
      expiresAt: new Date("2026-08-20T00:15:00.000Z"),
    }, new Date(NOW));
    const url = new URL(result.url);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host;x-amz-checksum-sha256");
    expect(result.requiredHeaders["content-length"]).toBeUndefined();
    expect(result.requiredHeaders["x-amz-checksum-sha256"]).toBeTruthy();
  });

  it("presigns the bucket supplied by the development configuration and never the former bucket", async () => {
    const configuredBucket = "lr-video-automation-dev-20260824";
    const formerBucket = `lr-video-automation-dev-202608${20 + 3}`;
    const result = await presignR2Put({
      accountId: "00000000000000000000000000000000",
      accessKeyId: "DEVACCESSKEYID",
      secretAccessKey: "development-only-test-secret",
      bucketName: configuredBucket,
    }, "r2_object_configured_bucket", {
      contentType: "video/mp4", sizeBytes: 1024, checksumSha256: checksum,
      expiresAt: new Date("2026-08-20T00:15:00.000Z"),
    }, new Date(NOW));

    const pathname = decodeURIComponent(new URL(result.url).pathname);
    expect(pathname).toBe(`/${configuredBucket}/r2_object_configured_bucket`);
    expect(pathname).not.toContain(formerBucket);
  });

  it("rejects an exact replay when the persisted receipt fingerprint no longer matches", async () => {
    const submissionId = uuid(1221);
    await resolvedSubmission(submissionId);
    const inspector = new FakeUploadObjectInspector();
    const service = uploadService(inspector);
    const session = await service.begin(beginInput(submissionId));
    inspector.objects.set(session.expected_object_ref, verified());
    const eventId = uuid(3221);
    await service.complete(callback(session, eventId));
    await env.DB.prepare(
      "UPDATE upload_receipt_events SET receipt_fingerprint = ? WHERE submission_id = ?",
    ).bind("b".repeat(64), submissionId).run();
    clock.set(AFTER_EXPIRY);
    await expect(service.complete(callback(session, eventId))).rejects.toThrow("changed");
  });

  it("does not complete from caller self-reported metadata when storage is missing", async () => {
    const submissionId = uuid(1251);
    await resolvedSubmission(submissionId);
    const service = uploadService(new FakeUploadObjectInspector());
    const session = await service.begin(beginInput(submissionId));
    const selfReported = {
      ...callback(session, uuid(3251)),
      objectRef: session.expected_object_ref,
      sizeBytes: 1_024,
      checksumSha256: checksum,
      contentType: "video/mp4",
    };
    await expect(service.complete(selfReported)).rejects.toThrow("MISSING");
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM video_jobs").first()).toEqual({ count: 0 });
  });

  it.each([
    ["missing", { status: "MISSING" } as const, "UPLOAD_OBJECT_MISSING", 1301],
    ["corrupt", { status: "CORRUPT", sizeBytes: 1_024, checksumSha256: checksum, contentType: "video/mp4" } as const, "UPLOAD_OBJECT_CORRUPT", 1302],
    ["unreadable result", { status: "UNREADABLE" } as const, "UPLOAD_OBJECT_UNREADABLE", 1303],
    ["non-video", { status: "NON_VIDEO", sizeBytes: 1_024, checksumSha256: checksum, contentType: "text/plain" } as const, "UPLOAD_OBJECT_NON_VIDEO", 1304],
  ])("fails closed for a %s inspected object", async (_name, inspection, code, id) => {
    const submissionId = uuid(id);
    await resolvedSubmission(submissionId);
    const inspector = new FakeUploadObjectInspector();
    const service = uploadService(inspector);
    const session = await service.begin(beginInput(submissionId));
    inspector.objects.set(session.expected_object_ref, inspection);
    await expect(service.complete(callback(session, uuid(id + 2_000)))).rejects.toThrow("validation failed");
    expect(await service.getSession(submissionId)).toMatchObject({ status: "REJECTED", rejection_code: code });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM video_jobs").first()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM upload_receipt_events").first()).toEqual({ count: 0 });
  });

  it("fails closed when the inspector throws an unreadable error", async () => {
    const submissionId = uuid(1351);
    await resolvedSubmission(submissionId);
    const inspector = new FakeUploadObjectInspector();
    const service = uploadService(inspector);
    const session = await service.begin(beginInput(submissionId));
    inspector.objects.set(session.expected_object_ref, new Error("fake read failure"));
    await expect(service.complete(callback(session, uuid(3351)))).rejects.toThrow("unreadable");
    expect(await service.getSession(submissionId)).toMatchObject({
      status: "REJECTED", rejection_code: "UPLOAD_OBJECT_UNREADABLE",
    });
  });

  it.each([
    ["size", verified({ sizeBytes: 1_025 }), 1401],
    ["checksum", verified({ checksumSha256: "b".repeat(64) }), 1402],
    ["content type", verified({ contentType: "video/webm" }), 1403],
  ])("rejects inspected %s that differs from the acceptance contract", async (_name, inspection, id) => {
    const submissionId = uuid(id);
    await resolvedSubmission(submissionId);
    const inspector = new FakeUploadObjectInspector();
    const service = uploadService(inspector);
    const session = await service.begin(beginInput(submissionId));
    inspector.objects.set(session.expected_object_ref, inspection);
    await expect(service.complete(callback(session, uuid(id + 2_000)))).rejects.toThrow("acceptance contract");
    expect(await service.getSession(submissionId)).toMatchObject({
      status: "REJECTED", rejection_code: "UPLOAD_RECEIPT_MISMATCH",
    });
  });

  it("rejects PENDING completion at the exact expiry boundary", async () => {
    const submissionId = uuid(1501);
    await resolvedSubmission(submissionId);
    const inspector = new FakeUploadObjectInspector();
    const service = uploadService(inspector);
    const session = await service.begin(beginInput(submissionId));
    inspector.objects.set(session.expected_object_ref, verified());
    clock.set(EXPIRES);
    await expect(service.complete(callback(session, uuid(3501)))).rejects.toThrow("expired");
    expect(inspector.calls).toEqual([]);
    expect(await service.getSession(submissionId)).toMatchObject({
      status: "REJECTED", rejection_code: "UPLOAD_RECEIPT_EXPIRED",
    });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM video_jobs").first()).toEqual({ count: 0 });
  });

  it("allows the first completion one millisecond before the fixed expiry", async () => {
    const submissionId = uuid(1511);
    await resolvedSubmission(submissionId);
    const inspector = new FakeUploadObjectInspector();
    const service = uploadService(inspector);
    const session = await service.begin(beginInput(submissionId));
    inspector.objects.set(session.expected_object_ref, verified());
    clock.set(JUST_BEFORE_EXPIRY);
    const event = await service.complete(callback(session, uuid(3511)));
    const message = await deliver(event, "message_before_expiry");
    expect(message.ack).toHaveBeenCalledOnce();
    expect(await env.DB.prepare("SELECT submission_id, state FROM video_jobs").first())
      .toEqual({ submission_id: submissionId, state: "RECEIVED" });
    expect(await service.getSession(submissionId)).toMatchObject({
      status: "COMPLETED", completed_at: JUST_BEFORE_EXPIRY,
    });
  });

  it("serializes concurrent identical callbacks into one upload event and one job", async () => {
    const submissionId = uuid(1551);
    await resolvedSubmission(submissionId);
    const inspector = new FakeUploadObjectInspector();
    const service = uploadService(inspector);
    const session = await service.begin(beginInput(submissionId));
    inspector.objects.set(session.expected_object_ref, verified());
    const input = callback(session, uuid(3551));
    const results = await Promise.all([service.complete(input), service.complete(input)]);
    expect(results[0]).toEqual(results[1]);
    const messages = [
      fakeMessage("message_callback_same_1", results[0]),
      fakeMessage("message_callback_same_2", results[1]),
    ];
    await handleQueueBatch(fakeBatch(messages), env, () => clock.now());
    expect(messages[0]!.ack).toHaveBeenCalledOnce();
    expect(messages[1]!.ack).toHaveBeenCalledOnce();
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM video_jobs").first()).toEqual({ count: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM upload_receipt_events").first()).toEqual({ count: 1 });
  });

  it("allows only one of two different event IDs racing for the same upload", async () => {
    const submissionId = uuid(1571);
    await resolvedSubmission(submissionId);
    const inspector = new FakeUploadObjectInspector();
    const service = uploadService(inspector);
    const session = await service.begin(beginInput(submissionId));
    inspector.objects.set(session.expected_object_ref, verified());
    const results = await Promise.allSettled([
      service.complete(callback(session, uuid(3571))),
      service.complete(callback(session, uuid(3572))),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const accepted = results.find((result) => result.status === "fulfilled");
    if (accepted?.status !== "fulfilled") throw new Error("expected one accepted event");
    const message = await deliver(accepted.value, "message_event_winner");
    expect(message.ack).toHaveBeenCalledOnce();
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM video_jobs").first()).toEqual({ count: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM upload_receipt_events").first()).toEqual({ count: 1 });
  });

  it("allows only one job when different submissions with the same checksum complete concurrently", async () => {
    const firstSubmissionId = uuid(1581);
    const secondSubmissionId = uuid(1582);
    await resolvedSubmissions([firstSubmissionId, secondSubmissionId]);
    const inspector = new FakeUploadObjectInspector();
    const service = uploadService(inspector);
    const first = await service.begin(beginInput(firstSubmissionId));
    const second = await service.begin(beginInput(secondSubmissionId));
    inspector.objects.set(first.expected_object_ref, verified());
    inspector.objects.set(second.expected_object_ref, verified());

    const completions = await Promise.allSettled([
      service.complete(callback(first, uuid(3581))),
      service.complete(callback(second, uuid(3582))),
    ]);

    const accepted = completions.find((result) => result.status === "fulfilled");
    expect(completions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(completions.filter((result) => result.status === "rejected")).toHaveLength(1);
    if (accepted?.status !== "fulfilled") throw new Error("expected one checksum fence winner");
    await deliver(accepted.value, "message_checksum_winner");
    expect(await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM fake_upload_sessions WHERE status = 'COMPLETED') completed,
         (SELECT COUNT(*) FROM fake_upload_sessions WHERE status = 'REJECTED' AND rejection_code = 'UPLOAD_DUPLICATE_CHECKSUM') rejected,
         (SELECT COUNT(*) FROM upload_receipt_events) receipts,
         (SELECT COUNT(*) FROM video_jobs) jobs,
         (SELECT COUNT(*) FROM audit_logs WHERE action = 'job.created') audits`,
    ).first()).toEqual({ completed: 1, rejected: 1, receipts: 1, jobs: 1, audits: 1 });

    const winnerSession = accepted.value.payload.submission_id === firstSubmissionId ? first : second;
    await expect(service.complete(callback(winnerSession, accepted.value.event_id))).resolves.toEqual(accepted.value);
  });

  it("rolls back the checksum claim and session completion when receipt insertion collides", async () => {
    const existingSubmissionId = uuid(1583);
    const pendingSubmissionId = uuid(1584);
    await resolvedSubmissions([existingSubmissionId, pendingSubmissionId]);
    const inspector = new FakeUploadObjectInspector();
    const service = uploadService(inspector);

    const existing = await service.begin(beginInput(existingSubmissionId));
    inspector.objects.set(existing.expected_object_ref, verified());
    const collidingEventId = uuid(3583);
    await service.complete(callback(existing, collidingEventId));

    const pendingChecksum = "b".repeat(64);
    const pending = await service.begin({
      ...beginInput(pendingSubmissionId),
      checksumSha256: pendingChecksum,
    });
    inspector.objects.set(pending.expected_object_ref, verified({ checksumSha256: pendingChecksum }));

    await expect(service.complete(callback(pending, collidingEventId))).rejects.toThrow();

    expect(await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM completed_upload_checksum_claims
            WHERE checksum_sha256 = ?) claims,
         (SELECT COUNT(*) FROM fake_upload_sessions
            WHERE submission_id = ? AND status = 'PENDING') pending_sessions,
         (SELECT COUNT(*) FROM upload_receipt_events
            WHERE submission_id = ?) new_receipts`,
    ).bind(pendingChecksum, pendingSubmissionId, pendingSubmissionId).first())
      .toEqual({ claims: 0, pending_sessions: 1, new_receipts: 0 });
  });

  it("returns a retryable 503 classification and recovers after Queue.send fails", async () => {
    const submissionId = uuid(1591);
    await resolvedSubmission(submissionId);
    const inspector = new FakeUploadObjectInspector();
    const service = uploadService(inspector);
    const session = await service.begin(beginInput(submissionId));
    inspector.objects.set(session.expected_object_ref, verified());
    const input = callback(session, uuid(3591));
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("temporary Queue outage"))
      .mockResolvedValueOnce(undefined);

    let firstError: unknown;
    try {
      await enqueueCompletedUploadEvent(service, { send } as unknown as Queue, input);
    } catch (error) {
      firstError = error;
    }
    expect(firstError).toBeInstanceOf(UploadQueueUnavailableError);
    const response = e3UploadErrorResponse(firstError);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "QUEUE_UNAVAILABLE", retryable: true });
    expect(await service.getSession(submissionId)).toMatchObject({ status: "COMPLETED" });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM upload_receipt_events").first()).toEqual({ count: 1 });

    await expect(enqueueCompletedUploadEvent(service, { send } as unknown as Queue, input)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toEqual(send.mock.calls[1]?.[0]);
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM upload_receipt_events").first()).toEqual({ count: 1 });
  });

  it("replays a video.uploaded event from DLQ and keeps one job on duplicate delivery", async () => {
    const { submissionId, event } = await completedUpload(1592);
    const dlqMessage = fakeMessage("message_video_uploaded_dlq", event);
    await handleQueueBatch(fakeBatch([dlqMessage]), { ...env, DLQ_QUEUE_NAME: "lr-video-jobs" }, () => clock.now());
    expect(dlqMessage.ack).toHaveBeenCalledOnce();

    const sent: VideoUploadedQueueEvent[] = [];
    const replayed = await new JobRepository(env.DB, {
      deletionOperatorIds: ["operator_local"],
    }).replayDlqMessage(
      "dlq_message_video_uploaded_dlq",
      { send: vi.fn(async (body: VideoUploadedQueueEvent) => { sent.push(body); }) } as unknown as Queue,
      "operator_local",
      LATER,
    );
    expect(replayed).toBe(true);
    expect(sent).toEqual([event]);

    const first = fakeMessage("message_video_uploaded_replay_1", sent[0]);
    const duplicate = fakeMessage("message_video_uploaded_replay_2", sent[0]);
    await handleQueueBatch(fakeBatch([first, duplicate]), env, () => clock.now());
    expect(first.ack).toHaveBeenCalledOnce();
    expect(duplicate.ack).toHaveBeenCalledOnce();
    expect(await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM video_jobs WHERE submission_id = ?) jobs,
         (SELECT COUNT(*) FROM audit_logs WHERE action = 'job.created') audits`,
    ).bind(submissionId).first()).toEqual({ jobs: 1, audits: 1 });
  });

  it("rolls back interrupted Queue job creation and resumes from the committed event", async () => {
    const submissionId = uuid(1601);
    const eventId = uuid(3601);
    await resolvedSubmission(submissionId);
    const inspector = new FakeUploadObjectInspector();
    const service = uploadService(inspector);
    const session = await service.begin(beginInput(submissionId));
    inspector.objects.set(session.expected_object_ref, verified());
    const event = await service.complete(callback(session, eventId));
    await env.DB.prepare(
      `CREATE TRIGGER e3_test_interrupt BEFORE INSERT ON video_jobs
       WHEN NEW.submission_id = '${submissionId}'
       BEGIN SELECT RAISE(ABORT, 'local e3 interruption'); END`,
    ).run();
    const interrupted = await deliver(event, "message_interrupted");
    expect(interrupted.retry).toHaveBeenCalledOnce();
    expect(await service.getSession(submissionId)).toMatchObject({ status: "COMPLETED" });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM upload_receipt_events").first()).toEqual({ count: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM video_jobs").first()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT video_job_id FROM submission_intakes WHERE submission_id = ?")
      .bind(submissionId).first()).toEqual({ video_job_id: null });
    await env.DB.prepare("DROP TRIGGER e3_test_interrupt").run();
    const resumed = await deliver(event, "message_resumed");
    expect(resumed.ack).toHaveBeenCalledOnce();
    expect(await env.DB.prepare("SELECT submission_id, state FROM video_jobs").first())
      .toEqual({ submission_id: submissionId, state: "RECEIVED" });
  });

  it("recovers when the job was created but Queue processing was not marked complete", async () => {
    const { submissionId, event } = await completedUpload(1651);
    const repository = new JobRepository(env.DB);
    const lease = await repository.recordQueueStart({
      messageId: "message_before_ack_crash",
      eventId: event.event_id,
      eventType: event.event_type,
      eventFingerprint: await queueFingerprint(event),
      now: LATER,
    });
    expect(lease.status).toBe("started");
    await new E3UploadReceiptConsumer(env.DB).consume(event);
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM video_jobs").first()).toEqual({ count: 1 });

    clock.set("2026-08-20T00:02:01.000Z");
    const redelivery = await deliver(event, "message_after_ack_crash");
    expect(redelivery.ack).toHaveBeenCalledOnce();
    expect(await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM video_jobs WHERE submission_id = ?) jobs,
              (SELECT COUNT(*) FROM audit_logs WHERE action = 'job.created') audits`,
    ).bind(submissionId).first()).toEqual({ jobs: 1, audits: 1 });
  });

  it("serializes simultaneous Queue deliveries and keeps one event and one job", async () => {
    const { event } = await completedUpload(1661);
    const first = fakeMessage("message_parallel_1", event);
    const second = fakeMessage("message_parallel_2", event);
    await Promise.all([
      handleQueueBatch(fakeBatch([first]), env, () => clock.now()),
      handleQueueBatch(fakeBatch([second]), env, () => clock.now()),
    ]);
    const acknowledged = vi.mocked(first.ack).mock.calls.length + vi.mocked(second.ack).mock.calls.length;
    const retried = vi.mocked(first.retry).mock.calls.length + vi.mocked(second.retry).mock.calls.length;
    expect(acknowledged + retried).toBe(2);
    expect(acknowledged).toBeGreaterThanOrEqual(1);
    expect(await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM upload_receipt_events) events,
              (SELECT COUNT(*) FROM video_jobs) jobs,
              (SELECT COUNT(*) FROM audit_logs WHERE action = 'job.created') audits`,
    ).first()).toEqual({ events: 1, jobs: 1, audits: 1 });
  });

  it("quarantines a Queue event ID collision before it can create a job", async () => {
    const { event } = await completedUpload(1671);
    const changed = {
      ...event,
      payload: { ...event.payload, object_ref: "fake_object_collision" },
    };
    const repository = new JobRepository(env.DB);
    await repository.recordQueueStart({
      messageId: "message_collision_first",
      eventId: changed.event_id,
      eventType: changed.event_type,
      eventFingerprint: await queueFingerprint(changed),
      now: LATER,
    });
    const collision = await deliver(event, "message_collision_second");
    expect(collision.retry).toHaveBeenCalledOnce();
    expect(await env.DB.prepare(
      "SELECT status, last_error_code FROM queue_deliveries WHERE event_id = ?",
    ).bind(event.event_id).first()).toEqual({ status: "QUARANTINED", last_error_code: "EVENT_ID_COLLISION" });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM video_jobs").first()).toEqual({ count: 0 });
  });

  it("fails closed when persisted object_ref no longer matches the Queue payload", async () => {
    const { event } = await completedUpload(1681);
    await env.DB.prepare(
      "UPDATE upload_receipt_events SET object_ref = 'fake_object_tampered' WHERE event_id = ?",
    ).bind(event.event_id).run();
    const message = await deliver(event, "message_object_tampered");
    expect(message.retry).toHaveBeenCalledOnce();
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM video_jobs").first()).toEqual({ count: 0 });
  });

  it("does not create a job for an unknown receipt event", async () => {
    const event: QueueEvent = {
      version: 1,
      event_id: uuid(3691),
      event_type: "video.uploaded",
      occurred_at: LATER,
      payload: {
        submission_id: uuid(1691),
        object_ref: "fake_object_unknown",
        actor_id: "fake_upload_callback",
      },
    };
    const message = await deliver(event, "message_unknown_receipt");
    expect(message.retry).toHaveBeenCalledOnce();
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM video_jobs").first()).toEqual({ count: 0 });
  });

  it("does not create a job when a receipt points at an unfinished session", async () => {
    const submissionId = uuid(1692);
    await resolvedSubmission(submissionId);
    const service = uploadService(new FakeUploadObjectInspector());
    const session = await service.begin(beginInput(submissionId));
    const event: QueueEvent = {
      version: 1,
      event_id: uuid(3692),
      event_type: "video.uploaded",
      occurred_at: LATER,
      payload: {
        submission_id: submissionId,
        object_ref: session.expected_object_ref,
        actor_id: "fake_upload_callback",
      },
    };
    await env.DB.prepare(
      `INSERT INTO upload_receipt_events (
         event_id, submission_id, object_ref, event_type, receipt_fingerprint, occurred_at
       ) VALUES (?, ?, ?, 'video.uploaded', ?, ?)`,
    ).bind(event.event_id, submissionId, session.expected_object_ref, "a".repeat(64), LATER).run();
    const message = await deliver(event, "message_unfinished_session");
    expect(message.retry).toHaveBeenCalledOnce();
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM video_jobs").first()).toEqual({ count: 0 });
  });

  it("does not start an upload from an unresolved intake", async () => {
    const fixture = await createLocalIdentityFixture(NOW);
    const email = fixture.makeEmail();
    const repository = new E2Repository(env.DB);
    await repository.importClassReadModel({
      sourceVersion: 1, fetchedAt: NOW, ttlSeconds: 3_600,
      entries: [{
        classId: "class_other_day", branchId: "branch_e3_dummy", studioId: "studio_e3_dummy",
        teacherId: "teacher_e3_dummy", teacherEmailFingerprint: await sha256Hex(email.toLowerCase()),
        lessonOn: "2026-08-21",
      }], now: NOW,
    });
    const submissionId = uuid(1701);
    const intake = await new E2LocalService(repository, fixture.config).submit({
      idToken: await fixture.sign({ email }), submissionId, lessonOn: LESSON_ON, now: LATER,
    });
    expect(intake.intake.status).toBe("UNRESOLVED");
    await expect(uploadService(new FakeUploadObjectInspector()).begin(beginInput(submissionId)))
      .rejects.toThrow("Resolved upload intake reservation");
  });
});
