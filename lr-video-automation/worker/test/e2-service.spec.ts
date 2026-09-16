import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  E2Repository,
  MAX_CLASS_READ_TTL_SECONDS,
  MAX_SOURCE_FUTURE_SKEW_SECONDS,
  type ClassReadModelEntryInput,
} from "../src/e2-repository";
import { E2LocalService, MemoryFakeNotifier } from "../src/e2-service";
import {
  IdentityBindingConflictError,
  IdentityLinkNotFoundError,
  IntakeIdentityCollisionError,
  ConcurrentUpdateError,
  ReadModelVersionError,
} from "../src/errors";
import { sha256Hex } from "../src/fingerprint";
import { createLocalIdentityFixture } from "./e2-test-identity";

const NOW = "2026-08-17T00:00:00.000Z";
const LATER = "2026-08-17T00:10:00.000Z";
const LESSON_ON = "2026-08-17";
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function clearDatabase(): Promise<void> {
  await env.DB.batch([
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
       SET active_source_version = NULL, read_status = 'UNAVAILABLE',
           failure_code = NULL, updated_at = '1970-01-01T00:00:00.000Z'
       WHERE singleton_id = 1`,
    ),
  ]);
}

async function makeEntry(
  email: string,
  overrides: Partial<ClassReadModelEntryInput> = {},
): Promise<ClassReadModelEntryInput> {
  return {
    classId: "class_dummy_a",
    branchId: "branch_dummy",
    studioId: "studio_dummy",
    teacherId: "teacher_dummy",
    teacherEmailFingerprint: await sha256Hex(email.trim().toLowerCase()),
    lessonOn: LESSON_ON,
    ...overrides,
  };
}

async function seed(
  repository: E2Repository,
  entries: readonly ClassReadModelEntryInput[],
  options: { sourceVersion?: number; fetchedAt?: string; ttlSeconds?: number } = {},
): Promise<void> {
  await repository.importClassReadModel({
    sourceVersion: options.sourceVersion ?? 1,
    fetchedAt: options.fetchedAt ?? NOW,
    ttlSeconds: options.ttlSeconds ?? 3_600,
    entries,
    now: NOW,
  });
}

describe("E-2.1 local identity and class intake service", () => {
  beforeEach(clearDatabase);

  it("imports a monotonic snapshot idempotently and rejects old or changed same versions", async () => {
    const repository = new E2Repository(env.DB);
    const email = `dummy-${crypto.randomUUID()}${String.fromCharCode(64)}local.invalid`;
    const entries = [await makeEntry(email)];
    await expect(repository.importClassReadModel({
      sourceVersion: 10,
      fetchedAt: NOW,
      ttlSeconds: 3_600,
      entries,
      now: NOW,
    })).resolves.toBe("IMPORTED");
    await expect(repository.importClassReadModel({
      sourceVersion: 10,
      fetchedAt: LATER,
      ttlSeconds: 3_600,
      entries,
      now: LATER,
    })).resolves.toBe("UNCHANGED");
    await expect(repository.importClassReadModel({
      sourceVersion: 10,
      fetchedAt: NOW,
      ttlSeconds: 3_600,
      entries,
      now: LATER,
    })).resolves.toBe("UNCHANGED");
    expect(await env.DB.prepare(
      "SELECT fetched_at FROM class_read_model_versions WHERE source_version = 10",
    ).first<{ fetched_at: string }>()).toEqual({ fetched_at: LATER });
    await expect(repository.importClassReadModel({
      sourceVersion: 9,
      fetchedAt: NOW,
      ttlSeconds: 3_600,
      entries,
      now: LATER,
    })).rejects.toMatchObject({ code: "OLD_SOURCE_VERSION" });
    await expect(repository.importClassReadModel({
      sourceVersion: 10,
      fetchedAt: NOW,
      ttlSeconds: 3_600,
      entries: [await makeEntry(email, { studioId: "studio_changed" })],
      now: LATER,
    })).rejects.toMatchObject({ code: "SOURCE_VERSION_COLLISION" });
  });

  it("switches concurrent newer versions without exposing a mixed snapshot", async () => {
    const repository = new E2Repository(env.DB);
    const email = `dummy-${crypto.randomUUID()}${String.fromCharCode(64)}local.invalid`;
    await seed(repository, [await makeEntry(email)]);
    const version2Entries = [await makeEntry(email, { classId: "class_v2" })];
    const version3Entries = [await makeEntry(email, { classId: "class_v3" })];
    const importV3WithRetry = async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await repository.importClassReadModel({
            sourceVersion: 3,
            fetchedAt: NOW,
            ttlSeconds: 3_600,
            entries: version3Entries,
            now: LATER,
          });
        } catch (error) {
          if (!(error instanceof ReadModelVersionError) || !error.retryable) throw error;
        }
      }
      throw new Error("v3 import did not converge after retryable conflicts");
    };
    const results = await Promise.allSettled([
      repository.importClassReadModel({
        sourceVersion: 2, fetchedAt: NOW, ttlSeconds: 3_600, entries: version2Entries, now: LATER,
      }),
      importV3WithRetry(),
    ]);
    expect(results[1]?.status).toBe("fulfilled");
    const snapshot = await repository.readCandidates("teacher_dummy", LESSON_ON, LATER);
    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot).toMatchObject({ sourceVersion: 3, candidates: [{ class_id: "class_v3" }] });
    expect(new ReadModelVersionError("SOURCE_IMPORT_CONFLICT").retryable).toBe(true);
    expect(new ReadModelVersionError("OLD_SOURCE_VERSION").retryable).toBe(false);
    expect(new ReadModelVersionError("SOURCE_VERSION_COLLISION").retryable).toBe(false);
  });

  it("rejects unsafe source versions, excessive future skew/TTL, and nonexistent dates", async () => {
    const repository = new E2Repository(env.DB);
    const email = `dummy-${crypto.randomUUID()}${String.fromCharCode(64)}local.invalid`;
    const future = new Date(
      Date.parse(NOW) + (MAX_SOURCE_FUTURE_SKEW_SECONDS + 1) * 1_000,
    ).toISOString();
    for (const sourceVersion of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(repository.importClassReadModel({
        sourceVersion,
        fetchedAt: NOW,
        ttlSeconds: 3_600,
        entries: [await makeEntry(email)],
        now: NOW,
      })).rejects.toThrow("sourceVersion");
    }
    await expect(repository.importClassReadModel({
      sourceVersion: 1,
      fetchedAt: future,
      ttlSeconds: 3_600,
      entries: [await makeEntry(email)],
      now: NOW,
    })).rejects.toThrow("future clock skew");
    await expect(repository.importClassReadModel({
      sourceVersion: 1,
      fetchedAt: NOW,
      ttlSeconds: MAX_CLASS_READ_TTL_SECONDS + 1,
      entries: [await makeEntry(email)],
      now: NOW,
    })).rejects.toThrow("ttlSeconds");
    await expect(repository.importClassReadModel({
      sourceVersion: 1,
      fetchedAt: NOW,
      ttlSeconds: 3_600,
      entries: [await makeEntry(email, { lessonOn: "2026-02-30" })],
      now: NOW,
    })).rejects.toThrow("lessonOn");
    await expect(repository.beginIntake({
      submissionId: uuid(99),
      intendedVideoJobId: uuid(199),
      subjectFingerprint: await sha256Hex("dummy-subject"),
      teacherId: "teacher_dummy",
      lessonOn: "2026-02-30",
      now: NOW,
    })).rejects.toThrow("lessonOn");
  });

  it("rolls back a failed snapshot switch and succeeds when the same version is resumed", async () => {
    const repository = new E2Repository(env.DB);
    const email = `dummy-${crypto.randomUUID()}${String.fromCharCode(64)}local.invalid`;
    await seed(repository, [await makeEntry(email)]);
    await env.DB.prepare(
      `CREATE TRIGGER fail_local_fixture BEFORE INSERT ON class_read_model_entries
       WHEN NEW.class_id = 'class_injected_failure'
       BEGIN SELECT RAISE(ABORT, 'injected local failure'); END`,
    ).run();
    const version2 = [await makeEntry(email, { classId: "class_injected_failure" })];
    await expect(repository.importClassReadModel({
      sourceVersion: 2, fetchedAt: NOW, ttlSeconds: 3_600, entries: version2, now: LATER,
    })).rejects.toThrow();
    expect((await repository.readCandidates("teacher_dummy", LESSON_ON, LATER))).toMatchObject({
      sourceVersion: 1,
      candidates: [{ class_id: "class_dummy_a" }],
    });
    await env.DB.prepare("DROP TRIGGER fail_local_fixture").run();
    await expect(repository.importClassReadModel({
      sourceVersion: 2, fetchedAt: NOW, ttlSeconds: 3_600, entries: version2, now: LATER,
    })).resolves.toBe("IMPORTED");
    expect((await repository.readCandidates("teacher_dummy", LESSON_ON, LATER))).toMatchObject({
      sourceVersion: 2,
      candidates: [{ class_id: "class_injected_failure" }],
    });
  });

  it("audits bind, duplicate rejection, unbind, and rebind without storing raw identity", async () => {
    const repository = new E2Repository(env.DB);
    const subjectA = await sha256Hex(`subject-${crypto.randomUUID()}`);
    const subjectB = await sha256Hex(`subject-${crypto.randomUUID()}`);
    await repository.bindTeacherIdentity({
      teacherId: "teacher_a", subjectFingerprint: subjectA, actorId: "operator_dummy", now: NOW,
    });
    await expect(repository.bindTeacherIdentity({
      teacherId: "teacher_b", subjectFingerprint: subjectA, actorId: "operator_dummy", now: NOW,
    })).rejects.toBeInstanceOf(IdentityBindingConflictError);
    await expect(repository.bindTeacherIdentity({
      teacherId: "teacher_a", subjectFingerprint: subjectB, actorId: "operator_dummy", now: NOW,
    })).rejects.toBeInstanceOf(IdentityBindingConflictError);
    expect(await repository.unbindTeacherIdentity({
      teacherId: "teacher_a", actorId: "operator_dummy", now: LATER,
    })).toBe(true);
    await repository.bindTeacherIdentity({
      teacherId: "teacher_a", subjectFingerprint: subjectB, actorId: "operator_dummy", now: LATER,
    });
    expect(await repository.identityAuditCount("teacher_a", "BOUND")).toBe(2);
    expect(await repository.identityAuditCount("teacher_a", "UNBOUND")).toBe(1);
    expect(await repository.identityAuditCount("teacher_a", "BIND_REJECTED")).toBe(1);
    expect(await repository.identityAuditCount("teacher_b", "BIND_REJECTED")).toBe(1);
  });

  it("resolves one candidate and reserves the E-3 job ID without creating a job", async () => {
    const fixture = await createLocalIdentityFixture(NOW);
    const email = fixture.makeEmail();
    const subject = `dummy-sub-${crypto.randomUUID()}`;
    const repository = new E2Repository(env.DB);
    await seed(repository, [await makeEntry(email)]);
    const token = await fixture.sign({ email, sub: subject });
    const service = new E2LocalService(repository, fixture.config);
    const outcome = await service.submit({
      idToken: token,
      submissionId: uuid(1),
      lessonOn: LESSON_ON,
      now: LATER,
    });
    expect(outcome.intake.status).toBe("RESOLVED");
    expect(outcome.identityWasRegistered).toBe(true);
    expect(await repository.getResolvedIntakeReservation(uuid(1))).toMatchObject({
      branch_id: "branch_dummy",
      studio_id: "studio_dummy",
      class_id: "class_dummy_a",
      teacher_id: "teacher_dummy",
    });
    expect(outcome.intake).toMatchObject({ status: "RESOLVED", video_job_id: null });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM video_jobs")
      .first<{ count: number }>()).toEqual({ count: 0 });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM audit_logs WHERE action = 'job.created'",
    ).first<{ count: number }>()).toEqual({ count: 0 });
    const persisted = JSON.stringify(await env.DB.prepare(
      `SELECT b.*, i.subject_fingerprint, i.teacher_id, i.status
       FROM teacher_identity_bindings b
       JOIN submission_intakes i ON i.teacher_id = b.teacher_id`,
    ).all());
    expect(persisted).not.toContain(email);
    expect(persisted).not.toContain(subject);
    expect(persisted).not.toContain(token);
  });

  it("keeps zero candidates unresolved and deduplicates its fake notification", async () => {
    const fixture = await createLocalIdentityFixture(NOW);
    const email = fixture.makeEmail();
    const subject = `dummy-sub-${crypto.randomUUID()}`;
    const repository = new E2Repository(env.DB);
    await seed(repository, [await makeEntry(email, { lessonOn: "2026-08-18" })]);
    const token = await fixture.sign({ email, sub: subject });
    const service = new E2LocalService(repository, fixture.config);
    const input = {
      idToken: token, submissionId: uuid(2),
      lessonOn: LESSON_ON, now: LATER,
    };
    expect((await service.submit(input)).intake).toMatchObject({
      status: "UNRESOLVED", reason_code: "NO_CLASS_MATCH", video_job_id: null,
    });
    expect((await service.submit(input)).intake.status).toBe("UNRESOLVED");
    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM video_jobs) jobs,
         (SELECT COUNT(*) FROM fake_notification_outbox) notifications`,
    ).first<{ jobs: number; notifications: number }>();
    expect(counts).toEqual({ jobs: 0, notifications: 1 });
  });

  it("keeps multiple canonical candidates in SELECTION_REQUIRED without free input or a job", async () => {
    const fixture = await createLocalIdentityFixture(NOW);
    const email = fixture.makeEmail();
    const repository = new E2Repository(env.DB);
    await seed(repository, [
      await makeEntry(email, { classId: "class_dummy_a" }),
      await makeEntry(email, { classId: "class_dummy_b", studioId: "studio_other" }),
    ]);
    const token = await fixture.sign({ email });
    const service = new E2LocalService(repository, fixture.config);
    const outcome = await service.submit({
      idToken: token, submissionId: uuid(3),
      lessonOn: LESSON_ON, now: LATER,
    });
    expect(outcome.intake.status).toBe("SELECTION_REQUIRED");
    expect(outcome.candidates.map((candidate) => candidate.class_id)).toEqual([
      "class_dummy_a", "class_dummy_b",
    ]);
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM video_jobs")
      .first<{ count: number }>()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM fake_notification_outbox")
      .first<{ count: number }>()).toEqual({ count: 0 });
  });

  it.each([
    ["expired", "SOURCE_TTL_EXPIRED"],
    ["unavailable", "SOURCE_READ_FAILED"],
  ])("isolates a %s read model and never creates a job", async (mode, reason) => {
    const fixture = await createLocalIdentityFixture(NOW);
    const email = fixture.makeEmail();
    const subjectFingerprint = await sha256Hex(`${fixture.config.issuer}\ndummy-known-sub`);
    const repository = new E2Repository(env.DB);
    await seed(repository, [await makeEntry(email)], { ttlSeconds: 60 });
    await repository.bindTeacherIdentity({
      teacherId: "teacher_dummy", subjectFingerprint, actorId: "system_identity", now: NOW,
    });
    if (mode === "unavailable") await repository.markClassReadUnavailable(reason, LATER);
    const token = await fixture.sign({ email, sub: "dummy-known-sub" });
    const service = new E2LocalService(repository, fixture.config);
    const outcome = await service.submit({
      idToken: token, submissionId: uuid(mode === "expired" ? 4 : 5),
      lessonOn: LESSON_ON, now: LATER,
    });
    expect(outcome.intake).toMatchObject({ status: "UNRESOLVED", reason_code: reason });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM video_jobs")
      .first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("converts a legacy JOB_CREATING intake into a resolved reservation without a job", async () => {
    const fixture = await createLocalIdentityFixture(NOW);
    const email = fixture.makeEmail();
    const subject = "dummy-resume-sub";
    const subjectFingerprint = await sha256Hex(`${fixture.config.issuer}\n${subject}`);
    const repository = new E2Repository(env.DB);
    await seed(repository, [await makeEntry(email)]);
    await repository.bindTeacherIdentity({
      teacherId: "teacher_dummy", subjectFingerprint, actorId: "system_identity", now: NOW,
    });
    await repository.beginIntake({
      submissionId: uuid(6), intendedVideoJobId: uuid(106), subjectFingerprint,
      teacherId: "teacher_dummy", lessonOn: LESSON_ON, now: NOW,
    });
    const snapshot = await repository.readCandidates("teacher_dummy", LESSON_ON, LATER);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE submission_intakes
         SET status = 'JOB_CREATING', source_version = ?, decision_fingerprint = ?,
             decision_version = 1, updated_at = ? WHERE submission_id = ?`,
      ).bind(snapshot.sourceVersion, "a".repeat(64), LATER, uuid(6)),
      env.DB.prepare(
        `INSERT INTO submission_candidate_snapshots (
           submission_id, class_id, branch_id, studio_id, teacher_id, source_version
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        uuid(6),
        snapshot.candidates[0]!.class_id,
        snapshot.candidates[0]!.branch_id,
        snapshot.candidates[0]!.studio_id,
        snapshot.candidates[0]!.teacher_id,
        snapshot.candidates[0]!.source_version,
      ),
    ]);
    const token = await fixture.sign({ email, sub: subject });
    const service = new E2LocalService(repository, fixture.config);
    const outcome = await service.submit({
      idToken: token, submissionId: uuid(6),
      lessonOn: LESSON_ON, now: LATER,
    });
    expect(outcome.intake.status).toBe("RESOLVED");
    expect(await repository.getResolvedIntakeReservation(uuid(6))).toMatchObject({
      class_id: "class_dummy_a",
      intended_video_job_id: uuid(106),
    });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM video_jobs")
      .first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("serializes concurrent duplicates into one resolved intake and no premature job", async () => {
    const fixture = await createLocalIdentityFixture(NOW);
    const email = fixture.makeEmail();
    const subject = `dummy-concurrent-${crypto.randomUUID()}`;
    const repository = new E2Repository(env.DB);
    await seed(repository, [await makeEntry(email)]);
    const token = await fixture.sign({ email, sub: subject });
    const service = new E2LocalService(repository, fixture.config);
    const input = { idToken: token, submissionId: uuid(9), lessonOn: LESSON_ON, now: LATER };
    const results = await Promise.all([service.submit(input), service.submit(input)]);
    expect(results.every((result) => result.intake.status === "RESOLVED")).toBe(true);
    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM submission_intakes) intakes,
         (SELECT COUNT(*) FROM video_jobs) jobs,
         (SELECT COUNT(*) FROM audit_logs WHERE action = 'job.created') job_audits`,
    ).first<{ intakes: number; jobs: number; job_audits: number }>();
    expect(counts).toEqual({ intakes: 1, jobs: 0, job_audits: 0 });
  });

  it("leaves no stale candidates, audit, or notification when an old decision loses to RESOLVED", async () => {
    const fixture = await createLocalIdentityFixture(NOW);
    const email = fixture.makeEmail();
    const subject = `dummy-race-${crypto.randomUUID()}`;
    const subjectFingerprint = await sha256Hex(`${fixture.config.issuer}\n${subject}`);
    const repository = new E2Repository(env.DB);
    await seed(repository, [await makeEntry(email, { lessonOn: "2026-08-18" })]);
    await repository.bindTeacherIdentity({
      teacherId: "teacher_dummy", subjectFingerprint, actorId: "system_identity", now: NOW,
    });
    const enteredBatch = deferred();
    const releaseBatch = deferred();
    let delayed = false;
    const delayedDb = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!delayed) {
              delayed = true;
              enteredBatch.resolve();
              await releaseBatch.promise;
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const staleService = new E2LocalService(
      new E2Repository(delayedDb),
      fixture.config,
    );
    const token = await fixture.sign({ email, sub: subject });
    const stale = staleService.submit({
      idToken: token, submissionId: uuid(11), lessonOn: LESSON_ON, now: LATER,
    });
    await enteredBatch.promise;
    await repository.importClassReadModel({
      sourceVersion: 2,
      fetchedAt: LATER,
      ttlSeconds: 3_600,
      entries: [await makeEntry(email)],
      now: LATER,
    });
    const winner = await new E2LocalService(
      repository,
      fixture.config,
    ).submit({ idToken: token, submissionId: uuid(11), lessonOn: LESSON_ON, now: LATER });
    expect(winner.intake.status).toBe("RESOLVED");
    releaseBatch.resolve();
    await expect(stale).rejects.toBeInstanceOf(ConcurrentUpdateError);
    expect(await repository.getCandidateSnapshots(uuid(11))).toMatchObject([
      { class_id: "class_dummy_a", source_version: 2 },
    ]);
    const ghosts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM intake_audit_logs
          WHERE submission_id = ? AND to_status = 'UNRESOLVED') unresolved_audits,
         (SELECT COUNT(*) FROM fake_notification_outbox WHERE submission_id = ?) notifications`,
    ).bind(uuid(11), uuid(11)).first<{ unresolved_audits: number; notifications: number }>();
    expect(ghosts).toEqual({ unresolved_audits: 0, notifications: 0 });
  });

  it("rejects reuse of a submission ID for different intake input without ghost changes", async () => {
    const fixture = await createLocalIdentityFixture(NOW);
    const email = fixture.makeEmail();
    const repository = new E2Repository(env.DB);
    await seed(repository, [await makeEntry(email)]);
    const token = await fixture.sign({ email });
    const service = new E2LocalService(repository, fixture.config);
    const first = await service.submit({
      idToken: token, submissionId: uuid(10), lessonOn: LESSON_ON, now: LATER,
    });
    await expect(service.submit({
      idToken: token, submissionId: uuid(10), lessonOn: "2026-08-18", now: LATER,
    })).rejects.toBeInstanceOf(IntakeIdentityCollisionError);
    expect(await repository.getIntake(uuid(10))).toMatchObject({
      status: "RESOLVED",
      lesson_on: LESSON_ON,
      video_job_id: first.intake.video_job_id,
    });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM video_jobs")
      .first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("retries a failed fake notification without duplicate delivery", async () => {
    const fixture = await createLocalIdentityFixture(NOW);
    const email = fixture.makeEmail();
    const repository = new E2Repository(env.DB);
    await seed(repository, [await makeEntry(email, { lessonOn: "2026-08-18" })]);
    const service = new E2LocalService(repository, fixture.config);
    await service.submit({
      idToken: await fixture.sign({ email }), submissionId: uuid(7),
      lessonOn: LESSON_ON, now: LATER,
    });
    const notifier = new MemoryFakeNotifier(1);
    await expect(service.flushFakeNotifications(notifier, LATER)).rejects.toThrow(
      "Fake notification delivery failed",
    );
    expect(await service.flushFakeNotifications(notifier, LATER)).toBe(1);
    expect(await service.flushFakeNotifications(notifier, LATER)).toBe(0);
    expect(notifier.deliveries).toHaveLength(1);
  });

  it("atomically claims a fake notification across concurrent flushes", async () => {
    const fixture = await createLocalIdentityFixture(NOW);
    const email = fixture.makeEmail();
    const repository = new E2Repository(env.DB);
    await seed(repository, [await makeEntry(email, { lessonOn: "2026-08-18" })]);
    const service = new E2LocalService(repository, fixture.config);
    await service.submit({
      idToken: await fixture.sign({ email }), submissionId: uuid(12),
      lessonOn: LESSON_ON, now: LATER,
    });
    const sendEntered = deferred();
    const releaseSend = deferred();
    const deliveries: string[] = [];
    const notifier = {
      async send(input: { notificationId: string }) {
        deliveries.push(input.notificationId);
        sendEntered.resolve();
        await releaseSend.promise;
      },
    };
    const first = service.flushFakeNotifications(notifier, LATER);
    await sendEntered.promise;
    const second = await service.flushFakeNotifications(notifier, LATER);
    expect(second).toBe(0);
    releaseSend.resolve();
    expect(await first).toBe(1);
    expect(deliveries).toHaveLength(1);
  });

  it("recovers fake notification leases after crashes before and after send", async () => {
    const fixture = await createLocalIdentityFixture(NOW);
    const email = fixture.makeEmail();
    const repository = new E2Repository(env.DB);
    await seed(repository, [await makeEntry(email, { lessonOn: "2026-08-18" })]);
    const service = new E2LocalService(repository, fixture.config);
    const token = await fixture.sign({ email, sub: "dummy-notification-crash" });
    await service.submit({
      idToken: token, submissionId: uuid(13),
      lessonOn: LESSON_ON, now: LATER,
    });
    const beforeSendClaim = await repository.claimFakeNotifications({ now: LATER, leaseSeconds: 30 });
    expect(beforeSendClaim).toHaveLength(1);
    const afterFirstLease = new Date(Date.parse(LATER) + 31_000).toISOString();
    const notifier = new MemoryFakeNotifier();
    expect(await service.flushFakeNotifications(notifier, afterFirstLease)).toBe(1);
    expect(notifier.deliveries).toHaveLength(1);

    await service.submit({
      idToken: token, submissionId: uuid(14),
      lessonOn: LESSON_ON, now: afterFirstLease,
    });
    const afterSendClaim = await repository.claimFakeNotifications({
      now: afterFirstLease,
      leaseSeconds: 30,
    });
    expect(afterSendClaim).toHaveLength(1);
    await notifier.send({
      notificationId: afterSendClaim[0]!.notification_id,
      submissionId: afterSendClaim[0]!.submission_id,
      reasonCode: afterSendClaim[0]!.reason_code,
    });
    const afterSecondLease = new Date(Date.parse(afterFirstLease) + 31_000).toISOString();
    expect(await service.flushFakeNotifications(notifier, afterSecondLease)).toBe(1);
    expect(notifier.deliveries).toHaveLength(2);
    expect(new Set(notifier.deliveries.map((item) => item.notificationId)).size).toBe(2);
  });

  it("rejects an unmatched initial identity and performs no external communication", async () => {
    const fixture = await createLocalIdentityFixture(NOW);
    const repository = new E2Repository(env.DB);
    const masterEmail = fixture.makeEmail();
    await seed(repository, [await makeEntry(masterEmail)]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const service = new E2LocalService(repository, fixture.config);
    await expect(service.submit({
      idToken: await fixture.sign({ email: fixture.makeEmail() }),
      submissionId: uuid(8),
      lessonOn: LESSON_ON, now: LATER,
    })).rejects.toBeInstanceOf(IdentityLinkNotFoundError);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM submission_intakes")
      .first<{ count: number }>()).toEqual({ count: 0 });
  });
});
