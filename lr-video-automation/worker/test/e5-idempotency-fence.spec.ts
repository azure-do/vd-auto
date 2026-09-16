import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  fakeObjectFixture,
  FakeR2ReadClient,
  FakeYouTubePublishClient,
  FakeYouTubeReconciliationClient,
} from "../src/e5-fakes";
import type { PublishContractInput } from "../src/e5-contracts";
import { E5PublishContractService } from "../src/e5-service";
import { E5YoutubeReconciliationService } from "../src/e5-youtube-reconciliation";
import { ConcurrentUpdateError } from "../src/errors";
import { JobRepository } from "../src/repository";

const NOW = "2026-09-07T00:00:00.000Z";
const LATER = "2026-09-07T00:01:00.000Z";
const AFTER_LEASE = "2026-09-07T00:06:00.000Z";
const AFTER_STABILITY = "2026-09-07T00:07:00.000Z";
const AFTER_OBSERVATION_TIMEOUT = "2026-09-07T00:01:01.000Z";
const IMMEDIATELY_AFTER_TIMEOUT = "2026-09-07T00:01:02.000Z";
const AFTER_REAL_STABILITY = "2026-09-07T00:01:33.000Z";
const JOB_ID = "00000000-0000-4000-8000-000000000522";
const TARGET = "youtube_channel_fake";
const VERSION = "approved-v1";
const ACTOR = { type: "system" as const, id: "system_e54_fake" };
const BYTES = new TextEncoder().encode("fake-e54-video-bytes");

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function publishFixture() {
  const checksum = await sha256(BYTES);
  return {
    r2: new FakeR2ReadClient([
      await fakeObjectFixture("object_e54_fake", BYTES),
    ]),
    input: {
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      source: {
        objectKey: "object_e54_fake",
        expectedSize: BYTES.byteLength,
        expectedSha256: checksum,
      },
      actorId: ACTOR.id,
    } satisfies PublishContractInput,
  };
}

async function approve(repository: JobRepository): Promise<void> {
  await repository.createVideoJob({
    videoJobId: JOB_ID,
    submissionId: "00000000-0000-4000-8000-000000010522",
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
      videoJobId: JOB_ID, expectedState, nextState, actor: ACTOR, now: NOW,
    });
  }
  await repository.transitionJob({
    videoJobId: JOB_ID,
    expectedState: "WAITING_APPROVAL",
    nextState: "APPROVED",
    approvedContentVersion: VERSION,
    publicationTargets: [{ destination: "youtube", targetAccountId: TARGET }],
    actor: { type: "approver", id: "approver_fake" },
    now: NOW,
  });
}

async function claim(repository: JobRepository, token: string, now = NOW) {
  return repository.claimPublication({
    videoJobId: JOB_ID,
    destination: "youtube",
    targetAccountId: TARGET,
    approvedContentVersion: VERSION,
    actor: ACTOR,
    now,
    mutationToken: token,
  });
}

async function moveToReconciliation(
  repository: JobRepository,
  claimToken: string,
  fenceToken: string,
  options: { offset: number; videoId?: string; sessionState?: "ACTIVE" | "UNUSABLE" },
): Promise<void> {
  expect(await repository.prepareYoutubeSideEffect({
    videoJobId: JOB_ID,
    targetAccountId: TARGET,
    approvedContentVersion: VERSION,
    claimMutationToken: claimToken,
    fenceToken,
    now: NOW,
  })).toEqual({ allowed: true, attemptNo: 1 });
  expect(await repository.recordYoutubeUploadProgress({
    videoJobId: JOB_ID,
    targetAccountId: TARGET,
    approvedContentVersion: VERSION,
    fenceToken,
    committedOffset: options.offset,
    ...(options.videoId ? { videoId: options.videoId } : {}),
    sessionState: options.sessionState ?? "ACTIVE",
    now: NOW,
  })).toBe(true);
  await repository.recordPublicationResult({
    videoJobId: JOB_ID,
    destination: "youtube",
    targetAccountId: TARGET,
    approvedContentVersion: VERSION,
    result: "OUTCOME_UNKNOWN",
    actor: ACTOR,
    now: NOW,
    error: { code: "YOUTUBE_OUTCOME_UNKNOWN", retryable: true },
  });
  await repository.recordPublicationResult({
    videoJobId: JOB_ID,
    destination: "youtube",
    targetAccountId: TARGET,
    approvedContentVersion: VERSION,
    result: "RECONCILIATION_REQUIRED",
    actor: ACTOR,
    now: NOW,
    error: { code: "YOUTUBE_OUTCOME_UNKNOWN", retryable: true },
  });
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

describe("E-5.4 YouTube idempotency fence", () => {
  it("grants one side-effect fence for one job/channel/approved-version attempt", async () => {
    const repository = new JobRepository(env.DB);
    await approve(repository);
    await claim(repository, "claim_one");

    const [first, second] = await Promise.all([
      repository.prepareYoutubeSideEffect({
        videoJobId: JOB_ID, targetAccountId: TARGET, approvedContentVersion: VERSION,
        claimMutationToken: "claim_one", fenceToken: "fence_one", now: NOW,
      }),
      repository.prepareYoutubeSideEffect({
        videoJobId: JOB_ID, targetAccountId: TARGET, approvedContentVersion: VERSION,
        claimMutationToken: "claim_one", fenceToken: "fence_two", now: NOW,
      }),
    ]);

    expect([first, second].filter((result) => result.allowed)).toHaveLength(1);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM youtube_publication_attempts",
    ).first<{ count: number }>())?.count).toBe(1);
  });

  it.each(["sequential", "concurrent", "lost-ack"] as const)(
    "consumes the same claim and fence only once: %s",
    async (mode) => {
      const repository = new JobRepository(env.DB);
      await approve(repository);
      await claim(repository, "claim_identical");
      const input = { videoJobId: JOB_ID, targetAccountId: TARGET,
        approvedContentVersion: VERSION, claimMutationToken: "claim_identical",
        fenceToken: "fence_identical", now: NOW };
      if (mode === "concurrent") {
        const results = await Promise.all(Array.from({ length: 8 }, () =>
          repository.prepareYoutubeSideEffect(input)));
        expect(results.filter((result) => result.allowed)).toHaveLength(1);
      } else if (mode === "lost-ack") {
        const db = new Proxy(env.DB, {
          get(target, property) {
            if (property === "batch") return async (...args: Parameters<D1Database["batch"]>) => {
              await target.batch(...args);
              throw new Error("FAKE_ACK_LOST");
            };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        await expect(new JobRepository(db).prepareYoutubeSideEffect(input))
          .rejects.toThrow("FAKE_ACK_LOST");
      } else {
        expect(await repository.prepareYoutubeSideEffect(input))
          .toEqual({ allowed: true, attemptNo: 1 });
      }
      expect(await repository.prepareYoutubeSideEffect(input))
        .toEqual({ allowed: false, attemptNo: null });
      await repository.recoverExpiredYoutubePublicationClaim({
        videoJobId: JOB_ID, targetAccountId: TARGET, approvedContentVersion: VERSION,
        actor: ACTOR, now: AFTER_LEASE, expiredBefore: LATER,
        error: { code: "YOUTUBE_SIDE_EFFECT_START_UNKNOWN", retryable: true },
        mutationToken: "recover_identical",
      });
      expect(await repository.getPublicationRecord({
        videoJobId: JOB_ID, targetAccountId: TARGET,
        approvedContentVersion: VERSION, destination: "youtube",
      })).toMatchObject({ status: "OUTCOME_UNKNOWN", attempt_no: 1 });
    },
  );

  it("keeps attempt_no outside the idempotency key and increments only after a retryable release", async () => {
    const repository = new JobRepository(env.DB);
    await approve(repository);
    const first = await claim(repository, "claim_attempt_one");
    await repository.releaseYoutubePublicationClaim({
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      actor: ACTOR,
      now: NOW,
      error: { code: "R2_SOURCE_UNAVAILABLE", retryable: true },
      claimMutationToken: "claim_attempt_one",
    });
    const second = await claim(repository, "claim_attempt_two", LATER);

    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(await repository.getPublicationRecord({
      videoJobId: JOB_ID, destination: "youtube", targetAccountId: TARGET,
      approvedContentVersion: VERSION,
    })).toMatchObject({ attempt_no: 2, status: "CLAIMED" });
  });

  it("blocks a new session for committed bytes even when no video ID is known", async () => {
    const repository = new JobRepository(env.DB);
    await approve(repository);
    await claim(repository, "claim_offset");
    await moveToReconciliation(repository, "claim_offset", "fence_offset", { offset: 64 });

    expect(await repository.prepareYoutubeSideEffect({
      videoJobId: JOB_ID, targetAccountId: TARGET, approvedContentVersion: VERSION,
      claimMutationToken: "claim_offset", fenceToken: "fence_retry", now: LATER,
    })).toEqual({ allowed: false, attemptNo: null });
    const fake = new FakeYouTubeReconciliationClient({});
    const result = await new E5YoutubeReconciliationService(repository, fake, () => LATER)
      .reconcile({ videoJobId: JOB_ID, targetAccountId: TARGET,
        approvedContentVersion: VERSION, actor: ACTOR });
    expect(result).toMatchObject({
      state: "RECONCILIATION_REQUIRED", newSessionAllowed: false,
    });
    expect(fake.requests()).toEqual([]);
  });

  it("moves an interrupted attempt row through unknown and reconciliation without finishYoutubeAttempt", async () => {
    const repository = new JobRepository(env.DB);
    await approve(repository);
    await claim(repository, "claim_interrupted");
    expect(await repository.prepareYoutubeSideEffect({
      videoJobId: JOB_ID, targetAccountId: TARGET, approvedContentVersion: VERSION,
      claimMutationToken: "claim_interrupted", fenceToken: "fence_interrupted", now: NOW,
    })).toEqual({ allowed: true, attemptNo: 1 });
    await repository.recordYoutubeUploadProgress({
      videoJobId: JOB_ID, targetAccountId: TARGET, approvedContentVersion: VERSION,
      fenceToken: "fence_interrupted", committedOffset: 32,
      videoId: "FAKEVID0525", now: NOW,
    });

    expect((await repository.recoverExpiredYoutubePublicationClaim({
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      actor: ACTOR,
      now: AFTER_LEASE,
      expiredBefore: LATER,
      error: { code: "YOUTUBE_SIDE_EFFECT_START_UNKNOWN", retryable: true },
      mutationToken: "recover_interrupted",
    })).recovered).toBe(true);
    await repository.recordPublicationResult({
      videoJobId: JOB_ID, destination: "youtube", targetAccountId: TARGET,
      approvedContentVersion: VERSION, result: "RECONCILIATION_REQUIRED",
      actor: ACTOR, now: AFTER_LEASE,
      error: { code: "YOUTUBE_SIDE_EFFECT_START_UNKNOWN", retryable: true },
    });
    expect(await env.DB.prepare(
      "SELECT state FROM youtube_publication_attempts WHERE fence_token = 'fence_interrupted'",
    ).first()).toEqual({ state: "RECONCILIATION_REQUIRED" });

    expect(await repository.markYoutubeSessionUnusableForReconciliation({
      videoJobId: JOB_ID, targetAccountId: TARGET,
      approvedContentVersion: VERSION, now: AFTER_LEASE,
    })).toBe(true);
    const firstResult = await new E5YoutubeReconciliationService(
      repository,
      new FakeYouTubeReconciliationClient({ FAKEVID0525: { kind: "not_found" } }),
      () => AFTER_LEASE,
    ).reconcile({ videoJobId: JOB_ID, targetAccountId: TARGET,
      approvedContentVersion: VERSION, actor: ACTOR });
    expect(firstResult).toMatchObject({
      state: "PENDING", newSessionAllowed: true,
    });
    const stableResult = await new E5YoutubeReconciliationService(
      repository,
      new FakeYouTubeReconciliationClient({ FAKEVID0525: { kind: "not_found" } }),
      () => AFTER_STABILITY,
    ).reconcile({ videoJobId: JOB_ID, targetAccountId: TARGET,
      approvedContentVersion: VERSION, actor: ACTOR });
    expect(stableResult).toMatchObject({ state: "PENDING", newSessionAllowed: true });
  });

  it("also reconciles an expired SIDE_EFFECT_ALLOWED attempt row without an explicit finish", async () => {
    const repository = new JobRepository(env.DB);
    await approve(repository);
    await claim(repository, "claim_allowed_stop");
    await repository.prepareYoutubeSideEffect({
      videoJobId: JOB_ID, targetAccountId: TARGET, approvedContentVersion: VERSION,
      claimMutationToken: "claim_allowed_stop", fenceToken: "fence_allowed_stop", now: NOW,
    });
    await repository.recoverExpiredYoutubePublicationClaim({
      videoJobId: JOB_ID, targetAccountId: TARGET, approvedContentVersion: VERSION,
      actor: ACTOR, now: AFTER_LEASE, expiredBefore: LATER,
      error: { code: "YOUTUBE_SIDE_EFFECT_START_UNKNOWN", retryable: true },
      mutationToken: "recover_allowed_stop",
    });
    await repository.recordPublicationResult({
      videoJobId: JOB_ID, destination: "youtube", targetAccountId: TARGET,
      approvedContentVersion: VERSION, result: "RECONCILIATION_REQUIRED",
      actor: ACTOR, now: AFTER_LEASE,
      error: { code: "YOUTUBE_SIDE_EFFECT_START_UNKNOWN", retryable: true },
    });
    expect(await env.DB.prepare(
      "SELECT state FROM youtube_publication_attempts WHERE fence_token = 'fence_allowed_stop'",
    ).first()).toEqual({ state: "RECONCILIATION_REQUIRED" });
  });

  it("tracks a processing video ID under the active fence", async () => {
    const repository = new JobRepository(env.DB);
    await approve(repository);
    const fixture = await publishFixture();
    const youtube = new FakeYouTubePublishClient({
      kind: "status", uploadStatus: "uploaded", processingStatus: "processing",
      privacyStatus: "private", videoId: "FAKEVID0526",
    });
    const result = await new E5PublishContractService(
      repository, youtube.client, fixture.r2, () => NOW,
    ).execute(fixture.input);

    expect(result.state).toBe("PUBLISHING");
    expect(await repository.getPublicationRecord({
      videoJobId: JOB_ID, destination: "youtube", targetAccountId: TARGET,
      approvedContentVersion: VERSION,
    })).toMatchObject({ status: "CLAIMED", yt_video_id: "FAKEVID0526" });
    expect(await env.DB.prepare(
      "SELECT state, video_id FROM youtube_publication_attempts",
    ).first()).toEqual({ state: "UPLOADING", video_id: "FAKEVID0526" });
  });

  it("rejects a conflicting A to B video ID update in both operational tables", async () => {
    const repository = new JobRepository(env.DB);
    await approve(repository);
    await claim(repository, "claim_video_identity");
    await repository.prepareYoutubeSideEffect({
      videoJobId: JOB_ID, targetAccountId: TARGET, approvedContentVersion: VERSION,
      claimMutationToken: "claim_video_identity", fenceToken: "fence_video_identity", now: NOW,
    });
    expect(await repository.recordYoutubeUploadProgress({
      videoJobId: JOB_ID, targetAccountId: TARGET, approvedContentVersion: VERSION,
      fenceToken: "fence_video_identity", committedOffset: 10,
      videoId: "FAKEVID0529", now: NOW,
    })).toBe(true);
    expect(await repository.recordYoutubeUploadProgress({
      videoJobId: JOB_ID, targetAccountId: TARGET, approvedContentVersion: VERSION,
      fenceToken: "fence_video_identity", committedOffset: 20,
      videoId: "FAKEVID0530", now: LATER,
    })).toBe(false);
    expect(await repository.getPublicationRecord({
      videoJobId: JOB_ID, destination: "youtube", targetAccountId: TARGET,
      approvedContentVersion: VERSION,
    })).toMatchObject({ yt_video_id: "FAKEVID0529", yt_committed_offset: 10 });
    expect(await env.DB.prepare(
      "SELECT video_id, committed_offset FROM youtube_publication_attempts",
    ).first()).toEqual({ video_id: "FAKEVID0529", committed_offset: 10 });
  });

  it("rejects a conflicting success video ID at the atomic finalization boundary", async () => {
    const repository = new JobRepository(env.DB);
    await approve(repository);
    await claim(repository, "claim_result_identity");
    await repository.prepareYoutubeSideEffect({
      videoJobId: JOB_ID, targetAccountId: TARGET, approvedContentVersion: VERSION,
      claimMutationToken: "claim_result_identity", fenceToken: "fence_result_identity", now: NOW,
    });
    await repository.recordYoutubeUploadProgress({
      videoJobId: JOB_ID, targetAccountId: TARGET, approvedContentVersion: VERSION,
      fenceToken: "fence_result_identity", committedOffset: 10,
      videoId: "FAKEVID0529", now: NOW,
    });
    const beforeJob = await repository.getVideoJob(JOB_ID);
    const beforeRecord = await env.DB.prepare(
      `SELECT status, result_ref, yt_video_id, yt_committed_offset,
              last_mutation_token, updated_at
       FROM idempotency_records WHERE destination = 'youtube'`,
    ).first();

    await expect(repository.recordPublicationResult({
      videoJobId: JOB_ID, destination: "youtube", targetAccountId: TARGET,
      approvedContentVersion: VERSION, result: "SUCCEEDED", resultRef: "FAKEVID0530",
      actor: ACTOR, now: LATER, mutationToken: "result_identity_conflict",
      expectedClaimMutationToken: "claim_result_identity",
    })).rejects.toBeInstanceOf(ConcurrentUpdateError);

    expect(await env.DB.prepare(
      `SELECT status, result_ref, yt_video_id, yt_committed_offset,
              last_mutation_token, updated_at
       FROM idempotency_records WHERE destination = 'youtube'`,
    ).first()).toEqual(beforeRecord);
    expect(await env.DB.prepare(
      "SELECT state, video_id, committed_offset FROM youtube_publication_attempts",
    ).first()).toEqual({
      state: "UPLOADING", video_id: "FAKEVID0529", committed_offset: 10,
    });
    expect(await repository.getVideoJob(JOB_ID)).toMatchObject({
      row_version: beforeJob?.row_version,
      state: beforeJob?.state,
      youtube_status: beforeJob?.youtube_status,
    });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM applied_mutations WHERE mutation_token = ?",
    ).bind("result_identity_conflict").first()).toEqual({ count: 0 });
  });

  it.each([
    ["missing", undefined],
    ["session URI", "https://upload.youtube.invalid/resumable/session-secret"],
    ["arbitrary string", "not a video id"],
  ] as const)("rejects a %s YouTube success ID without any database mutation", async (_label, resultRef) => {
    const repository = new JobRepository(env.DB);
    await approve(repository);
    await claim(repository, "claim_invalid_success_id");
    await repository.prepareYoutubeSideEffect({
      videoJobId: JOB_ID, targetAccountId: TARGET, approvedContentVersion: VERSION,
      claimMutationToken: "claim_invalid_success_id", fenceToken: "fence_invalid_success_id",
      now: NOW,
    });
    const snapshot = async () => ({
      job: await env.DB.prepare(
        `SELECT state, youtube_status, row_version, last_mutation_token, updated_at
         FROM video_jobs WHERE video_job_id = ?`,
      ).bind(JOB_ID).first(),
      record: await env.DB.prepare(
        `SELECT status, result_ref, attempt_no, yt_committed_offset, yt_video_id,
                yt_session_state, last_mutation_token, updated_at
         FROM idempotency_records WHERE destination = 'youtube'`,
      ).first(),
      attempt: await env.DB.prepare(
        `SELECT attempt_no, state, committed_offset, video_id, updated_at
         FROM youtube_publication_attempts`,
      ).first(),
      counts: await env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM audit_logs) AS audits,
                (SELECT COUNT(*) FROM mirror_outbox) AS outbox,
                (SELECT COUNT(*) FROM applied_mutations) AS mutations`,
      ).first(),
    });
    const before = await snapshot();

    await expect(repository.recordPublicationResult({
      videoJobId: JOB_ID, destination: "youtube", targetAccountId: TARGET,
      approvedContentVersion: VERSION, result: "SUCCEEDED",
      ...(resultRef === undefined ? {} : { resultRef }),
      actor: ACTOR, now: LATER, mutationToken: "invalid_success_result",
      expectedClaimMutationToken: "claim_invalid_success_id",
    })).rejects.toBeInstanceOf(TypeError);
    expect(await snapshot()).toEqual(before);
  });

  it("keeps the success video ID if execution stops before result commit and later reconciles it", async () => {
    const repository = new JobRepository(env.DB);
    await approve(repository);
    const fixture = await publishFixture();
    let stopBeforeResult = true;
    const interruptedRepository = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === "recordPublicationResult") {
          return async (input: Parameters<JobRepository["recordPublicationResult"]>[0]) => {
            if (stopBeforeResult && input.result === "SUCCEEDED") {
              stopBeforeResult = false;
              throw new Error("FAKE_STOP_BEFORE_SUCCESS_RESULT");
            }
            return target.recordPublicationResult(input);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const youtube = new FakeYouTubePublishClient({
      kind: "status", uploadStatus: "processed", processingStatus: "succeeded",
      privacyStatus: "private", videoId: "FAKEVID0527",
    });
    await expect(new E5PublishContractService(
      interruptedRepository, youtube.client, fixture.r2, () => NOW,
    ).execute(fixture.input)).rejects.toThrow("FAKE_STOP_BEFORE_SUCCESS_RESULT");
    expect(await repository.getPublicationRecord({
      videoJobId: JOB_ID, destination: "youtube", targetAccountId: TARGET,
      approvedContentVersion: VERSION,
    })).toMatchObject({ status: "CLAIMED", yt_video_id: "FAKEVID0527" });

    const recovery = await new E5PublishContractService(
      repository, youtube.client, fixture.r2, () => AFTER_LEASE,
    ).execute(fixture.input);
    expect(recovery.state).toBe("RECONCILIATION_REQUIRED");
    const reconciled = await new E5YoutubeReconciliationService(
      repository,
      new FakeYouTubeReconciliationClient({
        FAKEVID0527: { kind: "found", observation: {
          kind: "status", uploadStatus: "processed", processingStatus: "succeeded",
          privacyStatus: "private", videoId: "FAKEVID0527",
        } },
      }),
      () => AFTER_LEASE,
    ).reconcile({ videoJobId: JOB_ID, targetAccountId: TARGET,
      approvedContentVersion: VERSION, actor: ACTOR });
    expect(reconciled).toMatchObject({ state: "PUBLISHED", videoId: "FAKEVID0527" });
    expect(await env.DB.prepare(
      "SELECT state, video_id FROM youtube_publication_attempts",
    ).first()).toEqual({ state: "SUCCEEDED", video_id: "FAKEVID0527" });
    expect(youtube.sideEffectCount()).toBe(1);
  });

  it("recovers a stopped FAILED result through confirmed not-found without a second upload", async () => {
    const repository = new JobRepository(env.DB);
    await approve(repository);
    const fixture = await publishFixture();
    const interruptedRepository = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === "recordPublicationResult") {
          return async (input: Parameters<JobRepository["recordPublicationResult"]>[0]) => {
            if (input.result === "FAILED") throw new Error("FAKE_STOP_BEFORE_FAILED_RESULT");
            return target.recordPublicationResult(input);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const youtube = new FakeYouTubePublishClient({
      kind: "status", uploadStatus: "failed", processingStatus: "failed",
      privacyStatus: "private", videoId: "FAKEVID0531",
    });
    await expect(new E5PublishContractService(
      interruptedRepository, youtube.client, fixture.r2, () => NOW,
    ).execute(fixture.input)).rejects.toThrow("FAKE_STOP_BEFORE_FAILED_RESULT");
    expect(await repository.getPublicationRecord({
      videoJobId: JOB_ID, destination: "youtube", targetAccountId: TARGET,
      approvedContentVersion: VERSION,
    })).toMatchObject({ status: "CLAIMED", yt_video_id: "FAKEVID0531" });
    expect((await new E5PublishContractService(
      repository, youtube.client, fixture.r2, () => AFTER_LEASE,
    ).execute(fixture.input)).state).toBe("RECONCILIATION_REQUIRED");
    await repository.markYoutubeSessionUnusableForReconciliation({
      videoJobId: JOB_ID, targetAccountId: TARGET,
      approvedContentVersion: VERSION, now: AFTER_LEASE,
    });
    const notFound = new FakeYouTubeReconciliationClient({
      FAKEVID0531: { kind: "not_found" },
    });
    expect((await new E5YoutubeReconciliationService(
      repository, notFound, () => AFTER_LEASE,
    ).reconcile({ videoJobId: JOB_ID, targetAccountId: TARGET,
      approvedContentVersion: VERSION, actor: ACTOR })).state)
      .toBe("PENDING");
    expect(await new E5YoutubeReconciliationService(
      repository, notFound, () => AFTER_STABILITY,
    ).reconcile({ videoJobId: JOB_ID, targetAccountId: TARGET,
      approvedContentVersion: VERSION, actor: ACTOR })).toMatchObject({
      state: "PENDING", newSessionAllowed: true,
    });
    expect(youtube.sideEffectCount()).toBe(1);
  });

  it("keeps DLQ replays blocked while a known video is not conclusively reconciled", async () => {
    const repository = new JobRepository(env.DB);
    await approve(repository);
    await claim(repository, "claim_dlq");
    await moveToReconciliation(repository, "claim_dlq", "fence_dlq", {
      offset: 0, videoId: "FAKEVID0524", sessionState: "ACTIVE",
    });
    const fake = new FakeYouTubeReconciliationClient({
      FAKEVID0524: { kind: "not_found" },
    });
    const service = new E5YoutubeReconciliationService(repository, fake, () => LATER);

    for (let replay = 0; replay < 2; replay += 1) {
      expect(await service.reconcile({
        videoJobId: JOB_ID, targetAccountId: TARGET,
        approvedContentVersion: VERSION, actor: ACTOR,
      })).toMatchObject({
        state: "RECONCILIATION_REQUIRED", newSessionAllowed: false,
      });
    }
    expect(await repository.prepareYoutubeSideEffect({
      videoJobId: JOB_ID, targetAccountId: TARGET, approvedContentVersion: VERSION,
      claimMutationToken: "claim_dlq", fenceToken: "fence_dlq_replay", now: LATER,
    })).toEqual({ allowed: false, attemptNo: null });
    expect(fake.requests()).toEqual(["FAKEVID0524", "FAKEVID0524"]);
  });

  it("reconciles a known private video to PUBLISHED without opening another session", async () => {
    const repository = new JobRepository(env.DB);
    await approve(repository);
    await claim(repository, "claim_found");
    await moveToReconciliation(repository, "claim_found", "fence_found", {
      offset: 64, videoId: "FAKEVID0522",
    });
    const fake = new FakeYouTubeReconciliationClient({
      FAKEVID0522: {
        kind: "found",
        observation: {
          kind: "status", uploadStatus: "processed", processingStatus: "succeeded",
          privacyStatus: "private", videoId: "FAKEVID0522",
        },
      },
    });

    const service = new E5YoutubeReconciliationService(repository, fake, () => LATER);
    const results = await Promise.all([
      service.reconcile({ videoJobId: JOB_ID, targetAccountId: TARGET,
        approvedContentVersion: VERSION, actor: ACTOR }),
      service.reconcile({ videoJobId: JOB_ID, targetAccountId: TARGET,
        approvedContentVersion: VERSION, actor: ACTOR }),
    ]);
    expect(results).toEqual([
      expect.objectContaining({
        state: "PUBLISHED", newSessionAllowed: false, videoId: "FAKEVID0522",
        job: expect.objectContaining({ youtube_status: "PUBLISHED" }),
      }),
      expect.objectContaining({
        state: "PUBLISHED", newSessionAllowed: false, videoId: "FAKEVID0522",
        job: expect.objectContaining({ youtube_status: "PUBLISHED" }),
      }),
    ]);
    expect(fake.requests()).toEqual(["FAKEVID0522", "FAKEVID0522"]);
  });

  it.each(["none-first", "found-first"] as const)(
    "keeps found dominant when contradictory reconciliations complete %s",
    async (completionOrder) => {
      const repository = new JobRepository(env.DB);
      await approve(repository);
      await claim(repository, "claim_conflicting_reconciliation");
      await moveToReconciliation(
        repository,
        "claim_conflicting_reconciliation",
        "fence_conflicting_reconciliation",
        { offset: 64, videoId: "FAKEVID0532", sessionState: "UNUSABLE" },
      );

      let releasePaused!: () => void;
      let signalPausedEntered!: () => void;
      const pausedGate = new Promise<void>((resolve) => { releasePaused = resolve; });
      const pausedEntered = new Promise<void>((resolve) => { signalPausedEntered = resolve; });
      const foundObservation = {
        kind: "found" as const,
        observation: {
          kind: "status" as const,
          uploadStatus: "processed" as const,
          processingStatus: "succeeded" as const,
          privacyStatus: "private" as const,
          videoId: "FAKEVID0532",
        },
      };
      const notFoundObservation = { kind: "not_found" as const };
      const pausedResult = completionOrder === "none-first"
        ? foundObservation
        : notFoundObservation;
      const immediateResult = completionOrder === "none-first"
        ? notFoundObservation
        : foundObservation;
      const pausedService = new E5YoutubeReconciliationService(repository, {
        async listVideo() {
          signalPausedEntered();
          await pausedGate;
          return pausedResult;
        },
      }, () => LATER);
      const immediateService = new E5YoutubeReconciliationService(repository, {
        async listVideo() { return immediateResult; },
      }, () => LATER);
      const request = {
        videoJobId: JOB_ID,
        targetAccountId: TARGET,
        approvedContentVersion: VERSION,
        actor: ACTOR,
      };

      const paused = pausedService.reconcile(request);
      await pausedEntered;
      const immediate = await immediateService.reconcile(request);
      if (completionOrder === "none-first") {
        expect(immediate).toMatchObject({
          state: "RECONCILIATION_REQUIRED", newSessionAllowed: false,
        });
      } else {
        expect(immediate).toMatchObject({ state: "PUBLISHED", newSessionAllowed: false });
      }
      releasePaused();
      expect(await paused).toMatchObject({ state: "PUBLISHED", newSessionAllowed: false });
      expect(await repository.getPublicationRecord({
        videoJobId: JOB_ID, destination: "youtube", targetAccountId: TARGET,
        approvedContentVersion: VERSION,
      })).toMatchObject({ status: "SUCCEEDED", result_ref: "FAKEVID0532" });
      expect(await repository.prepareYoutubeSideEffect({
        videoJobId: JOB_ID, targetAccountId: TARGET, approvedContentVersion: VERSION,
        claimMutationToken: "claim_conflicting_reconciliation",
        fenceToken: `fence_forbidden_${completionOrder}`,
        now: AFTER_STABILITY,
      })).toEqual({ allowed: false, attemptNo: null });
    },
  );

  it("keeps a crashed lookup unresolved despite repeated negative observations", async () => {
    const repository = new JobRepository(env.DB);
    await approve(repository);
    await claim(repository, "claim_stopped_lookup");
    await moveToReconciliation(repository, "claim_stopped_lookup", "fence_stopped_lookup", {
      offset: 64, videoId: "FAKEVID0533", sessionState: "UNUSABLE",
    });
    expect(await repository.beginYoutubeReconciliationObservation({
      videoJobId: JOB_ID, targetAccountId: TARGET, approvedContentVersion: VERSION,
      observationToken: "observation_worker_stopped", now: NOW, expiresAt: LATER,
    })).toBe(true);

    const notFound = new FakeYouTubeReconciliationClient({
      FAKEVID0533: { kind: "not_found" },
    });
    expect(await new E5YoutubeReconciliationService(
      repository, notFound, () => AFTER_LEASE,
    ).reconcile({ videoJobId: JOB_ID, targetAccountId: TARGET,
      approvedContentVersion: VERSION, actor: ACTOR })).toMatchObject({
      state: "RECONCILIATION_REQUIRED", newSessionAllowed: false,
    });
    expect(await env.DB.prepare(
      `SELECT result FROM youtube_reconciliation_observations
       WHERE observation_token = 'observation_worker_stopped'`,
    ).first()).toEqual({ result: "TIMED_OUT" });
    expect(await new E5YoutubeReconciliationService(
      repository, notFound, () => AFTER_STABILITY,
    ).reconcile({ videoJobId: JOB_ID, targetAccountId: TARGET,
      approvedContentVersion: VERSION, actor: ACTOR })).toMatchObject({
      state: "RECONCILIATION_REQUIRED", newSessionAllowed: false,
    });
  });

  it("does not treat an expired negative response as evidence that uncertainty ended", async () => {
    const repository = new JobRepository(env.DB);
    await approve(repository);
    await claim(repository, "claim_slow_none");
    await moveToReconciliation(repository, "claim_slow_none", "fence_slow_none", {
      offset: 64, videoId: "FAKEVID0536", sessionState: "UNUSABLE",
    });
    const notFound = new FakeYouTubeReconciliationClient({
      FAKEVID0536: { kind: "not_found" },
    });
    let firstClockCall = 0;
    const slowResult = await new E5YoutubeReconciliationService(
      repository,
      notFound,
      () => firstClockCall++ === 0 ? NOW : AFTER_OBSERVATION_TIMEOUT,
    ).reconcile({ videoJobId: JOB_ID, targetAccountId: TARGET,
      approvedContentVersion: VERSION, actor: ACTOR });
    expect(slowResult).toMatchObject({
      state: "RECONCILIATION_REQUIRED", newSessionAllowed: false,
    });
    expect(await env.DB.prepare(
      `SELECT result, completed_at FROM youtube_reconciliation_observations
       ORDER BY started_at LIMIT 1`,
    ).first()).toEqual({ result: "IN_FLIGHT", completed_at: null });

    // The first valid NONE completes immediately after the timeout. The stale t0 timestamp
    // must not make it look stable yet.
    expect(await new E5YoutubeReconciliationService(
      repository, notFound, () => IMMEDIATELY_AFTER_TIMEOUT,
    ).reconcile({ videoJobId: JOB_ID, targetAccountId: TARGET,
      approvedContentVersion: VERSION, actor: ACTOR })).toMatchObject({
      state: "RECONCILIATION_REQUIRED", newSessionAllowed: false,
    });
    expect(await repository.getPublicationRecord({
      videoJobId: JOB_ID, destination: "youtube", targetAccountId: TARGET,
      approvedContentVersion: VERSION,
    })).toMatchObject({ status: "RECONCILIATION_REQUIRED" });

    // Repeated negative observations do not resolve the earlier unknown response.
    expect(await new E5YoutubeReconciliationService(
      repository, notFound, () => AFTER_REAL_STABILITY,
    ).reconcile({ videoJobId: JOB_ID, targetAccountId: TARGET,
      approvedContentVersion: VERSION, actor: ACTOR })).toMatchObject({
      state: "RECONCILIATION_REQUIRED", newSessionAllowed: false,
    });
  });

  it.each(["unknown", "exception"] as const)(
    "expires and safely rechecks a reconciliation client %s outcome",
    async (outcome) => {
      const repository = new JobRepository(env.DB);
      await approve(repository);
      await claim(repository, `claim_${outcome}_lookup`);
      await moveToReconciliation(
        repository,
        `claim_${outcome}_lookup`,
        `fence_${outcome}_lookup`,
        { offset: 64, videoId: "FAKEVID0535", sessionState: "UNUSABLE" },
      );
      const uncertain = new E5YoutubeReconciliationService(repository, {
        async listVideo() {
          if (outcome === "exception") throw new Error("FAKE_LOOKUP_INTERRUPTED");
          return { kind: "unknown" } as const;
        },
      }, () => NOW).reconcile({ videoJobId: JOB_ID, targetAccountId: TARGET,
        approvedContentVersion: VERSION, actor: ACTOR });
      if (outcome === "exception") {
        await expect(uncertain).rejects.toThrow("FAKE_LOOKUP_INTERRUPTED");
      } else {
        expect(await uncertain).toMatchObject({
          state: "RECONCILIATION_REQUIRED", newSessionAllowed: false,
        });
      }

      const notFound = new FakeYouTubeReconciliationClient({
        FAKEVID0535: { kind: "not_found" },
      });
      expect(await new E5YoutubeReconciliationService(
        repository, notFound, () => AFTER_LEASE,
      ).reconcile({ videoJobId: JOB_ID, targetAccountId: TARGET,
        approvedContentVersion: VERSION, actor: ACTOR })).toMatchObject({
        state: "RECONCILIATION_REQUIRED", newSessionAllowed: false,
      });
      expect(await new E5YoutubeReconciliationService(
        repository, notFound, () => AFTER_STABILITY,
      ).reconcile({ videoJobId: JOB_ID, targetAccountId: TARGET,
        approvedContentVersion: VERSION, actor: ACTOR })).toMatchObject({
        state: "RECONCILIATION_REQUIRED", newSessionAllowed: false,
      });
    },
  );

  it.each(["before", "claimed", "prepared"] as const)(
    "preserves late FOUND evidence %s a newer attempt without overwriting it",
    async (phase) => {
      const repository = new JobRepository(env.DB);
      await approve(repository);
      await claim(repository, "claim_delayed_found");
      await moveToReconciliation(repository, "claim_delayed_found", "fence_delayed_found", {
        offset: 64, videoId: "FAKEVID0534", sessionState: "UNUSABLE",
      });
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      let time = NOW;
      const request = { videoJobId: JOB_ID, targetAccountId: TARGET,
        approvedContentVersion: VERSION, actor: ACTOR };
      const delayed = new E5YoutubeReconciliationService(repository, {
        async listVideo() {
          entered();
          await gate;
          return { kind: "found", observation: {
            kind: "status", uploadStatus: "processed", processingStatus: "succeeded",
            privacyStatus: "private", videoId: "FAKEVID0534",
          } };
        },
      }, () => time).reconcile(request);
      await started;
      for (const now of [AFTER_LEASE, AFTER_STABILITY]) {
        expect(await new E5YoutubeReconciliationService(repository,
          new FakeYouTubeReconciliationClient({ FAKEVID0534: { kind: "not_found" } }),
          () => now).reconcile(request)).toMatchObject({
          state: "RECONCILIATION_REQUIRED", newSessionAllowed: false,
        });
      }
      expect((await claim(repository, "claim_blocked_retry", AFTER_STABILITY)).claimed).toBe(false);
      expect(await repository.prepareYoutubeSideEffect({
        ...request, claimMutationToken: "claim_blocked_retry",
        fenceToken: "blocked_retry", now: AFTER_STABILITY,
      })).toEqual({ allowed: false, attemptNo: null });
      if (phase !== "before") {
        // Simulate an out-of-band future recovery/old-version database. Production APIs
        // above cannot create this state while the old observation remains unresolved.
        await env.DB.prepare(`UPDATE idempotency_records SET status = 'PENDING',
          retryable = 1, yt_video_id = NULL, yt_committed_offset = 0,
          yt_session_state = 'NONE' WHERE video_job_id = ?`).bind(JOB_ID).run();
        await claim(repository, "claim_newer", AFTER_STABILITY);
        if (phase === "prepared") {
          expect(await repository.prepareYoutubeSideEffect({
            ...request, claimMutationToken: "claim_newer",
            fenceToken: "fence_newer", now: AFTER_STABILITY,
          })).toEqual({ allowed: true, attemptNo: 2 });
        }
      }
      const before = await repository.getPublicationRecord({
        ...request, destination: "youtube",
      });
      time = AFTER_STABILITY;
      release();
      expect(await delayed).toMatchObject({
        state: phase === "before" ? "PUBLISHED" : "RECONCILIATION_REQUIRED",
        newSessionAllowed: false,
      });
      expect(await env.DB.prepare(`SELECT result FROM youtube_reconciliation_observations
        WHERE started_at = ?`).bind(NOW).first()).toEqual({ result: "FOUND" });
      if (phase !== "before") {
        expect(await repository.getPublicationRecord({
          ...request, destination: "youtube",
        })).toEqual(before);
        expect(await repository.prepareYoutubeSideEffect({
          ...request, claimMutationToken: "claim_newer",
          fenceToken: "fence_after_found", now: AFTER_STABILITY,
        })).toEqual({ allowed: false, attemptNo: null });
      }
    },
  );

  it("allows a new attempt only after videos.list confirms absence and the old session is unusable", async () => {
    const repository = new JobRepository(env.DB);
    await approve(repository);
    await claim(repository, "claim_missing");
    await moveToReconciliation(repository, "claim_missing", "fence_missing", {
      offset: 64, videoId: "FAKEVID0523", sessionState: "UNUSABLE",
    });
    const fake = new FakeYouTubeReconciliationClient({
      FAKEVID0523: { kind: "not_found" },
    });
    const service = new E5YoutubeReconciliationService(repository, fake, () => LATER);

    const results = await Promise.all([
      service.reconcile({ videoJobId: JOB_ID, targetAccountId: TARGET,
        approvedContentVersion: VERSION, actor: ACTOR }),
      service.reconcile({ videoJobId: JOB_ID, targetAccountId: TARGET,
        approvedContentVersion: VERSION, actor: ACTOR }),
    ]);
    expect(results).toEqual([
      expect.objectContaining({ state: "PENDING", newSessionAllowed: true }),
      expect.objectContaining({ state: "PENDING", newSessionAllowed: true }),
    ]);
    expect(await new E5YoutubeReconciliationService(
      repository, fake, () => AFTER_STABILITY,
    ).reconcile({ videoJobId: JOB_ID, targetAccountId: TARGET,
      approvedContentVersion: VERSION, actor: ACTOR })).toMatchObject({
      state: "PENDING", newSessionAllowed: true,
    });
    await claim(repository, "claim_after_reconcile", AFTER_STABILITY);
    expect(await repository.prepareYoutubeSideEffect({
      videoJobId: JOB_ID, targetAccountId: TARGET, approvedContentVersion: VERSION,
      claimMutationToken: "claim_after_reconcile", fenceToken: "fence_after_reconcile",
      now: AFTER_STABILITY,
    })).toEqual({ allowed: true, attemptNo: 2 });
  });

  it("does not let stale cleanup release a newer claim", async () => {
    const repository = new JobRepository(env.DB);
    await approve(repository);
    await claim(repository, "claim_stale");
    // Simulate the first cleanup having made the retryable row available while its caller is paused.
    await env.DB.prepare(
      `UPDATE idempotency_records
       SET status = 'PENDING', retryable = 1
       WHERE video_job_id = ? AND destination = 'youtube'`,
    ).bind(JOB_ID).run();
    await claim(repository, "claim_new", LATER);

    await expect(repository.releaseYoutubePublicationClaim({
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      actor: ACTOR,
      now: LATER,
      error: { code: "R2_RANGE_READ_FAILED", retryable: true },
      claimMutationToken: "claim_stale",
    })).rejects.toBeInstanceOf(ConcurrentUpdateError);
    await expect(repository.recordPublicationResult({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      result: "FAILED",
      actor: ACTOR,
      now: LATER,
      error: { code: "YOUTUBE_PROCESSING_FAILED", retryable: false },
      expectedClaimMutationToken: "claim_stale",
    })).rejects.toBeInstanceOf(ConcurrentUpdateError);
    expect(await repository.getPublicationRecord({
      videoJobId: JOB_ID, destination: "youtube", targetAccountId: TARGET,
      approvedContentVersion: VERSION,
    })).toMatchObject({ status: "CLAIMED", attempt_no: 2 });
  });

  it("preserves a newer success when an older failed execution resumes cleanup", async () => {
    const repository = new JobRepository(env.DB);
    await approve(repository);
    await claim(repository, "claim_old_failure");
    await env.DB.prepare(
      `UPDATE idempotency_records
       SET status = 'PENDING', retryable = 1
       WHERE video_job_id = ? AND destination = 'youtube'`,
    ).bind(JOB_ID).run();
    await claim(repository, "claim_new_success", LATER);
    await repository.recordPublicationResult({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      result: "SUCCEEDED",
      resultRef: "FAKEVID0528",
      actor: ACTOR,
      now: LATER,
      expectedClaimMutationToken: "claim_new_success",
    });

    await expect(repository.releaseYoutubePublicationClaim({
      videoJobId: JOB_ID,
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      actor: ACTOR,
      now: AFTER_LEASE,
      error: { code: "R2_RANGE_READ_FAILED", retryable: true },
      claimMutationToken: "claim_old_failure",
    })).rejects.toThrow();
    await expect(repository.recordPublicationResult({
      videoJobId: JOB_ID,
      destination: "youtube",
      targetAccountId: TARGET,
      approvedContentVersion: VERSION,
      result: "FAILED",
      actor: ACTOR,
      now: AFTER_LEASE,
      error: { code: "YOUTUBE_PROCESSING_FAILED", retryable: false },
      expectedClaimMutationToken: "claim_old_failure",
    })).rejects.toThrow();
    expect(await repository.getPublicationRecord({
      videoJobId: JOB_ID, destination: "youtube", targetAccountId: TARGET,
      approvedContentVersion: VERSION,
    })).toMatchObject({
      status: "SUCCEEDED", attempt_no: 2,
      result_ref: "FAKEVID0528", yt_video_id: "FAKEVID0528",
    });
    expect(await repository.getVideoJob(JOB_ID)).toMatchObject({
      state: "PUBLISHED", youtube_status: "PUBLISHED",
    });
  });

  it("stores no resumable session URI field or value in the operational tables", async () => {
    const columns = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('idempotency_records')
       UNION ALL SELECT name FROM pragma_table_info('youtube_publication_attempts')`,
    ).all<{ name: string }>();
    expect(columns.results.map((row) => row.name).join(" ")).not.toMatch(/uri|url|session_cipher/i);
  });
});
