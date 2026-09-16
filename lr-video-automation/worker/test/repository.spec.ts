import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { PublicationTarget } from "../src/domain";
import {
  InvalidTransitionError,
  JobIdentityCollisionError,
  MutationCollisionError,
  PublicationClaimBlockedError,
} from "../src/errors";
import { flushMirrorOutbox } from "../src/mirror";
import { JobRepository } from "../src/repository";

const NOW = "2026-08-16T00:00:00.000Z";
const ACTOR = { type: "system" as const, id: "system_test" };
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const jobId = (suffix = 1) => uuid(suffix);
const submissionId = (suffix = 1) => uuid(10_000 + suffix);

async function clearDatabase(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM dlq_messages"),
    env.DB.prepare("DELETE FROM queue_deliveries"),
    env.DB.prepare("DELETE FROM mirror_outbox"),
    env.DB.prepare("DELETE FROM audit_logs"),
    env.DB.prepare("DELETE FROM idempotency_records"),
    env.DB.prepare("DELETE FROM applied_mutations"),
    env.DB.prepare("DELETE FROM video_jobs"),
  ]);
}

async function createJob(repository: JobRepository, suffix = 1) {
  return repository.createVideoJob({
    videoJobId: jobId(suffix),
    submissionId: submissionId(suffix),
    branchId: "branch_dummy",
    studioId: "studio_dummy",
    classId: "class_dummy",
    teacherId: "teacher_dummy",
    actor: ACTOR,
    now: NOW,
  });
}

async function advanceToApproved(
  repository: JobRepository,
  suffix = 1,
  publicationTargets: readonly PublicationTarget[] = [
    { destination: "youtube" as const, targetAccountId: "youtube_account_a" },
    { destination: "instagram" as const, targetAccountId: "instagram_account_a" },
  ],
) {
  await createJob(repository, suffix);
  const transitions = [
    ["RECEIVED", "VALIDATING"],
    ["VALIDATING", "PROCESSING"],
    ["PROCESSING", "WAITING_APPROVAL"],
  ] as const;
  for (const [expectedState, nextState] of transitions) {
    await repository.transitionJob({
      videoJobId: jobId(suffix),
      expectedState,
      nextState,
      actor: ACTOR,
      now: NOW,
    });
  }
  return repository.transitionJob({
    videoJobId: jobId(suffix),
    expectedState: "WAITING_APPROVAL",
    nextState: "APPROVED",
    approvedContentVersion: "v1",
    publicationTargets,
    actor: ACTOR,
    now: NOW,
  });
}

describe("JobRepository", () => {
  beforeEach(clearDatabase);

  it("rejects malformed UUIDs and email-shaped internal actor IDs", async () => {
    const repository = new JobRepository(env.DB);
    await expect(
      repository.createVideoJob({
        videoJobId: "not-a-uuid",
        submissionId: submissionId(),
        branchId: "branch_dummy",
        studioId: "studio_dummy",
        classId: "class_dummy",
        teacherId: "teacher_dummy",
        actor: { type: "system", id: "person@example.invalid" },
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("creates a job with an audit record and one-way mirror event", async () => {
    const repository = new JobRepository(env.DB);
    const job = await createJob(repository);

    expect(job.state).toBe("RECEIVED");
    expect(job.row_version).toBe(0);
    const audit = await env.DB.prepare("SELECT action FROM audit_logs").first<{ action: string }>();
    const mirror = await env.DB
      .prepare("SELECT status FROM mirror_outbox")
      .first<{ status: string }>();
    expect(audit?.action).toBe("job.created");
    expect(mirror?.status).toBe("PENDING");

    await createJob(repository);
    const counts = await env.DB
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM video_jobs) AS jobs,
          (SELECT COUNT(*) FROM audit_logs) AS audits,
          (SELECT COUNT(*) FROM mirror_outbox) AS mirrors`,
      )
      .first<{ jobs: number; audits: number; mirrors: number }>();
    expect(counts).toEqual({ jobs: 1, audits: 1, mirrors: 1 });
  });

  it("rejects the same video job ID with different immutable input without ghost rows", async () => {
    const repository = new JobRepository(env.DB);
    await createJob(repository);
    const before = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM video_jobs) jobs,
           (SELECT COUNT(*) FROM audit_logs) audits,
           (SELECT COUNT(*) FROM mirror_outbox) mirrors,
           (SELECT COUNT(*) FROM applied_mutations) mutations`,
      )
      .first<{ jobs: number; audits: number; mirrors: number; mutations: number }>();
    const base = {
      videoJobId: jobId(),
      submissionId: submissionId(),
      branchId: "branch_dummy",
      studioId: "studio_dummy",
      classId: "class_dummy",
      teacherId: "teacher_dummy",
      actor: ACTOR,
      now: NOW,
    };
    for (const changed of [
      { submissionId: submissionId(999) },
      { branchId: "branch_other" },
      { studioId: "studio_other" },
      { classId: "class_other" },
      { teacherId: "teacher_other" },
    ]) {
      await expect(
        repository.createVideoJob({ ...base, ...changed }),
      ).rejects.toBeInstanceOf(JobIdentityCollisionError);
    }
    expect(await repository.getVideoJob(jobId())).toMatchObject({
      submission_id: submissionId(),
      branch_id: "branch_dummy",
      studio_id: "studio_dummy",
      class_id: "class_dummy",
      teacher_id: "teacher_dummy",
    });
    const after = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM video_jobs) jobs,
           (SELECT COUNT(*) FROM audit_logs) audits,
           (SELECT COUNT(*) FROM mirror_outbox) mirrors,
           (SELECT COUNT(*) FROM applied_mutations) mutations`,
      )
      .first<{ jobs: number; audits: number; mirrors: number; mutations: number }>();
    expect(after).toEqual(before);
  });

  it("serializes concurrent creates with the same ID and different immutable input", async () => {
    const repository = new JobRepository(env.DB);
    for (let index = 0; index < 20; index += 1) {
      const suffix = 100 + index;
      const create = (variant: "a" | "b") => repository.createVideoJob({
        videoJobId: jobId(suffix),
        submissionId: submissionId(1_000 + index * 2 + (variant === "a" ? 0 : 1)),
        branchId: `branch_${variant}`,
        studioId: "studio_dummy",
        classId: "class_dummy",
        teacherId: "teacher_dummy",
        actor: ACTOR,
        now: NOW,
      });
      const results = await Promise.allSettled([create("a"), create("b")]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: expect.any(JobIdentityCollisionError),
      });
    }
    const counts = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM video_jobs) jobs,
           (SELECT COUNT(*) FROM audit_logs WHERE action = 'job.created') audits,
           (SELECT COUNT(*) FROM mirror_outbox) mirrors`,
      )
      .first<{ jobs: number; audits: number; mirrors: number }>();
    expect(counts).toEqual({ jobs: 20, audits: 20, mirrors: 20 });
  });

  it("rejects an invalid state transition without changing the job", async () => {
    const repository = new JobRepository(env.DB);
    await createJob(repository);

    await expect(
      repository.transitionJob({
        videoJobId: jobId(),
        expectedState: "RECEIVED",
        nextState: "PUBLISHED",
        actor: ACTOR,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    for (const nextState of ["PARTIALLY_PUBLISHED", "FAILED"] as const) {
      await expect(
        repository.transitionJob({
          videoJobId: jobId(),
          expectedState: "PUBLISHING",
          nextState,
          actor: ACTOR,
          now: NOW,
        }),
      ).rejects.toBeInstanceOf(InvalidTransitionError);
    }
    expect((await repository.getVideoJob(jobId()))?.state).toBe("RECEIVED");
  });

  it("rejects unsafe approved content version identifiers without writing partial state", async () => {
    const repository = new JobRepository(env.DB);
    await createJob(repository);
    for (const [expectedState, nextState] of [
      ["RECEIVED", "VALIDATING"],
      ["VALIDATING", "PROCESSING"],
      ["PROCESSING", "WAITING_APPROVAL"],
    ] as const) {
      await repository.transitionJob({
        videoJobId: jobId(),
        expectedState,
        nextState,
        actor: ACTOR,
        now: NOW,
      });
    }
    const before = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM audit_logs) audits,
           (SELECT COUNT(*) FROM mirror_outbox) mirrors,
           (SELECT COUNT(*) FROM applied_mutations) mutations,
           (SELECT COUNT(*) FROM idempotency_records) targets`,
      )
      .first<{ audits: number; mirrors: number; mutations: number; targets: number }>();
    for (const [index, approvedContentVersion] of [
      "person@example.invalid",
      "bad version",
      "bad\nversion",
      "../version",
      "<version>",
    ].entries()) {
      await expect(
        repository.transitionJob({
          videoJobId: jobId(),
          expectedState: "WAITING_APPROVAL",
          nextState: "APPROVED",
          approvedContentVersion,
          publicationTargets: [
            { destination: "youtube", targetAccountId: "youtube_account_a" },
          ],
          actor: ACTOR,
          now: NOW,
          mutationToken: `unsafe_version_${index}`,
        }),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(await repository.getVideoJob(jobId())).toMatchObject({
      state: "WAITING_APPROVAL",
      approved_content_version: null,
    });
    const after = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM audit_logs) audits,
           (SELECT COUNT(*) FROM mirror_outbox) mirrors,
           (SELECT COUNT(*) FROM applied_mutations) mutations,
           (SELECT COUNT(*) FROM idempotency_records) targets`,
      )
      .first<{ audits: number; mirrors: number; mutations: number; targets: number }>();
    expect(after).toEqual(before);
  });

  it("rejects a mutation token reused for different transition input without ghost rows", async () => {
    const repository = new JobRepository(env.DB);
    await createJob(repository);
    await repository.transitionJob({
      videoJobId: jobId(),
      expectedState: "RECEIVED",
      nextState: "VALIDATING",
      actor: ACTOR,
      now: NOW,
      mutationToken: "shared_transition_token",
    });
    const before = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM audit_logs) audits,
           (SELECT COUNT(*) FROM mirror_outbox) mirrors,
           (SELECT COUNT(*) FROM applied_mutations) mutations`,
      )
      .first<{ audits: number; mirrors: number; mutations: number }>();

    await expect(
      repository.transitionJob({
        videoJobId: jobId(),
        expectedState: "VALIDATING",
        nextState: "PROCESSING",
        actor: ACTOR,
        now: NOW,
        mutationToken: "shared_transition_token",
      }),
    ).rejects.toBeInstanceOf(MutationCollisionError);
    expect(await repository.getVideoJob(jobId())).toMatchObject({
      state: "VALIDATING",
      row_version: 1,
    });
    const after = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM audit_logs) audits,
           (SELECT COUNT(*) FROM mirror_outbox) mirrors,
           (SELECT COUNT(*) FROM applied_mutations) mutations`,
      )
      .first<{ audits: number; mirrors: number; mutations: number }>();
    expect(after).toEqual(before);
  });

  it("rejects a mutation token reused by another operation without ghost rows", async () => {
    const repository = new JobRepository(env.DB);
    await advanceToApproved(repository);
    await repository.claimPublication({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      actor: ACTOR,
      now: NOW,
      mutationToken: "shared_cross_operation_token",
    });
    const before = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM audit_logs) audits,
           (SELECT COUNT(*) FROM mirror_outbox) mirrors,
           (SELECT COUNT(*) FROM applied_mutations) mutations,
           (SELECT COUNT(*) FROM idempotency_records WHERE status <> 'PENDING') touched_targets`,
      )
      .first<{
        audits: number;
        mirrors: number;
        mutations: number;
        touched_targets: number;
      }>();

    await expect(
      repository.recordPublicationResult({
        videoJobId: jobId(),
        destination: "youtube",
        targetAccountId: "youtube_account_a",
        approvedContentVersion: "v1",
        result: "SUCCEEDED",
        resultRef: "FAKEVID0001",
        actor: ACTOR,
        now: NOW,
        mutationToken: "shared_cross_operation_token",
      }),
    ).rejects.toBeInstanceOf(MutationCollisionError);
    expect(await repository.getVideoJob(jobId())).toMatchObject({
      state: "PUBLISHING",
      youtube_status: "PUBLISHING",
    });
    const target = await env.DB
      .prepare(
        `SELECT status FROM idempotency_records
         WHERE destination = 'youtube' AND target_account_id = 'youtube_account_a'`,
      )
      .first<{ status: string }>();
    expect(target?.status).toBe("CLAIMED");
    const after = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM audit_logs) audits,
           (SELECT COUNT(*) FROM mirror_outbox) mirrors,
           (SELECT COUNT(*) FROM applied_mutations) mutations,
           (SELECT COUNT(*) FROM idempotency_records WHERE status <> 'PENDING') touched_targets`,
      )
      .first<{
        audits: number;
        mirrors: number;
        mutations: number;
        touched_targets: number;
      }>();
    expect(after).toEqual(before);
  });

  it("claims a publication and its idempotency record atomically only once", async () => {
    const repository = new JobRepository(env.DB);
    await advanceToApproved(repository);

    const first = await repository.claimPublication({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      actor: ACTOR,
      now: NOW,
    });
    const second = await repository.claimPublication({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      actor: ACTOR,
      now: NOW,
    });

    expect(first.claimed).toBe(true);
    expect(second).toEqual({ claimed: false, idempotencyKey: first.idempotencyKey });
    expect((await repository.getVideoJob(jobId()))?.state).toBe("PUBLISHING");
    const ledger = await env.DB
      .prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE status = 'CLAIMED'")
      .first<{ count: number }>();
    expect(ledger?.count).toBe(1);
  });

  it("prevents two concurrent workers from claiming the same publication twice", async () => {
    const repository = new JobRepository(env.DB);
    await advanceToApproved(repository);
    const claim = () =>
      repository.claimPublication({
        videoJobId: jobId(),
        destination: "youtube",
        targetAccountId: "youtube_account_a",
        approvedContentVersion: "v1",
        actor: ACTOR,
        now: NOW,
      });

    const results = await Promise.all([claim(), claim()]);
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    const ledger = await env.DB
      .prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE status = 'CLAIMED'")
      .first<{ count: number }>();
    expect(ledger?.count).toBe(1);
  });

  it("allows the approved version to be claimed independently for two destinations", async () => {
    const repository = new JobRepository(env.DB);
    await advanceToApproved(repository);

    const youtube = await repository.claimPublication({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      actor: ACTOR,
      now: NOW,
    });
    const instagram = await repository.claimPublication({
      videoJobId: jobId(),
      destination: "instagram",
      targetAccountId: "instagram_account_a",
      approvedContentVersion: "v1",
      actor: ACTOR,
      now: NOW,
    });

    expect(youtube.claimed).toBe(true);
    expect(instagram.claimed).toBe(true);
    const job = await repository.getVideoJob(jobId());
    expect(job?.youtube_status).toBe("PUBLISHING");
    expect(job?.instagram_status).toBe("PUBLISHING");
  });

  it("treats two accounts on the same medium as distinct publication targets", async () => {
    const repository = new JobRepository(env.DB);
    await advanceToApproved(repository, 1, [
      { destination: "youtube", targetAccountId: "youtube_account_a" },
      { destination: "youtube", targetAccountId: "youtube_account_b" },
    ]);

    const accountA = await repository.claimPublication({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      actor: ACTOR,
      now: NOW,
    });
    const accountB = await repository.claimPublication({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_b",
      approvedContentVersion: "v1",
      actor: ACTOR,
      now: NOW,
    });
    const duplicateA = await repository.claimPublication({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      actor: ACTOR,
      now: NOW,
    });

    expect(accountA.claimed).toBe(true);
    expect(accountB.claimed).toBe(true);
    expect(accountA.idempotencyKey).not.toBe(accountB.idempotencyKey);
    expect(duplicateA.claimed).toBe(false);
    const rows = await env.DB
      .prepare(
        `SELECT target_account_id, status FROM idempotency_records
         ORDER BY target_account_id`,
      )
      .all<{ target_account_id: string; status: string }>();
    expect(rows.results).toEqual([
      { target_account_id: "youtube_account_a", status: "CLAIMED" },
      { target_account_id: "youtube_account_b", status: "CLAIMED" },
    ]);
  });

  it("binds a no-op claim token so it cannot be reused for another target", async () => {
    const repository = new JobRepository(env.DB);
    await advanceToApproved(repository, 1, [
      { destination: "youtube", targetAccountId: "youtube_account_a" },
      { destination: "youtube", targetAccountId: "youtube_account_b" },
    ]);
    await repository.claimPublication({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      actor: ACTOR,
      now: NOW,
      mutationToken: "initial_claim_token",
    });
    const noOp = await repository.claimPublication({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      actor: ACTOR,
      now: NOW,
      mutationToken: "bound_noop_claim_token",
    });
    expect(noOp.claimed).toBe(false);
    const before = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM audit_logs) audits,
           (SELECT COUNT(*) FROM mirror_outbox) mirrors,
           (SELECT COUNT(*) FROM applied_mutations) mutations`,
      )
      .first<{ audits: number; mirrors: number; mutations: number }>();

    await expect(
      repository.claimPublication({
        videoJobId: jobId(),
        destination: "youtube",
        targetAccountId: "youtube_account_b",
        approvedContentVersion: "v1",
        actor: ACTOR,
        now: NOW,
        mutationToken: "bound_noop_claim_token",
      }),
    ).rejects.toBeInstanceOf(MutationCollisionError);
    const accountB = await env.DB
      .prepare(
        `SELECT status FROM idempotency_records
         WHERE destination = 'youtube' AND target_account_id = 'youtube_account_b'`,
      )
      .first<{ status: string }>();
    expect(accountB?.status).toBe("PENDING");
    const after = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM audit_logs) audits,
           (SELECT COUNT(*) FROM mirror_outbox) mirrors,
           (SELECT COUNT(*) FROM applied_mutations) mutations`,
      )
      .first<{ audits: number; mirrors: number; mutations: number }>();
    expect(after).toEqual(before);
  });

  it("blocks another YouTube account until an unknown outcome is reconciled", async () => {
    const repository = new JobRepository(env.DB);
    await advanceToApproved(repository, 1, [
      { destination: "youtube", targetAccountId: "youtube_account_a" },
      { destination: "youtube", targetAccountId: "youtube_account_b" },
    ]);
    await repository.claimPublication({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      actor: ACTOR,
      now: NOW,
    });
    await repository.recordPublicationResult({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      result: "OUTCOME_UNKNOWN",
      actor: ACTOR,
      now: NOW,
    });

    const claimAccountB = () =>
      repository.claimPublication({
        videoJobId: jobId(),
        destination: "youtube" as const,
        targetAccountId: "youtube_account_b",
        approvedContentVersion: "v1",
        actor: ACTOR,
        now: NOW,
      });
    await expect(claimAccountB()).rejects.toBeInstanceOf(PublicationClaimBlockedError);

    await repository.recordPublicationResult({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      result: "RECONCILIATION_REQUIRED",
      actor: ACTOR,
      now: NOW,
    });
    await expect(claimAccountB()).rejects.toBeInstanceOf(PublicationClaimBlockedError);

    await repository.recordPublicationResult({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      result: "SUCCEEDED",
      resultRef: "FAKEVID0001",
      actor: ACTOR,
      now: NOW,
    });
    await expect(claimAccountB()).resolves.toMatchObject({ claimed: true });
  });

  it("serializes a concurrent unknown outcome and a new YouTube account claim", async () => {
    const repository = new JobRepository(env.DB);
    await advanceToApproved(repository, 1, [
      { destination: "youtube", targetAccountId: "youtube_account_a" },
      { destination: "youtube", targetAccountId: "youtube_account_b" },
    ]);
    await repository.claimPublication({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      actor: ACTOR,
      now: NOW,
    });

    const before = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM audit_logs) audits,
           (SELECT COUNT(*) FROM mirror_outbox) mirrors,
           (SELECT COUNT(*) FROM applied_mutations) mutations`,
      )
      .first<{ audits: number; mirrors: number; mutations: number }>();
    const unknown = () =>
      repository.recordPublicationResult({
        videoJobId: jobId(),
        destination: "youtube",
        targetAccountId: "youtube_account_a",
        approvedContentVersion: "v1",
        result: "OUTCOME_UNKNOWN",
        actor: ACTOR,
        now: NOW,
        mutationToken: "race_unknown_a",
      });
    const claimAccountB = () =>
      repository.claimPublication({
        videoJobId: jobId(),
        destination: "youtube",
        targetAccountId: "youtube_account_b",
        approvedContentVersion: "v1",
        actor: ACTOR,
        now: NOW,
        mutationToken: "race_claim_b",
      });
    const [unknownResult, accountBClaim] = await Promise.allSettled([
      unknown(),
      claimAccountB(),
    ]);
    expect([unknownResult, accountBClaim].some((result) => result.status === "fulfilled"))
      .toBe(true);
    if (unknownResult.status === "rejected") {
      await unknown();
    } else {
      expect(accountBClaim.status).toBe("rejected");
      if (accountBClaim.status === "rejected") {
        expect(accountBClaim.reason).toBeInstanceOf(PublicationClaimBlockedError);
      }
    }
    const rows = await env.DB
      .prepare(
        `SELECT target_account_id, status FROM idempotency_records
         WHERE destination = 'youtube' ORDER BY target_account_id`,
      )
      .all<{ target_account_id: string; status: string }>();
    expect(rows.results[0]).toEqual({
      target_account_id: "youtube_account_a",
      status: "OUTCOME_UNKNOWN",
    });
    expect(rows.results[1]).toEqual({
      target_account_id: "youtube_account_b",
      status: accountBClaim.status === "fulfilled" ? "CLAIMED" : "PENDING",
    });
    expect((await repository.getVideoJob(jobId()))?.youtube_status).toBe("OUTCOME_UNKNOWN");
    const after = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM audit_logs) audits,
           (SELECT COUNT(*) FROM mirror_outbox) mirrors,
           (SELECT COUNT(*) FROM applied_mutations) mutations`,
      )
      .first<{ audits: number; mirrors: number; mutations: number }>();
    const successfulMutations = accountBClaim.status === "fulfilled" ? 2 : 1;
    expect(after).toEqual({
      audits: (before?.audits ?? 0) + successfulMutations,
      mirrors: (before?.mirrors ?? 0) + successfulMutations,
      mutations: (before?.mutations ?? 0) + successfulMutations,
    });
  });

  it("derives PUBLISHED and retention only after every configured target succeeds", async () => {
    const repository = new JobRepository(env.DB, { retentionDays: 30 });
    await advanceToApproved(repository, 1, [
      { destination: "youtube", targetAccountId: "youtube_account_a" },
      { destination: "youtube", targetAccountId: "youtube_account_b" },
      { destination: "instagram", targetAccountId: "instagram_account_a" },
    ]);
    for (const target of [
      { destination: "youtube" as const, targetAccountId: "youtube_account_a" },
      { destination: "youtube" as const, targetAccountId: "youtube_account_b" },
      { destination: "instagram" as const, targetAccountId: "instagram_account_a" },
    ]) {
      await repository.claimPublication({
        videoJobId: jobId(),
        ...target,
        approvedContentVersion: "v1",
        actor: ACTOR,
        now: NOW,
      });
    }

    await expect(
      repository.transitionJob({
        videoJobId: jobId(),
        expectedState: "PUBLISHING",
        nextState: "PUBLISHED",
        actor: ACTOR,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);

    await repository.recordPublicationResult({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      result: "SUCCEEDED",
      resultRef: "FAKEVID0001",
      actor: ACTOR,
      now: NOW,
      mutationToken: "result_youtube_a",
    });
    await repository.recordPublicationResult({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_b",
      approvedContentVersion: "v1",
      result: "OUTCOME_UNKNOWN",
      actor: ACTOR,
      now: NOW,
      mutationToken: "result_youtube_b_unknown",
    });
    for (const result of ["SUCCEEDED", "FAILED"] as const) {
      await expect(
        repository.recordPublicationResult({
          videoJobId: jobId(),
          destination: "youtube",
          targetAccountId: "youtube_account_b",
          approvedContentVersion: "v1",
          result,
          ...(result === "SUCCEEDED" ? { resultRef: "FAKEVID0002" } : {}),
          actor: ACTOR,
          now: NOW,
        }),
      ).rejects.toBeInstanceOf(InvalidTransitionError);
    }
    await repository.recordPublicationResult({
      videoJobId: jobId(),
      destination: "instagram",
      targetAccountId: "instagram_account_a",
      approvedContentVersion: "v1",
      result: "SUCCEEDED",
      actor: ACTOR,
      now: NOW,
      mutationToken: "result_instagram_a",
    });
    let pending = await repository.getVideoJob(jobId());
    expect(pending).toMatchObject({
      state: "PUBLISHING",
      youtube_status: "OUTCOME_UNKNOWN",
      instagram_status: "PUBLISHED",
      tiktok_status: "SKIPPED",
      retention_state: "HOLD",
      retention_start_at: null,
      delete_due_at: null,
    });

    await repository.recordPublicationResult({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_b",
      approvedContentVersion: "v1",
      result: "RECONCILIATION_REQUIRED",
      actor: ACTOR,
      now: NOW,
      mutationToken: "result_youtube_b_reconcile",
    });
    pending = await repository.getVideoJob(jobId());
    expect(pending?.state).toBe("PUBLISHING");
    expect(pending?.retention_state).toBe("HOLD");

    const completed = await repository.recordPublicationResult({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_b",
      approvedContentVersion: "v1",
      result: "SUCCEEDED",
      resultRef: "FAKEVID0002",
      actor: ACTOR,
      now: NOW,
      mutationToken: "result_youtube_b_reconciled",
    });
    expect(completed).toMatchObject({
      state: "PUBLISHED",
      youtube_status: "PUBLISHED",
      instagram_status: "PUBLISHED",
      retention_state: "RETAINED",
      retention_start_at: NOW,
      delete_due_at: "2026-09-15T00:00:00.000Z",
    });

    const beforeDuplicate = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM audit_logs WHERE action = 'publication.result.recorded') audits,
           (SELECT COUNT(*) FROM mirror_outbox) mirrors`,
      )
      .first<{ audits: number; mirrors: number }>();
    await repository.recordPublicationResult({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_b",
      approvedContentVersion: "v1",
      result: "SUCCEEDED",
      resultRef: "FAKEVID0002",
      actor: ACTOR,
      now: "2026-08-17T00:00:00.000Z",
      mutationToken: "duplicate_result_youtube_b",
    });
    const afterDuplicate = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM audit_logs WHERE action = 'publication.result.recorded') audits,
           (SELECT COUNT(*) FROM mirror_outbox) mirrors`,
      )
      .first<{ audits: number; mirrors: number }>();
    expect(afterDuplicate).toEqual(beforeDuplicate);
    expect((await repository.getVideoJob(jobId()))?.retention_start_at).toBe(NOW);
  });

  it("does not complete while a configured publication target is still pending", async () => {
    const repository = new JobRepository(env.DB);
    await advanceToApproved(repository);
    await repository.claimPublication({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      actor: ACTOR,
      now: NOW,
    });
    const job = await repository.recordPublicationResult({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      result: "SUCCEEDED",
      resultRef: "FAKEVID0001",
      actor: ACTOR,
      now: NOW,
    });
    expect(job).toMatchObject({
      state: "PUBLISHING",
      youtube_status: "PUBLISHED",
      instagram_status: "PENDING",
      retention_state: "HOLD",
      retention_start_at: null,
    });
    const pending = await env.DB
      .prepare(
        `SELECT status FROM idempotency_records
         WHERE destination = 'instagram' AND target_account_id = 'instagram_account_a'`,
      )
      .first<{ status: string }>();
    expect(pending?.status).toBe("PENDING");
  });

  it("binds a no-op publication result token so it cannot be reused for another result", async () => {
    const repository = new JobRepository(env.DB);
    await advanceToApproved(repository, 1, [
      { destination: "youtube", targetAccountId: "youtube_account_a" },
    ]);
    await repository.claimPublication({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      actor: ACTOR,
      now: NOW,
      mutationToken: "claim_for_noop_result",
    });
    await repository.recordPublicationResult({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      result: "SUCCEEDED",
      resultRef: "FAKEVID0001",
      actor: ACTOR,
      now: NOW,
      mutationToken: "initial_result_token",
    });
    await repository.recordPublicationResult({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      result: "SUCCEEDED",
      resultRef: "FAKEVID0001",
      actor: ACTOR,
      now: NOW,
      mutationToken: "bound_noop_result_token",
    });
    const before = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM audit_logs) audits,
           (SELECT COUNT(*) FROM mirror_outbox) mirrors,
           (SELECT COUNT(*) FROM applied_mutations) mutations`,
      )
      .first<{ audits: number; mirrors: number; mutations: number }>();

    await expect(
      repository.recordPublicationResult({
        videoJobId: jobId(),
        destination: "youtube",
        targetAccountId: "youtube_account_a",
        approvedContentVersion: "v1",
        result: "FAILED",
        actor: ACTOR,
        now: NOW,
        mutationToken: "bound_noop_result_token",
      }),
    ).rejects.toBeInstanceOf(MutationCollisionError);
    const target = await env.DB
      .prepare(
        `SELECT status FROM idempotency_records
         WHERE destination = 'youtube' AND target_account_id = 'youtube_account_a'`,
      )
      .first<{ status: string }>();
    expect(target?.status).toBe("SUCCEEDED");
    const after = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM audit_logs) audits,
           (SELECT COUNT(*) FROM mirror_outbox) mirrors,
           (SELECT COUNT(*) FROM applied_mutations) mutations`,
      )
      .first<{ audits: number; mirrors: number; mutations: number }>();
    expect(after).toEqual(before);
  });

  it("keeps a partial aggregate when another medium is claimed after YouTube failed", async () => {
    const repository = new JobRepository(env.DB);
    await advanceToApproved(repository);
    await repository.claimPublication({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      actor: ACTOR,
      now: NOW,
    });
    const partial = await repository.recordPublicationResult({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      result: "FAILED",
      actor: ACTOR,
      now: NOW,
    });
    expect(partial).toMatchObject({
      state: "PARTIALLY_PUBLISHED",
      youtube_status: "FAILED",
      instagram_status: "PENDING",
    });
    for (const nextState of ["PUBLISHING", "FAILED"] as const) {
      await expect(
        repository.transitionJob({
          videoJobId: jobId(),
          expectedState: "PARTIALLY_PUBLISHED",
          nextState,
          actor: ACTOR,
          now: NOW,
        }),
      ).rejects.toBeInstanceOf(InvalidTransitionError);
    }

    const instagram = await repository.claimPublication({
      videoJobId: jobId(),
      destination: "instagram",
      targetAccountId: "instagram_account_a",
      approvedContentVersion: "v1",
      actor: ACTOR,
      now: NOW,
    });
    expect(instagram.claimed).toBe(true);
    expect(await repository.getVideoJob(jobId())).toMatchObject({
      state: "PARTIALLY_PUBLISHED",
      youtube_status: "FAILED",
      instagram_status: "PUBLISHING",
      retention_state: "HOLD",
    });
  });

  it("does not allow a generic retry from an aggregate FAILED state", async () => {
    const repository = new JobRepository(env.DB);
    await advanceToApproved(repository, 1, [
      { destination: "youtube", targetAccountId: "youtube_account_a" },
    ]);
    await repository.claimPublication({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      actor: ACTOR,
      now: NOW,
    });
    await repository.recordPublicationResult({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      result: "FAILED",
      actor: ACTOR,
      now: NOW,
    });
    expect((await repository.getVideoJob(jobId()))?.state).toBe("FAILED");
    await expect(
      repository.transitionJob({
        videoJobId: jobId(),
        expectedState: "FAILED",
        nextState: "PUBLISHING",
        actor: ACTOR,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("requires TikTok handoff and an HTTPS publication URL before confirmation", async () => {
    const repository = new JobRepository(env.DB);
    await advanceToApproved(repository, 1, [
      { destination: "tiktok", targetAccountId: "tiktok_account_a" },
    ]);
    const approved = await repository.getVideoJob(jobId());
    expect(approved).toMatchObject({
      youtube_status: "SKIPPED",
      instagram_status: "SKIPPED",
      tiktok_status: "PENDING",
    });
    await repository.claimPublication({
      videoJobId: jobId(),
      destination: "tiktok",
      targetAccountId: "tiktok_account_a",
      approvedContentVersion: "v1",
      actor: ACTOR,
      now: NOW,
    });
    await expect(
      repository.recordPublicationResult({
        videoJobId: jobId(),
        destination: "tiktok",
        targetAccountId: "tiktok_account_a",
        approvedContentVersion: "v1",
        result: "SUCCEEDED",
        resultRef: "https://example.invalid/video/before-handoff",
        actor: ACTOR,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    const handedOff = await repository.recordPublicationResult({
      videoJobId: jobId(),
      destination: "tiktok",
      targetAccountId: "tiktok_account_a",
      approvedContentVersion: "v1",
      result: "HANDED_OFF",
      actor: ACTOR,
      now: NOW,
    });
    expect(handedOff).toMatchObject({
      state: "PUBLISHING",
      tiktok_status: "HANDED_OFF",
      retention_state: "HOLD",
    });
    await expect(
      repository.recordPublicationResult({
        videoJobId: jobId(),
        destination: "tiktok",
        targetAccountId: "tiktok_account_a",
        approvedContentVersion: "v1",
        result: "SUCCEEDED",
        actor: ACTOR,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    const confirmed = await repository.recordPublicationResult({
      videoJobId: jobId(),
      destination: "tiktok",
      targetAccountId: "tiktok_account_a",
      approvedContentVersion: "v1",
      result: "SUCCEEDED",
      resultRef: "https://example.invalid/video/confirmed",
      actor: ACTOR,
      now: NOW,
    });
    expect(confirmed).toMatchObject({
      state: "PUBLISHED",
      tiktok_status: "CONFIRMED_PUBLISHED",
      retention_state: "RETAINED",
    });
  });

  it("rolls back a losing concurrent result before a retry completes the aggregate", async () => {
    const repository = new JobRepository(env.DB);
    await advanceToApproved(repository);
    for (const target of [
      { destination: "youtube" as const, targetAccountId: "youtube_account_a" },
      { destination: "instagram" as const, targetAccountId: "instagram_account_a" },
    ]) {
      await repository.claimPublication({
        videoJobId: jobId(),
        ...target,
        approvedContentVersion: "v1",
        actor: ACTOR,
        now: NOW,
      });
    }
    const youtubeResult = () => repository.recordPublicationResult({
      videoJobId: jobId(),
      destination: "youtube",
      targetAccountId: "youtube_account_a",
      approvedContentVersion: "v1",
      result: "SUCCEEDED" as const,
      resultRef: "FAKEVID0001",
      actor: ACTOR,
      now: NOW,
      mutationToken: "concurrent_youtube",
    });
    const instagramResult = () => repository.recordPublicationResult({
      videoJobId: jobId(),
      destination: "instagram",
      targetAccountId: "instagram_account_a",
      approvedContentVersion: "v1",
      result: "SUCCEEDED" as const,
      actor: ACTOR,
      now: NOW,
      mutationToken: "concurrent_instagram",
    });

    const firstPass = await Promise.allSettled([youtubeResult(), instagramResult()]);
    expect(firstPass.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const claimed = await env.DB
      .prepare("SELECT COUNT(*) count FROM idempotency_records WHERE status = 'CLAIMED'")
      .first<{ count: number }>();
    expect(claimed?.count).toBe(1);
    if (firstPass[0]?.status === "rejected") await youtubeResult();
    if (firstPass[1]?.status === "rejected") await instagramResult();
    expect(await repository.getVideoJob(jobId())).toMatchObject({
      state: "PUBLISHED",
      retention_state: "RETAINED",
    });
  });

  it("does not create ghost audit or mirror rows for a lost concurrent transition", async () => {
    const repository = new JobRepository(env.DB);
    await createJob(repository);
    const transition = (mutationToken: string) =>
      repository.transitionJob({
        videoJobId: jobId(),
        expectedState: "RECEIVED",
        nextState: "VALIDATING",
        actor: ACTOR,
        now: NOW,
        mutationToken,
      });

    const results = await Promise.allSettled([transition("event_a"), transition("event_b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const counts = await env.DB
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM audit_logs WHERE action = 'job.state.changed') AS audits,
          (SELECT COUNT(*) FROM mirror_outbox WHERE event_type = 'job.state.changed') AS mirrors`,
      )
      .first<{ audits: number; mirrors: number }>();
    expect(counts).toEqual({ audits: 1, mirrors: 2 });
  });

  it("keeps Sheets as a one-way mirror and retries failed writes", async () => {
    const repository = new JobRepository(env.DB);
    await createJob(repository);
    const rows = new Map<string, string>();
    let failAfterUpsert = true;
    const sink = {
      upsertByEventId: async (records: readonly { mirror_event_id: string; payload_json: string }[]) => {
        for (const record of records) rows.set(record.mirror_event_id, record.payload_json);
        if (failAfterUpsert) {
          failAfterUpsert = false;
          throw new Error("fake failure after Sheets accepted the row");
        }
      },
    };

    await expect(flushMirrorOutbox(env.DB, sink, NOW)).rejects.toThrow(
      "Sheets mirror write failed",
    );
    const failed = await env.DB
      .prepare("SELECT status, attempt_count FROM mirror_outbox")
      .first<{ status: string; attempt_count: number }>();
    expect(failed).toEqual({ status: "FAILED", attempt_count: 1 });

    const delivered = await flushMirrorOutbox(
      env.DB,
      sink,
      NOW,
    );
    expect(delivered).toBe(1);
    expect(rows.size).toBe(1);
  });

  it("starts retention automatically at a terminal business outcome", async () => {
    const repository = new JobRepository(env.DB, {
      retentionDays: 30,
      deletionOperatorIds: ["operator_retention"],
    });
    await createJob(repository);
    await repository.transitionJob({
      videoJobId: jobId(),
      expectedState: "RECEIVED",
      nextState: "VALIDATING",
      actor: ACTOR,
      now: NOW,
    });
    await repository.transitionJob({
      videoJobId: jobId(),
      expectedState: "VALIDATING",
      nextState: "PROCESSING",
      actor: ACTOR,
      now: NOW,
    });
    await repository.transitionJob({
      videoJobId: jobId(),
      expectedState: "PROCESSING",
      nextState: "WAITING_APPROVAL",
      actor: ACTOR,
      now: NOW,
    });
    await repository.transitionJob({
      videoJobId: jobId(),
      expectedState: "WAITING_APPROVAL",
      nextState: "REJECTED",
      actor: ACTOR,
      now: NOW,
    });
    const retained = await repository.getVideoJob(jobId());
    expect(retained?.retention_state).toBe("RETAINED");
    expect(retained?.delete_due_at).toBe("2026-09-15T00:00:00.000Z");

    const dueAt = "2026-09-15T00:00:00.000Z";
    expect(await repository.markRetentionDue(dueAt, ACTOR)).toBe(1);
    expect(await repository.markRetentionDue(dueAt, ACTOR)).toBe(0);
    await expect(
      repository.markDeleted({
        videoJobId: jobId(),
        actor: { type: "operator", id: "operator_unapproved" },
        now: dueAt,
        storageDeletionConfirmed: true,
        backupDeletionConfirmed: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const deleted = await repository.markDeleted({
      videoJobId: jobId(),
      actor: { type: "operator", id: "operator_retention" },
      now: dueAt,
      storageDeletionConfirmed: true,
      backupDeletionConfirmed: true,
    });
    expect(deleted.retention_state).toBe("DELETED");
  });
});
