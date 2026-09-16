import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  classifyYouTubeObservation,
  validatePrivateOnlyRequest,
  type PublishContractInput,
  type R2ReadClient,
  type YouTubePublishObservation,
} from "../src/e5-contracts";
import { ConcurrentUpdateError } from "../src/errors";
import {
  fakeObjectFixture,
  FakeR2ReadClient,
  FakeYouTubePublishClient,
} from "../src/e5-fakes";
import { E5PublishContractService } from "../src/e5-service";
import {
  R2StreamError,
  type R2StreamingSource,
  type VerifiedR2Source,
} from "../src/e5-r2-stream";
import {
  buildPrivateYouTubeUploadRequest,
  createScriptedYouTubePublishController,
  dispatchGuardedPrivateYouTubeUpload,
  YouTubePrivateRequestRejectedError,
} from "../src/e5-youtube-private-request";
import { JobRepository } from "../src/repository";

const NOW = "2026-08-19T00:00:00.000Z";
const BEFORE_CLAIM_LEASE = "2026-08-19T00:04:00.000Z";
const AFTER_CLAIM_LEASE = "2026-08-19T00:06:00.000Z";
const JOB_ID = "00000000-0000-4000-8000-000000000510";
const SUBMISSION_ID = "00000000-0000-4000-8000-000000010510";
const TARGET = "youtube_account_fake";
const VERSION = "approved-v1";
const ACTOR = { type: "system" as const, id: "system_e5_contract" };
const BYTES = new TextEncoder().encode("fake-video-bytes-only");

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function verifiedSourceFor(
  source: PublishContractInput["source"],
  bytes: Uint8Array,
): VerifiedR2Source {
  return {
    size: source.expectedSize,
    checksumSha256: source.expectedSha256,
    snapshot: {
      schemaVersion: 1,
      objectKey: source.objectKey,
      size: source.expectedSize,
      checksumSha256: source.expectedSha256,
      etag: "fake-etag",
      version: "fake-version",
    },
    open: (offset = 0) => new ReadableStream<Uint8Array>({
      start(controller) {
        if (offset < bytes.byteLength) controller.enqueue(bytes.slice(offset));
        controller.close();
      },
    }),
  };
}

async function approveJob(
  repository: JobRepository,
  targets: Array<{ destination: "youtube" | "instagram"; targetAccountId: string }> = [
    { destination: "youtube", targetAccountId: TARGET },
  ],
): Promise<void> {
  await repository.createVideoJob({
    videoJobId: JOB_ID,
    submissionId: SUBMISSION_ID,
    branchId: "branch_fake",
    studioId: "studio_fake",
    classId: "class_fake",
    teacherId: "teacher_fake",
    actor: ACTOR,
    now: NOW,
  });
  for (const [expectedState, nextState] of [
    ["RECEIVED", "VALIDATING"],
    ["VALIDATING", "PROCESSING"],
    ["PROCESSING", "WAITING_APPROVAL"],
  ] as const) {
    await repository.transitionJob({
      videoJobId: JOB_ID,
      expectedState,
      nextState,
      actor: ACTOR,
      now: NOW,
    });
  }
  await repository.transitionJob({
    videoJobId: JOB_ID,
    expectedState: "WAITING_APPROVAL",
    nextState: "APPROVED",
    approvedContentVersion: VERSION,
    publicationTargets: targets,
    actor: { type: "approver", id: "approver_fake" },
    now: NOW,
  });
}

async function harness(
  observation: YouTubePublishObservation,
  options: {
    reportedSize?: number;
    reportedChecksumSha256?: string;
    corruptRanges?: boolean;
  } = {},
): Promise<{
  repository: JobRepository;
  youtube: FakeYouTubePublishClient;
  r2: FakeR2ReadClient;
  service: E5PublishContractService;
  input: PublishContractInput;
}> {
  const repository = new JobRepository(env.DB);
  await approveJob(repository);
  const checksum = await sha256(BYTES);
  const fixture = await fakeObjectFixture("object_fake_video", BYTES, options);
  const r2 = new FakeR2ReadClient([fixture]);
  const youtube = new FakeYouTubePublishClient(observation);
  return {
    repository,
    youtube,
    r2,
    service: new E5PublishContractService(repository, youtube.client, r2, () => NOW, {
      rangeSize: 5,
    }),
    input: {
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      source: {
        objectKey: "object_fake_video",
        expectedSize: BYTES.byteLength,
        expectedSha256: checksum,
      },
      actorId: ACTOR.id,
    },
  };
}

async function policyAuditCount(): Promise<number> {
  return (await env.DB.prepare(
    "SELECT COUNT(*) count FROM audit_logs WHERE action = 'publication.policy_rejected'",
  ).first<{ count: number }>())?.count ?? 0;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mirror_outbox"),
    env.DB.prepare("DELETE FROM audit_logs"),
    env.DB.prepare("DELETE FROM idempotency_records"),
    env.DB.prepare("DELETE FROM applied_mutations"),
    env.DB.prepare("DELETE FROM video_jobs"),
  ]);
});

describe("YouTube status contract", () => {
  it("accepts completion only for processed + succeeded + private", () => {
    expect(classifyYouTubeObservation({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0001",
    }, NOW)).toEqual({ state: "PUBLISHED", videoId: "FAKEVID0001" });

    expect(classifyYouTubeObservation({
      kind: "status",
      uploadStatus: "uploaded",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0001",
    }, NOW)).toMatchObject({
      state: "OUTCOME_UNKNOWN",
      error: { code: "YOUTUBE_STATUS_INDETERMINATE", retryable: true },
    });

    expect(classifyYouTubeObservation({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "public",
      videoId: "FAKEVID0001",
    }, NOW)).toMatchObject({
      state: "FAILED",
      error: { code: "YOUTUBE_PRIVACY_MISMATCH", retryable: false },
    });

    expect(classifyYouTubeObservation({
      kind: "status",
      uploadStatus: "uploaded",
      processingStatus: "processing",
      privacyStatus: "unlisted",
    }, NOW)).toMatchObject({
      state: "FAILED",
      error: { code: "YOUTUBE_PRIVACY_MISMATCH", retryable: false },
    });
  });

  it.each([
    ["processing", { kind: "status", uploadStatus: "uploaded", processingStatus: "processing", privacyStatus: "private" }, "PUBLISHING"],
    ["failed", { kind: "status", uploadStatus: "failed", processingStatus: "failed", privacyStatus: "private" }, "FAILED"],
    ["terminated", { kind: "status", uploadStatus: "processed", processingStatus: "terminated", privacyStatus: "private" }, "FAILED"],
    ["rejected", { kind: "status", uploadStatus: "rejected", processingStatus: "failed", privacyStatus: "private" }, "FAILED"],
    ["unknown", { kind: "outcome_unknown", reason: "timeout" }, "OUTCOME_UNKNOWN"],
  ] as const)("classifies %s without using log text", (_name, observation, state) => {
    expect(classifyYouTubeObservation(observation, NOW).state).toBe(state);
  });

  it("maps provider failure and rejection reasons to fixed safe codes", () => {
    expect(classifyYouTubeObservation({
      kind: "status",
      uploadStatus: "failed",
      processingStatus: "failed",
      privacyStatus: "private",
      failureReason: "transcodeFailed",
    }, NOW)).toMatchObject({
      state: "FAILED",
      error: {
        code: "YOUTUBE_PROCESSING_FAILED",
        provider_reason_code: "TRANSCODE_FAILED",
        retryable: true,
      },
    });
    expect(classifyYouTubeObservation({
      kind: "status",
      uploadStatus: "rejected",
      processingStatus: "failed",
      privacyStatus: "private",
      rejectionReason: "copyright",
    }, NOW)).toMatchObject({
      state: "FAILED",
      error: {
        code: "YOUTUBE_REJECTED",
        provider_reason_code: "COPYRIGHT",
        retryable: false,
      },
    });
  });

  it("returns the accepted structured error shape", () => {
    const decision = classifyYouTubeObservation({
      kind: "outcome_unknown",
      reason: "confirmation_unavailable",
    }, NOW);
    expect(decision).toMatchObject({
      error: {
        code: "YOUTUBE_OUTCOME_UNKNOWN",
        media: "youtube",
        retryable: true,
        message: expect.any(String),
        occurred_at: NOW,
      },
    });
  });
});

describe("private-only boundary", () => {
  it.each(["public", "unlisted"])("rejects %s before any upload", (privacyStatus) => {
    expect(validatePrivateOnlyRequest({ requestedPrivacyStatus: privacyStatus }, NOW)).toMatchObject({
      code: "YOUTUBE_PRIVATE_ONLY",
      retryable: false,
    });
  });

  it("rejects publishAt and accepts absent/private settings", () => {
    expect(validatePrivateOnlyRequest({ publishAt: "2026-09-01T00:00:00Z" }, NOW))
      .toMatchObject({ code: "YOUTUBE_SCHEDULE_NOT_ALLOWED" });
    expect(validatePrivateOnlyRequest({ publishAt: null }, NOW))
      .toMatchObject({ code: "YOUTUBE_SCHEDULE_NOT_ALLOWED" });
    expect(validatePrivateOnlyRequest({ publishAt: undefined } as never, NOW))
      .toMatchObject({ code: "YOUTUBE_SCHEDULE_NOT_ALLOWED" });
    expect(validatePrivateOnlyRequest({}, NOW)).toBeNull();
    expect(validatePrivateOnlyRequest({ requestedPrivacyStatus: "private" }, NOW)).toBeNull();
  });
});

describe("E-5.1 local publication boundary", () => {
  it.each([
    ["empty job ID", { videoJobId: "" }],
    ["invalid target", { targetAccountId: "invalid target" }],
    ["empty approval version", { approvedContentVersion: "" }],
    ["empty actor", { actorId: "" }],
    ["negative size", { source: { objectKey: "dummy", expectedSize: -1, expectedSha256: "0".repeat(64) } }],
    ["invalid checksum", { source: { objectKey: "dummy", expectedSize: 1, expectedSha256: "bad" } }],
    ["empty object key", { source: { objectKey: "", expectedSize: 1, expectedSha256: "0".repeat(64) } }],
  ])("rejects %s without claims, audit, or client calls", async (_name, override) => {
    const context = await harness({
      kind: "status", uploadStatus: "uploaded", processingStatus: "processing", privacyStatus: "private",
    });
    await expect(context.service.execute({ ...context.input, ...override })).rejects.toBeInstanceOf(TypeError);
    expect(context.youtube.sideEffectCount()).toBe(0);
    expect(context.r2.requests()).toHaveLength(0);
    expect(await policyAuditCount()).toBe(0);
    expect(await context.repository.getPublicationRecord({
      videoJobId: JOB_ID, destination: "youtube", targetAccountId: TARGET, approvedContentVersion: VERSION,
    })).toMatchObject({ status: "PENDING" });
    expect((await context.repository.getVideoJob(JOB_ID))?.state).toBe("APPROVED");
  });

  it("records a complete private result and starts retention for a single target", async () => {
    const context = await harness({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0001",
    });
    const result = await context.service.execute(context.input);
    expect(result).toMatchObject({
      state: "PUBLISHED",
      duplicate: false,
      sideEffectStarted: true,
      job: {
        state: "PUBLISHED",
        youtube_status: "PUBLISHED",
        retention_state: "RETAINED",
      },
    });
    expect(context.youtube.sideEffectCount()).toBe(1);
    const expectedRanges = [
      { offset: 0, length: 5 },
      { offset: 5, length: 5 },
      { offset: 10, length: 5 },
      { offset: 15, length: 5 },
      { offset: 20, length: 1 },
    ];
    expect(context.r2.requests().map(({ offset, length }) => ({ offset, length })))
      .toEqual([...expectedRanges, ...expectedRanges]);
  });

  it("does not mark the whole job published while another approved target is unfinished", async () => {
    const repository = new JobRepository(env.DB);
    await approveJob(repository, [
      { destination: "youtube", targetAccountId: TARGET },
      { destination: "instagram", targetAccountId: "instagram_account_fake" },
    ]);
    const checksum = await sha256(BYTES);
    const r2 = new FakeR2ReadClient([
      await fakeObjectFixture("object_fake_video", BYTES),
    ]);
    const youtube = new FakeYouTubePublishClient({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0002",
    });
    const service = new E5PublishContractService(repository, youtube.client, r2, () => NOW);
    const result = await service.execute({
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      source: {
        objectKey: "object_fake_video",
        expectedSize: BYTES.byteLength,
        expectedSha256: checksum,
      },
      actorId: ACTOR.id,
    });
    expect(result.job).toMatchObject({
      state: "PUBLISHING",
      youtube_status: "PUBLISHED",
      instagram_status: "PENDING",
      retention_state: "HOLD",
      retention_start_at: null,
    });
  });

  it.each([
    ["processing", { kind: "status", uploadStatus: "uploaded", processingStatus: "processing", privacyStatus: "private" }, "PUBLISHING", undefined],
    ["failed", { kind: "status", uploadStatus: "failed", processingStatus: "failed", privacyStatus: "private", failureReason: "fake_failure" }, "FAILED", "YOUTUBE_PROCESSING_FAILED"],
    ["rejected", { kind: "status", uploadStatus: "rejected", processingStatus: "failed", privacyStatus: "private", rejectionReason: "fake_policy" }, "FAILED", "YOUTUBE_REJECTED"],
  ] as const)("persists the %s branch", async (_name, observation, state, errorCode) => {
    const context = await harness(observation);
    const result = await context.service.execute(context.input);
    expect(result.state).toBe(state);
    expect(result.job?.youtube_status).toBe(state);
    expect(result.job?.state).not.toBe("PUBLISHED");
    expect(result.job?.retention_state).toBe("HOLD");
    if (errorCode) expect(result.error?.code).toBe(errorCode);
    else expect(result.error).toBeUndefined();
  });

  it.each([
    [
      "failure",
      { kind: "status", uploadStatus: "failed", processingStatus: "failed", privacyStatus: "private", failureReason: "transcodeFailed" },
      "YOUTUBE_PROCESSING_FAILED",
      "TRANSCODE_FAILED",
      true,
    ],
    [
      "rejection",
      { kind: "status", uploadStatus: "rejected", processingStatus: "failed", privacyStatus: "private", rejectionReason: "copyright" },
      "YOUTUBE_REJECTED",
      "COPYRIGHT",
      false,
    ],
  ] as const)("persists and restores safe %s details", async (
    _name,
    observation,
    errorCode,
    providerReasonCode,
    retryable,
  ) => {
    const context = await harness(observation);
    const first = await context.service.execute(context.input);
    const record = await context.repository.getPublicationRecord({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
    });
    expect(first.error).toMatchObject({
      code: errorCode,
      provider_reason_code: providerReasonCode,
      retryable,
    });
    expect(record).toMatchObject({
      status: "FAILED",
      result_ref: null,
      error_code: errorCode,
      provider_reason_code: providerReasonCode,
      retryable: Number(retryable),
    });

    const redelivery = await context.service.execute(context.input);
    expect(redelivery).toMatchObject({
      state: "FAILED",
      duplicate: true,
      sideEffectStarted: false,
      error: {
        code: errorCode,
        provider_reason_code: providerReasonCode,
        retryable,
      },
    });
    expect(context.youtube.sideEffectCount()).toBe(1);

    const audit = await env.DB
      .prepare(
        `SELECT details_json FROM audit_logs
         WHERE action = 'publication.result.recorded'
         ORDER BY occurred_at DESC LIMIT 1`,
      )
      .first<{ details_json: string }>();
    expect(JSON.parse(audit!.details_json)).toMatchObject({
      error_code: errorCode,
      provider_reason_code: providerReasonCode,
      retryable,
    });
  });

  it("replaces untrusted provider reason text with a fixed fallback code", async () => {
    const maliciousReason = ["https", "://not-a-code/", "name", "@", "invalid", "\n"]
      .join("");
    const context = await harness({
      kind: "status",
      uploadStatus: "failed",
      processingStatus: "failed",
      privacyStatus: "private",
      failureReason: maliciousReason,
    });
    const result = await context.service.execute(context.input);
    expect(result.error).toMatchObject({
      provider_reason_code: "UNSPECIFIED_FAILURE",
      retryable: true,
    });
    const record = await context.repository.getPublicationRecord({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
    });
    expect(record?.provider_reason_code).toBe("UNSPECIFIED_FAILURE");
    expect(JSON.stringify(record)).not.toContain(maliciousReason);
    const audits = await env.DB
      .prepare("SELECT details_json FROM audit_logs")
      .all<{ details_json: string }>();
    expect(JSON.stringify(audits.results)).not.toContain(maliciousReason);
  });

  it.each([
    ["error code", { code: "BAD\nCODE", retryable: false }],
    [
      "provider reason",
      {
        code: "YOUTUBE_REJECTED",
        providerReasonCode: ["https", "://not-safe"].join(""),
        retryable: false,
      },
    ],
  ])("rejects an unsafe stored %s at the repository boundary", async (_name, error) => {
    const repository = new JobRepository(env.DB);
    await approveJob(repository);
    await repository.claimPublication({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      actor: ACTOR,
      now: NOW,
    });
    await expect(repository.recordPublicationResult({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      result: "FAILED",
      actor: ACTOR,
      now: NOW,
      error,
    })).rejects.toBeInstanceOf(TypeError);
    expect(await repository.getPublicationRecord({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
    })).toMatchObject({
      status: "CLAIMED",
      error_code: null,
      provider_reason_code: null,
      retryable: null,
    });
  });

  it.each([
    ["empty", ""],
    ["overlong", "A".repeat(12)],
    ["url-shaped", ["https", "://invalid-id"].join("")],
    ["email-shaped", ["name", "@", "invalid-id"].join("")],
    ["control-character", "BAD\nID00000"],
  ])("requires reconciliation for a %s video ID without persisting it", async (_name, videoId) => {
    const context = await harness({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId,
    });
    const result = await context.service.execute(context.input);
    expect(result).toMatchObject({
      state: "RECONCILIATION_REQUIRED",
      duplicate: false,
      sideEffectStarted: true,
      transitions: ["OUTCOME_UNKNOWN", "RECONCILIATION_REQUIRED"],
      error: {
        code: "YOUTUBE_VIDEO_ID_INVALID",
        provider_reason_code: "INVALID_VIDEO_ID",
        retryable: true,
      },
    });
    const record = await context.repository.getPublicationRecord({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
    });
    expect(record).toMatchObject({
      status: "RECONCILIATION_REQUIRED",
      result_ref: null,
      error_code: "YOUTUBE_VIDEO_ID_INVALID",
      provider_reason_code: "INVALID_VIDEO_ID",
      retryable: 1,
    });
    const audits = await env.DB
      .prepare("SELECT details_json FROM audit_logs")
      .all<{ details_json: string }>();
    if (videoId) {
      expect(JSON.stringify(record)).not.toContain(videoId);
      expect(JSON.stringify(audits.results)).not.toContain(videoId);
    }
    expect(context.youtube.sideEffectCount()).toBe(1);

    const redelivery = await context.service.execute(context.input);
    expect(redelivery).toMatchObject({
      state: "RECONCILIATION_REQUIRED",
      duplicate: true,
      sideEffectStarted: false,
      error: {
        code: "YOUTUBE_VIDEO_ID_INVALID",
        provider_reason_code: "INVALID_VIDEO_ID",
        retryable: true,
      },
    });
    expect(context.youtube.sideEffectCount()).toBe(1);
  });

  it("moves an unknown result through both fail-closed states and blocks redelivery", async () => {
    const context = await harness({ kind: "outcome_unknown", reason: "timeout" });
    const first = await context.service.execute(context.input);
    expect(first).toMatchObject({
      state: "RECONCILIATION_REQUIRED",
      transitions: ["OUTCOME_UNKNOWN", "RECONCILIATION_REQUIRED"],
      job: { state: "PUBLISHING", youtube_status: "RECONCILIATION_REQUIRED" },
      error: { code: "YOUTUBE_OUTCOME_UNKNOWN", retryable: true },
    });
    const redelivery = await context.service.execute(context.input);
    expect(redelivery).toMatchObject({
      state: "RECONCILIATION_REQUIRED",
      duplicate: true,
      sideEffectStarted: false,
    });
    expect(context.youtube.sideEffectCount()).toBe(1);

    const audit = await env.DB
      .prepare(
        `SELECT COUNT(*) count FROM audit_logs
         WHERE action = 'publication.result.recorded'`,
      )
      .first<{ count: number }>();
    expect(audit?.count).toBe(2);
  });

  it("deduplicates an ordinary Queue redelivery", async () => {
    const context = await harness({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0003",
    });
    const first = await context.service.execute(context.input);
    const redelivery = await context.service.execute(context.input);
    expect(first.duplicate).toBe(false);
    expect(redelivery).toMatchObject({ state: "PUBLISHED", duplicate: true });
    expect(context.youtube.sideEffectCount()).toBe(1);
  });

  it("returns an existing result before rereading a missing source on redelivery", async () => {
    const repository = new JobRepository(env.DB);
    await approveJob(repository);
    const checksum = await sha256(BYTES);
    const baseR2 = new FakeR2ReadClient([
      await fakeObjectFixture("object_fake_video", BYTES),
    ]);
    let headCalls = 0;
    const oneUseR2 = {
      headObject: async (objectKey: string) => {
        headCalls += 1;
        if (headCalls > 1) throw new Error("fake object removed after completion");
        return baseR2.headObject(objectKey);
      },
      readRange: baseR2.readRange.bind(baseR2),
    };
    const youtube = new FakeYouTubePublishClient({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0009",
    });
    const service = new E5PublishContractService(repository, youtube.client, oneUseR2, () => NOW);
    const input = {
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      source: {
        objectKey: "object_fake_video",
        expectedSize: BYTES.byteLength,
        expectedSha256: checksum,
      },
      actorId: ACTOR.id,
    };
    expect((await service.execute(input)).state).toBe("PUBLISHED");
    expect(await service.execute(input)).toMatchObject({
      state: "PUBLISHED",
      duplicate: true,
      sideEffectStarted: false,
    });
    expect(headCalls).toBe(1);
    expect(youtube.sideEffectCount()).toBe(1);
  });

  it("treats different target accounts as different publication effects", async () => {
    const repository = new JobRepository(env.DB);
    await approveJob(repository, [
      { destination: "youtube", targetAccountId: "youtube_account_a" },
      { destination: "youtube", targetAccountId: "youtube_account_b" },
    ]);
    const checksum = await sha256(BYTES);
    const r2 = new FakeR2ReadClient([
      await fakeObjectFixture("object_fake_video", BYTES),
    ]);
    const youtube = new FakeYouTubePublishClient({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0010",
    });
    const service = new E5PublishContractService(repository, youtube.client, r2, () => NOW);
    const base = {
      videoJobId: JOB_ID,
      approvedContentVersion: VERSION,
      source: {
        objectKey: "object_fake_video",
        expectedSize: BYTES.byteLength,
        expectedSha256: checksum,
      },
      actorId: ACTOR.id,
    };
    const accountA = await service.execute({ ...base, targetAccountId: "youtube_account_a" });
    const accountARedelivery = await service.execute({
      ...base,
      targetAccountId: "youtube_account_a",
    });
    const accountB = await service.execute({ ...base, targetAccountId: "youtube_account_b" });
    expect(accountA.job?.state).toBe("PUBLISHING");
    expect(accountARedelivery).toMatchObject({
      state: "PUBLISHED",
      duplicate: true,
      sideEffectStarted: false,
      job: { state: "PUBLISHING", youtube_status: "PUBLISHING" },
    });
    expect(accountB.job?.state).toBe("PUBLISHED");
    expect(youtube.sideEffectCount()).toBe(2);
    expect(await env.DB.prepare(
      `SELECT target_account_id, attempt_no FROM idempotency_records
       WHERE video_job_id = ? ORDER BY target_account_id`,
    ).bind(JOB_ID).all<{ target_account_id: string; attempt_no: number }>())
      .toMatchObject({
        results: [
          { target_account_id: "youtube_account_a", attempt_no: 1 },
          { target_account_id: "youtube_account_b", attempt_no: 1 },
        ],
      });
  });

  it("recovers an interruption between unknown and reconciliation without another upload", async () => {
    const repository = new JobRepository(env.DB);
    await approveJob(repository);
    const checksum = await sha256(BYTES);
    const r2 = new FakeR2ReadClient([
      await fakeObjectFixture("object_fake_video", BYTES),
    ]);
    const youtube = new FakeYouTubePublishClient({
      kind: "outcome_unknown",
      reason: "response_lost",
    });
    const input: PublishContractInput = {
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      source: {
        objectKey: "object_fake_video",
        expectedSize: BYTES.byteLength,
        expectedSha256: checksum,
      },
      actorId: ACTOR.id,
    };
    const claim = await repository.claimPublication({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      actor: ACTOR,
      now: NOW,
    });
    await dispatchGuardedPrivateYouTubeUpload(youtube.client, buildPrivateYouTubeUploadRequest({
      idempotencyKey: claim.idempotencyKey,
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      source: input.source,
      privacyStatus: "private",
    }), verifiedSourceFor(input.source, BYTES));
    await repository.recordPublicationResult({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      result: "OUTCOME_UNKNOWN",
      actor: ACTOR,
      now: NOW,
    });

    const service = new E5PublishContractService(repository, youtube.client, r2, () => NOW);
    const recovered = await service.execute(input);
    expect(recovered).toMatchObject({
      state: "RECONCILIATION_REQUIRED",
      duplicate: true,
      sideEffectStarted: false,
      transitions: ["RECONCILIATION_REQUIRED"],
      job: { youtube_status: "RECONCILIATION_REQUIRED" },
    });
    expect(youtube.sideEffectCount()).toBe(1);
    expect(r2.requests()).toHaveLength(0);
  });

  it("moves a redelivered claim with an unknown side-effect start to reconciliation", async () => {
    const context = await harness({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0013",
    });
    await context.repository.claimPublication({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      actor: ACTOR,
      now: NOW,
    });

    const recoveryService = new E5PublishContractService(
      context.repository,
      context.youtube.client,
      context.r2,
      () => AFTER_CLAIM_LEASE,
      { rangeSize: 5 },
    );
    const recovered = await recoveryService.execute(context.input);
    expect(recovered).toMatchObject({
      state: "RECONCILIATION_REQUIRED",
      duplicate: true,
      sideEffectStarted: false,
      transitions: ["OUTCOME_UNKNOWN", "RECONCILIATION_REQUIRED"],
      error: { code: "YOUTUBE_SIDE_EFFECT_START_UNKNOWN", retryable: true },
      job: { youtube_status: "RECONCILIATION_REQUIRED" },
    });
    expect(context.youtube.sideEffectCount()).toBe(0);
    expect(context.r2.requests()).toHaveLength(0);

    const redelivery = await recoveryService.execute(context.input);
    expect(redelivery).toMatchObject({
      state: "RECONCILIATION_REQUIRED",
      duplicate: true,
      sideEffectStarted: false,
    });
    expect(context.youtube.sideEffectCount()).toBe(0);
  });

  it("recovers concurrent redeliveries of an interrupted claim without uploading", async () => {
    const context = await harness({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0015",
    });
    await context.repository.claimPublication({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      actor: ACTOR,
      now: NOW,
    });

    const recoveryService = new E5PublishContractService(
      context.repository,
      context.youtube.client,
      context.r2,
      () => AFTER_CLAIM_LEASE,
      { rangeSize: 5 },
    );
    const redeliveries = await Promise.all([
      recoveryService.execute(context.input),
      recoveryService.execute(context.input),
    ]);
    expect(redeliveries).toEqual([
      expect.objectContaining({ state: "RECONCILIATION_REQUIRED", duplicate: true }),
      expect.objectContaining({ state: "RECONCILIATION_REQUIRED", duplicate: true }),
    ]);
    expect(context.youtube.sideEffectCount()).toBe(0);
    expect(context.r2.requests()).toHaveLength(0);
  });

  it.each(["success", "transient failure"] as const)(
    "keeps a fresh active claim while R2 is paused and then resumes with %s",
    async (resumeResult) => {
    const repository = new JobRepository(env.DB);
    await approveJob(repository);
    const checksum = await sha256(BYTES);
    const baseR2 = new FakeR2ReadClient([
      await fakeObjectFixture("object_fake_video", BYTES),
    ]);
    let signalHeadEntered!: () => void;
    let resumeHead!: () => void;
    const headEntered = new Promise<void>((resolve) => { signalHeadEntered = resolve; });
    const headGate = new Promise<void>((resolve) => { resumeHead = resolve; });
    let shouldPause = true;
    const pausedR2 = {
      headObject: async (objectKey: string) => {
        if (shouldPause) {
          shouldPause = false;
          signalHeadEntered();
          await headGate;
          if (resumeResult === "transient failure") {
            throw new Error("FAKE_TRANSIENT_HEAD_FAILURE_AFTER_REDELIVERY");
          }
        }
        return baseR2.headObject(objectKey);
      },
      readRange: baseR2.readRange.bind(baseR2),
    };
    const youtube = new FakeYouTubePublishClient({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0016",
    });
    const service = new E5PublishContractService(repository, youtube.client, pausedR2, () => NOW, {
      rangeSize: 5,
    });
    const input: PublishContractInput = {
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      source: {
        objectKey: "object_fake_video",
        expectedSize: BYTES.byteLength,
        expectedSha256: checksum,
      },
      actorId: ACTOR.id,
    };

    const active = service.execute(input);
    await headEntered;
    const redelivery = await service.execute(input);
    expect(redelivery).toMatchObject({
      state: "PUBLISHING",
      duplicate: true,
      sideEffectStarted: false,
    });
    expect(await repository.getPublicationRecord({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
    })).toMatchObject({ status: "CLAIMED" });

    resumeHead();
    const activeResult = await active;
    if (resumeResult === "success") {
      expect(activeResult).toMatchObject({
        state: "PUBLISHED",
        duplicate: false,
        sideEffectStarted: true,
      });
      expect(youtube.sideEffectCount()).toBe(1);
      expect(await repository.getPublicationRecord({
        videoJobId: JOB_ID,
        destination: "youtube",
        targetAccountId: TARGET,
        approvedContentVersion: VERSION,
      })).toMatchObject({ status: "SUCCEEDED" });
    } else {
      expect(activeResult).toMatchObject({
        state: "FAILED",
        duplicate: false,
        sideEffectStarted: false,
        error: { code: "R2_SOURCE_UNAVAILABLE", retryable: true },
      });
      expect(youtube.sideEffectCount()).toBe(0);
      expect(await repository.getPublicationRecord({
        videoJobId: JOB_ID,
        destination: "youtube",
        targetAccountId: TARGET,
        approvedContentVersion: VERSION,
      })).toMatchObject({ status: "PENDING", retryable: 1 });
    }
    },
  );

  it("keeps the renewed claim while the active YouTube call is in progress", async () => {
    const repository = new JobRepository(env.DB);
    await approveJob(repository);
    const checksum = await sha256(BYTES);
    const r2 = new FakeR2ReadClient([
      await fakeObjectFixture("object_fake_video", BYTES),
    ]);
    const youtube = createScriptedYouTubePublishController({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0017",
    }, { pauseBeforeResult: true });
    const service = new E5PublishContractService(repository, youtube.client, r2, () => NOW, {
      rangeSize: 5,
    });
    const input: PublishContractInput = {
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      source: {
        objectKey: "object_fake_video",
        expectedSize: BYTES.byteLength,
        expectedSha256: checksum,
      },
      actorId: ACTOR.id,
    };

    const active = service.execute(input);
    await youtube.waitUntilUploadStarted();
    const redelivery = await service.execute(input);
    expect(redelivery).toMatchObject({
      state: "PUBLISHING",
      duplicate: true,
      sideEffectStarted: false,
    });
    expect(youtube.sideEffectCount()).toBe(1);
    expect(await repository.getPublicationRecord({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
    })).toMatchObject({ status: "CLAIMED" });

    youtube.resumeUpload();
    expect(await active).toMatchObject({
      state: "PUBLISHED",
      duplicate: false,
      sideEffectStarted: true,
    });
    expect(youtube.sideEffectCount()).toBe(1);
  });

  it("rejects a stale expired-claim recovery after the active lease was renewed", async () => {
    const repository = new JobRepository(env.DB);
    await approveJob(repository);
    const checksum = await sha256(BYTES);
    const baseR2 = new FakeR2ReadClient([
      await fakeObjectFixture("object_fake_video", BYTES),
    ]);
    let signalHeadEntered!: () => void;
    let resumeHead!: () => void;
    let signalRecoveryEntered!: () => void;
    let resumeRecovery!: () => void;
    let signalRenewCommitted!: () => void;
    let resumeRenew!: () => void;
    const headEntered = new Promise<void>((resolve) => { signalHeadEntered = resolve; });
    const headGate = new Promise<void>((resolve) => { resumeHead = resolve; });
    const recoveryEntered = new Promise<void>((resolve) => { signalRecoveryEntered = resolve; });
    const recoveryGate = new Promise<void>((resolve) => { resumeRecovery = resolve; });
    const renewCommitted = new Promise<void>((resolve) => { signalRenewCommitted = resolve; });
    const renewGate = new Promise<void>((resolve) => { resumeRenew = resolve; });
    let pauseHead = true;
    const r2 = {
      headObject: async (objectKey: string) => {
        if (pauseHead) {
          pauseHead = false;
          signalHeadEntered();
          await headGate;
        }
        return baseR2.headObject(objectKey);
      },
      readRange: baseR2.readRange.bind(baseR2),
    };
    const coordinatedRepository = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === "recoverExpiredYoutubePublicationClaim") {
          return async (input: Parameters<JobRepository["recoverExpiredYoutubePublicationClaim"]>[0]) => {
            signalRecoveryEntered();
            await recoveryGate;
            return target.recoverExpiredYoutubePublicationClaim(input);
          };
        }
        if (property === "renewPublicationClaimLease") {
          return async (input: Parameters<JobRepository["renewPublicationClaimLease"]>[0]) => {
            const renewed = await target.renewPublicationClaimLease(input);
            signalRenewCommitted();
            await renewGate;
            return renewed;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const youtube = new FakeYouTubePublishClient({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0018",
    });
    let activeClockReads = 0;
    const active = new E5PublishContractService(
      coordinatedRepository,
      youtube.client,
      r2,
      () => activeClockReads++ === 0 ? NOW : BEFORE_CLAIM_LEASE,
      { rangeSize: 5 },
    );
    const duplicate = new E5PublishContractService(
      coordinatedRepository,
      youtube.client,
      r2,
      () => AFTER_CLAIM_LEASE,
      { rangeSize: 5 },
    );
    const input: PublishContractInput = {
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      source: {
        objectKey: "object_fake_video",
        expectedSize: BYTES.byteLength,
        expectedSha256: checksum,
      },
      actorId: ACTOR.id,
    };

    const activeResult = active.execute(input);
    await headEntered;
    const staleRecovery = duplicate.execute(input);
    await recoveryEntered;
    resumeHead();
    await renewCommitted;
    resumeRecovery();
    expect(await staleRecovery).toMatchObject({
      state: "PUBLISHING",
      duplicate: true,
      sideEffectStarted: false,
    });
    expect(await repository.getPublicationRecord({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
    })).toMatchObject({ status: "CLAIMED", updated_at: BEFORE_CLAIM_LEASE });

    resumeRenew();
    expect(await activeResult).toMatchObject({
      state: "PUBLISHED",
      duplicate: false,
      sideEffectStarted: true,
    });
    expect(youtube.sideEffectCount()).toBe(1);
  });

  it("recovers concurrent redeliveries of an unknown result idempotently", async () => {
    const repository = new JobRepository(env.DB);
    await approveJob(repository);
    const checksum = await sha256(BYTES);
    const r2 = new FakeR2ReadClient([
      await fakeObjectFixture("object_fake_video", BYTES),
    ]);
    const youtube = new FakeYouTubePublishClient({
      kind: "outcome_unknown",
      reason: "response_lost",
    });
    const input: PublishContractInput = {
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      source: {
        objectKey: "object_fake_video",
        expectedSize: BYTES.byteLength,
        expectedSha256: checksum,
      },
      actorId: ACTOR.id,
    };
    const claim = await repository.claimPublication({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      actor: ACTOR,
      now: NOW,
    });
    await dispatchGuardedPrivateYouTubeUpload(youtube.client, buildPrivateYouTubeUploadRequest({
      idempotencyKey: claim.idempotencyKey,
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      source: input.source,
      privacyStatus: "private",
    }), verifiedSourceFor(input.source, BYTES));
    await repository.recordPublicationResult({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      result: "OUTCOME_UNKNOWN",
      actor: ACTOR,
      now: NOW,
    });
    const service = new E5PublishContractService(repository, youtube.client, r2, () => NOW);

    const redeliveries = await Promise.all([
      service.execute(input),
      service.execute(input),
    ]);
    expect(redeliveries).toEqual([
      expect.objectContaining({ state: "RECONCILIATION_REQUIRED", duplicate: true }),
      expect.objectContaining({ state: "RECONCILIATION_REQUIRED", duplicate: true }),
    ]);
    expect(youtube.sideEffectCount()).toBe(1);
    expect(r2.requests()).toHaveLength(0);
  });

  it("fails closed when the YouTube boundary stops after the claim", async () => {
    const repository = new JobRepository(env.DB);
    await approveJob(repository);
    const checksum = await sha256(BYTES);
    const r2 = new FakeR2ReadClient([
      await fakeObjectFixture("object_fake_video", BYTES),
    ]);
    const service = new E5PublishContractService(
      repository,
      createScriptedYouTubePublishController({ kind: "fake_throw" }).client,
      r2,
      () => NOW,
    );
    const result = await service.execute({
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      source: {
        objectKey: "object_fake_video",
        expectedSize: BYTES.byteLength,
        expectedSha256: checksum,
      },
      actorId: ACTOR.id,
    });
    expect(result).toMatchObject({
      state: "RECONCILIATION_REQUIRED",
      transitions: ["OUTCOME_UNKNOWN", "RECONCILIATION_REQUIRED"],
      job: { youtube_status: "RECONCILIATION_REQUIRED", retention_state: "HOLD" },
      error: { code: "YOUTUBE_OUTCOME_UNKNOWN" },
    });
  });

  it("allows only one fake side effect under concurrent duplicate execution", async () => {
    const context = await harness({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0004",
    });
    const results = await Promise.all([
      context.service.execute(context.input),
      context.service.execute(context.input),
    ]);
    expect(results.filter((result) => result.sideEffectStarted)).toHaveLength(1);
    expect(context.youtube.sideEffectCount()).toBe(1);
    expect((await context.repository.getVideoJob(JOB_ID))?.state).toBe("PUBLISHED");
    expect(await env.DB.prepare(
      "SELECT attempt_no FROM idempotency_records WHERE video_job_id = ?",
    ).bind(JOB_ID).first<{ attempt_no: number }>()).toEqual({ attempt_no: 1 });
  });

  it.each([
    ["public", { requestedPrivacyStatus: "public" }, "YOUTUBE_PRIVATE_ONLY"],
    ["unlisted", { requestedPrivacyStatus: "unlisted" }, "YOUTUBE_PRIVATE_ONLY"],
    ["scheduled", { publishAt: "2026-09-01T00:00:00Z" }, "YOUTUBE_SCHEDULE_NOT_ALLOWED"],
  ] as const)("rejects %s before R2 or YouTube side effects", async (_name, override, errorCode) => {
    const context = await harness({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0005",
    });
    const result = await context.service.execute({ ...context.input, ...override });
    expect(result).toMatchObject({
      state: "VALIDATION_FAILED",
      sideEffectStarted: false,
      error: { code: errorCode, retryable: false },
    });
    expect(context.youtube.sideEffectCount()).toBe(0);
    expect(context.r2.requests()).toHaveLength(0);
    expect(result.job?.state).toBe("APPROVED");
    expect(await env.DB.prepare(
      `SELECT action, from_state, to_state, details_json FROM audit_logs
       WHERE action = 'publication.policy_rejected' ORDER BY occurred_at DESC LIMIT 1`,
    ).first()).toMatchObject({
      action: "publication.policy_rejected",
      from_state: "APPROVED",
      to_state: "APPROVED",
      details_json: JSON.stringify({
        destination: "youtube",
        target_account_id: TARGET,
        error_code: errorCode,
      }),
    });
  });

  it.each(["PUBLISHING", "PUBLISHED", "FAILED"] as const)(
    "does not write a stale policy audit when the job is already %s",
    async (state) => {
      const context = await harness(state === "FAILED"
        ? {
            kind: "status",
            uploadStatus: "failed",
            processingStatus: "failed",
            privacyStatus: "private",
          }
        : {
            kind: "status",
            uploadStatus: "processed",
            processingStatus: "succeeded",
            privacyStatus: "private",
            videoId: "FAKEVID0553",
          });

      if (state === "PUBLISHING") {
        await context.repository.claimPublication({
          videoJobId: JOB_ID,
          destination: "youtube",
          targetAccountId: TARGET,
          approvedContentVersion: VERSION,
          actor: ACTOR,
          now: NOW,
        });
      } else {
        expect((await context.service.execute(context.input)).state).toBe(state);
      }

      await expect(context.service.execute({
        ...context.input,
        requestedPrivacyStatus: "public",
      })).rejects.toBeInstanceOf(ConcurrentUpdateError);
      expect(await policyAuditCount()).toBe(0);
    },
  );

  it("does not audit an unapproved YouTube target", async () => {
    const context = await harness({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0554",
    });

    await expect(context.service.execute({
      ...context.input,
      targetAccountId: "youtube_account_unapproved",
      requestedPrivacyStatus: "unlisted",
    })).rejects.toBeInstanceOf(ConcurrentUpdateError);

    expect(context.youtube.sideEffectCount()).toBe(0);
    expect(await policyAuditCount()).toBe(0);
  });

  it.each([
    ["non-enumerable privacyStatus", true, (base: PublishContractInput) => {
      const value = { ...base };
      Object.defineProperty(value, "privacyStatus", { value: "public", enumerable: false });
      return value;
    }],
    ["non-enumerable providerRequest", true, (base: PublishContractInput) => {
      const value = { ...base };
      Object.defineProperty(value, "providerRequest", {
        value: { requestBody: { status: { privacyStatus: "public" } } },
        enumerable: false,
      });
      return value;
    }],
    ["inherited publishAt", false, (base: PublishContractInput) =>
      Object.assign(Object.create({ publishAt: "2026-09-01T00:00:00Z" }), base)],
    ["accessor", false, (base: PublishContractInput) => {
      const value = { ...base };
      Object.defineProperty(value, "requestedPrivacyStatus", {
        get: () => "private",
        enumerable: true,
      });
      return value;
    }],
    ["symbol field", true, (base: PublishContractInput) => {
      const value = { ...base } as PublishContractInput & Record<symbol, string>;
      value[Symbol("privacyStatus")] = "public";
      return value;
    }],
  ] as const)("rejects unsafe whole-input shape: %s", async (_name, auditSafe, makeInput) => {
    const context = await harness({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0555",
    });

    const execution = context.service.execute(makeInput(context.input) as PublishContractInput);
    if (auditSafe) {
      await expect(execution).resolves.toMatchObject({
        state: "VALIDATION_FAILED",
        sideEffectStarted: false,
        error: { code: "YOUTUBE_PRIVATE_ONLY", retryable: false },
      });
    } else {
      await expect(execution).rejects.toBeInstanceOf(YouTubePrivateRequestRejectedError);
    }
    expect(context.youtube.sideEffectCount()).toBe(0);
    expect(context.r2.requests()).toHaveLength(0);
    expect(await policyAuditCount()).toBe(auditSafe ? 1 : 0);
    expect(await context.repository.getPublicationRecord({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
    })).toMatchObject({ status: "PENDING" });
  });

  it("records an unaltered policy audit under Object.prototype.toJSON pollution", async () => {
    const context = await harness({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0558",
    });
    const toJsonDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        value: function (this: Record<string, unknown>) {
          return Object.prototype.hasOwnProperty.call(this, "error_code")
            ? { error_code: "BYPASSED", target_account_id: "wrong" }
            : this;
        },
        configurable: true,
      });

      await expect(context.service.execute({
        ...context.input,
        requestedPrivacyStatus: "public",
      })).resolves.toMatchObject({
        state: "VALIDATION_FAILED",
        sideEffectStarted: false,
        error: { code: "YOUTUBE_PRIVATE_ONLY" },
      });
    } finally {
      if (toJsonDescriptor) {
        Object.defineProperty(Object.prototype, "toJSON", toJsonDescriptor);
      } else {
        delete (Object.prototype as { toJSON?: unknown }).toJSON;
      }
    }

    const audit = await env.DB.prepare(
      `SELECT details_json FROM audit_logs
       WHERE action = 'publication.policy_rejected' ORDER BY occurred_at DESC LIMIT 1`,
    ).first<{ details_json: string }>();
    expect(audit?.details_json).toBe(JSON.stringify({
      destination: "youtube",
      target_account_id: TARGET,
      error_code: "YOUTUBE_PRIVATE_ONLY",
    }));
    expect(context.youtube.sideEffectCount()).toBe(0);
    expect(context.r2.requests()).toHaveLength(0);
  });

  it("rejects inherited Object.prototype.publishAt and records the safe rejection", async () => {
    const context = await harness({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0559",
    });
    const publishAtDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "publishAt");
    try {
      Object.defineProperty(Object.prototype, "publishAt", {
        value: "2026-09-01T00:00:00Z",
        configurable: true,
      });

      await expect(context.service.execute({ ...context.input })).resolves.toMatchObject({
        state: "VALIDATION_FAILED",
        sideEffectStarted: false,
        error: { code: "YOUTUBE_SCHEDULE_NOT_ALLOWED", retryable: false },
      });
    } finally {
      if (publishAtDescriptor) {
        Object.defineProperty(Object.prototype, "publishAt", publishAtDescriptor);
      } else {
        delete (Object.prototype as { publishAt?: unknown }).publishAt;
      }
    }

    expect(context.youtube.sideEffectCount()).toBe(0);
    expect(context.r2.requests()).toHaveLength(0);
    const audit = await env.DB.prepare(
      `SELECT details_json FROM audit_logs
       WHERE action = 'publication.policy_rejected' ORDER BY occurred_at DESC LIMIT 1`,
    ).first<{ details_json: string }>();
    expect(audit?.details_json).toBe(JSON.stringify({
      destination: "youtube",
      target_account_id: TARGET,
      error_code: "YOUTUBE_SCHEDULE_NOT_ALLOWED",
    }));
  });

  it("uses the module-initialized hasOwnProperty after runtime pollution", async () => {
    const context = await harness({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0560",
    });
    const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, "hasOwnProperty")!;
    const originalHasOwnProperty = descriptor.value as (
      this: object,
      key: PropertyKey,
    ) => boolean;
    try {
      Object.defineProperty(Object.prototype, "hasOwnProperty", {
        value: function (this: object, key: PropertyKey) {
          if (key === "publishAt") return false;
          return Reflect.apply(originalHasOwnProperty, this, [key]);
        },
        configurable: true,
        writable: true,
      });

      await expect(context.service.execute({
        ...context.input,
        publishAt: null,
      })).resolves.toMatchObject({
        state: "VALIDATION_FAILED",
        sideEffectStarted: false,
        error: { code: "YOUTUBE_SCHEDULE_NOT_ALLOWED", retryable: false },
      });
    } finally {
      Object.defineProperty(Object.prototype, "hasOwnProperty", descriptor);
    }

    expect(context.youtube.sideEffectCount()).toBe(0);
    expect(context.r2.requests()).toHaveLength(0);
    const audit = await env.DB.prepare(
      `SELECT details_json FROM audit_logs
       WHERE action = 'publication.policy_rejected' ORDER BY occurred_at DESC LIMIT 1`,
    ).first<{ details_json: string }>();
    expect(audit?.details_json).toContain('"error_code":"YOUTUBE_SCHEDULE_NOT_ALLOWED"');
  });

  it("does not insert a stale rejection audit when a valid publication advances after the read", async () => {
    const repository = new JobRepository(env.DB);
    await approveJob(repository);
    const snapshot = await repository.getVideoJob(JOB_ID);
    expect(snapshot?.state).toBe("APPROVED");

    await repository.claimPublication({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      actor: ACTOR,
      now: NOW,
    });
    await expect(repository.recordYoutubePublicationPolicyRejection({
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      actor: ACTOR,
      now: NOW,
      expectedRowVersion: snapshot!.row_version,
      errorCode: "YOUTUBE_PRIVATE_ONLY",
    })).rejects.toBeInstanceOf(ConcurrentUpdateError);

    expect((await repository.getVideoJob(JOB_ID))?.state).toBe("PUBLISHING");
    expect(await policyAuditCount()).toBe(0);
  });

  it("uses one frozen source snapshot for R2 verification and the client across an await", async () => {
    const repository = new JobRepository(env.DB);
    await approveJob(repository);
    const originalBytes = new TextEncoder().encode("immutable-source-a");
    const replacementBytes = new TextEncoder().encode("mutable-source-b");
    const sourceA = {
      objectKey: "object_source_a",
      expectedSize: originalBytes.byteLength,
      expectedSha256: await sha256(originalBytes),
    };
    const sourceB = {
      objectKey: "object_source_b",
      expectedSize: replacementBytes.byteLength,
      expectedSha256: await sha256(replacementBytes),
    };
    const innerR2 = new FakeR2ReadClient([
      await fakeObjectFixture(sourceA.objectKey, originalBytes),
      await fakeObjectFixture(sourceB.objectKey, replacementBytes),
    ]);
    let releaseHead!: () => void;
    const headGate = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    let markHeadEntered!: () => void;
    const headEntered = new Promise<void>((resolve) => {
      markHeadEntered = resolve;
    });
    const headKeys: string[] = [];
    const r2: R2ReadClient = {
      async headObject(objectKey) {
        headKeys.push(objectKey);
        markHeadEntered();
        await headGate;
        return innerR2.headObject(objectKey);
      },
      readRange(request) {
        return innerR2.readRange(request);
      },
    };
    const youtube = createScriptedYouTubePublishController({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0556",
    });
    const service = new E5PublishContractService(repository, youtube.client, r2, () => NOW, {
      rangeSize: 4,
    });
    const input: PublishContractInput = {
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      source: { ...sourceA },
      actorId: ACTOR.id,
    };

    const execution = service.execute(input);
    await headEntered;
    Object.assign(input.source, sourceB);
    releaseHead();
    const result = await execution;

    expect(result.state).toBe("PUBLISHED");
    expect(headKeys).toEqual([sourceA.objectKey]);
    expect(innerR2.requests().map((request) => request.objectKey))
      .toEqual(Array(Math.ceil(originalBytes.byteLength / 4) * 2).fill(sourceA.objectKey));
    expect(youtube.lastUpload()?.source).toEqual({
      expectedSize: sourceA.expectedSize,
      expectedSha256: sourceA.expectedSha256,
    });
    expect(youtube.lastUpload()?.source).not.toBe(input.source);
    expect(Object.isFrozen(youtube.lastUpload()?.source)).toBe(true);
    expect(Reflect.has(youtube.lastUpload()?.source ?? {}, "objectKey")).toBe(false);
    expect(input.source).toEqual(sourceB);
  });

  it("uses one immutable job/target/version/actor snapshot while the client is awaiting", async () => {
    const repository = new JobRepository(env.DB);
    await approveJob(repository);
    const checksum = await sha256(BYTES);
    const sourceA = {
      objectKey: "object_snapshot_a",
      expectedSize: BYTES.byteLength,
      expectedSha256: checksum,
    };
    const r2 = new FakeR2ReadClient([
      await fakeObjectFixture(sourceA.objectKey, BYTES),
    ]);
    const youtube = createScriptedYouTubePublishController({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0557",
    }, { pauseBeforeResult: true });
    const service = new E5PublishContractService(repository, youtube.client, r2, () => NOW, {
      rangeSize: 5,
    });
    const input: PublishContractInput = {
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      source: { ...sourceA },
      actorId: ACTOR.id,
    };
    const replacement = {
      videoJobId: "00000000-0000-4000-8000-000000000599",
      targetAccountId: "youtube_account_changed",
      approvedContentVersion: "approved-v2",
      source: {
        objectKey: "object_snapshot_b",
        expectedSize: 1,
        expectedSha256: "f".repeat(64),
      },
      actorId: "system_changed",
    };

    const execution = service.execute(input);
    await youtube.waitUntilUploadStarted();
    Object.assign(input, replacement);
    youtube.resumeUpload();
    const result = await execution;

    expect(result).toMatchObject({
      state: "PUBLISHED",
      job: { video_job_id: JOB_ID, approved_content_version: VERSION },
      publicationRef: "FAKEVID0557",
    });
    expect(youtube.lastUpload()).toMatchObject({
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      source: {
        expectedSize: sourceA.expectedSize,
        expectedSha256: sourceA.expectedSha256,
      },
    });
    expect(await repository.getPublicationRecord({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
    })).toMatchObject({ status: "SUCCEEDED", result_ref: "FAKEVID0557" });
    expect(await repository.getPublicationRecord({
      videoJobId: replacement.videoJobId,
      destination: "youtube",
      targetAccountId: replacement.targetAccountId,
      approvedContentVersion: replacement.approvedContentVersion,
    })).toBeNull();
    const resultAudit = await env.DB.prepare(
      `SELECT actor_id, details_json FROM audit_logs
       WHERE action = 'publication.result.recorded' ORDER BY occurred_at DESC LIMIT 1`,
    ).first<{ actor_id: string; details_json: string }>();
    expect(resultAudit?.actor_id).toBe(ACTOR.id);
    expect(JSON.parse(resultAudit!.details_json)).toMatchObject({
      destination: "youtube",
      target_account_id: TARGET,
      result: "SUCCEEDED",
    });
    expect(input).toMatchObject(replacement);
  });

  it("stops on a reported R2 size mismatch", async () => {
    const context = await harness({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0006",
    }, { reportedSize: BYTES.byteLength + 1 });
    const result = await context.service.execute(context.input);
    expect(result).toMatchObject({
      state: "FAILED",
      sideEffectStarted: false,
      job: { state: "FAILED", youtube_status: "FAILED", retention_state: "HOLD" },
      error: { code: "R2_SIZE_MISMATCH" },
    });
    expect(context.youtube.sideEffectCount()).toBe(0);
  });

  it("uses the E-5.5 streaming verifier at the existing publication boundary", async () => {
    const repository = new JobRepository(env.DB);
    await approveJob(repository);
    const checksum = await sha256(BYTES);
    let verifyCalls = 0;
    const openedOffsets: number[] = [];
    const streamingSource: R2StreamingSource = {
      async verify(source) {
        verifyCalls += 1;
        return {
          size: source.expectedSize,
          checksumSha256: source.expectedSha256,
          snapshot: {
            schemaVersion: 1,
            objectKey: source.objectKey,
            size: source.expectedSize,
            checksumSha256: source.expectedSha256,
            etag: "fake-etag",
            version: "fake-version",
          },
          open: (offset = 0) => new ReadableStream<Uint8Array>({
            start(controller) {
              openedOffsets.push(offset);
              if (offset < BYTES.byteLength) controller.enqueue(BYTES.slice(offset));
              controller.close();
            },
          }),
        };
      },
      rehydrate() {
        throw new Error("not used by E-5.1 contract execution");
      },
    };
    const youtube = new FakeYouTubePublishClient({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0055",
    });
    const result = await new E5PublishContractService(
      repository,
      youtube.client,
      streamingSource,
      () => NOW,
    ).execute({
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      source: {
        objectKey: "object_fake_video",
        expectedSize: BYTES.byteLength,
        expectedSha256: checksum,
      },
      actorId: ACTOR.id,
    });

    expect(result.state).toBe("PUBLISHED");
    expect(verifyCalls).toBe(1);
    expect(openedOffsets).toEqual([0]);
    expect(youtube.sideEffectCount()).toBe(1);
  });

  it.each([
    ["empty", () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() })],
    ["short", () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(BYTES.slice(0, BYTES.byteLength - 1));
        controller.close();
      },
    })],
    ["overlong", () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(BYTES.byteLength + 1));
        controller.close();
      },
    })],
    ["downstream failure", () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(BYTES.slice(0, 3));
        controller.error(new Error("injected downstream failure"));
      },
    })],
    ["pinned object replacement", () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new R2StreamError(
          "R2_RANGE_INVALID",
          false,
          "The source range response was inconsistent",
        ));
      },
    })],
  ] as const)("does not accept a %s verified-source stream as published", async (_name, open) => {
    const repository = new JobRepository(env.DB);
    await approveJob(repository);
    const checksum = await sha256(BYTES);
    const sourceDescriptor = {
      objectKey: "object_fake_video",
      expectedSize: BYTES.byteLength,
      expectedSha256: checksum,
    };
    const base = verifiedSourceFor(sourceDescriptor, BYTES);
    const streamingSource: R2StreamingSource = {
      async verify() { return { ...base, open }; },
      rehydrate() { throw new Error("not used"); },
    };
    const youtube = new FakeYouTubePublishClient({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0056",
    });
    const result = await new E5PublishContractService(
      repository,
      youtube.client,
      streamingSource,
      () => NOW,
    ).execute({
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      source: sourceDescriptor,
      actorId: ACTOR.id,
    });

    expect(result).toMatchObject({
      state: "RECONCILIATION_REQUIRED",
      transitions: ["OUTCOME_UNKNOWN", "RECONCILIATION_REQUIRED"],
      job: { youtube_status: "RECONCILIATION_REQUIRED", retention_state: "HOLD" },
    });
    expect(result.publicationRef).toBeUndefined();
  });

  it("stops on metadata and returned-byte checksum mismatches", async () => {
    const checksum = await sha256(BYTES);
    const metadataMismatch = await harness({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0007",
    }, { reportedChecksumSha256: "0".repeat(64) });
    expect((await metadataMismatch.service.execute(metadataMismatch.input)).error?.code)
      .toBe("R2_CHECKSUM_MISMATCH");
    expect(metadataMismatch.youtube.sideEffectCount()).toBe(0);

    await env.DB.batch([
      env.DB.prepare("DELETE FROM mirror_outbox"),
      env.DB.prepare("DELETE FROM audit_logs"),
      env.DB.prepare("DELETE FROM idempotency_records"),
      env.DB.prepare("DELETE FROM applied_mutations"),
      env.DB.prepare("DELETE FROM video_jobs"),
    ]);
    const byteMismatch = await harness({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0008",
    }, { reportedChecksumSha256: checksum, corruptRanges: true });
    expect((await byteMismatch.service.execute(byteMismatch.input)).error?.code)
      .toBe("R2_CHECKSUM_MISMATCH");
    expect(byteMismatch.youtube.sideEffectCount()).toBe(0);
  });

  it("does not publish when same-size bytes change between verification and fake upload", async () => {
    const repository = new JobRepository(env.DB);
    await approveJob(repository);
    const original = BYTES;
    const replacement = new Uint8Array(original.byteLength).fill(0x78);
    const checksum = await sha256(original);
    const rangeSize = 5;
    const firstPassRanges = Math.ceil(original.byteLength / rangeSize);
    let rangeReads = 0;
    const r2 = {
      headObject: async () => ({ size: original.byteLength, checksumSha256: checksum }),
      readRange: async (request: { objectKey: string; offset: number; length: number }) => {
        const current = rangeReads < firstPassRanges ? original : replacement;
        rangeReads += 1;
        return {
          offset: request.offset,
          totalSize: original.byteLength,
          bytes: current.slice(request.offset, request.offset + request.length),
        };
      },
    };
    const youtube = new FakeYouTubePublishClient({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0058",
    });
    const result = await new E5PublishContractService(
      repository,
      youtube.client,
      r2,
      () => NOW,
      { rangeSize },
    ).execute({
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      source: {
        objectKey: "object_fake_video",
        expectedSize: original.byteLength,
        expectedSha256: checksum,
      },
      actorId: ACTOR.id,
    });

    expect(result).toMatchObject({
      state: "RECONCILIATION_REQUIRED",
      transitions: ["OUTCOME_UNKNOWN", "RECONCILIATION_REQUIRED"],
      job: { youtube_status: "RECONCILIATION_REQUIRED", retention_state: "HOLD" },
    });
    expect(result.publicationRef).toBeUndefined();
    expect(rangeReads).toBe(firstPassRanges * 2);
  });

  it.each([
    ["short", -1],
    ["long", 1],
  ] as const)("rejects a %s R2 range response before upload", async (_name, delta) => {
    const repository = new JobRepository(env.DB);
    await approveJob(repository);
    const checksum = await sha256(BYTES);
    const r2 = {
      headObject: async () => ({ size: BYTES.byteLength, checksumSha256: checksum }),
      readRange: async (request: { objectKey: string; offset: number; length: number }) => ({
        offset: request.offset,
        totalSize: BYTES.byteLength,
        bytes: BYTES.slice(request.offset, request.offset + request.length + delta),
      }),
    };
    const youtube = new FakeYouTubePublishClient({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0011",
    });
    const service = new E5PublishContractService(repository, youtube.client, r2, () => NOW, {
      rangeSize: 5,
    });
    const result = await service.execute({
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      source: {
        objectKey: "object_fake_video",
        expectedSize: BYTES.byteLength,
        expectedSha256: checksum,
      },
      actorId: ACTOR.id,
    });
    expect(result).toMatchObject({
      state: "FAILED",
      sideEffectStarted: false,
      error: { code: "R2_RANGE_INVALID" },
    });
    expect(youtube.sideEffectCount()).toBe(0);
  });

  it("reports an unknown R2 object without starting upload", async () => {
    const repository = new JobRepository(env.DB);
    await approveJob(repository);
    const checksum = await sha256(BYTES);
    const r2 = new FakeR2ReadClient([]);
    const youtube = new FakeYouTubePublishClient({
      kind: "status",
      uploadStatus: "processed",
      processingStatus: "succeeded",
      privacyStatus: "private",
      videoId: "FAKEVID0012",
    });
    const service = new E5PublishContractService(repository, youtube.client, r2, () => NOW);
    const result = await service.execute({
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      source: {
        objectKey: "object_missing",
        expectedSize: BYTES.byteLength,
        expectedSha256: checksum,
      },
      actorId: ACTOR.id,
    });
    expect(result).toMatchObject({
      state: "FAILED",
      sideEffectStarted: false,
      error: { code: "R2_SOURCE_UNAVAILABLE", retryable: true },
    });
    expect(await repository.getPublicationRecord({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
    })).toMatchObject({
      status: "PENDING",
      error_code: "R2_SOURCE_UNAVAILABLE",
      retryable: 1,
    });
    expect(youtube.sideEffectCount()).toBe(0);
  });

  it.each(["head", "range"] as const)(
    "retries a transient R2 %s failure before starting upload",
    async (failurePoint) => {
      const repository = new JobRepository(env.DB);
      await approveJob(repository);
      const checksum = await sha256(BYTES);
      const baseR2 = new FakeR2ReadClient([
        await fakeObjectFixture("object_fake_video", BYTES),
      ]);
      let remainingFailures = 1;
      const r2 = {
        headObject: async (objectKey: string) => {
          if (failurePoint === "head" && remainingFailures-- > 0) {
            throw new Error("FAKE_TRANSIENT_HEAD_FAILURE");
          }
          return baseR2.headObject(objectKey);
        },
        readRange: async (request: { objectKey: string; offset: number; length: number }) => {
          if (failurePoint === "range" && remainingFailures-- > 0) {
            throw new Error("FAKE_TRANSIENT_RANGE_FAILURE");
          }
          return baseR2.readRange(request);
        },
      };
      const youtube = new FakeYouTubePublishClient({
        kind: "status",
        uploadStatus: "processed",
        processingStatus: "succeeded",
        privacyStatus: "private",
        videoId: "FAKEVID0014",
      });
      const service = new E5PublishContractService(repository, youtube.client, r2, () => NOW, {
        rangeSize: 5,
      });
      const input: PublishContractInput = {
        videoJobId: JOB_ID,
        targetAccountId: TARGET,
        approvedContentVersion: VERSION,
        source: {
          objectKey: "object_fake_video",
          expectedSize: BYTES.byteLength,
          expectedSha256: checksum,
        },
        actorId: ACTOR.id,
      };

      const first = await service.execute(input);
      expect(first).toMatchObject({
        state: "FAILED",
        sideEffectStarted: false,
        error: {
          code: failurePoint === "head" ? "R2_SOURCE_UNAVAILABLE" : "R2_RANGE_READ_FAILED",
          retryable: true,
        },
        job: { state: "PUBLISHING", youtube_status: "PENDING" },
      });
      expect(youtube.sideEffectCount()).toBe(0);
      expect(await env.DB.prepare(
        "SELECT attempt_no FROM idempotency_records WHERE video_job_id = ?",
      ).bind(JOB_ID).first<{ attempt_no: number }>()).toEqual({ attempt_no: 1 });

      const retries = await Promise.all([
        service.execute(input),
        service.execute(input),
      ]);
      expect(retries.some((retry) => retry.state === "PUBLISHED")).toBe(true);
      expect(youtube.sideEffectCount()).toBe(1);
      expect(await env.DB.prepare(
        "SELECT attempt_no FROM idempotency_records WHERE video_job_id = ?",
      ).bind(JOB_ID).first<{ attempt_no: number }>()).toEqual({ attempt_no: 2 });
    },
  );

  it.each([
    ["offset at object end", BYTES.byteLength, 1],
    ["range past object end", BYTES.byteLength - 1, 2],
    ["safe integer overflow", Number.MAX_SAFE_INTEGER, 2],
  ] as const)("rejects an unsatisfiable fake R2 %s", async (_name, offset, length) => {
    const r2 = new FakeR2ReadClient([
      await fakeObjectFixture("object_fake_video", BYTES),
    ]);
    await expect(r2.readRange({
      objectKey: "object_fake_video",
      offset,
      length,
    })).rejects.toBeInstanceOf(RangeError);
    expect(r2.requests()).toHaveLength(0);
  });
});
