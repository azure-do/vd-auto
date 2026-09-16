import {
  assertApprovedContentVersion,
  assertInternalId,
  assertUuid,
  isSafeYouTubeVideoId,
} from "./domain";
import { assertSha256Hex } from "./fingerprint";

const HAS_OWN_PROPERTY = Object.prototype.hasOwnProperty;
const REFLECT_APPLY = Reflect.apply;

function hasOwn(value: object, key: PropertyKey): boolean {
  return REFLECT_APPLY(HAS_OWN_PROPERTY, value, [key]);
}

export type YouTubeUploadStatus = "uploaded" | "processed" | "failed" | "rejected";
export type YouTubeProcessingStatus = "processing" | "succeeded" | "failed" | "terminated";
export type YouTubePrivacyStatus = "private" | "public" | "unlisted";

export interface StructuredPublicationError {
  code: string;
  media?: "youtube";
  retryable: boolean;
  message: string;
  occurred_at: string;
  provider_reason_code?: string;
}

export type PrivateOnlyPublicationError = StructuredPublicationError & {
  code: "YOUTUBE_PRIVATE_ONLY" | "YOUTUBE_SCHEDULE_NOT_ALLOWED";
};

export interface R2ObjectDescriptor {
  objectKey: string;
  expectedSize: number;
  expectedSha256: string;
}

export interface R2ObjectMetadata {
  size: number;
  checksumSha256: string;
}

export interface R2RangeRequest {
  objectKey: string;
  offset: number;
  length: number;
}

export interface R2RangeResponse {
  offset: number;
  totalSize: number;
  bytes: Uint8Array;
}

/** E-5.5 will provide the real adapter. E-5.1 only supplies this boundary and a local fake. */
export interface R2ReadClient {
  headObject(objectKey: string): Promise<R2ObjectMetadata>;
  readRange(request: R2RangeRequest): Promise<R2RangeResponse>;
}

declare const PRIVATE_YOUTUBE_REQUEST_BRAND: unique symbol;

export interface YouTubePrivateUploadRequest {
  readonly [PRIVATE_YOUTUBE_REQUEST_BRAND]: true;
  idempotencyKey: string;
  videoJobId: string;
  targetAccountId: string;
  approvedContentVersion: string;
  source: R2ObjectDescriptor;
  providerRequest: YouTubeVideosInsertPrivateRequest;
}

/** Exact provider-facing visibility fragment used when a resumable session is added in E-5.6. */
export interface YouTubeVideosInsertPrivateRequest {
  readonly part: "status";
  readonly requestBody: {
    readonly status: {
      readonly privacyStatus: "private";
    };
  };
}

export type YouTubePublishObservation =
  | {
      kind: "status";
      uploadStatus: YouTubeUploadStatus;
      processingStatus: YouTubeProcessingStatus;
      privacyStatus: YouTubePrivacyStatus;
      videoId?: string;
      failureReason?: string;
      rejectionReason?: string;
    }
  | {
      kind: "outcome_unknown";
      reason: "response_lost" | "timeout" | "confirmation_unavailable";
    };

export interface PublishContractInput {
  videoJobId: string;
  targetAccountId: string;
  approvedContentVersion: string;
  source: R2ObjectDescriptor;
  requestedPrivacyStatus?: YouTubePrivacyStatus | string;
  publishAt?: string | null;
  actorId: string;
}

export type YouTubeContractDecision =
  | { state: "PUBLISHED"; videoId: string }
  | { state: "PUBLISHING" }
  | { state: "FAILED"; error: StructuredPublicationError }
  | { state: "OUTCOME_UNKNOWN"; error: StructuredPublicationError };

function error<Code extends string>(
  code: Code,
  retryable: boolean,
  message: string,
  occurredAt: string,
  providerReasonCode?: string,
): StructuredPublicationError & { code: Code } {
  return {
    code,
    media: "youtube",
    retryable,
    message,
    occurred_at: occurredAt,
    ...(providerReasonCode ? { provider_reason_code: providerReasonCode } : {}),
  };
}

const FAILURE_REASON_CODES: Readonly<Record<string, string>> = {
  uploadFailed: "UPLOAD_FAILED",
  transcodeFailed: "TRANSCODE_FAILED",
  streamingFailed: "STREAMING_FAILED",
  other: "OTHER_FAILURE",
};

const REJECTION_REASON_CODES: Readonly<Record<string, string>> = {
  claim: "CLAIM",
  copyright: "COPYRIGHT",
  duplicate: "DUPLICATE",
  inappropriate: "INAPPROPRIATE",
  legal: "LEGAL",
  length: "LENGTH",
  termsOfUse: "TERMS_OF_USE",
  trademark: "TRADEMARK",
  uploaderAccountClosed: "UPLOADER_ACCOUNT_CLOSED",
  uploaderAccountSuspended: "UPLOADER_ACCOUNT_SUSPENDED",
};

function safeProviderReason(
  kind: "failure" | "rejection",
  value: string | undefined,
): string {
  const accepted = kind === "failure" ? FAILURE_REASON_CODES : REJECTION_REASON_CODES;
  return (value && accepted[value]) ??
    (kind === "failure" ? "UNSPECIFIED_FAILURE" : "UNSPECIFIED_REJECTION");
}

export function assertPublishContractInput(input: PublishContractInput): void {
  assertYouTubeUploadIdentityAndSource(input);
  assertInternalId(input.actorId, "actorId");
}

/** Shared by the service entry point and the final request builder. */
export function assertYouTubeUploadIdentityAndSource(
  input: Pick<PublishContractInput, "videoJobId" | "targetAccountId" | "approvedContentVersion" | "source">,
): void {
  assertUuid(input.videoJobId, "videoJobId");
  assertInternalId(input.targetAccountId, "targetAccountId");
  assertApprovedContentVersion(input.approvedContentVersion);
  if (
    input.source.objectKey.length === 0 ||
    input.source.objectKey.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(input.source.objectKey) ||
    input.source.objectKey.includes("://") ||
    input.source.objectKey.includes("@")
  ) {
    throw new TypeError("source.objectKey must be a non-secret internal object reference");
  }
  if (!Number.isSafeInteger(input.source.expectedSize) || input.source.expectedSize <= 0) {
    throw new TypeError("source.expectedSize must be a positive safe integer");
  }
  assertSha256Hex(input.source.expectedSha256, "source.expectedSha256");
}

export function validatePrivateOnlyRequest(
  input: Pick<PublishContractInput, "requestedPrivacyStatus" | "publishAt">,
  occurredAt: string,
): PrivateOnlyPublicationError | null {
  if (
    input.requestedPrivacyStatus !== undefined &&
    input.requestedPrivacyStatus !== "private"
  ) {
    return error(
      "YOUTUBE_PRIVATE_ONLY",
      false,
      "YouTube publication is restricted to private visibility",
      occurredAt,
    );
  }
  if (hasOwn(input, "publishAt")) {
    return error(
      "YOUTUBE_SCHEDULE_NOT_ALLOWED",
      false,
      "Scheduled publication is not allowed",
      occurredAt,
    );
  }
  return null;
}

export function classifyYouTubeObservation(
  observation: YouTubePublishObservation,
  occurredAt: string,
): YouTubeContractDecision {
  if (observation.kind === "outcome_unknown") {
    return {
      state: "OUTCOME_UNKNOWN",
      error: error(
        "YOUTUBE_OUTCOME_UNKNOWN",
        true,
        "The final YouTube result could not be confirmed",
        occurredAt,
      ),
    };
  }

  if (observation.uploadStatus === "rejected") {
    return {
      state: "FAILED",
      error: error(
        "YOUTUBE_REJECTED",
        false,
        "YouTube rejected the upload and human review is required",
        occurredAt,
        safeProviderReason("rejection", observation.rejectionReason),
      ),
    };
  }
  if (
    observation.uploadStatus === "failed" ||
    observation.processingStatus === "failed" ||
    observation.processingStatus === "terminated"
  ) {
    return {
      state: "FAILED",
      error: error(
        "YOUTUBE_PROCESSING_FAILED",
        true,
        "YouTube processing failed",
        occurredAt,
        safeProviderReason("failure", observation.failureReason),
      ),
    };
  }
  if (observation.privacyStatus !== "private") {
    return {
      state: "FAILED",
      error: error(
        "YOUTUBE_PRIVACY_MISMATCH",
        false,
        "YouTube did not confirm private visibility",
        occurredAt,
      ),
    };
  }
  if (observation.processingStatus === "processing") {
    return { state: "PUBLISHING" };
  }
  if (
    observation.uploadStatus === "processed" &&
    observation.processingStatus === "succeeded"
  ) {
    if (!isSafeYouTubeVideoId(observation.videoId)) {
      return {
        state: "OUTCOME_UNKNOWN",
        error: error(
          "YOUTUBE_VIDEO_ID_INVALID",
          true,
          "YouTube reported completion with an invalid opaque video identifier; reconciliation is required",
          occurredAt,
          "INVALID_VIDEO_ID",
        ),
      };
    }
    return { state: "PUBLISHED", videoId: observation.videoId };
  }
  return {
    state: "OUTCOME_UNKNOWN",
    error: error(
      "YOUTUBE_STATUS_INDETERMINATE",
      true,
      "The YouTube status combination did not establish a final result",
      occurredAt,
    ),
  };
}

export function makePublicationError<Code extends string>(
  code: Code,
  retryable: boolean,
  message: string,
  occurredAt: string,
): StructuredPublicationError & { code: Code } {
  return error(code, retryable, message, occurredAt);
}
