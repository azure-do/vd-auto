import {
  buildIdempotencyKey,
  isSafeYouTubeVideoId,
  type Actor,
  type VideoJob,
} from "./domain";
import type { PublicationRecordStatus } from "./repository";
import {
  classifyYouTubeObservation,
  makePublicationError,
  type PrivateOnlyPublicationError,
  type PublishContractInput,
  type R2ReadClient,
  type StructuredPublicationError,
  type YouTubePrivateUploadRequest,
  type YouTubePublishObservation,
} from "./e5-contracts";
import { validatePrivateOnlyRequest } from "./e5-contracts";
import {
  R2StreamError,
  type R2StreamingSource,
  type VerifiedR2Source,
  verifyR2Source,
} from "./e5-r2-stream";
import {
  buildPrivateYouTubeUploadRequest,
  dispatchGuardedPrivateYouTubeUpload,
  type GuardedYouTubePublishClient,
  type ImmutablePublishContractInput,
  snapshotPublishContractInput,
  trySnapshotPublishContractAuditContext,
  YouTubePrivateRequestRejectedError,
} from "./e5-youtube-private-request";

const HAS_OWN_PROPERTY = Object.prototype.hasOwnProperty;
const REFLECT_APPLY = Reflect.apply;

function hasOwn(value: object, key: PropertyKey): boolean {
  return REFLECT_APPLY(HAS_OWN_PROPERTY, value, [key]);
}

interface PublicationRepository {
  claimPublication(input: {
    videoJobId: string;
    destination: "youtube";
    targetAccountId: string;
    approvedContentVersion: string;
    actor: Actor;
    now: string;
    mutationToken?: string;
  }): Promise<{ claimed: boolean; idempotencyKey: string }>;
  renewPublicationClaimLease(input: {
    videoJobId: string;
    destination: "youtube";
    targetAccountId: string;
    approvedContentVersion: string;
    mutationToken: string;
    now: string;
    expiredBefore: string;
  }): Promise<boolean>;
  recoverExpiredYoutubePublicationClaim(input: {
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
  }): Promise<{ recovered: boolean; job: VideoJob }>;
  releaseYoutubePublicationClaim(input: {
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
  }): Promise<VideoJob>;
  prepareYoutubeSideEffect(input: {
    videoJobId: string;
    targetAccountId: string;
    approvedContentVersion: string;
    claimMutationToken: string;
    fenceToken: string;
    now: string;
  }): Promise<{ allowed: boolean; attemptNo: number | null }>;
  recordYoutubeUploadProgress(input: {
    videoJobId: string;
    targetAccountId: string;
    approvedContentVersion: string;
    fenceToken: string;
    committedOffset: number;
    videoId?: string;
    sessionState?: "ACTIVE" | "UNUSABLE";
    now: string;
  }): Promise<boolean>;
  recordPublicationResult(input: {
    videoJobId: string;
    destination: "youtube";
    targetAccountId: string;
    approvedContentVersion: string;
    result: "SUCCEEDED" | "FAILED" | "OUTCOME_UNKNOWN" | "RECONCILIATION_REQUIRED";
    actor: Actor;
    now: string;
    resultRef?: string;
    error?: {
      code: string;
      providerReasonCode?: string;
      retryable: boolean;
    };
    mutationToken?: string;
    expectedClaimMutationToken?: string;
  }): Promise<VideoJob>;
  getPublicationRecord(input: {
    videoJobId: string;
    destination: "youtube";
    targetAccountId: string;
    approvedContentVersion: string;
  }): Promise<{
    status: PublicationRecordStatus;
    result_ref: string | null;
    error_code: string | null;
    provider_reason_code: string | null;
    retryable: 0 | 1 | null;
    attempt_no: number;
    yt_committed_offset: number;
    yt_video_id: string | null;
    yt_session_state: "NONE" | "ACTIVE" | "UNUSABLE";
    yt_reconciled_at: string | null;
    updated_at: string;
  } | null>;
  getVideoJob(videoJobId: string): Promise<VideoJob | null>;
  recordYoutubePublicationPolicyRejection(input: {
    videoJobId: string;
    targetAccountId: string;
    approvedContentVersion: string;
    actor: Actor;
    now: string;
    expectedRowVersion: number;
    errorCode: "YOUTUBE_PRIVATE_ONLY" | "YOUTUBE_SCHEDULE_NOT_ALLOWED";
  }): Promise<VideoJob>;
}

export type PublishContractState =
  | "VALIDATION_FAILED"
  | "PUBLISHING"
  | "PUBLISHED"
  | "FAILED"
  | "OUTCOME_UNKNOWN"
  | "RECONCILIATION_REQUIRED";

export interface PublishContractResult {
  state: PublishContractState;
  duplicate: boolean;
  sideEffectStarted: boolean;
  transitions: readonly PublishContractState[];
  job: VideoJob | null;
  error?: StructuredPublicationError;
  publicationRef?: string;
}

function persistenceError(error: StructuredPublicationError): {
  code: string;
  providerReasonCode?: string;
  retryable: boolean;
} {
  return {
    code: error.code,
    ...(error.provider_reason_code
      ? { providerReasonCode: error.provider_reason_code }
      : {}),
    retryable: error.retryable,
  };
}

function restoredError(record: {
  error_code: string | null;
  provider_reason_code: string | null;
  retryable: 0 | 1 | null;
  updated_at: string;
}): StructuredPublicationError | undefined {
  if (!record.error_code || record.retryable === null) return undefined;
  return {
    code: record.error_code,
    media: "youtube",
    retryable: record.retryable === 1,
    message: "The previous publication result was restored from the idempotency record",
    occurred_at: record.updated_at,
    ...(record.provider_reason_code
      ? { provider_reason_code: record.provider_reason_code }
      : {}),
  };
}

function r2PublicationError(
  sourceError: R2StreamError,
  occurredAt: string,
): StructuredPublicationError {
  const messages: Record<R2StreamError["code"], string> = {
    R2_SOURCE_UNAVAILABLE: "The source object could not be read",
    R2_SIZE_MISMATCH: "The source object size did not match the approved metadata",
    R2_CHECKSUM_MISMATCH: "The source object checksum did not match the approved metadata",
    R2_RANGE_INVALID: "The source range response was inconsistent",
    R2_RANGE_READ_FAILED: "The source range could not be read",
  };
  return makePublicationError(
    sourceError.code,
    sourceError.retryable,
    messages[sourceError.code],
    occurredAt,
  );
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function duplicateState(status: PublicationRecordStatus): PublishContractState {
  if (status === "SUCCEEDED") return "PUBLISHED";
  if (status === "FAILED") return "FAILED";
  if (status === "OUTCOME_UNKNOWN") return "OUTCOME_UNKNOWN";
  if (status === "RECONCILIATION_REQUIRED") return "RECONCILIATION_REQUIRED";
  return "PUBLISHING";
}

const DEFAULT_CLAIM_LEASE_MS = 5 * 60 * 1000;

function leaseBoundary(now: string, leaseMs: number): string {
  return new Date(Date.parse(now) - leaseMs).toISOString();
}

function isClaimLeaseFresh(updatedAt: string, now: string, leaseMs: number): boolean {
  return Date.parse(updatedAt) > Date.parse(now) - leaseMs;
}

export class E5PublishContractService {
  private readonly rangeSize: number;
  private readonly claimLeaseMs: number;

  constructor(
    private readonly repository: PublicationRepository,
    private readonly youtube: GuardedYouTubePublishClient,
    private readonly r2: R2ReadClient | R2StreamingSource,
    private readonly now: () => string = () => new Date().toISOString(),
    options: { rangeSize?: number; claimLeaseMs?: number } = {},
  ) {
    this.rangeSize = options.rangeSize ?? 4;
    this.claimLeaseMs = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    if (!Number.isSafeInteger(this.rangeSize) || this.rangeSize <= 0) {
      throw new TypeError("rangeSize must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.claimLeaseMs) || this.claimLeaseMs <= 0) {
      throw new TypeError("claimLeaseMs must be a positive safe integer");
    }
  }

  async execute(rawInput: PublishContractInput): Promise<PublishContractResult> {
    const occurredAt = this.now();
    const recordPolicyRejection = async (
      safeInput: ImmutablePublishContractInput,
      rejection: PrivateOnlyPublicationError,
    ): Promise<PublishContractResult> => {
      const snapshot = await this.repository.getVideoJob(safeInput.videoJobId);
      if (!snapshot) throw new Error("Video job was not found for policy rejection");
      const job = await this.repository.recordYoutubePublicationPolicyRejection({
        videoJobId: safeInput.videoJobId,
        targetAccountId: safeInput.targetAccountId,
        approvedContentVersion: safeInput.approvedContentVersion,
        actor: { type: "system", id: safeInput.actorId },
        now: occurredAt,
        expectedRowVersion: snapshot.row_version,
        errorCode: rejection.code,
      });
      return {
        state: "VALIDATION_FAILED",
        duplicate: false,
        sideEffectStarted: false,
        transitions: ["VALIDATION_FAILED"],
        job,
        error: rejection,
      };
    };
    let input: ImmutablePublishContractInput;
    try {
      input = snapshotPublishContractInput(rawInput);
    } catch (shapeError) {
      if (!(shapeError instanceof YouTubePrivateRequestRejectedError)) throw shapeError;
      const auditContext = trySnapshotPublishContractAuditContext(rawInput);
      if (!auditContext) throw shapeError;
      return recordPolicyRejection(auditContext, makePublicationError(
        shapeError.code,
        false,
        "The YouTube request shape contained a forbidden publication policy field",
        occurredAt,
      ));
    }
    const policyError = validatePrivateOnlyRequest(input, occurredAt);
    if (policyError) {
      return recordPolicyRejection(input, policyError);
    }

    let uploadRequest: YouTubePrivateUploadRequest;
    try {
      uploadRequest = buildPrivateYouTubeUploadRequest({
        videoJobId: input.videoJobId,
        targetAccountId: input.targetAccountId,
        approvedContentVersion: input.approvedContentVersion,
        source: input.source,
        actorId: input.actorId,
        ...(hasOwn(input, "requestedPrivacyStatus")
          ? { requestedPrivacyStatus: input.requestedPrivacyStatus }
          : {}),
        ...(hasOwn(input, "publishAt")
          ? { publishAt: input.publishAt }
          : {}),
        idempotencyKey: buildIdempotencyKey(
          input.videoJobId,
          "youtube",
          input.targetAccountId,
          input.approvedContentVersion,
        ),
      });
    } catch (buildError) {
      if (!(buildError instanceof YouTubePrivateRequestRejectedError)) throw buildError;
      return recordPolicyRejection(input, makePublicationError(
        buildError.code,
        false,
        "The YouTube request contained a forbidden publication policy field",
        occurredAt,
      ));
    }

    const actor = { type: "system" as const, id: input.actorId };
    const claimMutationToken = `e5_claim_${crypto.randomUUID()}`;
    const claim = await this.repository.claimPublication({
      videoJobId: input.videoJobId,
      destination: "youtube",
      targetAccountId: input.targetAccountId,
      approvedContentVersion: input.approvedContentVersion,
      actor,
      now: occurredAt,
      mutationToken: claimMutationToken,
    });
    if (!claim.claimed) {
      const record = await this.repository.getPublicationRecord({
        videoJobId: input.videoJobId,
        destination: "youtube",
        targetAccountId: input.targetAccountId,
        approvedContentVersion: input.approvedContentVersion,
      });
      if (!record) {
        throw new Error("Claimed publication record was not found");
      }
      const priorError = restoredError(record);
      if (record.status === "CLAIMED") {
        if (isClaimLeaseFresh(record.updated_at, occurredAt, this.claimLeaseMs)) {
          return {
            state: "PUBLISHING",
            duplicate: true,
            sideEffectStarted: false,
            transitions: ["PUBLISHING"],
            job: await this.repository.getVideoJob(input.videoJobId),
          };
        }
        const interruptedError = makePublicationError(
          "YOUTUBE_SIDE_EFFECT_START_UNKNOWN",
          true,
          "The worker stopped after claiming the publication; reconciliation is required before another upload",
          occurredAt,
        );
        const tokenSuffix = await sha256Bytes(
          new TextEncoder().encode(claim.idempotencyKey),
        );
        const recovery = await this.repository.recoverExpiredYoutubePublicationClaim({
          videoJobId: input.videoJobId,
          targetAccountId: input.targetAccountId,
          approvedContentVersion: input.approvedContentVersion,
          actor,
          now: occurredAt,
          expiredBefore: leaseBoundary(occurredAt, this.claimLeaseMs),
          error: {
            ...persistenceError(interruptedError),
            retryable: true,
          },
          mutationToken: `e5_interrupted_unknown_${tokenSuffix}`,
        });
        if (!recovery.recovered) {
          const latest = await this.repository.getPublicationRecord({
            videoJobId: input.videoJobId,
            destination: "youtube",
            targetAccountId: input.targetAccountId,
            approvedContentVersion: input.approvedContentVersion,
          });
          if (!latest) throw new Error("Publication record disappeared during recovery");
          const state = duplicateState(latest.status);
          const latestError = restoredError(latest);
          return {
            state,
            duplicate: true,
            sideEffectStarted: false,
            transitions: [state],
            job: recovery.job,
            ...(latest.status === "SUCCEEDED" && latest.result_ref
              ? { publicationRef: latest.result_ref }
              : {}),
            ...(latestError ? { error: latestError } : {}),
          };
        }
        let latest = await this.repository.getPublicationRecord({
          videoJobId: input.videoJobId,
          destination: "youtube",
          targetAccountId: input.targetAccountId,
          approvedContentVersion: input.approvedContentVersion,
        });
        if (latest?.status === "OUTCOME_UNKNOWN") {
          try {
            await this.repository.recordPublicationResult({
              videoJobId: input.videoJobId,
              destination: "youtube",
              targetAccountId: input.targetAccountId,
              approvedContentVersion: input.approvedContentVersion,
              result: "RECONCILIATION_REQUIRED",
              actor,
              now: occurredAt,
              error: persistenceError(interruptedError),
              mutationToken: `e5_interrupted_reconcile_${tokenSuffix}`,
            });
          } catch (error) {
            latest = await this.repository.getPublicationRecord({
              videoJobId: input.videoJobId,
              destination: "youtube",
              targetAccountId: input.targetAccountId,
              approvedContentVersion: input.approvedContentVersion,
            });
            if (latest?.status !== "RECONCILIATION_REQUIRED") throw error;
          }
        }
        latest = await this.repository.getPublicationRecord({
          videoJobId: input.videoJobId,
          destination: "youtube",
          targetAccountId: input.targetAccountId,
          approvedContentVersion: input.approvedContentVersion,
        });
        if (!latest) throw new Error("Publication record disappeared during recovery");
        const recoveredState = duplicateState(latest.status);
        const recoveredError = restoredError(latest) ?? interruptedError;
        return {
          state: recoveredState,
          duplicate: true,
          sideEffectStarted: false,
          transitions: recoveredState === "RECONCILIATION_REQUIRED"
            ? ["OUTCOME_UNKNOWN", "RECONCILIATION_REQUIRED"]
            : [recoveredState],
          job: await this.repository.getVideoJob(input.videoJobId),
          ...(latest.status === "SUCCEEDED" && latest.result_ref
            ? { publicationRef: latest.result_ref }
            : {}),
          ...(latest.status === "SUCCEEDED" ? {} : { error: recoveredError }),
        };
      }
      if (record.status === "OUTCOME_UNKNOWN") {
        const reconciliationMutationToken = `e5_reconcile_${await sha256Bytes(
          new TextEncoder().encode(claim.idempotencyKey),
        )}`;
        const job = await this.repository.recordPublicationResult({
          videoJobId: input.videoJobId,
          destination: "youtube",
          targetAccountId: input.targetAccountId,
          approvedContentVersion: input.approvedContentVersion,
          result: "RECONCILIATION_REQUIRED",
          actor,
          now: occurredAt,
          ...(priorError
            ? { error: persistenceError(priorError) }
            : {}),
          mutationToken: reconciliationMutationToken,
        });
        return {
          state: "RECONCILIATION_REQUIRED",
          duplicate: true,
          sideEffectStarted: false,
          transitions: ["RECONCILIATION_REQUIRED"],
          job,
          ...(priorError ? { error: priorError } : {}),
        };
      }
      const job = await this.repository.getVideoJob(input.videoJobId);
      const state = duplicateState(record.status);
      return {
        state,
        duplicate: true,
        sideEffectStarted: false,
        transitions: [state],
        job,
        ...(record.status === "SUCCEEDED" && record.result_ref
          ? { publicationRef: record.result_ref }
          : {}),
        ...(priorError ? { error: priorError } : {}),
      };
    }

    let sourceError: StructuredPublicationError | null = null;
    let verifiedSource: VerifiedR2Source | null = null;
    try {
      verifiedSource = await verifyR2Source(this.r2, uploadRequest.source, {
        contractRangeSize: this.rangeSize,
      });
    } catch (error) {
      sourceError = error instanceof R2StreamError
        ? r2PublicationError(error, occurredAt)
        : makePublicationError(
            "R2_SOURCE_UNAVAILABLE",
            true,
            "The source object could not be read",
            occurredAt,
          );
    }
    const leaseRenewedAt = this.now();
    const stillOwnsClaim = await this.repository.renewPublicationClaimLease({
      videoJobId: input.videoJobId,
      destination: "youtube",
      targetAccountId: input.targetAccountId,
      approvedContentVersion: input.approvedContentVersion,
      mutationToken: claimMutationToken,
      now: leaseRenewedAt,
      expiredBefore: leaseBoundary(leaseRenewedAt, this.claimLeaseMs),
    });
    if (!stillOwnsClaim) {
      const latest = await this.repository.getPublicationRecord({
        videoJobId: input.videoJobId,
        destination: "youtube",
        targetAccountId: input.targetAccountId,
        approvedContentVersion: input.approvedContentVersion,
      });
      if (!latest) throw new Error("Publication claim disappeared before upload");
      const state = duplicateState(latest.status);
      const latestError = restoredError(latest);
      return {
        state,
        duplicate: true,
        sideEffectStarted: false,
        transitions: [state],
        job: await this.repository.getVideoJob(input.videoJobId),
        ...(latest.status === "SUCCEEDED" && latest.result_ref
          ? { publicationRef: latest.result_ref }
          : {}),
        ...(latestError ? { error: latestError } : {}),
      };
    }
    if (sourceError) {
      const job = sourceError.retryable
        ? await this.repository.releaseYoutubePublicationClaim({
            videoJobId: input.videoJobId,
            targetAccountId: input.targetAccountId,
            approvedContentVersion: input.approvedContentVersion,
            actor,
            now: occurredAt,
            error: {
              code: sourceError.code,
              ...(sourceError.provider_reason_code
                ? { providerReasonCode: sourceError.provider_reason_code }
                : {}),
              retryable: true,
            },
            claimMutationToken,
          })
        : await this.repository.recordPublicationResult({
            videoJobId: input.videoJobId,
            destination: "youtube",
            targetAccountId: input.targetAccountId,
            approvedContentVersion: input.approvedContentVersion,
            result: "FAILED",
            actor,
            now: occurredAt,
            error: persistenceError(sourceError),
            expectedClaimMutationToken: claimMutationToken,
          });
      return {
        state: "FAILED",
        duplicate: false,
        sideEffectStarted: false,
        transitions: ["FAILED"],
        job,
        error: sourceError,
      };
    }

    if (uploadRequest.idempotencyKey !== claim.idempotencyKey) {
      throw new Error("Publication claim idempotency key did not match the guarded request");
    }
    const fenceToken = `e5_fence_${crypto.randomUUID()}`;
    const fence = await this.repository.prepareYoutubeSideEffect({
      videoJobId: input.videoJobId,
      targetAccountId: input.targetAccountId,
      approvedContentVersion: input.approvedContentVersion,
      claimMutationToken,
      fenceToken,
      now: leaseRenewedAt,
    });
    if (!fence.allowed) {
      const latest = await this.repository.getPublicationRecord({
        videoJobId: input.videoJobId,
        destination: "youtube",
        targetAccountId: input.targetAccountId,
        approvedContentVersion: input.approvedContentVersion,
      });
      if (!latest) throw new Error("Publication fence disappeared before upload");
      const state = duplicateState(latest.status);
      return {
        state,
        duplicate: true,
        sideEffectStarted: false,
        transitions: [state],
        job: await this.repository.getVideoJob(input.videoJobId),
        ...(latest.status === "SUCCEEDED" && latest.result_ref
          ? { publicationRef: latest.result_ref }
          : {}),
      };
    }
    let observation: YouTubePublishObservation;
    try {
      if (!verifiedSource) throw new Error("Verified source was not available for upload");
      observation = await dispatchGuardedPrivateYouTubeUpload(
        this.youtube,
        uploadRequest,
        verifiedSource,
      );
    } catch {
      observation = { kind: "outcome_unknown", reason: "response_lost" };
    }
    const decision = classifyYouTubeObservation(observation, occurredAt);

    if (observation.kind === "status" && isSafeYouTubeVideoId(observation.videoId)) {
      const latest = await this.repository.getPublicationRecord({
        videoJobId: input.videoJobId,
        destination: "youtube",
        targetAccountId: input.targetAccountId,
        approvedContentVersion: input.approvedContentVersion,
      });
      const tracked = latest && await this.repository.recordYoutubeUploadProgress({
        videoJobId: input.videoJobId,
        targetAccountId: input.targetAccountId,
        approvedContentVersion: input.approvedContentVersion,
        fenceToken,
        committedOffset: latest.yt_committed_offset,
        videoId: observation.videoId,
        now: occurredAt,
      });
      if (!tracked) {
        const currentRecord = await this.repository.getPublicationRecord({
          videoJobId: input.videoJobId,
          destination: "youtube",
          targetAccountId: input.targetAccountId,
          approvedContentVersion: input.approvedContentVersion,
        });
        if (!currentRecord) throw new Error("Publication record disappeared while tracking video ID");
        const state = duplicateState(currentRecord.status);
        return {
          state,
          duplicate: true,
          sideEffectStarted: true,
          transitions: [state],
          job: await this.repository.getVideoJob(input.videoJobId),
          ...(currentRecord.status === "SUCCEEDED" && currentRecord.result_ref
            ? { publicationRef: currentRecord.result_ref }
            : {}),
        };
      }
    }

    if (decision.state === "PUBLISHING") {
      return {
        state: "PUBLISHING",
        duplicate: false,
        sideEffectStarted: true,
        transitions: ["PUBLISHING"],
        job: await this.repository.getVideoJob(input.videoJobId),
      };
    }
    if (decision.state === "PUBLISHED") {
      const job = await this.repository.recordPublicationResult({
        videoJobId: input.videoJobId,
        destination: "youtube",
        targetAccountId: input.targetAccountId,
        approvedContentVersion: input.approvedContentVersion,
        result: "SUCCEEDED",
        resultRef: decision.videoId,
        actor,
        now: occurredAt,
        expectedClaimMutationToken: claimMutationToken,
      });
      return {
        state: "PUBLISHED",
        duplicate: false,
        sideEffectStarted: true,
        transitions: ["PUBLISHED"],
        job,
        publicationRef: decision.videoId,
      };
    }
    if (decision.state === "FAILED") {
      const job = await this.repository.recordPublicationResult({
        videoJobId: input.videoJobId,
        destination: "youtube",
        targetAccountId: input.targetAccountId,
        approvedContentVersion: input.approvedContentVersion,
        result: "FAILED",
        actor,
        now: occurredAt,
        error: persistenceError(decision.error),
        expectedClaimMutationToken: claimMutationToken,
      });
      return {
        state: "FAILED",
        duplicate: false,
        sideEffectStarted: true,
        transitions: ["FAILED"],
        job,
        error: decision.error,
      };
    }

    await this.repository.recordPublicationResult({
      videoJobId: input.videoJobId,
      destination: "youtube",
      targetAccountId: input.targetAccountId,
      approvedContentVersion: input.approvedContentVersion,
      result: "OUTCOME_UNKNOWN",
      actor,
      now: occurredAt,
      error: persistenceError(decision.error),
      expectedClaimMutationToken: claimMutationToken,
    });
    const job = await this.repository.recordPublicationResult({
      videoJobId: input.videoJobId,
      destination: "youtube",
      targetAccountId: input.targetAccountId,
      approvedContentVersion: input.approvedContentVersion,
      result: "RECONCILIATION_REQUIRED",
      actor,
      now: occurredAt,
      error: persistenceError(decision.error),
    });
    return {
      state: "RECONCILIATION_REQUIRED",
      duplicate: false,
      sideEffectStarted: true,
      transitions: ["OUTCOME_UNKNOWN", "RECONCILIATION_REQUIRED"],
      job,
      error: decision.error,
    };
  }
}
