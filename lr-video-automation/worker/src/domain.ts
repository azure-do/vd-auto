export const JOB_STATES = [
  "RECEIVED",
  "VALIDATING",
  "VALIDATION_FAILED",
  "CLASS_UNRESOLVED",
  "PROCESSING",
  "WAITING_APPROVAL",
  "REJECTED",
  "APPROVED",
  "PUBLISHING",
  "PARTIALLY_PUBLISHED",
  "PUBLISHED",
  "FAILED",
] as const;

export type JobState = (typeof JOB_STATES)[number];
export type MediaDestination = "youtube" | "instagram" | "tiktok";
export type ActorType = "system" | "teacher" | "approver" | "operator";

export interface PublicationTarget {
  destination: MediaDestination;
  targetAccountId: string;
}

export interface Actor {
  type: ActorType;
  id: string;
}

export interface VideoJob {
  video_job_id: string;
  submission_id: string;
  branch_id: string;
  studio_id: string;
  class_id: string;
  teacher_id: string;
  state: JobState;
  approved_content_version: string | null;
  youtube_status: string;
  instagram_status: string;
  tiktok_status: string;
  retention_state: "HOLD" | "RETAINED" | "DUE_FOR_DELETION" | "DELETED";
  retention_start_at: string | null;
  delete_due_at: string | null;
  creation_fingerprint: string;
  last_mutation_token: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface CreateVideoJobInput {
  videoJobId: string;
  submissionId: string;
  branchId: string;
  studioId: string;
  classId: string;
  teacherId: string;
  actor: Actor;
  now: string;
}

export interface TransitionJobInput {
  videoJobId: string;
  expectedState: JobState;
  nextState: JobState;
  actor: Actor;
  now: string;
  approvedContentVersion?: string;
  publicationTargets?: readonly PublicationTarget[];
  mutationToken?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const APPROVED_CONTENT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export function assertUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${field} must be a UUID`);
}

export function assertInternalId(value: string, field: string): void {
  if (!INTERNAL_ID_PATTERN.test(value) || value.includes("@")) {
    throw new TypeError(`${field} must be a non-email internal ID`);
  }
}

export function assertApprovedContentVersion(value: string): void {
  if (!APPROVED_CONTENT_VERSION_PATTERN.test(value) || value.includes("@")) {
    throw new TypeError(
      "approvedContentVersion must be a non-email identifier using A-Z, a-z, 0-9, dot, underscore, colon, or hyphen",
    );
  }
}

export function isSafeYouTubeVideoId(value: unknown): value is string {
  return typeof value === "string" && YOUTUBE_VIDEO_ID_PATTERN.test(value);
}

export function assertCreateVideoJobInput(input: CreateVideoJobInput): void {
  assertUuid(input.videoJobId, "videoJobId");
  assertUuid(input.submissionId, "submissionId");
  for (const [field, value] of Object.entries({
    branchId: input.branchId,
    studioId: input.studioId,
    classId: input.classId,
    teacherId: input.teacherId,
  })) assertInternalId(value, field);
  assertInternalId(input.actor.id, "actor.id");
}

export type QueueEvent =
  | {
      version: 1;
      event_id: string;
      event_type: "video.uploaded";
      occurred_at: string;
      payload: {
        submission_id: string;
        object_ref: string;
        actor_id: string;
      };
    }
  | {
      version: 1;
      event_id: string;
      event_type: "job.transition.requested";
      occurred_at: string;
      payload: {
        video_job_id: string;
        expected_state: JobState;
        next_state: JobState;
        actor_id: string;
        approved_content_version?: string;
        publication_targets?: Array<{
          destination: MediaDestination;
          target_account_id: string;
        }>;
      };
    }
  | {
      version: 1;
      event_id: string;
      event_type: "publication.claim.requested";
      occurred_at: string;
      payload: {
        video_job_id: string;
        destination: MediaDestination;
        target_account_id: string;
        approved_content_version: string;
        actor_id: string;
      };
    }
  | {
      version: 1;
      event_id: string;
      event_type: "retention.sweep.requested";
      occurred_at: string;
      payload: {
        actor_id: string;
      };
    };

export function isJobState(value: unknown): value is JobState {
  return typeof value === "string" && JOB_STATES.includes(value as JobState);
}

export function isQueueEvent(value: unknown): value is QueueEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (!(
    event.version === 1 &&
    typeof event.event_id === "string" &&
    typeof event.event_type === "string" &&
    typeof event.occurred_at === "string" &&
    !!event.payload &&
    typeof event.payload === "object"
  )) return false;

  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.actor_id !== "string") return false;
  try {
    assertUuid(event.event_id, "event_id");
    assertInternalId(payload.actor_id, "actor_id");
    if (Number.isNaN(Date.parse(event.occurred_at))) return false;
  } catch {
    return false;
  }
  if (event.event_type === "retention.sweep.requested") return true;
  if (event.event_type === "video.uploaded") {
    if (
      typeof payload.submission_id !== "string"
      || typeof payload.object_ref !== "string"
    ) return false;
    try {
      assertUuid(payload.submission_id, "submission_id");
      assertInternalId(payload.object_ref, "object_ref");
    } catch {
      return false;
    }
    return true;
  }
  if (typeof payload.video_job_id !== "string") return false;
  try {
    assertUuid(payload.video_job_id, "video_job_id");
  } catch {
    return false;
  }
  if (event.event_type === "job.transition.requested") {
    if (payload.approved_content_version !== undefined) {
      if (typeof payload.approved_content_version !== "string") return false;
      try {
        assertApprovedContentVersion(payload.approved_content_version);
      } catch {
        return false;
      }
    }
    if (payload.publication_targets !== undefined) {
      if (!Array.isArray(payload.publication_targets)) return false;
      try {
        for (const target of payload.publication_targets) {
          if (!target || typeof target !== "object") return false;
          const record = target as Record<string, unknown>;
          if (
            typeof record.destination !== "string" ||
            typeof record.target_account_id !== "string"
          ) return false;
          if (!(["youtube", "instagram", "tiktok"] as const).includes(
            record.destination as MediaDestination,
          )) return false;
          assertInternalId(record.target_account_id, "target_account_id");
        }
      } catch {
        return false;
      }
    }
    return (
      isJobState(payload.expected_state) &&
      isJobState(payload.next_state) &&
      (payload.approved_content_version === undefined ||
        typeof payload.approved_content_version === "string") &&
      (payload.next_state !== "APPROVED" ||
        (Array.isArray(payload.publication_targets) && payload.publication_targets.length > 0))
    );
  }
  if (event.event_type === "publication.claim.requested") {
    if (
      typeof payload.destination !== "string" ||
      typeof payload.target_account_id !== "string" ||
      typeof payload.approved_content_version !== "string"
    ) return false;
    try {
      assertApprovedContentVersion(payload.approved_content_version);
      assertInternalId(payload.target_account_id, "target_account_id");
    } catch {
      return false;
    }
    return ["youtube", "instagram", "tiktok"].includes(payload.destination);
  }
  return false;
}

export function normalizeQueueEvent(value: unknown): QueueEvent | null {
  if (!isQueueEvent(value)) return null;
  const occurredAt = new Date(value.occurred_at).toISOString();
  if (value.event_type === "retention.sweep.requested") {
    return {
      version: 1,
      event_id: value.event_id,
      event_type: value.event_type,
      occurred_at: occurredAt,
      payload: { actor_id: value.payload.actor_id },
    };
  }
  if (value.event_type === "video.uploaded") {
    return {
      version: 1,
      event_id: value.event_id,
      event_type: value.event_type,
      occurred_at: occurredAt,
      payload: {
        submission_id: value.payload.submission_id,
        object_ref: value.payload.object_ref,
        actor_id: value.payload.actor_id,
      },
    };
  }
  if (value.event_type === "publication.claim.requested") {
    return {
      version: 1,
      event_id: value.event_id,
      event_type: value.event_type,
      occurred_at: occurredAt,
      payload: {
        video_job_id: value.payload.video_job_id,
        destination: value.payload.destination,
        target_account_id: value.payload.target_account_id,
        approved_content_version: value.payload.approved_content_version,
        actor_id: value.payload.actor_id,
      },
    };
  }
  const targets = value.payload.publication_targets
    ?.map((target) => ({
      destination: target.destination,
      target_account_id: target.target_account_id,
    }))
    .sort((left, right) =>
      `${left.destination}:${left.target_account_id}`.localeCompare(
        `${right.destination}:${right.target_account_id}`,
      ));
  return {
    version: 1,
    event_id: value.event_id,
    event_type: value.event_type,
    occurred_at: occurredAt,
    payload: {
      video_job_id: value.payload.video_job_id,
      expected_state: value.payload.expected_state,
      next_state: value.payload.next_state,
      actor_id: value.payload.actor_id,
      ...(value.payload.approved_content_version === undefined
        ? {}
        : { approved_content_version: value.payload.approved_content_version }),
      ...(targets === undefined ? {} : { publication_targets: targets }),
    },
  };
}

export function buildIdempotencyKey(
  videoJobId: string,
  destination: MediaDestination,
  targetAccountId: string,
  approvedContentVersion: string,
): string {
  assertUuid(videoJobId, "videoJobId");
  assertInternalId(targetAccountId, "targetAccountId");
  assertApprovedContentVersion(approvedContentVersion);
  return JSON.stringify([videoJobId, destination, targetAccountId, approvedContentVersion]);
}
