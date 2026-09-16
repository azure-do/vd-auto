import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { JobRepository } from "../src/repository";

const JOB_ID = "00000000-0000-4000-8000-000000000901";
const SUBMISSION_ID = "00000000-0000-4000-8000-000000010901";
const NOW = "2026-08-16T00:00:00.000Z";
const ACTOR = { type: "system" as const, id: "system_demo" };

it("shows the E-1 dummy flow in plain values", async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mirror_outbox"),
    env.DB.prepare("DELETE FROM audit_logs"),
    env.DB.prepare("DELETE FROM idempotency_records"),
    env.DB.prepare("DELETE FROM applied_mutations"),
    env.DB.prepare("DELETE FROM video_jobs"),
  ]);
  const repository = new JobRepository(env.DB);
  await repository.createVideoJob({
    videoJobId: JOB_ID,
    submissionId: SUBMISSION_ID,
    branchId: "branch_demo",
    studioId: "studio_demo",
    classId: "class_demo",
    teacherId: "teacher_demo",
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
    approvedContentVersion: "approved-v1",
    publicationTargets: [
      { destination: "youtube", targetAccountId: "youtube_account_demo" },
      { destination: "instagram", targetAccountId: "instagram_account_demo" },
    ],
    actor: { type: "approver", id: "approver_demo" },
    now: NOW,
  });
  await repository.claimPublication({
    videoJobId: JOB_ID,
    destination: "youtube",
    targetAccountId: "youtube_account_demo",
    approvedContentVersion: "approved-v1",
    actor: ACTOR,
    now: NOW,
  });
  await repository.claimPublication({
    videoJobId: JOB_ID,
    destination: "instagram",
    targetAccountId: "instagram_account_demo",
    approvedContentVersion: "approved-v1",
    actor: ACTOR,
    now: NOW,
  });

  const job = await repository.getVideoJob(JOB_ID);
  const counts = await env.DB
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM audit_logs) AS audit_count,
        (SELECT COUNT(*) FROM mirror_outbox) AS mirror_count,
        (SELECT COUNT(*) FROM idempotency_records) AS publication_claims`,
    )
    .first<{ audit_count: number; mirror_count: number; publication_claims: number }>();

  const result = {
    business_state: job?.state,
    youtube: job?.youtube_status,
    instagram: job?.instagram_status,
    publication_claims: counts?.publication_claims,
    audit_records: counts?.audit_count,
    sheets_mirror_events: counts?.mirror_count,
  };
  console.log("\nE-1 dummy demonstration (no real video/account):", result);

  expect(result).toMatchObject({
    business_state: "PUBLISHING",
    youtube: "PUBLISHING",
    instagram: "PUBLISHING",
    publication_claims: 2,
  });
});
