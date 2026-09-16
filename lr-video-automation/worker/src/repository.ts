import {
  assertCreateVideoJobInput,
  assertApprovedContentVersion,
  assertInternalId,
  assertUuid,
  buildIdempotencyKey,
  type Actor,
  type CreateVideoJobInput,
  type JobState,
  type MediaDestination,
  normalizeQueueEvent,
  type TransitionJobInput,
  type VideoJob,
} from "./domain";
import {
  ConcurrentUpdateError,
  ForbiddenError,
  InvalidTransitionError,
  JobIdentityCollisionError,
  MutationCollisionError,
  NotFoundError,
  PublicationClaimBlockedError,
} from "./errors";
import {
  assertSha256Hex,
  canonicalFingerprint,
  canonicalJson,
  sha256Hex,
} from "./fingerprint";

const JSON_STRINGIFY = JSON.stringify;
const OBJECT_ASSIGN = Object.assign;
const OBJECT_CREATE = Object.create;

const ALLOWED_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  RECEIVED: ["VALIDATING"],
  VALIDATING: ["VALIDATION_FAILED", "CLASS_UNRESOLVED", "PROCESSING"],
  VALIDATION_FAILED: [],
  CLASS_UNRESOLVED: ["VALIDATING"],
  PROCESSING: ["WAITING_APPROVAL"],
  WAITING_APPROVAL: ["REJECTED", "APPROVED"],
  REJECTED: [],
  APPROVED: [],
  PUBLISHING: [],
  PARTIALLY_PUBLISHED: [],
  PUBLISHED: [],
  FAILED: [],
};

const MEDIA_STATUS_COLUMNS: Readonly<Record<MediaDestination, string>> = {
  youtube: "youtube_status",
  instagram: "instagram_status",
  tiktok: "tiktok_status",
};

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function changes(result: D1Result): number {
  return result.meta.changes ?? 0;
}

function assertIsoDate(value: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new TypeError("Timestamp must be an ISO-8601 date string");
  }
}

interface AppliedMutationRow {
  video_job_id: string;
  mutation_type: string;
  operation_fingerprint: string;
}

export type PublicationRecordStatus =
  | "PENDING"
  | "CLAIMED"
  | "SUCCEEDED"
  | "FAILED"
  | "OUTCOME_UNKNOWN"
  | "RECONCILIATION_REQUIRED"
  | "HANDED_OFF";

export interface PublicationRecord {
  status: PublicationRecordStatus;
  attempt_no: number;
  result_ref: string | null;
  error_code: string | null;
  provider_reason_code: string | null;
  retryable: 0 | 1 | null;
  yt_committed_offset: number;
  yt_video_id: string | null;
  yt_session_state: "NONE" | "ACTIVE" | "UNUSABLE";
  yt_reconciled_at: string | null;
  updated_at: string;
}

const SAFE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function assertSafeErrorCode(value: string, field: string): void {
  if (!SAFE_ERROR_CODE_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a safe fixed code`);
  }
}

function appliedMutationMatches(
  applied: AppliedMutationRow,
  videoJobId: string,
  mutationType: string,
  operationFingerprint: string,
): boolean {
  return applied.video_job_id === videoJobId &&
    applied.mutation_type === mutationType &&
    applied.operation_fingerprint === operationFingerprint;
}

export class JobRepository {
  private readonly retentionDays: number;
  private readonly deletionOperatorIds: ReadonlySet<string>;

  constructor(
    private readonly db: D1Database,
    options: { retentionDays?: number; deletionOperatorIds?: readonly string[] } = {},
  ) {
    this.retentionDays = options.retentionDays ?? 30;
    if (!Number.isInteger(this.retentionDays) || this.retentionDays <= 0) {
      throw new TypeError("retentionDays must be a positive integer");
    }
    this.deletionOperatorIds = new Set(options.deletionOperatorIds ?? []);
  }

  private async hasBlockingYoutubePublication(
    videoJobId: string,
    approvedContentVersion: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    const blocker = await this.db
      .prepare(
        `SELECT 1 AS blocked
         FROM idempotency_records
         WHERE video_job_id = ? AND approved_content_version = ?
           AND destination = 'youtube' AND idempotency_key <> ?
           AND status IN ('OUTCOME_UNKNOWN', 'RECONCILIATION_REQUIRED')
         LIMIT 1`,
      )
      .bind(videoJobId, approvedContentVersion, idempotencyKey)
      .first<{ blocked: number }>();
    return blocker?.blocked === 1;
  }

  private async bindNoopMutation(input: {
    mutationToken: string;
    videoJobId: string;
    mutationType: string;
    operationFingerprint: string;
    now: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO applied_mutations (
           mutation_token, video_job_id, mutation_type, operation_fingerprint,
           result_row_version, applied_at
         ) VALUES (
           ?, ?, ?, ?,
           (SELECT row_version FROM video_jobs WHERE video_job_id = ?), ?
         )
         ON CONFLICT(mutation_token) DO NOTHING`,
      )
      .bind(
        input.mutationToken,
        input.videoJobId,
        input.mutationType,
        input.operationFingerprint,
        input.videoJobId,
        input.now,
      )
      .run();
    const applied = await this.db
      .prepare(
        `SELECT video_job_id, mutation_type, operation_fingerprint
         FROM applied_mutations WHERE mutation_token = ?`,
      )
      .bind(input.mutationToken)
      .first<AppliedMutationRow>();
    if (!applied || !appliedMutationMatches(
      applied,
      input.videoJobId,
      input.mutationType,
      input.operationFingerprint,
    )) throw new MutationCollisionError();
  }

  async createVideoJob(input: CreateVideoJobInput): Promise<VideoJob> {
    assertCreateVideoJobInput(input);
    assertIsoDate(input.now);
    const auditId = id("audit");
    const mirrorEventId = id("mirror");
    const creationToken = id("creation");
    const creationFingerprint = await canonicalFingerprint({
      operation: "job.create",
      video_job_id: input.videoJobId,
      submission_id: input.submissionId,
      branch_id: input.branchId,
      studio_id: input.studioId,
      class_id: input.classId,
      teacher_id: input.teacherId,
      actor: input.actor,
    });
    const payload = JSON.stringify({
      video_job_id: input.videoJobId,
      state: "RECEIVED",
      row_version: 0,
    });

    const results = await this.db.batch([
      this.db
        .prepare(
           `INSERT INTO video_jobs (
             video_job_id, submission_id, branch_id, studio_id, class_id, teacher_id,
             state, creation_token, creation_fingerprint, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?, ?, ?)
           ON CONFLICT(video_job_id) DO NOTHING`,
        )
        .bind(
          input.videoJobId,
          input.submissionId,
          input.branchId,
          input.studioId,
          input.classId,
          input.teacherId,
          creationToken,
          creationFingerprint,
          input.now,
          input.now,
        ),
      this.db
        .prepare(
          `INSERT INTO audit_logs (
             audit_id, video_job_id, actor_type, actor_id, action,
             from_state, to_state, details_json, occurred_at
           )
           SELECT ?, video_job_id, ?, ?, 'job.created', NULL, 'RECEIVED', '{}', ?
           FROM video_jobs
           WHERE video_job_id = ? AND row_version = 0 AND creation_token = ?`,
        )
        .bind(
          auditId,
          input.actor.type,
          input.actor.id,
          input.now,
          input.videoJobId,
          creationToken,
        ),
      this.db
        .prepare(
          `INSERT INTO mirror_outbox (
             mirror_event_id, video_job_id, event_type, payload_json,
             available_at, created_at, updated_at
           )
           SELECT ?, video_job_id, 'job.state.changed', ?, ?, ?, ?
           FROM video_jobs
           WHERE video_job_id = ? AND row_version = 0 AND creation_token = ?`,
        )
        .bind(
          mirrorEventId,
          payload,
          input.now,
          input.now,
          input.now,
          input.videoJobId,
          creationToken,
        ),
    ]);

    if (changes(results[0]!) === 0) {
      const existing = await this.getVideoJob(input.videoJobId);
      if (existing?.creation_fingerprint === creationFingerprint) return existing;
      if (existing) throw new JobIdentityCollisionError();
      throw new ConcurrentUpdateError();
    }

    return (await this.getVideoJob(input.videoJobId))!;
  }

  async getVideoJob(videoJobId: string): Promise<VideoJob | null> {
    return this.db
      .prepare("SELECT * FROM video_jobs WHERE video_job_id = ?")
      .bind(videoJobId)
      .first<VideoJob>();
  }

  async getPublicationRecord(input: {
    videoJobId: string;
    destination: MediaDestination;
    targetAccountId: string;
    approvedContentVersion: string;
  }): Promise<PublicationRecord | null> {
    const idempotencyKey = buildIdempotencyKey(
      input.videoJobId,
      input.destination,
      input.targetAccountId,
      input.approvedContentVersion,
    );
    return this.db
      .prepare(
        `SELECT status, attempt_no, result_ref, error_code, provider_reason_code, retryable,
                yt_committed_offset, yt_video_id, yt_session_state, yt_reconciled_at, updated_at
         FROM idempotency_records
         WHERE idempotency_key = ?`,
      )
      .bind(idempotencyKey)
      .first<PublicationRecord>();
  }

  async prepareYoutubeSideEffect(input: {
    videoJobId: string;
    targetAccountId: string;
    approvedContentVersion: string;
    claimMutationToken: string;
    fenceToken: string;
    now: string;
  }): Promise<{ allowed: boolean; attemptNo: number | null }> {
    assertUuid(input.videoJobId, "videoJobId");
    assertInternalId(input.targetAccountId, "targetAccountId");
    assertApprovedContentVersion(input.approvedContentVersion);
    assertInternalId(input.claimMutationToken, "claimMutationToken");
    assertInternalId(input.fenceToken, "fenceToken");
    assertIsoDate(input.now);
    const idempotencyKey = buildIdempotencyKey(
      input.videoJobId,
      "youtube",
      input.targetAccountId,
      input.approvedContentVersion,
    );

    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO youtube_publication_attempts (
           idempotency_key, attempt_no, fence_token, state, created_at, updated_at
         )
         SELECT idempotency_key, attempt_no, ?, 'SIDE_EFFECT_ALLOWED', ?, ?
         FROM idempotency_records
         WHERE idempotency_key = ? AND destination = 'youtube'
           AND status = 'CLAIMED' AND last_mutation_token = ?
           AND yt_committed_offset = 0 AND yt_video_id IS NULL
           AND yt_session_state = 'NONE'
           AND NOT EXISTS (
             SELECT 1 FROM youtube_reconciliation_observations o
             WHERE o.idempotency_key = idempotency_records.idempotency_key
               AND o.result = 'FOUND'
           )
         ON CONFLICT(idempotency_key, attempt_no) DO NOTHING`,
      ).bind(
        input.fenceToken,
        input.now,
        input.now,
        idempotencyKey,
        input.claimMutationToken,
      ),
      this.db.prepare(
        `UPDATE idempotency_records
         SET yt_session_state = 'ACTIVE', updated_at = ?
         WHERE idempotency_key = ? AND status = 'CLAIMED'
           AND last_mutation_token = ?
           AND yt_committed_offset = 0 AND yt_video_id IS NULL
           AND yt_session_state = 'NONE'
           AND NOT EXISTS (
             SELECT 1 FROM youtube_reconciliation_observations o
             WHERE o.idempotency_key = idempotency_records.idempotency_key
               AND o.result = 'FOUND'
           )
           AND EXISTS (
             SELECT 1 FROM youtube_publication_attempts a
             WHERE a.idempotency_key = idempotency_records.idempotency_key
               AND a.attempt_no = idempotency_records.attempt_no
               AND a.fence_token = ?
               AND a.state = 'SIDE_EFFECT_ALLOWED'
           )`,
      ).bind(
        input.now,
        idempotencyKey,
        input.claimMutationToken,
        input.fenceToken,
      ),
    ]);

    // Only this transaction's insert and activation confer permission. A replay (including
    // the same fence token) or a lost acknowledgement must never confer it again.
    if (changes(results[0]!) !== 1 || changes(results[1]!) !== 1) {
      return { allowed: false, attemptNo: null };
    }
    const attempt = await this.db.prepare(
      `SELECT a.attempt_no
       FROM youtube_publication_attempts a
       JOIN idempotency_records r ON r.idempotency_key = a.idempotency_key
       WHERE a.idempotency_key = ? AND a.fence_token = ?
         AND a.attempt_no = r.attempt_no
         AND r.status = 'CLAIMED' AND r.last_mutation_token = ?
         AND r.yt_session_state = 'ACTIVE'
         AND NOT EXISTS (
           SELECT 1 FROM youtube_reconciliation_observations o
           WHERE o.idempotency_key = r.idempotency_key AND o.result = 'FOUND'
         )`,
    ).bind(
      idempotencyKey,
      input.fenceToken,
      input.claimMutationToken,
    ).first<{ attempt_no: number }>();
    return { allowed: attempt !== null, attemptNo: attempt?.attempt_no ?? null };
  }

  async recordYoutubeUploadProgress(input: {
    videoJobId: string;
    targetAccountId: string;
    approvedContentVersion: string;
    fenceToken: string;
    committedOffset: number;
    videoId?: string;
    sessionState?: "ACTIVE" | "UNUSABLE";
    now: string;
  }): Promise<boolean> {
    assertUuid(input.videoJobId, "videoJobId");
    assertInternalId(input.targetAccountId, "targetAccountId");
    assertApprovedContentVersion(input.approvedContentVersion);
    assertInternalId(input.fenceToken, "fenceToken");
    assertIsoDate(input.now);
    if (!Number.isSafeInteger(input.committedOffset) || input.committedOffset < 0) {
      throw new TypeError("committedOffset must be a non-negative safe integer");
    }
    if (input.videoId && !/^[A-Za-z0-9_-]{11}$/.test(input.videoId)) {
      throw new TypeError("videoId must be a safe opaque YouTube video ID");
    }
    const idempotencyKey = buildIdempotencyKey(
      input.videoJobId,
      "youtube",
      input.targetAccountId,
      input.approvedContentVersion,
    );
    const state = input.sessionState ?? "ACTIVE";
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE youtube_publication_attempts
         SET state = 'UPLOADING', committed_offset = ?,
             video_id = COALESCE(?, video_id), updated_at = ?
         WHERE idempotency_key = ? AND fence_token = ?
           AND state IN ('SIDE_EFFECT_ALLOWED', 'UPLOADING')
           AND committed_offset <= ?
           AND (video_id IS NULL OR ? IS NULL OR video_id = ?)
           AND EXISTS (
             SELECT 1 FROM idempotency_records r
             WHERE r.idempotency_key = youtube_publication_attempts.idempotency_key
               AND r.attempt_no = youtube_publication_attempts.attempt_no
               AND r.status = 'CLAIMED'
           )`,
      ).bind(
        input.committedOffset,
        input.videoId ?? null,
        input.now,
        idempotencyKey,
        input.fenceToken,
        input.committedOffset,
        input.videoId ?? null,
        input.videoId ?? null,
      ),
      this.db.prepare(
        `UPDATE idempotency_records
         SET yt_committed_offset = ?, yt_video_id = COALESCE(?, yt_video_id),
             yt_session_state = ?, updated_at = ?
         WHERE idempotency_key = ? AND status = 'CLAIMED'
           AND yt_committed_offset <= ?
           AND (yt_video_id IS NULL OR ? IS NULL OR yt_video_id = ?)
           AND EXISTS (
             SELECT 1 FROM youtube_publication_attempts a
             WHERE a.idempotency_key = idempotency_records.idempotency_key
               AND a.attempt_no = idempotency_records.attempt_no
               AND a.fence_token = ? AND a.state = 'UPLOADING'
               AND a.committed_offset = ?
               AND (? IS NULL OR a.video_id = ?)
           )`,
      ).bind(
        input.committedOffset,
        input.videoId ?? null,
        state,
        input.now,
        idempotencyKey,
        input.committedOffset,
        input.videoId ?? null,
        input.videoId ?? null,
        input.fenceToken,
        input.committedOffset,
        input.videoId ?? null,
        input.videoId ?? null,
      ),
    ]);
    return changes(results[1]!) === 1;
  }

  async beginYoutubeReconciliationObservation(input: {
    videoJobId: string;
    targetAccountId: string;
    approvedContentVersion: string;
    observationToken: string;
    now: string;
    expiresAt: string;
  }): Promise<boolean> {
    assertUuid(input.videoJobId, "videoJobId");
    assertInternalId(input.targetAccountId, "targetAccountId");
    assertApprovedContentVersion(input.approvedContentVersion);
    assertInternalId(input.observationToken, "observationToken");
    assertIsoDate(input.now);
    assertIsoDate(input.expiresAt);
    const idempotencyKey = buildIdempotencyKey(
      input.videoJobId, "youtube", input.targetAccountId, input.approvedContentVersion,
    );
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE youtube_reconciliation_observations
         SET result = 'TIMED_OUT'
         WHERE idempotency_key = ? AND result = 'IN_FLIGHT' AND expires_at <= ?
           AND attempt_no = (
             SELECT attempt_no FROM idempotency_records
             WHERE idempotency_key = ? AND status = 'RECONCILIATION_REQUIRED'
           )`,
      ).bind(idempotencyKey, input.now, idempotencyKey),
      this.db.prepare(
        `INSERT INTO youtube_reconciliation_observations (
           observation_token, idempotency_key, attempt_no, result, started_at, expires_at
         )
         SELECT ?, idempotency_key, attempt_no, 'IN_FLIGHT', ?, ?
         FROM idempotency_records
         WHERE idempotency_key = ? AND status = 'RECONCILIATION_REQUIRED'
         ON CONFLICT(observation_token) DO NOTHING`,
      ).bind(
        input.observationToken, input.now, input.expiresAt, idempotencyKey,
      ),
    ]);
    return changes(results[1]!) === 1;
  }

  async completeYoutubeReconciliationObservation(input: {
    observationToken: string;
    result: "FOUND" | "NONE";
    now: string;
  }): Promise<boolean> {
    assertInternalId(input.observationToken, "observationToken");
    assertIsoDate(input.now);
    const updated = await this.db.prepare(
      `UPDATE youtube_reconciliation_observations
       SET result = ?, completed_at = ?
       WHERE observation_token = ? AND (
         (result = 'IN_FLIGHT' AND expires_at > ?)
         OR (? = 'FOUND' AND result IN ('IN_FLIGHT', 'TIMED_OUT'))
       )`,
    ).bind(input.result, input.now, input.observationToken, input.now, input.result).run();
    return changes(updated) === 1;
  }

  async markYoutubeSessionUnusableForReconciliation(input: {
    videoJobId: string;
    targetAccountId: string;
    approvedContentVersion: string;
    now: string;
  }): Promise<boolean> {
    assertUuid(input.videoJobId, "videoJobId");
    assertInternalId(input.targetAccountId, "targetAccountId");
    assertApprovedContentVersion(input.approvedContentVersion);
    assertIsoDate(input.now);
    const idempotencyKey = buildIdempotencyKey(
      input.videoJobId,
      "youtube",
      input.targetAccountId,
      input.approvedContentVersion,
    );
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE idempotency_records
         SET yt_session_state = 'UNUSABLE', updated_at = ?
         WHERE idempotency_key = ? AND status = 'RECONCILIATION_REQUIRED'
           AND yt_session_state = 'ACTIVE'`,
      ).bind(input.now, idempotencyKey),
      this.db.prepare(
        `UPDATE youtube_publication_attempts
         SET updated_at = ?
         WHERE idempotency_key = ?
           AND attempt_no = (
             SELECT attempt_no FROM idempotency_records
             WHERE idempotency_key = ? AND status = 'RECONCILIATION_REQUIRED'
               AND yt_session_state = 'UNUSABLE'
           )
           AND state = 'RECONCILIATION_REQUIRED'`,
      ).bind(input.now, idempotencyKey, idempotencyKey),
    ]);
    return changes(results[0]!) === 1;
  }

  async recordYoutubeReconciliationNone(input: {
    videoJobId: string;
    targetAccountId: string;
    approvedContentVersion: string;
    expectedVideoId: string;
    actor: Actor;
    now: string;
  }): Promise<{ cleared: boolean; job: VideoJob }> {
    assertUuid(input.videoJobId, "videoJobId");
    assertInternalId(input.targetAccountId, "targetAccountId");
    assertApprovedContentVersion(input.approvedContentVersion);
    assertInternalId(input.actor.id, "actor.id");
    assertIsoDate(input.now);
    if (!/^[A-Za-z0-9_-]{11}$/.test(input.expectedVideoId)) {
      throw new TypeError("expectedVideoId must be a safe opaque YouTube video ID");
    }
    const current = await this.getVideoJob(input.videoJobId);
    if (!current) throw new NotFoundError("Video job");
    const idempotencyKey = buildIdempotencyKey(
      input.videoJobId,
      "youtube",
      input.targetAccountId,
      input.approvedContentVersion,
    );
    const before = await this.getPublicationRecord({
      videoJobId: input.videoJobId,
      destination: "youtube",
      targetAccountId: input.targetAccountId,
      approvedContentVersion: input.approvedContentVersion,
    });
    if (
      !before || before.status !== "RECONCILIATION_REQUIRED" ||
      before.yt_session_state !== "UNUSABLE" || before.yt_video_id !== input.expectedVideoId
    ) return { cleared: false, job: current };
    const canClear = await this.db.prepare(
      `SELECT 1 AS allowed
       FROM idempotency_records r
       WHERE r.idempotency_key = ? AND r.status = 'RECONCILIATION_REQUIRED'
         AND r.yt_session_state = 'UNUSABLE' AND r.yt_video_id = ?
         AND EXISTS (
           SELECT 1 FROM youtube_reconciliation_observations observed_none
           WHERE observed_none.idempotency_key = r.idempotency_key
             AND observed_none.attempt_no = r.attempt_no
             AND observed_none.result = 'NONE'
         )
         AND NOT EXISTS (
           SELECT 1 FROM youtube_reconciliation_observations observed_found
           WHERE observed_found.idempotency_key = r.idempotency_key
             AND observed_found.attempt_no = r.attempt_no
             AND observed_found.result = 'FOUND'
         )
         AND NOT EXISTS (
           SELECT 1 FROM youtube_reconciliation_observations active_lookup
           WHERE active_lookup.idempotency_key = r.idempotency_key
             AND active_lookup.attempt_no = r.attempt_no
             AND active_lookup.result IN ('IN_FLIGHT', 'TIMED_OUT')
         )`,
    ).bind(
      idempotencyKey,
      input.expectedVideoId,
    ).first<{ allowed: number }>();
    if (!canClear) return { cleared: false, job: current };
    const mutationToken = id("youtube_reconciled_none");
    const operationFingerprint = await canonicalFingerprint({
      operation: "publication.reconciled.none",
      video_job_id: input.videoJobId,
      destination: "youtube",
      target_account_id: input.targetAccountId,
      approved_content_version: input.approvedContentVersion,
      expected_video_id: input.expectedVideoId,
      actor: input.actor,
    });
    const nextVersion = current.row_version + 1;
    const auditId = id("audit_youtube_reconciled");
    const mirrorEventId = id("mirror_youtube_reconciled");
    let results: D1Result[];
    try {
      results = await this.db.batch([
      this.db.prepare(
        `UPDATE youtube_publication_attempts
         SET state = 'SUPERSEDED', updated_at = ?
         WHERE idempotency_key = ?
           AND attempt_no = (
             SELECT attempt_no FROM idempotency_records
             WHERE idempotency_key = ? AND status = 'RECONCILIATION_REQUIRED'
               AND yt_session_state = 'UNUSABLE' AND yt_video_id = ?
           )
           AND state IN ('OUTCOME_UNKNOWN', 'RECONCILIATION_REQUIRED')`,
      ).bind(input.now, idempotencyKey, idempotencyKey, input.expectedVideoId),
      this.db.prepare(
        `UPDATE idempotency_records
         SET status = 'PENDING', result_ref = NULL,
             error_code = 'YOUTUBE_RECONCILED_NONE', provider_reason_code = NULL,
             retryable = 1, yt_committed_offset = 0, yt_video_id = NULL,
             yt_session_state = 'NONE', yt_reconciled_at = ?,
             last_mutation_token = ?, updated_at = ?
         WHERE idempotency_key = ? AND status = 'RECONCILIATION_REQUIRED'
           AND yt_session_state = 'UNUSABLE' AND yt_video_id = ?
           AND EXISTS (
             SELECT 1 FROM youtube_reconciliation_observations observed_none
             WHERE observed_none.idempotency_key = idempotency_records.idempotency_key
               AND observed_none.attempt_no = idempotency_records.attempt_no
               AND observed_none.result = 'NONE'
             )
           AND NOT EXISTS (
             SELECT 1 FROM youtube_reconciliation_observations observed_found
             WHERE observed_found.idempotency_key = idempotency_records.idempotency_key
               AND observed_found.attempt_no = idempotency_records.attempt_no
               AND observed_found.result = 'FOUND'
           )
           AND NOT EXISTS (
             SELECT 1 FROM youtube_reconciliation_observations active_lookup
             WHERE active_lookup.idempotency_key = idempotency_records.idempotency_key
               AND active_lookup.attempt_no = idempotency_records.attempt_no
               AND active_lookup.result IN ('IN_FLIGHT', 'TIMED_OUT')
           )
           AND EXISTS (
             SELECT 1 FROM youtube_publication_attempts a
             WHERE a.idempotency_key = idempotency_records.idempotency_key
               AND a.attempt_no = idempotency_records.attempt_no
               AND a.state = 'SUPERSEDED'
           )`,
      ).bind(
        input.now,
        mutationToken,
        input.now,
        idempotencyKey,
        input.expectedVideoId,
        ),
      this.db.prepare(
        `UPDATE video_jobs
         SET youtube_status = 'PENDING', state = 'PUBLISHING',
             last_mutation_token = ?, row_version = row_version + 1, updated_at = ?
         WHERE video_job_id = ? AND row_version = ?
           AND approved_content_version = ?
           AND EXISTS (
             SELECT 1 FROM idempotency_records r
             WHERE r.idempotency_key = ? AND r.status = 'PENDING'
               AND r.last_mutation_token = ?
           )`,
      ).bind(
        mutationToken,
        input.now,
        input.videoJobId,
        current.row_version,
        input.approvedContentVersion,
        idempotencyKey,
        mutationToken,
      ),
      this.db.prepare(
        `INSERT INTO applied_mutations (
           mutation_token, video_job_id, mutation_type, operation_fingerprint,
           result_row_version, applied_at
         ) VALUES (
           ?, ?, 'publication.reconciled.none', ?,
           (SELECT row_version FROM video_jobs
            WHERE video_job_id = ? AND row_version = ? AND last_mutation_token = ?), ?
         )`,
      ).bind(
        mutationToken,
        input.videoJobId,
        operationFingerprint,
        input.videoJobId,
        nextVersion,
        mutationToken,
        input.now,
      ),
      this.db.prepare(
        `INSERT INTO audit_logs (
           audit_id, video_job_id, actor_type, actor_id, action,
           from_state, to_state, details_json, occurred_at
         )
         SELECT ?, video_job_id, ?, ?, 'publication.reconciled', ?, state,
           json_object(
             'destination', 'youtube',
             'target_account_id', ?,
             'result', 'none',
             'attempt_no', (
               SELECT attempt_no FROM idempotency_records WHERE idempotency_key = ?
             )
           ), ?
         FROM video_jobs
         WHERE video_job_id = ? AND row_version = ? AND last_mutation_token = ?`,
      ).bind(
        auditId,
        input.actor.type,
        input.actor.id,
        current.state,
        input.targetAccountId,
        idempotencyKey,
        input.now,
        input.videoJobId,
        nextVersion,
        mutationToken,
      ),
      this.db.prepare(
        `INSERT INTO mirror_outbox (
           mirror_event_id, video_job_id, event_type, payload_json,
           available_at, created_at, updated_at
         )
         SELECT ?, video_job_id, 'job.state.changed',
           json_object(
             'video_job_id', video_job_id,
             'state', state,
             'youtube_status', youtube_status,
             'instagram_status', instagram_status,
             'tiktok_status', tiktok_status,
             'retention_state', retention_state,
             'row_version', row_version
           ), ?, ?, ?
         FROM video_jobs
         WHERE video_job_id = ? AND row_version = ? AND last_mutation_token = ?`,
      ).bind(
        mirrorEventId,
        input.now,
        input.now,
        input.now,
        input.videoJobId,
        nextVersion,
        mutationToken,
      ),
      ]);
    } catch (error) {
      const latest = await this.getPublicationRecord({
        videoJobId: input.videoJobId,
        destination: "youtube",
        targetAccountId: input.targetAccountId,
        approvedContentVersion: input.approvedContentVersion,
      });
      const latestJob = await this.getVideoJob(input.videoJobId);
      if (
        latest && latestJob &&
        (latest.status !== "RECONCILIATION_REQUIRED" ||
          latest.yt_session_state !== "UNUSABLE" ||
          latest.yt_video_id !== input.expectedVideoId)
      ) return { cleared: false, job: latestJob };
      throw error;
    }
    const cleared = changes(results[1]!) === 1 && changes(results[2]!) === 1;
    if (!cleared && (changes(results[1]!) !== 0 || changes(results[2]!) !== 0)) {
      throw new ConcurrentUpdateError();
    }
    return { cleared, job: (await this.getVideoJob(input.videoJobId))! };
  }

  async recordYoutubePublicationPolicyRejection(input: {
    videoJobId: string;
    targetAccountId: string;
    approvedContentVersion: string;
    actor: Actor;
    now: string;
    expectedRowVersion: number;
    errorCode: "YOUTUBE_PRIVATE_ONLY" | "YOUTUBE_SCHEDULE_NOT_ALLOWED";
  }): Promise<VideoJob> {
    assertUuid(input.videoJobId, "videoJobId");
    assertInternalId(input.targetAccountId, "targetAccountId");
    assertApprovedContentVersion(input.approvedContentVersion);
    assertInternalId(input.actor.id, "actor.id");
    assertIsoDate(input.now);
    if (!Number.isSafeInteger(input.expectedRowVersion) || input.expectedRowVersion < 0) {
      throw new TypeError("expectedRowVersion must be a non-negative safe integer");
    }
    assertSafeErrorCode(input.errorCode, "errorCode");
    const auditInsert = await this.db
      .prepare(
        `INSERT INTO audit_logs (
           audit_id, video_job_id, actor_type, actor_id, action,
           from_state, to_state, details_json, occurred_at
         )
         SELECT ?, j.video_job_id, ?, ?, 'publication.policy_rejected',
                j.state, j.state, ?, ?
         FROM video_jobs j
         JOIN idempotency_records r
           ON r.video_job_id = j.video_job_id
          AND r.destination = 'youtube'
          AND r.target_account_id = ?
          AND r.approved_content_version = j.approved_content_version
          AND r.status = 'PENDING'
         WHERE j.video_job_id = ?
           AND j.state = 'APPROVED'
           AND j.approved_content_version = ?
           AND j.row_version = ?`,
      )
      .bind(
        id("audit_policy"),
        input.actor.type,
        input.actor.id,
        JSON_STRINGIFY(OBJECT_ASSIGN(OBJECT_CREATE(null), {
          destination: "youtube",
          target_account_id: input.targetAccountId,
          error_code: input.errorCode,
        })),
        input.now,
        input.targetAccountId,
        input.videoJobId,
        input.approvedContentVersion,
        input.expectedRowVersion,
      )
      .run();
    if (changes(auditInsert) !== 1) throw new ConcurrentUpdateError();
    const current = await this.getVideoJob(input.videoJobId);
    if (!current) throw new NotFoundError("Video job");
    return current;
  }

  async transitionJob(input: TransitionJobInput): Promise<VideoJob> {
    assertIsoDate(input.now);
    assertInternalId(input.actor.id, "actor.id");
    if (!ALLOWED_TRANSITIONS[input.expectedState].includes(input.nextState)) {
      throw new InvalidTransitionError(input.expectedState, input.nextState);
    }
    if (input.nextState === "APPROVED" && !input.approvedContentVersion) {
      throw new InvalidTransitionError(input.expectedState, input.nextState);
    }
    if (input.nextState === "APPROVED") {
      assertApprovedContentVersion(input.approvedContentVersion!);
      if (!input.publicationTargets?.length) {
        throw new InvalidTransitionError(input.expectedState, input.nextState);
      }
      const uniqueTargets = new Set<string>();
      for (const target of input.publicationTargets) {
        if (!Object.hasOwn(MEDIA_STATUS_COLUMNS, target.destination)) {
          throw new TypeError("publicationTargets.destination is invalid");
        }
        assertInternalId(target.targetAccountId, "publicationTargets.targetAccountId");
        const key = `${target.destination}:${target.targetAccountId}`;
        if (uniqueTargets.has(key)) throw new TypeError("publicationTargets must be unique");
        uniqueTargets.add(key);
      }
    }

    const current = await this.getVideoJob(input.videoJobId);
    if (!current) throw new NotFoundError("Video job");
    const mutationToken = input.mutationToken ?? id("mutation");
    assertInternalId(mutationToken, "mutationToken");
    const mutationType = "job.transition";
    const operationFingerprint = await canonicalFingerprint({
      operation: mutationType,
      video_job_id: input.videoJobId,
      expected_state: input.expectedState,
      next_state: input.nextState,
      actor: input.actor,
      approved_content_version: input.approvedContentVersion ?? null,
      publication_targets: [...(input.publicationTargets ?? [])]
        .map((target) => ({
          destination: target.destination,
          target_account_id: target.targetAccountId,
        }))
        .sort((left, right) =>
          `${left.destination}:${left.target_account_id}`.localeCompare(
            `${right.destination}:${right.target_account_id}`,
          )),
    });
    const applied = await this.db
      .prepare(
        `SELECT video_job_id, mutation_type, operation_fingerprint
         FROM applied_mutations WHERE mutation_token = ?`,
      )
      .bind(mutationToken)
      .first<AppliedMutationRow>();
    if (applied) {
      if (!appliedMutationMatches(
        applied,
        input.videoJobId,
        mutationType,
        operationFingerprint,
      )) throw new MutationCollisionError();
      return current;
    }
    if (current.state !== input.expectedState) throw new ConcurrentUpdateError();

    const nextVersion = current.row_version + 1;
    const startsRetention = input.nextState === "REJECTED";
    const deleteDueAt = startsRetention
      ? new Date(Date.parse(input.now) + this.retentionDays * 86_400_000).toISOString()
      : null;
    const auditId = id("audit");
    const mirrorEventId = id("mirror");
    const payload = JSON.stringify({
      video_job_id: input.videoJobId,
      from_state: input.expectedState,
      to_state: input.nextState,
      ...(startsRetention
        ? {
            retention_state: "RETAINED",
            retention_start_at: input.now,
            delete_due_at: deleteDueAt,
          }
        : {}),
      row_version: nextVersion,
    });
    const auditDetails = JSON.stringify(
      startsRetention
        ? { retention_state: "RETAINED", delete_due_at: deleteDueAt }
        : {},
    );

    let results: D1Result[];
    try {
      const targets = input.nextState === "APPROVED" ? input.publicationTargets! : [];
      const targetDestinations = new Set(targets.map((target) => target.destination));
      const targetStatements = targets.map((target) => {
        const idempotencyKey = buildIdempotencyKey(
          input.videoJobId,
          target.destination,
          target.targetAccountId,
          input.approvedContentVersion!,
        );
        return this.db
          .prepare(
            `INSERT INTO idempotency_records (
               idempotency_key, video_job_id, destination, target_account_id,
               approved_content_version, status, attempt_no, created_at, updated_at
             )
             SELECT ?, video_job_id, ?, ?, ?, 'PENDING', 1, ?, ?
             FROM video_jobs
             WHERE video_job_id = ? AND state = 'APPROVED' AND row_version = ?
               AND last_mutation_token = ?`,
          )
          .bind(
            idempotencyKey,
            target.destination,
            target.targetAccountId,
            input.approvedContentVersion!,
            input.now,
            input.now,
            input.videoJobId,
            nextVersion,
            mutationToken,
          );
      });
      results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE video_jobs
           SET state = ?,
               approved_content_version = CASE WHEN ? = 'APPROVED' THEN ? ELSE approved_content_version END,
               youtube_status = CASE WHEN ? = 'APPROVED' THEN ? ELSE youtube_status END,
               instagram_status = CASE WHEN ? = 'APPROVED' THEN ? ELSE instagram_status END,
               tiktok_status = CASE WHEN ? = 'APPROVED' THEN ? ELSE tiktok_status END,
               retention_state = CASE WHEN ? = 1 THEN 'RETAINED' ELSE retention_state END,
               retention_start_at = CASE WHEN ? = 1 THEN ? ELSE retention_start_at END,
               delete_due_at = CASE WHEN ? = 1 THEN ? ELSE delete_due_at END,
               last_mutation_token = ?,
               row_version = row_version + 1,
               updated_at = ?
           WHERE video_job_id = ? AND state = ? AND row_version = ?`,
        )
        .bind(
          input.nextState,
          input.nextState,
          input.approvedContentVersion ?? null,
          input.nextState,
          targetDestinations.has("youtube") ? "PENDING" : "SKIPPED",
          input.nextState,
          targetDestinations.has("instagram") ? "PENDING" : "SKIPPED",
          input.nextState,
          targetDestinations.has("tiktok") ? "PENDING" : "SKIPPED",
          startsRetention ? 1 : 0,
          startsRetention ? 1 : 0,
          input.now,
          startsRetention ? 1 : 0,
          deleteDueAt,
          mutationToken,
          input.now,
          input.videoJobId,
          input.expectedState,
          current.row_version,
        ),
      ...targetStatements,
      this.db
        .prepare(
          `INSERT INTO applied_mutations (
             mutation_token, video_job_id, mutation_type, operation_fingerprint,
             result_row_version, applied_at
           )
           SELECT ?, video_job_id, 'job.transition', ?, row_version, ?
           FROM video_jobs
           WHERE video_job_id = ? AND state = ? AND row_version = ?
             AND last_mutation_token = ?`,
        )
        .bind(
          mutationToken,
          operationFingerprint,
          input.now,
          input.videoJobId,
          input.nextState,
          nextVersion,
          mutationToken,
        ),
      this.db
        .prepare(
          `INSERT INTO audit_logs (
             audit_id, video_job_id, actor_type, actor_id, action,
             from_state, to_state, details_json, occurred_at
           )
           SELECT ?, video_job_id, ?, ?, 'job.state.changed', ?, ?, ?, ?
           FROM video_jobs WHERE video_job_id = ? AND state = ? AND row_version = ?
             AND last_mutation_token = ?`,
        )
        .bind(
          auditId,
          input.actor.type,
          input.actor.id,
          input.expectedState,
          input.nextState,
          auditDetails,
          input.now,
          input.videoJobId,
          input.nextState,
          nextVersion,
          mutationToken,
        ),
      this.db
        .prepare(
          `INSERT INTO mirror_outbox (
             mirror_event_id, video_job_id, event_type, payload_json,
             available_at, created_at, updated_at
           )
           SELECT ?, video_job_id, 'job.state.changed', ?, ?, ?, ?
           FROM video_jobs WHERE video_job_id = ? AND state = ? AND row_version = ?
             AND last_mutation_token = ?`,
        )
        .bind(
          mirrorEventId,
          payload,
          input.now,
          input.now,
          input.now,
          input.videoJobId,
          input.nextState,
          nextVersion,
          mutationToken,
        ),
      ]);
    } catch (error) {
      const alreadyApplied = await this.db
        .prepare(
          `SELECT video_job_id, mutation_type, operation_fingerprint
           FROM applied_mutations WHERE mutation_token = ?`,
        )
        .bind(mutationToken)
        .first<AppliedMutationRow>();
      if (alreadyApplied && appliedMutationMatches(
        alreadyApplied,
        input.videoJobId,
        mutationType,
        operationFingerprint,
      )) {
        return (await this.getVideoJob(input.videoJobId))!;
      }
      if (alreadyApplied) throw new MutationCollisionError();
      throw error;
    }

    if (changes(results[0]!) !== 1) throw new ConcurrentUpdateError();
    return (await this.getVideoJob(input.videoJobId))!;
  }

  async claimPublication(input: {
    videoJobId: string;
    destination: MediaDestination;
    targetAccountId: string;
    approvedContentVersion: string;
    actor: Actor;
    now: string;
    mutationToken?: string;
  }): Promise<{ claimed: boolean; idempotencyKey: string }> {
    assertIsoDate(input.now);
    assertInternalId(input.actor.id, "actor.id");
    assertInternalId(input.targetAccountId, "targetAccountId");
    const current = await this.getVideoJob(input.videoJobId);
    if (!current) throw new NotFoundError("Video job");
    const idempotencyKey = buildIdempotencyKey(
      input.videoJobId,
      input.destination,
      input.targetAccountId,
      input.approvedContentVersion,
    );
    const mutationToken = input.mutationToken ?? id("mutation");
    assertInternalId(mutationToken, "mutationToken");
    const mutationType = "publication.claim";
    const operationFingerprint = await canonicalFingerprint({
      operation: mutationType,
      video_job_id: input.videoJobId,
      destination: input.destination,
      target_account_id: input.targetAccountId,
      approved_content_version: input.approvedContentVersion,
      actor: input.actor,
    });
    const applied = await this.db
      .prepare(
        `SELECT video_job_id, mutation_type, operation_fingerprint
         FROM applied_mutations WHERE mutation_token = ?`,
      )
      .bind(mutationToken)
      .first<AppliedMutationRow>();
    if (applied) {
      if (!appliedMutationMatches(
        applied,
        input.videoJobId,
        mutationType,
        operationFingerprint,
      )) throw new MutationCollisionError();
      return { claimed: false, idempotencyKey };
    }
    const existing = await this.db
      .prepare("SELECT status FROM idempotency_records WHERE idempotency_key = ?")
      .bind(idempotencyKey)
      .first<{ status: string }>();
    if (!existing) throw new NotFoundError("Publication target");
    if (existing.status !== "PENDING") {
      await this.bindNoopMutation({
        mutationToken,
        videoJobId: input.videoJobId,
        mutationType,
        operationFingerprint,
        now: input.now,
      });
      return { claimed: false, idempotencyKey };
    }
    if (
      !["APPROVED", "PUBLISHING", "PARTIALLY_PUBLISHED"].includes(current.state) ||
      current.approved_content_version !== input.approvedContentVersion
    ) {
      throw new InvalidTransitionError(current.state, "PUBLISHING");
    }
    if (
      input.destination === "youtube" &&
      (await this.hasBlockingYoutubePublication(
        input.videoJobId,
        input.approvedContentVersion,
        idempotencyKey,
      ))
    ) {
      throw new PublicationClaimBlockedError();
    }
    if (input.destination === "youtube") {
      const found = await this.db.prepare(
        `SELECT 1 AS found FROM youtube_reconciliation_observations
         WHERE idempotency_key = ? AND result = 'FOUND' LIMIT 1`,
      ).bind(idempotencyKey).first<{ found: number }>();
      if (found) throw new PublicationClaimBlockedError();
    }

    const statusColumn = MEDIA_STATUS_COLUMNS[input.destination];
    const claimStatus = input.destination === "tiktok" ? "READY_FOR_MANUAL_POST" : "PUBLISHING";
    const nextVersion = current.row_version + 1;
    const auditId = id("audit");
    const mirrorEventId = id("mirror");
    let results: D1Result[];
    try {
      results = await this.db.batch([
        this.db
          .prepare(
            `UPDATE idempotency_records
             SET status = 'CLAIMED', result_ref = NULL, error_code = NULL,
                 provider_reason_code = NULL, retryable = NULL,
                 attempt_no = CASE WHEN retryable = 1 THEN attempt_no + 1 ELSE attempt_no END,
                 last_mutation_token = ?, updated_at = ?
             WHERE idempotency_key = ? AND status = 'PENDING'
               AND (? <> 'youtube' OR NOT EXISTS (
                 SELECT 1 FROM youtube_reconciliation_observations o
                 WHERE o.idempotency_key = idempotency_records.idempotency_key
                   AND o.result = 'FOUND'
               ))
               AND (
                 ? <> 'youtube' OR NOT EXISTS (
                   SELECT 1 FROM idempotency_records blocker
                   WHERE blocker.video_job_id = ?
                     AND blocker.approved_content_version = ?
                     AND blocker.destination = 'youtube'
                     AND blocker.idempotency_key <> ?
                     AND blocker.status IN ('OUTCOME_UNKNOWN', 'RECONCILIATION_REQUIRED')
                 )
               )`,
          )
          .bind(
            mutationToken,
            input.now,
            idempotencyKey,
            input.destination,
            input.destination,
            input.videoJobId,
            input.approvedContentVersion,
            idempotencyKey,
          ),
        this.db
          .prepare(
            `UPDATE video_jobs
             SET ${statusColumn} = CASE
                   WHEN EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.destination = ? AND r.status = 'FAILED'
                   ) THEN 'FAILED' ELSE ? END,
                 state = CASE
                   WHEN NOT EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.status <> 'FAILED'
                   ) THEN 'FAILED'
                   WHEN EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.status = 'FAILED'
                   ) THEN 'PARTIALLY_PUBLISHED'
                   ELSE 'PUBLISHING'
                 END,
                 last_mutation_token = ?, row_version = row_version + 1, updated_at = ?
             WHERE video_job_id = ? AND row_version = ?
               AND state IN ('APPROVED', 'PUBLISHING', 'PARTIALLY_PUBLISHED')
               AND approved_content_version = ?
               AND EXISTS (
                 SELECT 1 FROM idempotency_records r
                 WHERE r.idempotency_key = ? AND r.last_mutation_token = ?
               )`,
          )
          .bind(
            input.destination,
            claimStatus,
            mutationToken,
            input.now,
            input.videoJobId,
            current.row_version,
            input.approvedContentVersion,
            idempotencyKey,
            mutationToken,
          ),
        this.db
          .prepare(
            `INSERT INTO applied_mutations (
               mutation_token, video_job_id, mutation_type, operation_fingerprint,
               result_row_version, applied_at
             ) VALUES (
               ?, ?, 'publication.claim', ?,
               (SELECT row_version FROM video_jobs
                WHERE video_job_id = ? AND row_version = ? AND last_mutation_token = ?), ?
             )`,
          )
          .bind(
            mutationToken,
            input.videoJobId,
            operationFingerprint,
            input.videoJobId,
            nextVersion,
            mutationToken,
            input.now,
          ),
        this.db
          .prepare(
            `INSERT INTO audit_logs (
               audit_id, video_job_id, actor_type, actor_id, action,
               from_state, to_state, details_json, occurred_at
             )
             SELECT ?, video_job_id, ?, ?, 'publication.claimed', ?, state, ?, ?
             FROM video_jobs
             WHERE video_job_id = ? AND row_version = ? AND last_mutation_token = ?`,
          )
          .bind(
            auditId,
            input.actor.type,
            input.actor.id,
            current.state,
            JSON.stringify({
              destination: input.destination,
              target_account_id: input.targetAccountId,
              idempotency_key: idempotencyKey,
            }),
            input.now,
            input.videoJobId,
            nextVersion,
            mutationToken,
          ),
        this.db
          .prepare(
            `INSERT INTO mirror_outbox (
               mirror_event_id, video_job_id, event_type, payload_json,
               available_at, created_at, updated_at
             )
             SELECT ?, video_job_id, 'job.state.changed',
               json_object(
                 'video_job_id', video_job_id,
                 'state', state,
                 'youtube_status', youtube_status,
                 'instagram_status', instagram_status,
                 'tiktok_status', tiktok_status,
                 'retention_state', retention_state,
                 'row_version', row_version
               ), ?, ?, ?
             FROM video_jobs
             WHERE video_job_id = ? AND row_version = ? AND last_mutation_token = ?`,
          )
          .bind(
            mirrorEventId,
            input.now,
            input.now,
            input.now,
            input.videoJobId,
            nextVersion,
            mutationToken,
          ),
      ]);
    } catch (error) {
      const appliedAfterFailure = await this.db
        .prepare(
          `SELECT video_job_id, mutation_type, operation_fingerprint
           FROM applied_mutations WHERE mutation_token = ?`,
        )
        .bind(mutationToken)
        .first<AppliedMutationRow>();
      if (appliedAfterFailure) {
        if (!appliedMutationMatches(
          appliedAfterFailure,
          input.videoJobId,
          mutationType,
          operationFingerprint,
        )) throw new MutationCollisionError();
        return { claimed: false, idempotencyKey };
      }
      const duplicate = await this.db
        .prepare("SELECT status FROM idempotency_records WHERE idempotency_key = ?")
        .bind(idempotencyKey)
        .first<{ status: string }>();
      if (duplicate && duplicate.status !== "PENDING") {
        await this.bindNoopMutation({
          mutationToken,
          videoJobId: input.videoJobId,
          mutationType,
          operationFingerprint,
          now: input.now,
        });
        return { claimed: false, idempotencyKey };
      }
      if (
        input.destination === "youtube" &&
        (await this.hasBlockingYoutubePublication(
          input.videoJobId,
          input.approvedContentVersion,
          idempotencyKey,
        ))
      ) {
        throw new PublicationClaimBlockedError();
      }
      throw error;
    }

    if (changes(results[0]!) !== 1 || changes(results[1]!) !== 1) {
      const duplicate = await this.db
        .prepare("SELECT status FROM idempotency_records WHERE idempotency_key = ?")
        .bind(idempotencyKey)
        .first<{ status: string }>();
      if (duplicate && duplicate.status !== "PENDING") {
        await this.bindNoopMutation({
          mutationToken,
          videoJobId: input.videoJobId,
          mutationType,
          operationFingerprint,
          now: input.now,
        });
        return { claimed: false, idempotencyKey };
      }
      if (
        input.destination === "youtube" &&
        (await this.hasBlockingYoutubePublication(
          input.videoJobId,
          input.approvedContentVersion,
          idempotencyKey,
        ))
      ) {
        throw new PublicationClaimBlockedError();
      }
      throw new ConcurrentUpdateError();
    }

    return { claimed: true, idempotencyKey };
  }

  async renewPublicationClaimLease(input: {
    videoJobId: string;
    destination: MediaDestination;
    targetAccountId: string;
    approvedContentVersion: string;
    mutationToken: string;
    now: string;
    expiredBefore: string;
  }): Promise<boolean> {
    assertUuid(input.videoJobId, "videoJobId");
    assertInternalId(input.targetAccountId, "targetAccountId");
    assertApprovedContentVersion(input.approvedContentVersion);
    assertInternalId(input.mutationToken, "mutationToken");
    assertIsoDate(input.now);
    assertIsoDate(input.expiredBefore);
    const idempotencyKey = buildIdempotencyKey(
      input.videoJobId,
      input.destination,
      input.targetAccountId,
      input.approvedContentVersion,
    );
    const renewed = await this.db
      .prepare(
        `UPDATE idempotency_records
         SET updated_at = ?
         WHERE idempotency_key = ? AND status = 'CLAIMED'
           AND last_mutation_token = ? AND updated_at > ?`,
      )
      .bind(input.now, idempotencyKey, input.mutationToken, input.expiredBefore)
      .run();
    return changes(renewed) === 1;
  }

  async recoverExpiredYoutubePublicationClaim(input: {
    videoJobId: string;
    targetAccountId: string;
    approvedContentVersion: string;
    actor: Actor;
    now: string;
    expiredBefore: string;
    error: {
      code: string;
      providerReasonCode?: string;
      retryable: true;
    };
    mutationToken: string;
  }): Promise<{ recovered: boolean; job: VideoJob }> {
    assertIsoDate(input.expiredBefore);
    try {
      const job = await this.recordPublicationResult({
        videoJobId: input.videoJobId,
        destination: "youtube",
        targetAccountId: input.targetAccountId,
        approvedContentVersion: input.approvedContentVersion,
        result: "OUTCOME_UNKNOWN",
        actor: input.actor,
        now: input.now,
        error: input.error,
        mutationToken: input.mutationToken,
        expectedClaimExpiredBefore: input.expiredBefore,
      });
      return { recovered: true, job };
    } catch (error) {
      const record = await this.getPublicationRecord({
        videoJobId: input.videoJobId,
        destination: "youtube",
        targetAccountId: input.targetAccountId,
        approvedContentVersion: input.approvedContentVersion,
      });
      const job = await this.getVideoJob(input.videoJobId);
      if (
        record && job &&
        (record.status !== "CLAIMED" || record.updated_at > input.expiredBefore)
      ) {
        return { recovered: false, job };
      }
      throw error;
    }
  }

  async releaseYoutubePublicationClaim(input: {
    videoJobId: string;
    targetAccountId: string;
    approvedContentVersion: string;
    actor: Actor;
    now: string;
    error: {
      code: string;
      providerReasonCode?: string;
      retryable: true;
    };
    claimMutationToken: string;
    mutationToken?: string;
  }): Promise<VideoJob> {
    assertIsoDate(input.now);
    assertInternalId(input.actor.id, "actor.id");
    assertInternalId(input.targetAccountId, "targetAccountId");
    assertApprovedContentVersion(input.approvedContentVersion);
    assertInternalId(input.claimMutationToken, "claimMutationToken");
    assertSafeErrorCode(input.error.code, "error.code");
    if (input.error.providerReasonCode) {
      assertSafeErrorCode(input.error.providerReasonCode, "error.providerReasonCode");
    }
    if (input.error.retryable !== true) {
      throw new TypeError("Only retryable pre-upload failures may release a claim");
    }

    const current = await this.getVideoJob(input.videoJobId);
    if (!current) throw new NotFoundError("Video job");
    const idempotencyKey = buildIdempotencyKey(
      input.videoJobId,
      "youtube",
      input.targetAccountId,
      input.approvedContentVersion,
    );
    const mutationToken = input.mutationToken ?? id("mutation_release");
    assertInternalId(mutationToken, "mutationToken");
    const mutationType = "publication.claim.release";
    const operationFingerprint = await canonicalFingerprint({
      operation: mutationType,
      video_job_id: input.videoJobId,
      destination: "youtube",
      target_account_id: input.targetAccountId,
      approved_content_version: input.approvedContentVersion,
      error_code: input.error.code,
      provider_reason_code: input.error.providerReasonCode ?? null,
      retryable: true,
      claim_mutation_token: input.claimMutationToken,
      actor: input.actor,
    });
    const applied = await this.db
      .prepare(
        `SELECT video_job_id, mutation_type, operation_fingerprint
         FROM applied_mutations WHERE mutation_token = ?`,
      )
      .bind(mutationToken)
      .first<AppliedMutationRow>();
    if (applied) {
      if (!appliedMutationMatches(
        applied,
        input.videoJobId,
        mutationType,
        operationFingerprint,
      )) throw new MutationCollisionError();
      return current;
    }

    const record = await this.db
      .prepare(
        "SELECT status, last_mutation_token FROM idempotency_records WHERE idempotency_key = ?",
      )
      .bind(idempotencyKey)
      .first<{ status: string; last_mutation_token: string | null }>();
    if (!record) throw new NotFoundError("Publication target");
    if (record.status !== "CLAIMED") {
      throw new InvalidTransitionError(current.state, "PUBLISHING");
    }
    if (record.last_mutation_token !== input.claimMutationToken) {
      throw new ConcurrentUpdateError();
    }
    if (!["PUBLISHING", "PARTIALLY_PUBLISHED"].includes(current.state)) {
      throw new InvalidTransitionError(current.state, "PUBLISHING");
    }

    const nextVersion = current.row_version + 1;
    const auditId = id("audit_release");
    const mirrorEventId = id("mirror_release");
    let results: D1Result[];
    try {
      results = await this.db.batch([
        this.db
          .prepare(
            `UPDATE idempotency_records
             SET status = 'PENDING', result_ref = NULL, error_code = ?,
                 provider_reason_code = ?, retryable = 1,
                 last_mutation_token = ?, updated_at = ?
             WHERE idempotency_key = ? AND status = 'CLAIMED'
               AND last_mutation_token = ?`,
          )
          .bind(
            input.error.code,
            input.error.providerReasonCode ?? null,
            mutationToken,
            input.now,
            idempotencyKey,
            input.claimMutationToken,
          ),
        this.db
          .prepare(
            `UPDATE video_jobs
             SET youtube_status = CASE
                   WHEN NOT EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.destination = 'youtube' AND r.status <> 'PENDING'
                   ) THEN 'PENDING'
                   WHEN EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.destination = 'youtube' AND r.status = 'RECONCILIATION_REQUIRED'
                   ) THEN 'RECONCILIATION_REQUIRED'
                   WHEN EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.destination = 'youtube' AND r.status = 'OUTCOME_UNKNOWN'
                   ) THEN 'OUTCOME_UNKNOWN'
                   WHEN EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.destination = 'youtube' AND r.status = 'FAILED'
                   ) THEN 'FAILED'
                   WHEN NOT EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.destination = 'youtube' AND r.status <> 'SUCCEEDED'
                   ) THEN 'PUBLISHED'
                   ELSE 'PUBLISHING'
                 END,
                 state = CASE
                   WHEN EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.status = 'FAILED'
                   ) THEN 'PARTIALLY_PUBLISHED'
                   ELSE 'PUBLISHING'
                 END,
                 last_mutation_token = ?, row_version = row_version + 1, updated_at = ?
             WHERE video_job_id = ? AND row_version = ?
               AND state IN ('PUBLISHING', 'PARTIALLY_PUBLISHED')
               AND EXISTS (
                 SELECT 1 FROM idempotency_records r
                 WHERE r.idempotency_key = ? AND r.last_mutation_token = ?
               )`,
          )
          .bind(
            mutationToken,
            input.now,
            input.videoJobId,
            current.row_version,
            idempotencyKey,
            mutationToken,
          ),
        this.db
          .prepare(
            `INSERT INTO applied_mutations (
               mutation_token, video_job_id, mutation_type, operation_fingerprint,
               result_row_version, applied_at
             ) VALUES (
               ?, ?, ?, ?,
               (SELECT row_version FROM video_jobs
                WHERE video_job_id = ? AND row_version = ? AND last_mutation_token = ?), ?
             )`,
          )
          .bind(
            mutationToken,
            input.videoJobId,
            mutationType,
            operationFingerprint,
            input.videoJobId,
            nextVersion,
            mutationToken,
            input.now,
          ),
        this.db
          .prepare(
            `INSERT INTO audit_logs (
               audit_id, video_job_id, actor_type, actor_id, action,
               from_state, to_state, details_json, occurred_at
             )
             SELECT ?, video_job_id, ?, ?, 'publication.claim.released', ?, state, ?, ?
             FROM video_jobs
             WHERE video_job_id = ? AND row_version = ? AND last_mutation_token = ?`,
          )
          .bind(
            auditId,
            input.actor.type,
            input.actor.id,
            current.state,
            JSON.stringify({
              destination: "youtube",
              target_account_id: input.targetAccountId,
              error_code: input.error.code,
              provider_reason_code: input.error.providerReasonCode ?? null,
              retryable: true,
            }),
            input.now,
            input.videoJobId,
            nextVersion,
            mutationToken,
          ),
        this.db
          .prepare(
            `INSERT INTO mirror_outbox (
               mirror_event_id, video_job_id, event_type, payload_json,
               available_at, created_at, updated_at
             )
             SELECT ?, video_job_id, 'job.state.changed',
               json_object(
                 'video_job_id', video_job_id,
                 'state', state,
                 'youtube_status', youtube_status,
                 'instagram_status', instagram_status,
                 'tiktok_status', tiktok_status,
                 'retention_state', retention_state,
                 'row_version', row_version
               ), ?, ?, ?
             FROM video_jobs
             WHERE video_job_id = ? AND row_version = ? AND last_mutation_token = ?`,
          )
          .bind(
            mirrorEventId,
            input.now,
            input.now,
            input.now,
            input.videoJobId,
            nextVersion,
            mutationToken,
          ),
      ]);
    } catch (error) {
      const appliedAfterFailure = await this.db
        .prepare(
          `SELECT video_job_id, mutation_type, operation_fingerprint
           FROM applied_mutations WHERE mutation_token = ?`,
        )
        .bind(mutationToken)
        .first<AppliedMutationRow>();
      if (appliedAfterFailure && appliedMutationMatches(
        appliedAfterFailure,
        input.videoJobId,
        mutationType,
        operationFingerprint,
      )) return (await this.getVideoJob(input.videoJobId))!;
      if (appliedAfterFailure) throw new MutationCollisionError();
      throw error;
    }

    if (changes(results[0]!) !== 1 || changes(results[1]!) !== 1) {
      throw new ConcurrentUpdateError();
    }
    return (await this.getVideoJob(input.videoJobId))!;
  }

  async recordPublicationResult(input: {
    videoJobId: string;
    destination: MediaDestination;
    targetAccountId: string;
    approvedContentVersion: string;
    result: "SUCCEEDED" | "FAILED" | "OUTCOME_UNKNOWN" | "RECONCILIATION_REQUIRED" | "HANDED_OFF";
    actor: Actor;
    now: string;
    resultRef?: string;
    error?: {
      code: string;
      providerReasonCode?: string;
      retryable: boolean;
    };
    mutationToken?: string;
    expectedClaimExpiredBefore?: string;
    expectedClaimMutationToken?: string;
    expectedAttemptNo?: number;
  }): Promise<VideoJob> {
    assertIsoDate(input.now);
    assertInternalId(input.actor.id, "actor.id");
    assertInternalId(input.targetAccountId, "targetAccountId");
    assertApprovedContentVersion(input.approvedContentVersion);
    if (input.expectedAttemptNo !== undefined && (!Number.isSafeInteger(input.expectedAttemptNo) || input.expectedAttemptNo < 1)) {
      throw new TypeError("expectedAttemptNo must be a positive integer");
    }
    if (input.expectedClaimExpiredBefore) {
      assertIsoDate(input.expectedClaimExpiredBefore);
      if (input.destination !== "youtube" || input.result !== "OUTCOME_UNKNOWN") {
        throw new TypeError(
          "expectedClaimExpiredBefore is only valid for YouTube OUTCOME_UNKNOWN recovery",
        );
      }
    }
    if (input.expectedClaimMutationToken) {
      assertInternalId(input.expectedClaimMutationToken, "expectedClaimMutationToken");
      if (input.result === "RECONCILIATION_REQUIRED") {
        throw new TypeError(
          "expectedClaimMutationToken is only valid for a result written from CLAIMED",
        );
      }
    }
    if (input.error) {
      assertSafeErrorCode(input.error.code, "error.code");
      if (input.error.providerReasonCode) {
        assertSafeErrorCode(
          input.error.providerReasonCode,
          "error.providerReasonCode",
        );
      }
      if (typeof input.error.retryable !== "boolean") {
        throw new TypeError("error.retryable must be boolean");
      }
    }
    if (
      (["OUTCOME_UNKNOWN", "RECONCILIATION_REQUIRED"] as const).includes(
        input.result as "OUTCOME_UNKNOWN" | "RECONCILIATION_REQUIRED",
      ) && input.destination !== "youtube"
    ) throw new TypeError("Unknown publication outcomes are only valid for YouTube");
    if (input.result === "HANDED_OFF" && input.destination !== "tiktok") {
      throw new TypeError("HANDED_OFF is only valid for TikTok");
    }
    if (input.destination === "tiktok" && input.result === "SUCCEEDED") {
      if (!input.resultRef || input.resultRef.length > 2048) {
        throw new TypeError("TikTok confirmation requires a publication URL");
      }
      let publicationUrl: URL;
      try {
        publicationUrl = new URL(input.resultRef);
      } catch {
        throw new TypeError("TikTok confirmation requires a valid publication URL");
      }
      if (publicationUrl.protocol !== "https:") {
        throw new TypeError("TikTok confirmation requires an HTTPS publication URL");
      }
    }
    if (
      input.destination === "youtube" && input.result === "SUCCEEDED" &&
      (!input.resultRef || !/^[A-Za-z0-9_-]{11}$/.test(input.resultRef))
    ) {
      throw new TypeError("YouTube success requires a safe opaque video ID");
    }
    const current = await this.getVideoJob(input.videoJobId);
    if (!current) throw new NotFoundError("Video job");
    const mutationToken = input.mutationToken ?? id("mutation_result");
    assertInternalId(mutationToken, "mutationToken");
    const mutationType = "publication.result";
    const operationFingerprint = await canonicalFingerprint({
      operation: mutationType,
      video_job_id: input.videoJobId,
      destination: input.destination,
      target_account_id: input.targetAccountId,
      approved_content_version: input.approvedContentVersion,
      result: input.result,
      result_ref: input.resultRef ?? null,
      error_code: input.error?.code ?? null,
      provider_reason_code: input.error?.providerReasonCode ?? null,
      retryable: input.error?.retryable ?? null,
      expected_claim_expired_before: input.expectedClaimExpiredBefore ?? null,
      expected_claim_mutation_token: input.expectedClaimMutationToken ?? null,
      ...(input.expectedAttemptNo !== undefined
        ? { expected_attempt_no: input.expectedAttemptNo } : {}),
      actor: input.actor,
    });
    const alreadyApplied = await this.db
      .prepare(
        `SELECT video_job_id, mutation_type, operation_fingerprint
         FROM applied_mutations WHERE mutation_token = ?`,
      )
      .bind(mutationToken)
      .first<AppliedMutationRow>();
    if (alreadyApplied) {
      if (!appliedMutationMatches(
        alreadyApplied,
        input.videoJobId,
        mutationType,
        operationFingerprint,
      )) throw new MutationCollisionError();
      return current;
    }
    const idempotencyKey = buildIdempotencyKey(
      input.videoJobId,
      input.destination,
      input.targetAccountId,
      input.approvedContentVersion,
    );
    const record = await this.db
      .prepare(
        `SELECT status, last_mutation_token, yt_video_id, attempt_no
         FROM idempotency_records WHERE idempotency_key = ?`,
      )
      .bind(idempotencyKey)
      .first<{
        status: string;
        last_mutation_token: string | null;
        yt_video_id: string | null;
        attempt_no: number;
      }>();
    if (!record) throw new NotFoundError("Publication target");
    if (input.expectedAttemptNo !== undefined && record.attempt_no !== input.expectedAttemptNo) {
      throw new ConcurrentUpdateError();
    }
    if (
      input.destination === "youtube" && input.result === "SUCCEEDED" &&
      record.yt_video_id && record.yt_video_id !== input.resultRef
    ) {
      throw new ConcurrentUpdateError();
    }
    if (record.status === input.result) {
      await this.bindNoopMutation({
        mutationToken,
        videoJobId: input.videoJobId,
        mutationType,
        operationFingerprint,
        now: input.now,
      });
      return current;
    }
    if (!["PUBLISHING", "PARTIALLY_PUBLISHED"].includes(current.state)) {
      throw new InvalidTransitionError(current.state, "PUBLISHING");
    }
    let allowedFrom: readonly string[];
    switch (input.result) {
      case "SUCCEEDED":
        allowedFrom = input.destination === "tiktok"
          ? ["HANDED_OFF"]
          : input.destination === "youtube"
            ? ["CLAIMED", "RECONCILIATION_REQUIRED"]
            : ["CLAIMED"];
        break;
      case "FAILED":
        allowedFrom = input.destination === "youtube"
          ? ["CLAIMED", "RECONCILIATION_REQUIRED"]
          : ["CLAIMED", "HANDED_OFF"];
        break;
      case "OUTCOME_UNKNOWN":
        allowedFrom = ["CLAIMED"];
        break;
      case "RECONCILIATION_REQUIRED":
        allowedFrom = ["OUTCOME_UNKNOWN"];
        break;
      case "HANDED_OFF":
        allowedFrom = ["CLAIMED"];
        break;
    }
    if (!allowedFrom.includes(record.status)) {
      throw new InvalidTransitionError(current.state, "PUBLISHING");
    }
    if (
      input.expectedClaimMutationToken &&
      record.last_mutation_token !== input.expectedClaimMutationToken
    ) {
      throw new ConcurrentUpdateError();
    }

    const nextVersion = current.row_version + 1;
    const deleteDueAt = new Date(
      Date.parse(input.now) + this.retentionDays * 86_400_000,
    ).toISOString();
    const auditId = id("audit_publication");
    const mirrorEventId = id("mirror_publication");
    const allowedPlaceholders = allowedFrom.map(() => "?").join(", ");
    const claimExpiryCondition = input.expectedClaimExpiredBefore
      ? " AND updated_at <= ?"
      : "";
    const attemptCondition = input.expectedAttemptNo !== undefined ? " AND attempt_no = ?" : "";
    const claimTokenCondition = input.expectedClaimMutationToken
      ? " AND last_mutation_token = ?"
      : "";

    let results: D1Result[];
    try {
      results = await this.db.batch([
        this.db
          .prepare(
            `UPDATE idempotency_records
             SET status = ?, result_ref = ?, error_code = ?, provider_reason_code = ?,
                 retryable = ?,
                 yt_video_id = CASE
                   WHEN destination = 'youtube' AND ? = 'SUCCEEDED'
                     AND length(?) = 11 AND ? NOT GLOB '*[^A-Za-z0-9_-]*'
                     THEN ?
                   ELSE yt_video_id
                 END,
                 yt_reconciled_at = CASE
                   WHEN destination = 'youtube' AND status = 'RECONCILIATION_REQUIRED'
                     AND ? = 'SUCCEEDED' THEN ?
                   ELSE yt_reconciled_at
                 END,
                 last_mutation_token = ?, updated_at = ?
             WHERE idempotency_key = ? AND status IN (${allowedPlaceholders})
               AND (? <> 'youtube' OR ? <> 'SUCCEEDED' OR yt_video_id IS NULL OR yt_video_id = ?)
               ${claimExpiryCondition}${claimTokenCondition}${attemptCondition}`,
          )
          .bind(
            input.result,
            input.resultRef ?? null,
            input.error?.code ?? null,
            input.error?.providerReasonCode ?? null,
            input.error ? Number(input.error.retryable) : null,
            input.result,
            input.resultRef ?? null,
            input.resultRef ?? null,
            input.resultRef ?? null,
            input.result,
            input.now,
            mutationToken,
            input.now,
            idempotencyKey,
            ...allowedFrom,
            input.destination,
            input.result,
            input.resultRef ?? null,
            ...(input.expectedClaimExpiredBefore
              ? [input.expectedClaimExpiredBefore]
              : []),
            ...(input.expectedClaimMutationToken
              ? [input.expectedClaimMutationToken]
              : []),
            ...(input.expectedAttemptNo !== undefined ? [input.expectedAttemptNo] : []),
          ),
        this.db
          .prepare(
            `UPDATE video_jobs
             SET youtube_status = CASE
                   WHEN NOT EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.destination = 'youtube'
                   ) THEN 'SKIPPED'
                   WHEN NOT EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.destination = 'youtube' AND r.status <> 'PENDING'
                   ) THEN 'PENDING'
                   WHEN EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.destination = 'youtube' AND r.status = 'RECONCILIATION_REQUIRED'
                   ) THEN 'RECONCILIATION_REQUIRED'
                   WHEN EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.destination = 'youtube' AND r.status = 'OUTCOME_UNKNOWN'
                   ) THEN 'OUTCOME_UNKNOWN'
                   WHEN EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.destination = 'youtube' AND r.status = 'FAILED'
                   ) THEN 'FAILED'
                   WHEN NOT EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.destination = 'youtube' AND r.status <> 'SUCCEEDED'
                   ) THEN 'PUBLISHED'
                   ELSE 'PUBLISHING'
                 END,
                 instagram_status = CASE
                   WHEN NOT EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.destination = 'instagram'
                   ) THEN 'SKIPPED'
                   WHEN NOT EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.destination = 'instagram' AND r.status <> 'PENDING'
                   ) THEN 'PENDING'
                   WHEN EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.destination = 'instagram' AND r.status = 'FAILED'
                   ) THEN 'FAILED'
                   WHEN NOT EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.destination = 'instagram' AND r.status <> 'SUCCEEDED'
                   ) THEN 'PUBLISHED'
                   ELSE 'PUBLISHING'
                 END,
                 tiktok_status = CASE
                   WHEN NOT EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.destination = 'tiktok'
                   ) THEN 'SKIPPED'
                   WHEN NOT EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.destination = 'tiktok' AND r.status <> 'PENDING'
                   ) THEN 'PENDING'
                   WHEN EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.destination = 'tiktok' AND r.status = 'FAILED'
                   ) THEN 'FAILED'
                   WHEN NOT EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.destination = 'tiktok' AND r.status <> 'SUCCEEDED'
                   ) THEN 'CONFIRMED_PUBLISHED'
                   WHEN EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.destination = 'tiktok' AND r.status = 'HANDED_OFF'
                   ) THEN 'HANDED_OFF'
                   ELSE 'READY_FOR_MANUAL_POST'
                 END,
                 state = CASE
                   WHEN NOT EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.status <> 'SUCCEEDED'
                   ) THEN 'PUBLISHED'
                   WHEN NOT EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.status <> 'FAILED'
                   ) THEN 'FAILED'
                   WHEN EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.status = 'FAILED'
                   ) THEN 'PARTIALLY_PUBLISHED'
                   ELSE 'PUBLISHING'
                 END,
                 retention_state = CASE
                   WHEN NOT EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.status <> 'SUCCEEDED'
                   ) THEN 'RETAINED' ELSE retention_state END,
                 retention_start_at = CASE
                   WHEN retention_state = 'HOLD' AND NOT EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.status <> 'SUCCEEDED'
                   ) THEN ? ELSE retention_start_at END,
                 delete_due_at = CASE
                   WHEN retention_state = 'HOLD' AND NOT EXISTS (
                     SELECT 1 FROM idempotency_records r
                     WHERE r.video_job_id = video_jobs.video_job_id
                       AND r.approved_content_version = video_jobs.approved_content_version
                       AND r.status <> 'SUCCEEDED'
                   ) THEN ? ELSE delete_due_at END,
                 last_mutation_token = ?, row_version = row_version + 1, updated_at = ?
             WHERE video_job_id = ? AND row_version = ?
               AND state IN ('PUBLISHING', 'PARTIALLY_PUBLISHED')
               AND EXISTS (
                 SELECT 1 FROM idempotency_records r
                 WHERE r.idempotency_key = ? AND r.last_mutation_token = ?
               )`,
          )
          .bind(
            input.now,
            deleteDueAt,
            mutationToken,
            input.now,
            input.videoJobId,
            current.row_version,
            idempotencyKey,
            mutationToken,
          ),
        this.db
          .prepare(
            `INSERT INTO applied_mutations (
               mutation_token, video_job_id, mutation_type, operation_fingerprint,
               result_row_version, applied_at
             ) VALUES (
               ?, ?, 'publication.result', ?,
               (SELECT row_version FROM video_jobs
                WHERE video_job_id = ? AND row_version = ? AND last_mutation_token = ?), ?
             )`,
          )
          .bind(
            mutationToken,
            input.videoJobId,
            operationFingerprint,
            input.videoJobId,
            nextVersion,
            mutationToken,
            input.now,
          ),
        this.db
          .prepare(
            `INSERT INTO audit_logs (
               audit_id, video_job_id, actor_type, actor_id, action,
               from_state, to_state, details_json, occurred_at
             )
             SELECT ?, video_job_id, ?, ?, 'publication.result.recorded', ?, state, ?, ?
             FROM video_jobs
             WHERE video_job_id = ? AND row_version = ? AND last_mutation_token = ?`,
          )
          .bind(
            auditId,
            input.actor.type,
            input.actor.id,
            current.state,
            JSON.stringify({
              destination: input.destination,
              target_account_id: input.targetAccountId,
              result: input.result,
              ...(input.error
                ? {
                    error_code: input.error.code,
                    provider_reason_code: input.error.providerReasonCode ?? null,
                    retryable: input.error.retryable,
                  }
                : {}),
            }),
            input.now,
            input.videoJobId,
            nextVersion,
            mutationToken,
          ),
        this.db
          .prepare(
            `INSERT INTO mirror_outbox (
               mirror_event_id, video_job_id, event_type, payload_json,
               available_at, created_at, updated_at
             )
             SELECT ?, video_job_id, 'job.state.changed',
               json_object(
                 'video_job_id', video_job_id,
                 'state', state,
                 'youtube_status', youtube_status,
                 'instagram_status', instagram_status,
                 'tiktok_status', tiktok_status,
                 'retention_state', retention_state,
                 'row_version', row_version
               ), ?, ?, ?
             FROM video_jobs
             WHERE video_job_id = ? AND row_version = ? AND last_mutation_token = ?`,
          )
          .bind(
            mirrorEventId,
            input.now,
            input.now,
            input.now,
            input.videoJobId,
            nextVersion,
            mutationToken,
          ),
        this.db
          .prepare(
            `UPDATE youtube_publication_attempts
             SET state = CASE ?
                   WHEN 'SUCCEEDED' THEN 'SUCCEEDED'
                   WHEN 'FAILED' THEN 'FAILED'
                   WHEN 'OUTCOME_UNKNOWN' THEN 'OUTCOME_UNKNOWN'
                   WHEN 'RECONCILIATION_REQUIRED' THEN 'RECONCILIATION_REQUIRED'
                   ELSE state
                 END,
                 video_id = CASE
                   WHEN ? = 'SUCCEEDED' AND length(?) = 11
                     AND ? NOT GLOB '*[^A-Za-z0-9_-]*' THEN ?
                   ELSE video_id
                 END,
                 updated_at = ?
             WHERE ? = 'youtube' AND idempotency_key = ?
               AND attempt_no = (
                 SELECT attempt_no FROM idempotency_records
                 WHERE idempotency_key = ? AND last_mutation_token = ?
               )
               AND state IN (
                 'SIDE_EFFECT_ALLOWED', 'UPLOADING', 'OUTCOME_UNKNOWN',
                 'RECONCILIATION_REQUIRED', 'SUPERSEDED'
               )
               AND (? <> 'SUCCEEDED' OR video_id IS NULL OR video_id = ?)`,
          )
          .bind(
            input.result,
            input.result,
            input.resultRef ?? null,
            input.resultRef ?? null,
            input.resultRef ?? null,
            input.now,
            input.destination,
            idempotencyKey,
            idempotencyKey,
            mutationToken,
            input.result,
            input.resultRef ?? null,
          ),
      ]);
    } catch (error) {
      const applied = await this.db
        .prepare(
          `SELECT video_job_id, mutation_type, operation_fingerprint
           FROM applied_mutations WHERE mutation_token = ?`,
        )
        .bind(mutationToken)
        .first<AppliedMutationRow>();
      if (applied && appliedMutationMatches(
        applied,
        input.videoJobId,
        mutationType,
        operationFingerprint,
      )) {
        return (await this.getVideoJob(input.videoJobId))!;
      }
      if (applied) throw new MutationCollisionError();
      throw error;
    }

    if (changes(results[0]!) !== 1 || changes(results[1]!) !== 1) {
      throw new ConcurrentUpdateError();
    }
    return (await this.getVideoJob(input.videoJobId))!;
  }

  async markRetentionDue(now: string, actor: Actor): Promise<number> {
    assertIsoDate(now);
    assertInternalId(actor.id, "actor.id");
    const due = await this.db
      .prepare(
        `SELECT video_job_id, row_version FROM video_jobs
         WHERE retention_state = 'RETAINED' AND delete_due_at <= ?`,
      )
      .bind(now)
      .all<{ video_job_id: string; row_version: number }>();
    let marked = 0;
    for (const job of due.results) {
      const nextVersion = job.row_version + 1;
      const mutationToken = id("mutation_retention");
      const mirrorEventId = id("mirror_retention");
      const payload = JSON.stringify({
        video_job_id: job.video_job_id,
        retention_state: "DUE_FOR_DELETION",
        row_version: nextVersion,
      });
      const results = await this.db.batch([
        this.db
          .prepare(
            `UPDATE video_jobs
             SET retention_state = 'DUE_FOR_DELETION', last_mutation_token = ?,
                 row_version = row_version + 1, updated_at = ?
             WHERE video_job_id = ? AND retention_state = 'RETAINED' AND row_version = ?`,
          )
          .bind(mutationToken, now, job.video_job_id, job.row_version),
        this.db
          .prepare(
            `INSERT INTO audit_logs (
               audit_id, video_job_id, actor_type, actor_id, action,
               details_json, occurred_at
             )
             SELECT ?, video_job_id, ?, ?, 'retention.due', '{}', ?
             FROM video_jobs
             WHERE video_job_id = ? AND retention_state = 'DUE_FOR_DELETION'
               AND row_version = ? AND last_mutation_token = ?`,
          )
          .bind(
            id("audit_retention"),
            actor.type,
            actor.id,
            now,
            job.video_job_id,
            nextVersion,
            mutationToken,
          ),
        this.db
          .prepare(
            `INSERT INTO mirror_outbox (
               mirror_event_id, video_job_id, event_type, payload_json,
               available_at, created_at, updated_at
             )
             SELECT ?, video_job_id, 'job.retention.changed', ?, ?, ?, ?
             FROM video_jobs
             WHERE video_job_id = ? AND retention_state = 'DUE_FOR_DELETION'
               AND row_version = ? AND last_mutation_token = ?`,
          )
          .bind(
            mirrorEventId,
            payload,
            now,
            now,
            now,
            job.video_job_id,
            nextVersion,
            mutationToken,
          ),
      ]);
      marked += changes(results[0]!);
    }
    return marked;
  }

  async markDeleted(input: {
    videoJobId: string;
    actor: Actor;
    now: string;
    storageDeletionConfirmed: boolean;
    backupDeletionConfirmed: boolean;
  }): Promise<VideoJob> {
    assertIsoDate(input.now);
    assertInternalId(input.actor.id, "actor.id");
    if (
      input.actor.type !== "operator" ||
      !this.deletionOperatorIds.has(input.actor.id)
    ) throw new ForbiddenError();
    if (!input.storageDeletionConfirmed || !input.backupDeletionConfirmed) {
      throw new InvalidTransitionError("DUE_FOR_DELETION", "DELETED");
    }
    const current = await this.getVideoJob(input.videoJobId);
    if (!current) throw new NotFoundError("Video job");
    const nextVersion = current.row_version + 1;
    const mutationToken = id("mutation_retention");
    const mirrorEventId = id("mirror_retention");
    const payload = JSON.stringify({
      video_job_id: input.videoJobId,
      retention_state: "DELETED",
      row_version: nextVersion,
    });
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE video_jobs
           SET retention_state = 'DELETED', last_mutation_token = ?,
               row_version = row_version + 1, updated_at = ?
           WHERE video_job_id = ? AND retention_state = 'DUE_FOR_DELETION'
             AND row_version = ?`,
        )
        .bind(mutationToken, input.now, input.videoJobId, current.row_version),
      this.db
        .prepare(
          `INSERT INTO audit_logs (
             audit_id, video_job_id, actor_type, actor_id, action,
             details_json, occurred_at
           )
           SELECT ?, video_job_id, ?, ?, 'retention.deleted',
             '{"storage_deletion_confirmed":true,"backup_deletion_confirmed":true}', ?
           FROM video_jobs
           WHERE video_job_id = ? AND retention_state = 'DELETED' AND row_version = ?
             AND last_mutation_token = ?`,
        )
        .bind(
          id("audit_retention"),
          input.actor.type,
          input.actor.id,
          input.now,
          input.videoJobId,
          nextVersion,
          mutationToken,
        ),
      this.db
        .prepare(
          `INSERT INTO mirror_outbox (
             mirror_event_id, video_job_id, event_type, payload_json,
             available_at, created_at, updated_at
           )
           SELECT ?, video_job_id, 'job.retention.changed', ?, ?, ?, ?
           FROM video_jobs
           WHERE video_job_id = ? AND retention_state = 'DELETED' AND row_version = ?
             AND last_mutation_token = ?`,
        )
        .bind(
          mirrorEventId,
          payload,
          input.now,
          input.now,
          input.now,
          input.videoJobId,
          nextVersion,
          mutationToken,
        ),
    ]);
    if (changes(results[0]!) !== 1) throw new ConcurrentUpdateError();
    return (await this.getVideoJob(input.videoJobId))!;
  }

  async recordQueueStart(input: {
    messageId: string;
    eventId: string;
    eventType: string;
    eventFingerprint: string;
    videoJobId?: string;
    now: string;
  }): Promise<
    | { status: "started"; leaseToken: string }
    | { status: "processed" | "in_progress" | "collision" }
  > {
    assertSha256Hex(input.eventFingerprint, "eventFingerprint");
    const leaseExpiresAt = new Date(Date.parse(input.now) + 60_000).toISOString();
    const leaseToken = id("lease");
    const inserted = await this.db
      .prepare(
        `INSERT INTO queue_deliveries (
           event_id, last_message_id, event_type, video_job_id, event_fingerprint, status,
           attempt_count, lease_token, lease_expires_at, first_seen_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'PROCESSING', 1, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .bind(
        input.eventId,
        input.messageId,
        input.eventType,
        input.videoJobId ?? null,
        input.eventFingerprint,
        leaseToken,
        leaseExpiresAt,
        input.now,
        input.now,
      )
      .run();
    if (changes(inserted) === 1) return { status: "started", leaseToken };

    const existing = await this.db
      .prepare(
        `SELECT status, lease_expires_at, event_fingerprint
         FROM queue_deliveries WHERE event_id = ?`,
      )
      .bind(input.eventId)
      .first<{ status: string; lease_expires_at: string | null; event_fingerprint: string }>();
    if (existing && existing.event_fingerprint !== input.eventFingerprint) {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE queue_deliveries
             SET status = 'QUARANTINED', last_message_id = ?, lease_token = NULL,
                 lease_expires_at = NULL, last_error_code = 'EVENT_ID_COLLISION', updated_at = ?
             WHERE event_id = ? AND event_fingerprint <> ?`,
          )
          .bind(input.messageId, input.now, input.eventId, input.eventFingerprint),
        this.db
          .prepare(
            `INSERT OR IGNORE INTO audit_logs (
               audit_id, video_job_id, actor_type, actor_id, action,
               details_json, occurred_at
             )
             SELECT ?,
               CASE WHEN EXISTS (
                 SELECT 1 FROM video_jobs v WHERE v.video_job_id = q.video_job_id
               ) THEN q.video_job_id ELSE NULL END,
               'system', 'system_queue', 'queue.event_id.collision', ?, ?
             FROM queue_deliveries q WHERE q.event_id = ?`,
          )
          .bind(
            `queue_collision_${input.eventId}`,
            JSON.stringify({
              event_id: input.eventId,
              error_code: "EVENT_ID_COLLISION",
              stored_fingerprint: existing.event_fingerprint,
              received_fingerprint: input.eventFingerprint,
            }),
            input.now,
            input.eventId,
          ),
      ]);
      return { status: "collision" };
    }
    if (existing?.status === "QUARANTINED") return { status: "collision" };
    if (existing?.status === "PROCESSED") return { status: "processed" };

    const reclaimed = await this.db
      .prepare(
        `UPDATE queue_deliveries
         SET last_message_id = ?, status = 'PROCESSING',
             attempt_count = attempt_count + 1, lease_expires_at = ?,
             lease_token = ?, last_error_code = NULL, updated_at = ?
         WHERE event_id = ? AND (
           status = 'FAILED' OR
           (status = 'PROCESSING' AND lease_expires_at <= ?)
         )`,
      )
      .bind(
        input.messageId,
        leaseExpiresAt,
        leaseToken,
        input.now,
        input.eventId,
        input.now,
      )
      .run();
    return changes(reclaimed) === 1
      ? { status: "started", leaseToken }
      : { status: "in_progress" };
  }

  async quarantineEventCollision(
    eventId: string,
    eventFingerprint: string,
    now: string,
  ): Promise<boolean> {
    assertSha256Hex(eventFingerprint, "eventFingerprint");
    const existing = await this.db
      .prepare("SELECT event_fingerprint, status FROM queue_deliveries WHERE event_id = ?")
      .bind(eventId)
      .first<{ event_fingerprint: string; status: string }>();
    if (!existing) return false;
    if (existing.status === "QUARANTINED") return true;
    if (existing.event_fingerprint === eventFingerprint) return false;
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE queue_deliveries
           SET status = 'QUARANTINED', lease_token = NULL, lease_expires_at = NULL,
               last_error_code = 'EVENT_ID_COLLISION', updated_at = ?
           WHERE event_id = ? AND event_fingerprint <> ?`,
        )
        .bind(now, eventId, eventFingerprint),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO audit_logs (
             audit_id, video_job_id, actor_type, actor_id, action,
             details_json, occurred_at
           )
           SELECT ?,
             CASE WHEN EXISTS (
               SELECT 1 FROM video_jobs v WHERE v.video_job_id = q.video_job_id
             ) THEN q.video_job_id ELSE NULL END,
             'system', 'system_queue', 'queue.event_id.collision', ?, ?
           FROM queue_deliveries q WHERE q.event_id = ?`,
        )
        .bind(
          `queue_collision_${eventId}`,
          JSON.stringify({
            event_id: eventId,
            error_code: "EVENT_ID_COLLISION",
            stored_fingerprint: existing.event_fingerprint,
            received_fingerprint: eventFingerprint,
          }),
          now,
          eventId,
        ),
    ]);
    return true;
  }

  async recordQueueProcessed(eventId: string, leaseToken: string, now: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE queue_deliveries
         SET status = 'PROCESSED', lease_expires_at = NULL,
             lease_token = NULL, last_error_code = NULL, updated_at = ?
         WHERE event_id = ? AND status = 'PROCESSING' AND lease_token = ?`,
      )
      .bind(now, eventId, leaseToken)
      .run();
    return changes(result) === 1;
  }

  async recordQueueFailed(
    eventId: string,
    leaseToken: string,
    errorCode: string,
    now: string,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE queue_deliveries
         SET status = 'FAILED', lease_expires_at = NULL,
             lease_token = NULL, last_error_code = ?, updated_at = ?
         WHERE event_id = ? AND status = 'PROCESSING' AND lease_token = ?`,
      )
      .bind(errorCode, now, eventId, leaseToken)
      .run();
    return changes(result) === 1;
  }

  async captureDlqMessage(input: {
    originalMessageId: string;
    eventId: string;
    eventType: string;
    now: string;
  } & (
    | {
        event: unknown;
        quarantineReason?: "EVENT_ID_COLLISION";
      }
    | {
        payloadDigest: string;
        payloadByteSize: number;
        payloadType: string;
        quarantineReason: "INVALID_EVENT_SCHEMA";
      }
  )): Promise<void> {
    let payloadJson: string;
    let payloadDigest: string;
    let payloadByteSize: number;
    let payloadType: string;
    if (input.quarantineReason === "INVALID_EVENT_SCHEMA") {
      assertSha256Hex(input.payloadDigest, "payloadDigest");
      payloadDigest = input.payloadDigest;
      payloadByteSize = input.payloadByteSize;
      payloadType = input.payloadType;
      payloadJson = canonicalJson({
        error_code: "INVALID_EVENT_SCHEMA",
        payload_digest: payloadDigest,
        payload_byte_size: payloadByteSize,
        payload_type: payloadType,
      });
    } else {
      const event = normalizeQueueEvent(input.event);
      if (!event) throw new TypeError("Replayable DLQ event must match the queue schema");
      payloadJson = canonicalJson(event);
      payloadDigest = await sha256Hex(payloadJson);
      payloadByteSize = new TextEncoder().encode(payloadJson).byteLength;
      payloadType = "event";
    }
    await this.db
      .prepare(
        `INSERT INTO dlq_messages (
           dlq_message_id, original_message_id, event_id, event_type,
           payload_json, payload_digest, payload_byte_size, payload_type,
           quarantine_reason, status, captured_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(dlq_message_id) DO NOTHING`,
      )
      .bind(
        `dlq_${input.originalMessageId}`,
        input.originalMessageId,
        input.eventId,
        input.eventType,
        payloadJson,
        payloadDigest,
        payloadByteSize,
        payloadType,
        input.quarantineReason ?? null,
        input.quarantineReason ? "QUARANTINED" : "PENDING",
        input.now,
      )
      .run();
  }

  async replayDlqMessage(
    dlqMessageId: string,
    queue: Queue,
    actorId: string,
    now: string,
  ): Promise<boolean> {
    assertInternalId(actorId, "actorId");
    if (!this.deletionOperatorIds.has(actorId)) throw new ForbiddenError();
    const replayLeaseExpiresAt = new Date(Date.parse(now) + 60_000).toISOString();
    const replayLeaseToken = id("dlq_lease");
    const row = await this.db
      .prepare(
        `SELECT payload_json FROM dlq_messages
         WHERE dlq_message_id = ? AND (
           status = 'PENDING' OR
           (status = 'REPLAYING' AND replay_lease_expires_at <= ?)
         )`,
      )
      .bind(dlqMessageId, now)
      .first<{ payload_json: string }>();
    if (!row) return false;
    let event;
    try {
      event = normalizeQueueEvent(JSON.parse(row.payload_json));
    } catch {
      event = null;
    }
    if (!event) {
      await this.db
        .prepare(
          `UPDATE dlq_messages
           SET status = 'QUARANTINED', quarantine_reason = 'INVALID_EVENT_SCHEMA',
               last_error_code = 'INVALID_EVENT_SCHEMA'
           WHERE dlq_message_id = ? AND status = 'PENDING'`,
        )
        .bind(dlqMessageId)
        .run();
      return false;
    }

    const claimed = await this.db
      .prepare(
        `UPDATE dlq_messages
         SET status = 'REPLAYING', replayed_by = ?, replay_lease_expires_at = ?,
             replay_lease_token = ?, last_error_code = NULL
         WHERE dlq_message_id = ? AND (
           status = 'PENDING' OR
           (status = 'REPLAYING' AND replay_lease_expires_at <= ?)
         )`,
      )
      .bind(actorId, replayLeaseExpiresAt, replayLeaseToken, dlqMessageId, now)
      .run();
    if (changes(claimed) !== 1) return false;

    try {
      await queue.send(event);
      await this.db
        .prepare(
          `UPDATE dlq_messages
           SET status = 'REPLAYED', replayed_at = ?, replay_lease_expires_at = NULL,
               replay_lease_token = NULL
           WHERE dlq_message_id = ? AND status = 'REPLAYING'
             AND replay_lease_token = ?`,
        )
        .bind(now, dlqMessageId, replayLeaseToken)
        .run();
      return true;
    } catch (error) {
      await this.db
        .prepare(
          `UPDATE dlq_messages
           SET status = 'PENDING', replayed_by = NULL, replay_lease_expires_at = NULL,
               replay_lease_token = NULL, last_error_code = 'REPLAY_SEND_FAILED'
           WHERE dlq_message_id = ? AND status = 'REPLAYING'
             AND replay_lease_token = ?`,
        )
        .bind(dlqMessageId, replayLeaseToken)
        .run();
      throw error;
    }
  }
}
