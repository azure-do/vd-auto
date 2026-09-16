import { assertInternalId, assertUuid } from "./domain";
import {
  ConcurrentUpdateError,
  IdentityBindingConflictError,
  IntakeIdentityCollisionError,
  NotFoundError,
  ReadModelVersionError,
} from "./errors";
import { canonicalFingerprint } from "./fingerprint";

export interface ClassReadModelEntryInput {
  classId: string;
  branchId: string;
  studioId: string;
  teacherId: string;
  teacherEmailFingerprint: string;
  lessonOn: string;
}

export interface ClassCandidate {
  class_id: string;
  branch_id: string;
  studio_id: string;
  teacher_id: string;
  source_version: number;
}

export type IntakeStatus =
  | "PENDING"
  | "JOB_CREATING"
  | "RESOLVED"
  | "SELECTION_REQUIRED"
  | "UNRESOLVED";

export interface SubmissionIntake {
  submission_id: string;
  intended_video_job_id: string;
  request_fingerprint: string;
  subject_fingerprint: string;
  teacher_id: string;
  lesson_on: string;
  status: IntakeStatus;
  reason_code: string | null;
  source_version: number | null;
  decision_fingerprint: string | null;
  decision_version: number;
  video_job_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReadModelSnapshot {
  status: "AVAILABLE" | "UNAVAILABLE" | "EXPIRED";
  sourceVersion: number | null;
  candidates: ClassCandidate[];
  failureCode: string | null;
}

export interface ResolvedIntakeReservation {
  submission_id: string;
  intended_video_job_id: string;
  class_id: string;
  branch_id: string;
  studio_id: string;
  teacher_id: string;
  source_version: number;
}

export interface FakeNotificationRecord {
  notification_id: string;
  submission_id: string;
  reason_code: string;
  attempt_count: number;
  lease_token: string;
}

export const MAX_CLASS_READ_TTL_SECONDS = 86_400;
export const MAX_SOURCE_FUTURE_SKEW_SECONDS = 300;
export const FAKE_NOTIFICATION_LEASE_SECONDS = 30;

function changes(result: D1Result): number {
  return result.meta.changes ?? 0;
}

function assertIsoDate(value: string): void {
  if (Number.isNaN(Date.parse(value))) throw new TypeError("Timestamp must be an ISO date");
}

function assertDateOnly(value: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new TypeError("lessonOn must be YYYY-MM-DD");
  }
}

function assertFingerprint(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${field} must be a SHA-256 digest`);
}

function normalizedEntries(entries: readonly ClassReadModelEntryInput[]): ClassReadModelEntryInput[] {
  const normalized = entries.map((entry) => {
    assertInternalId(entry.classId, "classId");
    assertInternalId(entry.branchId, "branchId");
    assertInternalId(entry.studioId, "studioId");
    assertInternalId(entry.teacherId, "teacherId");
    assertFingerprint(entry.teacherEmailFingerprint, "teacherEmailFingerprint");
    assertDateOnly(entry.lessonOn);
    return { ...entry };
  });
  normalized.sort((left, right) =>
    [left.lessonOn, left.teacherId, left.classId, left.branchId, left.studioId].join(":")
      .localeCompare(
        [right.lessonOn, right.teacherId, right.classId, right.branchId, right.studioId].join(":"),
      ));
  const keys = new Set<string>();
  for (const entry of normalized) {
    const key = `${entry.classId}:${entry.teacherId}:${entry.lessonOn}`;
    if (keys.has(key)) throw new TypeError("Duplicate class read-model entry");
    keys.add(key);
  }
  return normalized;
}

export class E2Repository {
  constructor(private readonly db: D1Database) {}

  async importClassReadModel(input: {
    sourceVersion: number;
    fetchedAt: string;
    ttlSeconds: number;
    entries: readonly ClassReadModelEntryInput[];
    now: string;
  }): Promise<"IMPORTED" | "UNCHANGED"> {
    if (!Number.isSafeInteger(input.sourceVersion) || input.sourceVersion <= 0) {
      throw new TypeError("sourceVersion must be a positive monotonic integer");
    }
    if (
      !Number.isInteger(input.ttlSeconds) ||
      input.ttlSeconds <= 0 ||
      input.ttlSeconds > MAX_CLASS_READ_TTL_SECONDS
    ) {
      throw new TypeError(`ttlSeconds must be between 1 and ${MAX_CLASS_READ_TTL_SECONDS}`);
    }
    assertIsoDate(input.fetchedAt);
    assertIsoDate(input.now);
    const fetchedAt = new Date(input.fetchedAt).toISOString();
    const now = new Date(input.now).toISOString();
    if (Date.parse(fetchedAt) - Date.parse(now) > MAX_SOURCE_FUTURE_SKEW_SECONDS * 1_000) {
      throw new TypeError("fetchedAt exceeds the allowed future clock skew");
    }
    const entries = normalizedEntries(input.entries);
    const contentFingerprint = await canonicalFingerprint({
      ttl_seconds: input.ttlSeconds,
      entries,
    });
    const head = await this.db
      .prepare("SELECT active_source_version FROM class_read_model_head WHERE singleton_id = 1")
      .first<{ active_source_version: number | null }>();
    const activeVersion = head?.active_source_version ?? null;
    if (activeVersion !== null && input.sourceVersion < activeVersion) {
      throw new ReadModelVersionError("OLD_SOURCE_VERSION");
    }
    if (activeVersion === input.sourceVersion) {
      const existing = await this.db
        .prepare(
          "SELECT content_fingerprint FROM class_read_model_versions WHERE source_version = ?",
        )
        .bind(input.sourceVersion)
        .first<{ content_fingerprint: string }>();
      if (existing?.content_fingerprint !== contentFingerprint) {
        throw new ReadModelVersionError("SOURCE_VERSION_COLLISION");
      }
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE class_read_model_versions
             SET fetched_at = ?
             WHERE source_version = ? AND content_fingerprint = ?
               AND datetime(fetched_at) <= datetime(?)`,
          )
          .bind(
            fetchedAt,
            input.sourceVersion,
            contentFingerprint,
            fetchedAt,
          ),
        this.db
          .prepare(
            `UPDATE class_read_model_head
             SET read_status = 'AVAILABLE', failure_code = NULL, updated_at = ?
             WHERE singleton_id = 1 AND active_source_version = ?`,
          )
          .bind(input.now, input.sourceVersion),
      ]);
      return "UNCHANGED";
    }

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE class_read_model_head
           SET active_source_version = ?, read_status = 'AVAILABLE',
               failure_code = NULL, updated_at = ?
           WHERE singleton_id = 1 AND active_source_version IS ?`,
        )
        .bind(input.sourceVersion, input.now, activeVersion),
      this.db
        .prepare(
          `INSERT INTO class_read_model_versions (
             source_version, fetched_at, ttl_seconds, content_fingerprint, imported_at
           )
           SELECT ?, ?, ?, ?, ?
           FROM class_read_model_head
           WHERE singleton_id = 1 AND active_source_version = ?
           ON CONFLICT(source_version) DO NOTHING`,
        )
        .bind(
          input.sourceVersion,
          new Date(input.fetchedAt).toISOString(),
          input.ttlSeconds,
          contentFingerprint,
          input.now,
          input.sourceVersion,
        ),
      ...entries.map((entry) =>
        this.db
          .prepare(
            `INSERT INTO class_read_model_entries (
               source_version, class_id, branch_id, studio_id, teacher_id,
               teacher_email_fingerprint, lesson_on
             )
             SELECT ?, ?, ?, ?, ?, ?, ?
             FROM class_read_model_versions
             WHERE source_version = ? AND content_fingerprint = ?
             ON CONFLICT(source_version, class_id, teacher_id, lesson_on) DO NOTHING`,
          )
          .bind(
            input.sourceVersion,
            entry.classId,
            entry.branchId,
            entry.studioId,
            entry.teacherId,
            entry.teacherEmailFingerprint,
            entry.lessonOn,
            input.sourceVersion,
            contentFingerprint,
          ),
      ),
    ];
    const results = await this.db.batch(statements);
    if (changes(results[0]!) !== 1) throw new ReadModelVersionError("SOURCE_IMPORT_CONFLICT");
    const stored = await this.db
      .prepare(
        `SELECT h.active_source_version, v.content_fingerprint
         FROM class_read_model_head h
         LEFT JOIN class_read_model_versions v
           ON v.source_version = h.active_source_version
         WHERE h.singleton_id = 1`,
      )
      .first<{ active_source_version: number | null; content_fingerprint: string | null }>();
    if (
      stored?.active_source_version !== input.sourceVersion ||
      stored.content_fingerprint !== contentFingerprint
    ) throw new ReadModelVersionError("SOURCE_IMPORT_CONFLICT");
    return "IMPORTED";
  }

  async markClassReadUnavailable(failureCode: string, now: string): Promise<void> {
    assertInternalId(failureCode, "failureCode");
    assertIsoDate(now);
    await this.db
      .prepare(
        `UPDATE class_read_model_head
         SET read_status = 'UNAVAILABLE', failure_code = ?, updated_at = ?
         WHERE singleton_id = 1`,
      )
      .bind(failureCode, now)
      .run();
  }

  async findTeacherIdsForInitialLink(emailFingerprint: string, now: string): Promise<string[]> {
    assertFingerprint(emailFingerprint, "emailFingerprint");
    assertIsoDate(now);
    const result = await this.db
      .prepare(
        `SELECT DISTINCT e.teacher_id
         FROM class_read_model_head h
         JOIN class_read_model_versions v ON v.source_version = h.active_source_version
         JOIN class_read_model_entries e ON e.source_version = h.active_source_version
         WHERE h.singleton_id = 1 AND h.read_status = 'AVAILABLE'
           AND e.teacher_email_fingerprint = ?
           AND datetime(v.fetched_at, '+' || v.ttl_seconds || ' seconds') > datetime(?)
         ORDER BY e.teacher_id`,
      )
      .bind(emailFingerprint, now)
      .all<{ teacher_id: string }>();
    return result.results.map((row) => row.teacher_id);
  }

  async findTeacherBySubject(subjectFingerprint: string): Promise<string | null> {
    assertFingerprint(subjectFingerprint, "subjectFingerprint");
    const row = await this.db
      .prepare(
        "SELECT teacher_id FROM teacher_identity_bindings WHERE subject_fingerprint = ?",
      )
      .bind(subjectFingerprint)
      .first<{ teacher_id: string }>();
    return row?.teacher_id ?? null;
  }

  async bindTeacherIdentity(input: {
    teacherId: string;
    subjectFingerprint: string;
    actorId: string;
    now: string;
  }): Promise<void> {
    assertInternalId(input.teacherId, "teacherId");
    assertFingerprint(input.subjectFingerprint, "subjectFingerprint");
    assertInternalId(input.actorId, "actorId");
    assertIsoDate(input.now);
    const auditFingerprint = await canonicalFingerprint({
      action: "BOUND",
      teacher_id: input.teacherId,
      subject_fingerprint: input.subjectFingerprint,
      actor_id: input.actorId,
      occurred_at: input.now,
    });
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO teacher_identity_bindings (
             teacher_id, subject_fingerprint, bound_at, bound_by
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .bind(input.teacherId, input.subjectFingerprint, input.now, input.actorId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO teacher_identity_audits (
             identity_audit_id, teacher_id, action, actor_id, occurred_at
           )
           SELECT ?, teacher_id, 'BOUND', ?, ?
           FROM teacher_identity_bindings
           WHERE teacher_id = ? AND subject_fingerprint = ?
             AND bound_at = ? AND bound_by = ?`,
        )
        .bind(
          `identity_${auditFingerprint}`,
          input.actorId,
          input.now,
          input.teacherId,
          input.subjectFingerprint,
          input.now,
          input.actorId,
        ),
    ]);
    const byTeacher = await this.db
      .prepare(
        "SELECT subject_fingerprint FROM teacher_identity_bindings WHERE teacher_id = ?",
      )
      .bind(input.teacherId)
      .first<{ subject_fingerprint: string }>();
    const bySubject = await this.findTeacherBySubject(input.subjectFingerprint);
    if (byTeacher?.subject_fingerprint !== input.subjectFingerprint || bySubject !== input.teacherId) {
      const rejectionFingerprint = await canonicalFingerprint({
        action: "BIND_REJECTED",
        teacher_id: input.teacherId,
        actor_id: input.actorId,
        occurred_at: input.now,
      });
      await this.db
        .prepare(
          `INSERT OR IGNORE INTO teacher_identity_audits (
             identity_audit_id, teacher_id, action, actor_id, occurred_at
           ) VALUES (?, ?, 'BIND_REJECTED', ?, ?)`,
        )
        .bind(
          `identity_${rejectionFingerprint}`,
          input.teacherId,
          input.actorId,
          input.now,
        )
        .run();
      throw new IdentityBindingConflictError();
    }
  }

  async unbindTeacherIdentity(input: {
    teacherId: string;
    actorId: string;
    now: string;
  }): Promise<boolean> {
    assertInternalId(input.teacherId, "teacherId");
    assertInternalId(input.actorId, "actorId");
    assertIsoDate(input.now);
    const auditFingerprint = await canonicalFingerprint({
      action: "UNBOUND",
      teacher_id: input.teacherId,
      actor_id: input.actorId,
      occurred_at: input.now,
    });
    const results = await this.db.batch([
      this.db
        .prepare("DELETE FROM teacher_identity_bindings WHERE teacher_id = ?")
        .bind(input.teacherId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO teacher_identity_audits (
             identity_audit_id, teacher_id, action, actor_id, occurred_at
           )
           SELECT ?, ?, 'UNBOUND', ?, ? WHERE changes() = 1`,
        )
        .bind(`identity_${auditFingerprint}`, input.teacherId, input.actorId, input.now),
    ]);
    return changes(results[0]!) === 1;
  }

  async beginIntake(input: {
    submissionId: string;
    intendedVideoJobId: string;
    subjectFingerprint: string;
    teacherId: string;
    lessonOn: string;
    now: string;
  }): Promise<SubmissionIntake> {
    assertUuid(input.submissionId, "submissionId");
    assertUuid(input.intendedVideoJobId, "intendedVideoJobId");
    assertFingerprint(input.subjectFingerprint, "subjectFingerprint");
    assertInternalId(input.teacherId, "teacherId");
    assertDateOnly(input.lessonOn);
    assertIsoDate(input.now);
    const requestFingerprint = await canonicalFingerprint({
      submission_id: input.submissionId,
      subject_fingerprint: input.subjectFingerprint,
      teacher_id: input.teacherId,
      lesson_on: input.lessonOn,
    });
    await this.db
      .prepare(
        `INSERT INTO submission_intakes (
           submission_id, intended_video_job_id, request_fingerprint,
           subject_fingerprint, teacher_id, lesson_on, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
         ON CONFLICT(submission_id) DO NOTHING`,
      )
      .bind(
        input.submissionId,
        input.intendedVideoJobId,
        requestFingerprint,
        input.subjectFingerprint,
        input.teacherId,
        input.lessonOn,
        input.now,
        input.now,
      )
      .run();
    const intake = await this.getIntake(input.submissionId);
    if (!intake) throw new ConcurrentUpdateError();
    if (intake.request_fingerprint !== requestFingerprint) throw new IntakeIdentityCollisionError();
    return intake;
  }

  async getIntake(submissionId: string): Promise<SubmissionIntake | null> {
    assertUuid(submissionId, "submissionId");
    return this.db
      .prepare("SELECT * FROM submission_intakes WHERE submission_id = ?")
      .bind(submissionId)
      .first<SubmissionIntake>();
  }

  async readCandidates(teacherId: string, lessonOn: string, now: string): Promise<ReadModelSnapshot> {
    assertInternalId(teacherId, "teacherId");
    assertDateOnly(lessonOn);
    assertIsoDate(now);
    const head = await this.db
      .prepare(
        `SELECT h.active_source_version, h.read_status, h.failure_code,
                v.fetched_at, v.ttl_seconds
         FROM class_read_model_head h
         LEFT JOIN class_read_model_versions v ON v.source_version = h.active_source_version
         WHERE h.singleton_id = 1`,
      )
      .first<{
        active_source_version: number | null;
        read_status: "AVAILABLE" | "UNAVAILABLE";
        failure_code: string | null;
        fetched_at: string | null;
        ttl_seconds: number | null;
      }>();
    if (!head || head.read_status !== "AVAILABLE" || head.active_source_version === null) {
      return {
        status: "UNAVAILABLE",
        sourceVersion: head?.active_source_version ?? null,
        candidates: [],
        failureCode: head?.failure_code ?? "SOURCE_UNAVAILABLE",
      };
    }
    const expiresAt = Date.parse(head.fetched_at!) + head.ttl_seconds! * 1000;
    if (expiresAt <= Date.parse(now)) {
      return {
        status: "EXPIRED",
        sourceVersion: head.active_source_version,
        candidates: [],
        failureCode: "SOURCE_TTL_EXPIRED",
      };
    }
    const result = await this.db
      .prepare(
        `SELECT class_id, branch_id, studio_id, teacher_id, source_version
         FROM class_read_model_entries
         WHERE source_version = ? AND teacher_id = ? AND lesson_on = ?
         ORDER BY class_id`,
      )
      .bind(head.active_source_version, teacherId, lessonOn)
      .all<ClassCandidate>();
    return {
      status: "AVAILABLE",
      sourceVersion: head.active_source_version,
      candidates: result.results,
      failureCode: null,
    };
  }

  async stageDecision(input: {
    submissionId: string;
    status: "RESOLVED" | "SELECTION_REQUIRED" | "UNRESOLVED";
    reasonCode: string | null;
    sourceVersion: number | null;
    candidates: readonly ClassCandidate[];
    actorId: string;
    now: string;
  }): Promise<SubmissionIntake> {
    assertUuid(input.submissionId, "submissionId");
    assertInternalId(input.actorId, "actorId");
    assertIsoDate(input.now);
    if (input.reasonCode !== null) assertInternalId(input.reasonCode, "reasonCode");
    if (input.status === "RESOLVED" && input.candidates.length !== 1) {
      throw new TypeError("RESOLVED requires exactly one canonical candidate");
    }
    if (input.status === "RESOLVED" && input.reasonCode !== null) {
      throw new TypeError("RESOLVED cannot have an unresolved reason");
    }
    if (input.status === "SELECTION_REQUIRED" && input.candidates.length < 2) {
      throw new TypeError("SELECTION_REQUIRED requires multiple canonical candidates");
    }
    if (input.status === "UNRESOLVED" && input.candidates.length !== 0) {
      throw new TypeError("UNRESOLVED cannot contain candidates");
    }
    const sortedCandidates = [...input.candidates].sort((left, right) =>
      left.class_id.localeCompare(right.class_id));
    const decisionFingerprint = await canonicalFingerprint({
      status: input.status,
      reason_code: input.reasonCode,
      source_version: input.sourceVersion,
      candidates: sortedCandidates,
    });
    const auditId = `intake_${input.submissionId}_${decisionFingerprint}`;
    const notificationId = `fake_${input.submissionId}_${decisionFingerprint}`;
    const existing = await this.getIntake(input.submissionId);
    if (!existing) throw new NotFoundError("Submission intake");
    if (existing.status === "RESOLVED") return existing;
    if (existing.decision_fingerprint === decisionFingerprint && existing.status === input.status) {
      return existing;
    }
    const nextDecisionVersion = existing.decision_version + 1;
    const decisionIsCurrent = `EXISTS (
      SELECT 1 FROM submission_intakes i
      WHERE i.submission_id = ? AND i.decision_fingerprint = ?
        AND i.decision_version = ? AND i.status = ?
    )`;
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE submission_intakes
           SET status = ?, reason_code = ?, source_version = ?,
               decision_fingerprint = ?, decision_version = decision_version + 1,
               video_job_id = NULL, updated_at = ?
           WHERE submission_id = ? AND status <> 'RESOLVED' AND decision_version = ?`,
        )
        .bind(
          input.status,
          input.reasonCode,
          input.sourceVersion,
          decisionFingerprint,
          input.now,
          input.submissionId,
          existing.decision_version,
        ),
      this.db
        .prepare(
          `DELETE FROM submission_candidate_snapshots
           WHERE submission_id = ? AND ${decisionIsCurrent}`,
        )
        .bind(
          input.submissionId,
          input.submissionId,
          decisionFingerprint,
          nextDecisionVersion,
          input.status,
        ),
      ...sortedCandidates.map((candidate) =>
        this.db
          .prepare(
            `INSERT INTO submission_candidate_snapshots (
               submission_id, class_id, branch_id, studio_id, teacher_id, source_version
             )
             SELECT ?, ?, ?, ?, ?, ? WHERE ${decisionIsCurrent}`,
          )
          .bind(
            input.submissionId,
            candidate.class_id,
            candidate.branch_id,
            candidate.studio_id,
            candidate.teacher_id,
            candidate.source_version,
            input.submissionId,
            decisionFingerprint,
            nextDecisionVersion,
            input.status,
          ),
      ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO intake_audit_logs (
             intake_audit_id, submission_id, actor_id, action,
             from_status, to_status, reason_code, occurred_at
           )
           SELECT ?, ?, ?, 'intake.decision', ?, ?, ?, ?
           WHERE ${decisionIsCurrent}`,
        )
        .bind(
          auditId,
          input.submissionId,
          input.actorId,
          existing.status,
          input.status,
          input.reasonCode,
          input.now,
          input.submissionId,
          decisionFingerprint,
          nextDecisionVersion,
          input.status,
        ),
      ...(input.status === "UNRESOLVED"
        ? [
            this.db
              .prepare(
                `INSERT OR IGNORE INTO fake_notification_outbox (
                   notification_id, submission_id, decision_fingerprint,
                   reason_code, created_at, updated_at
                 )
                 SELECT ?, ?, ?, ?, ?, ? WHERE ${decisionIsCurrent}`,
              )
              .bind(
                notificationId,
                input.submissionId,
                decisionFingerprint,
                input.reasonCode,
                input.now,
                input.now,
                input.submissionId,
                decisionFingerprint,
                nextDecisionVersion,
                input.status,
              ),
          ]
        : []),
    ];
    const results = await this.db.batch(statements);
    if (changes(results[0]!) !== 1) {
      const concurrent = await this.getIntake(input.submissionId);
      if (
        concurrent?.status === input.status &&
        concurrent.decision_fingerprint === decisionFingerprint
      ) return concurrent;
      throw new ConcurrentUpdateError();
    }
    return (await this.getIntake(input.submissionId))!;
  }

  async getCandidateSnapshots(submissionId: string): Promise<ClassCandidate[]> {
    assertUuid(submissionId, "submissionId");
    const result = await this.db
      .prepare(
        `SELECT class_id, branch_id, studio_id, teacher_id, source_version
         FROM submission_candidate_snapshots
         WHERE submission_id = ? ORDER BY class_id`,
      )
      .bind(submissionId)
      .all<ClassCandidate>();
    return result.results;
  }

  async getResolvedIntakeReservation(
    submissionId: string,
  ): Promise<ResolvedIntakeReservation | null> {
    assertUuid(submissionId, "submissionId");
    const result = await this.db
      .prepare(
        `SELECT i.submission_id, i.intended_video_job_id,
                c.class_id, c.branch_id, c.studio_id, c.teacher_id, c.source_version
         FROM submission_intakes i
         JOIN submission_candidate_snapshots c ON c.submission_id = i.submission_id
         WHERE i.submission_id = ? AND i.status = 'RESOLVED' AND i.video_job_id IS NULL
         ORDER BY c.class_id`,
      )
      .bind(submissionId)
      .all<ResolvedIntakeReservation>();
    if (result.results.length === 0) return null;
    if (result.results.length !== 1) throw new ConcurrentUpdateError();
    return result.results[0]!;
  }

  async claimFakeNotifications(input: {
    now: string;
    leaseSeconds?: number;
    limit?: number;
  }): Promise<FakeNotificationRecord[]> {
    assertIsoDate(input.now);
    const leaseSeconds = input.leaseSeconds ?? FAKE_NOTIFICATION_LEASE_SECONDS;
    const limit = input.limit ?? 50;
    if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0 || leaseSeconds > 300) {
      throw new TypeError("leaseSeconds must be between 1 and 300");
    }
    if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
      throw new TypeError("limit must be between 1 and 100");
    }
    const claimable = await this.db
      .prepare(
        `SELECT notification_id, submission_id, reason_code, attempt_count
         FROM fake_notification_outbox
         WHERE status = 'PENDING'
            OR (status = 'SENDING' AND datetime(lease_expires_at) <= datetime(?))
         ORDER BY created_at LIMIT ?`,
      )
      .bind(input.now, limit)
      .all<FakeNotificationRecord>();
    const claimed: FakeNotificationRecord[] = [];
    for (const record of claimable.results) {
      const leaseToken = crypto.randomUUID();
      const leaseExpiresAt = new Date(
        Date.parse(input.now) + leaseSeconds * 1_000,
      ).toISOString();
      const result = await this.db
        .prepare(
          `UPDATE fake_notification_outbox
           SET status = 'SENDING', lease_token = ?, lease_expires_at = ?,
               attempt_count = attempt_count + 1, updated_at = ?
           WHERE notification_id = ? AND (
             status = 'PENDING'
             OR (status = 'SENDING' AND datetime(lease_expires_at) <= datetime(?))
           )`,
        )
        .bind(leaseToken, leaseExpiresAt, input.now, record.notification_id, input.now)
        .run();
      if (changes(result) === 1) {
        claimed.push({ ...record, attempt_count: record.attempt_count + 1, lease_token: leaseToken });
      }
    }
    return claimed;
  }

  async recordFakeNotificationDelivered(
    notificationId: string,
    leaseToken: string,
    now: string,
  ): Promise<boolean> {
    assertUuid(leaseToken, "leaseToken");
    assertIsoDate(now);
    const result = await this.db
      .prepare(
        `UPDATE fake_notification_outbox
         SET status = 'DELIVERED', delivered_at = ?, updated_at = ?,
             lease_token = NULL, lease_expires_at = NULL
         WHERE notification_id = ? AND status = 'SENDING' AND lease_token = ?`,
      )
      .bind(now, now, notificationId, leaseToken)
      .run();
    return changes(result) === 1;
  }

  async recordFakeNotificationFailed(
    notificationId: string,
    leaseToken: string,
    now: string,
  ): Promise<boolean> {
    assertUuid(leaseToken, "leaseToken");
    assertIsoDate(now);
    const result = await this.db
      .prepare(
        `UPDATE fake_notification_outbox
         SET status = 'PENDING', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE notification_id = ? AND status = 'SENDING' AND lease_token = ?`,
      )
      .bind(now, notificationId, leaseToken)
      .run();
    return changes(result) === 1;
  }

  async identityAuditCount(
    teacherId: string,
    action?: "BOUND" | "BIND_REJECTED" | "UNBOUND",
  ): Promise<number> {
    assertInternalId(teacherId, "teacherId");
    const row = action
      ? await this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM teacher_identity_audits WHERE teacher_id = ? AND action = ?",
          )
          .bind(teacherId, action)
          .first<{ count: number }>()
      : await this.db
          .prepare("SELECT COUNT(*) AS count FROM teacher_identity_audits WHERE teacher_id = ?")
          .bind(teacherId)
          .first<{ count: number }>();
    return row?.count ?? 0;
  }
}
