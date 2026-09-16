import type {
  PublishContractInput,
  R2ObjectDescriptor,
  YouTubePrivateUploadRequest,
  YouTubePublishObservation,
  YouTubeVideosInsertPrivateRequest,
} from "./e5-contracts";
import { assertYouTubeUploadIdentityAndSource } from "./e5-contracts";
import { assertInternalId } from "./domain";
import type { VerifiedR2Source } from "./e5-r2-stream";

// Capture every decision-relevant intrinsic at module initialization. The supported threat model
// includes later prototype/static-method pollution, but not a realm already compromised at load.
const OBJECT_PROTOTYPE = Object.prototype;
const HAS_OWN_PROPERTY = OBJECT_PROTOTYPE.hasOwnProperty;
const GET_PROTOTYPE_OF = Object.getPrototypeOf;
const GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_VALUES = Object.values;
const OBJECT_CREATE = Object.create;
const DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_ENTRIES = Object.entries;
const ARRAY_IS_ARRAY = Array.isArray;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const SET_HAS = Set.prototype.has;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_HAS = WeakSet.prototype.has;
const WEAK_MAP_SET = WeakMap.prototype.set;
const WEAK_MAP_GET = WeakMap.prototype.get;
const JSON_STRINGIFY = JSON.stringify;
const SAFE_STRUCTURED_CLONE = globalThis.structuredClone;
const CLOUDFLARE_CRYPTO = crypto as Crypto & { DigestStream: typeof DigestStream };

export interface YouTubePrivateRequestCandidate {
  idempotencyKey: string;
  videoJobId: string;
  targetAccountId: string;
  approvedContentVersion: string;
  source: R2ObjectDescriptor;
  /** Runtime value from request, configuration, or an internal caller. */
  privacyStatus?: unknown;
  requestedPrivacyStatus?: unknown;
  actorId?: string;
  /** Presence is forbidden, including null or undefined. */
  publishAt?: unknown;
}

export class YouTubePrivateRequestRejectedError extends TypeError {
  constructor(readonly code: "YOUTUBE_PRIVATE_ONLY" | "YOUTUBE_SCHEDULE_NOT_ALLOWED") {
    super(code);
    this.name = "YouTubePrivateRequestRejectedError";
  }
}

const CANDIDATE_KEYS = new Set([
  "idempotencyKey",
  "videoJobId",
  "targetAccountId",
  "approvedContentVersion",
  "source",
  "privacyStatus",
  "requestedPrivacyStatus",
  "actorId",
  "publishAt",
]);
const SOURCE_KEYS = new Set(["objectKey", "expectedSize", "expectedSha256"]);
const PUBLISH_INPUT_KEYS = new Set([
  "videoJobId",
  "targetAccountId",
  "approvedContentVersion",
  "source",
  "requestedPrivacyStatus",
  "publishAt",
  "actorId",
]);
const INHERITED_POLICY_KEYS = [
  "publishAt",
  "privacyStatus",
  "requestedPrivacyStatus",
  "providerRequest",
] as const;
const guardedRequests = new WeakSet<object>();
declare const GUARDED_YOUTUBE_CLIENT_BRAND: unique symbol;
export interface GuardedYouTubePublishClient {
  readonly [GUARDED_YOUTUBE_CLIENT_BRAND]: true;
}
interface ProviderPrivateUploadRequest {
  readonly idempotencyKey: string;
  readonly videoJobId: string;
  readonly targetAccountId: string;
  readonly approvedContentVersion: string;
  readonly providerRequest: YouTubeVideosInsertPrivateRequest;
}

interface VerifiedUploadBody {
  readonly size: number;
  readonly checksumSha256: string;
  open(offset?: number): ReadableStream<Uint8Array>;
}

type PrivateYouTubeAdapter = (
  request: ProviderPrivateUploadRequest,
  source: VerifiedUploadBody,
) => Promise<YouTubePublishObservation>;
const guardedClientAdapters = new WeakMap<object, PrivateYouTubeAdapter>();

function hasOwn(record: object, key: PropertyKey): boolean {
  return REFLECT_APPLY(HAS_OWN_PROPERTY, record, [key]);
}

function reject(code: "YOUTUBE_PRIVATE_ONLY" | "YOUTUBE_SCHEDULE_NOT_ALLOWED"): never {
  throw new YouTubePrivateRequestRejectedError(code);
}

function assertPlainDataRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || ARRAY_IS_ARRAY(value)) {
    reject("YOUTUBE_PRIVATE_ONLY");
  }
  const prototype = GET_PROTOTYPE_OF(value);
  if (prototype !== OBJECT_PROTOTYPE && prototype !== null) {
    reject("YOUTUBE_PRIVATE_ONLY");
  }
  const descriptors = OBJECT_VALUES(GET_OWN_PROPERTY_DESCRIPTORS(value));
  for (let index = 0; index < descriptors.length; index += 1) {
    if (!("value" in descriptors[index]!)) reject("YOUTUBE_PRIVATE_ONLY");
  }
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const keys = REFLECT_OWN_KEYS(record);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    if (typeof key !== "string" || !REFLECT_APPLY(SET_HAS, allowed, [key])) {
      reject(key === "publishAt" ? "YOUTUBE_SCHEDULE_NOT_ALLOWED" : "YOUTUBE_PRIVATE_ONLY");
    }
  }
}

function assertNoInheritedPolicyProperties(record: Record<string, unknown>): void {
  for (let index = 0; index < INHERITED_POLICY_KEYS.length; index += 1) {
    const key = INHERITED_POLICY_KEYS[index]!;
    if (!hasOwn(record, key) && key in record) {
      reject(key === "publishAt" ? "YOUTUBE_SCHEDULE_NOT_ALLOWED" : "YOUTUBE_PRIVATE_ONLY");
    }
  }
}

function frozenNullRecord<T extends object>(entries: Readonly<Record<string, unknown>>): T {
  const record = OBJECT_CREATE(null) as Record<string, unknown>;
  const ownEntries = OBJECT_ENTRIES(entries);
  for (let index = 0; index < ownEntries.length; index += 1) {
    const [key, value] = ownEntries[index]!;
    DEFINE_PROPERTY(record, key, {
      value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return OBJECT_FREEZE(record) as T;
}

function privateProviderRequest(): YouTubeVideosInsertPrivateRequest {
  const status = frozenNullRecord<{ readonly privacyStatus: "private" }>({
    privacyStatus: "private",
  });
  const requestBody = frozenNullRecord<{ readonly status: typeof status }>({ status });
  return frozenNullRecord<YouTubeVideosInsertPrivateRequest>({
    part: "status",
    requestBody,
  });
}

export type ImmutablePublishContractInput = Readonly<PublishContractInput> & {
  readonly source: Readonly<R2ObjectDescriptor>;
};

type UploadIdentityAndSource = Pick<
  ImmutablePublishContractInput,
  "videoJobId" | "targetAccountId" | "approvedContentVersion" | "source"
>;

/** Extract only required own data fields; callers decide whether extra policy fields are allowed. */
function snapshotUploadIdentityAndSource(value: unknown): UploadIdentityAndSource {
  assertPlainDataRecord(value);
  assertPlainDataRecord(value.source);
  const requiredInputKeys = [
    "videoJobId",
    "targetAccountId",
    "approvedContentVersion",
    "source",
  ];
  for (let index = 0; index < requiredInputKeys.length; index += 1) {
    const required = requiredInputKeys[index]!;
    if (!hasOwn(value, required)) reject("YOUTUBE_PRIVATE_ONLY");
  }
  const requiredSourceKeys = ["objectKey", "expectedSize", "expectedSha256"];
  for (let index = 0; index < requiredSourceKeys.length; index += 1) {
    const required = requiredSourceKeys[index]!;
    if (!hasOwn(value.source, required)) reject("YOUTUBE_PRIVATE_ONLY");
  }
  if (
    typeof value.videoJobId !== "string" ||
    typeof value.targetAccountId !== "string" ||
    typeof value.approvedContentVersion !== "string" ||
    typeof value.source.objectKey !== "string" ||
    typeof value.source.expectedSize !== "number" ||
    typeof value.source.expectedSha256 !== "string"
  ) reject("YOUTUBE_PRIVATE_ONLY");

  const source = frozenNullRecord<Readonly<R2ObjectDescriptor>>({
    objectKey: value.source.objectKey,
    expectedSize: value.source.expectedSize,
    expectedSha256: value.source.expectedSha256,
  });
  const snapshot = frozenNullRecord<UploadIdentityAndSource>({
    videoJobId: value.videoJobId,
    targetAccountId: value.targetAccountId,
    approvedContentVersion: value.approvedContentVersion,
    source,
  });
  assertYouTubeUploadIdentityAndSource(snapshot);
  return snapshot;
}

function snapshotPublishContext(value: unknown): ImmutablePublishContractInput {
  const identity = snapshotUploadIdentityAndSource(value);
  // The shared extractor has already checked the record without invoking accessors.
  const record = value as Record<string, unknown>;
  if (!hasOwn(record, "actorId") || typeof record.actorId !== "string") {
    reject("YOUTUBE_PRIVATE_ONLY");
  }
  const context = frozenNullRecord<ImmutablePublishContractInput>({
    ...identity,
    actorId: record.actorId,
  });
  assertInternalId(context.actorId, "actorId");
  return context;
}

function assertSourcePolicyShape(value: unknown): void {
  assertPlainDataRecord(value);
  assertNoInheritedPolicyProperties(value);
  assertOnlyKeys(value, SOURCE_KEYS);
}

/** Validate untrusted service input once and detach it from caller-owned mutable objects. */
export function snapshotPublishContractInput(value: unknown): ImmutablePublishContractInput {
  assertPlainDataRecord(value);
  assertNoInheritedPolicyProperties(value);
  assertOnlyKeys(value, PUBLISH_INPUT_KEYS);
  assertSourcePolicyShape(value.source);
  const context = snapshotPublishContext(value);
  return frozenNullRecord<ImmutablePublishContractInput>({
    ...context,
    ...(hasOwn(value, "requestedPrivacyStatus")
      ? { requestedPrivacyStatus: value.requestedPrivacyStatus }
      : {}),
    ...(hasOwn(value, "publishAt")
      ? { publishAt: value.publishAt }
      : {}),
  });
}

/** Best-effort extraction used only to audit a rejected outer shape without copying that shape. */
export function trySnapshotPublishContractAuditContext(
  value: unknown,
): ImmutablePublishContractInput | null {
  try {
    return snapshotPublishContext(value);
  } catch {
    return null;
  }
}

/**
 * Final request-construction boundary before a YouTube adapter is invoked.
 *
 * The returned provider request is rebuilt from constants rather than spread from caller data.
 * This prevents configuration, type casts, extra properties, or later mutation from changing
 * visibility. A future real adapter must consume `providerRequest` unchanged.
 */
export function buildPrivateYouTubeUploadRequest(
  value: unknown,
): YouTubePrivateUploadRequest {
  assertPlainDataRecord(value);
  assertNoInheritedPolicyProperties(value);
  assertOnlyKeys(value, CANDIDATE_KEYS);
  if (hasOwn(value, "publishAt")) {
    reject("YOUTUBE_SCHEDULE_NOT_ALLOWED");
  }
  if (
    hasOwn(value, "privacyStatus") &&
    value.privacyStatus !== undefined &&
    value.privacyStatus !== "private"
  ) {
    reject("YOUTUBE_PRIVATE_ONLY");
  }
  if (
    hasOwn(value, "requestedPrivacyStatus") &&
    value.requestedPrivacyStatus !== undefined &&
    value.requestedPrivacyStatus !== "private"
  ) {
    reject("YOUTUBE_PRIVATE_ONLY");
  }
  assertSourcePolicyShape(value.source);
  const identity = snapshotUploadIdentityAndSource(value);
  if (hasOwn(value, "actorId")) {
    if (typeof value.actorId !== "string") reject("YOUTUBE_PRIVATE_ONLY");
    assertInternalId(value.actorId, "actorId");
  }

  // Same JSON tuple as buildIdempotencyKey. Serialize primitive strings individually so an
  // inherited toJSON hook cannot substitute the tuple while validating the dispatch boundary.
  const expectedKey = `[${JSON_STRINGIFY(identity.videoJobId)},"youtube",${
    JSON_STRINGIFY(identity.targetAccountId)
  },${JSON_STRINGIFY(identity.approvedContentVersion)}]`;
  if (!hasOwn(value, "idempotencyKey") || value.idempotencyKey !== expectedKey) {
    throw new TypeError("idempotencyKey must match the YouTube upload identity");
  }

  const request = frozenNullRecord<YouTubePrivateUploadRequest>({
    idempotencyKey: expectedKey,
    ...identity,
    providerRequest: privateProviderRequest(),
  });
  REFLECT_APPLY(WEAK_SET_ADD, guardedRequests, [request]);
  return request;
}

function assertGuardedRequestForDispatch(request: YouTubePrivateUploadRequest): void {
  if (!REFLECT_APPLY(WEAK_SET_HAS, guardedRequests, [request])) reject("YOUTUBE_PRIVATE_ONLY");
  const provider = request.providerRequest;
  if (
    GET_PROTOTYPE_OF(provider) !== null ||
    GET_PROTOTYPE_OF(provider.requestBody) !== null ||
    GET_PROTOTYPE_OF(provider.requestBody.status) !== null ||
    provider.part !== "status" ||
    provider.requestBody.status.privacyStatus !== "private" ||
    hasOwn(provider.requestBody.status, "publishAt")
  ) reject("YOUTUBE_PRIVATE_ONLY");
}

function registerPrivateYouTubeAdapter(adapter: PrivateYouTubeAdapter): GuardedYouTubePublishClient {
  const client = frozenNullRecord<GuardedYouTubePublishClient>({});
  REFLECT_APPLY(WEAK_MAP_SET, guardedClientAdapters, [client, adapter]);
  return client;
}

/** The only production-source dispatch site for a YouTube upload client. */
export function dispatchGuardedPrivateYouTubeUpload(
  client: GuardedYouTubePublishClient,
  request: YouTubePrivateUploadRequest,
  verifiedSource?: VerifiedR2Source,
): Promise<YouTubePublishObservation> {
  assertGuardedRequestForDispatch(request);
  const adapter = REFLECT_APPLY(WEAK_MAP_GET, guardedClientAdapters, [client]);
  if (!adapter) reject("YOUTUBE_PRIVATE_ONLY");
  if (
    !verifiedSource ||
    verifiedSource.size !== request.source.expectedSize ||
    verifiedSource.checksumSha256.toLowerCase() !== request.source.expectedSha256.toLowerCase() ||
    typeof verifiedSource.open !== "function"
  ) {
    reject("YOUTUBE_PRIVATE_ONLY");
  }
  const providerRequest = frozenNullRecord<ProviderPrivateUploadRequest>({
    idempotencyKey: request.idempotencyKey,
    videoJobId: request.videoJobId,
    targetAccountId: request.targetAccountId,
    approvedContentVersion: request.approvedContentVersion,
    providerRequest: request.providerRequest,
  });
  const source = frozenNullRecord<VerifiedUploadBody>({
    size: verifiedSource.size,
    checksumSha256: verifiedSource.checksumSha256,
    open: (offset = 0) => verifiedSource.open(offset),
  });
  return adapter(providerRequest, source);
}

/** Keeps validation and the client call adjacent so no unguarded request can be dispatched. */
export function startGuardedPrivateYouTubeUpload(
  client: GuardedYouTubePublishClient,
  candidate: YouTubePrivateRequestCandidate,
  verifiedSource?: VerifiedR2Source,
): Promise<YouTubePublishObservation> {
  return dispatchGuardedPrivateYouTubeUpload(
    client,
    buildPrivateYouTubeUploadRequest(candidate),
    verifiedSource,
  );
}

// Local-only scripted fake. Kept in this module so raw adapter registration stays private.
const FAKE_STATUS_KEYS = new Set([
  "kind",
  "uploadStatus",
  "processingStatus",
  "privacyStatus",
  "videoId",
  "failureReason",
  "rejectionReason",
]);
const FAKE_UNKNOWN_KEYS = new Set(["kind", "reason"]);
const FAKE_THROW_KEYS = new Set(["kind"]);
const FAKE_CONTROLLER_OPTION_KEYS = new Set(["pauseBeforeResult"]);
const OBJECT_PROTOTYPE_KEYS_AT_LOAD = REFLECT_OWN_KEYS(OBJECT_PROTOTYPE);
const OBJECT_PROTOTYPE_KEY_SET_AT_LOAD = new Set(OBJECT_PROTOTYPE_KEYS_AT_LOAD);

export type ScriptedYouTubePublishResult =
  | YouTubePublishObservation
  | { readonly kind: "fake_throw" };

export interface FakeYouTubeUploadSnapshot {
  readonly idempotencyKey: string;
  readonly videoJobId: string;
  readonly targetAccountId: string;
  readonly approvedContentVersion: string;
  readonly source: Readonly<Pick<R2ObjectDescriptor, "expectedSize" | "expectedSha256">>;
  readonly uploadedBytes: number;
  readonly providerBodyJson: string;
}

export interface ScriptedYouTubePublishController {
  readonly client: GuardedYouTubePublishClient;
  sideEffectCount(idempotencyKey?: string): number;
  lastUpload(): FakeYouTubeUploadSnapshot | null;
  waitUntilUploadStarted(): Promise<void>;
  resumeUpload(): void;
}

function snapshotScriptedResult(value: unknown): ScriptedYouTubePublishResult {
  assertPlainDataRecord(value);
  if (value.kind === "fake_throw") {
    assertOnlyKeys(value, FAKE_THROW_KEYS);
    return frozenNullRecord({ kind: "fake_throw" });
  }
  if (value.kind === "outcome_unknown") {
    assertOnlyKeys(value, FAKE_UNKNOWN_KEYS);
    if (![
      "response_lost",
      "timeout",
      "confirmation_unavailable",
    ].includes(value.reason as string)) reject("YOUTUBE_PRIVATE_ONLY");
    return frozenNullRecord({
      kind: "outcome_unknown",
      reason: value.reason,
    }) as YouTubePublishObservation;
  }
  if (value.kind !== "status") reject("YOUTUBE_PRIVATE_ONLY");
  assertOnlyKeys(value, FAKE_STATUS_KEYS);
  if (
    !["uploaded", "processed", "failed", "rejected"].includes(value.uploadStatus as string) ||
    !["processing", "succeeded", "failed", "terminated"].includes(
      value.processingStatus as string,
    ) ||
    !["private", "public", "unlisted"].includes(value.privacyStatus as string)
  ) reject("YOUTUBE_PRIVATE_ONLY");
  const optionalKeys = ["videoId", "failureReason", "rejectionReason"] as const;
  for (let index = 0; index < optionalKeys.length; index += 1) {
    const optional = optionalKeys[index]!;
    if (hasOwn(value, optional) && typeof value[optional] !== "string") {
      reject("YOUTUBE_PRIVATE_ONLY");
    }
  }
  return frozenNullRecord({
    kind: "status",
    uploadStatus: value.uploadStatus,
    processingStatus: value.processingStatus,
    privacyStatus: value.privacyStatus,
    ...(hasOwn(value, "videoId") ? { videoId: value.videoId } : {}),
    ...(hasOwn(value, "failureReason") ? { failureReason: value.failureReason } : {}),
    ...(hasOwn(value, "rejectionReason") ? { rejectionReason: value.rejectionReason } : {}),
  }) as YouTubePublishObservation;
}

function snapshotScriptedControllerOptions(value: unknown): boolean {
  assertPlainDataRecord(value);
  assertOnlyKeys(value, FAKE_CONTROLLER_OPTION_KEYS);

  // A normal options object inherits Object.prototype. Reject properties added after module load
  // so policy/wire/callback values cannot arrive through that otherwise-valid prototype.
  if (GET_PROTOTYPE_OF(value) === OBJECT_PROTOTYPE) {
    const currentPrototypeKeys = REFLECT_OWN_KEYS(OBJECT_PROTOTYPE);
    if (currentPrototypeKeys.length !== OBJECT_PROTOTYPE_KEYS_AT_LOAD.length) {
      reject("YOUTUBE_PRIVATE_ONLY");
    }
    for (let index = 0; index < currentPrototypeKeys.length; index += 1) {
      if (!REFLECT_APPLY(SET_HAS, OBJECT_PROTOTYPE_KEY_SET_AT_LOAD, [currentPrototypeKeys[index]!])) {
        reject("YOUTUBE_PRIVATE_ONLY");
      }
    }
  }

  const descriptors = GET_OWN_PROPERTY_DESCRIPTORS(value);
  const keys = REFLECT_OWN_KEYS(value);
  for (let index = 0; index < keys.length; index += 1) {
    const descriptor = descriptors[keys[index] as keyof typeof descriptors]!;
    if (!descriptor.enumerable) reject("YOUTUBE_PRIVATE_ONLY");
  }
  if (!hasOwn(value, "pauseBeforeResult")) return false;
  if (typeof value.pauseBeforeResult !== "boolean") reject("YOUTUBE_PRIVATE_ONLY");
  return value.pauseBeforeResult;
}

/**
 * Local-test-only client. Callers provide result data, never an executable adapter or wire body.
 * A real E-5.6 adapter must be registered by code added inside this module instead.
 */
export function createScriptedYouTubePublishController(
  scriptedResult: ScriptedYouTubePublishResult,
  options: Readonly<{ pauseBeforeResult?: boolean }> = {},
): ScriptedYouTubePublishController {
  const pauseBeforeResult = snapshotScriptedControllerOptions(options);
  const resultSnapshot = snapshotScriptedResult(scriptedResult);
  const observations = new Map<string, YouTubePublishObservation>();
  const starts = new Map<string, number>();
  let lastUpload: FakeYouTubeUploadSnapshot | null = null;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  let releaseUpload!: () => void;
  const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve; });

  const adapter: PrivateYouTubeAdapter = async (request, source) => {
    const existing = observations.get(request.idempotencyKey);
    if (existing) return SAFE_STRUCTURED_CLONE(existing);
    starts.set(request.idempotencyKey, (starts.get(request.idempotencyKey) ?? 0) + 1);
    lastUpload = frozenNullRecord<FakeYouTubeUploadSnapshot>({
      idempotencyKey: request.idempotencyKey,
      videoJobId: request.videoJobId,
      targetAccountId: request.targetAccountId,
      approvedContentVersion: request.approvedContentVersion,
      source: frozenNullRecord({
        expectedSize: source.size,
        expectedSha256: source.checksumSha256,
      }),
      uploadedBytes: 0,
      providerBodyJson: JSON_STRINGIFY(request.providerRequest.requestBody),
    });
    signalStarted();
    const reader = source.open(0).getReader();
    const digestStream = new CLOUDFLARE_CRYPTO.DigestStream("SHA-256");
    const digestWriter = digestStream.getWriter();
    let uploadedBytes = 0;
    try {
      while (true) {
        const read = await reader.read();
        if (read.done) break;
        if (!(read.value instanceof Uint8Array) || read.value.byteLength === 0) {
          throw new Error("fake verified source returned an invalid chunk");
        }
        uploadedBytes += read.value.byteLength;
        if (uploadedBytes > source.size) {
          throw new Error("fake verified source exceeded its verified size");
        }
        await digestWriter.write(read.value);
      }
      if (uploadedBytes !== source.size) {
        throw new Error("fake verified source ended before its verified size");
      }
      await digestWriter.close();
      const digest = [...new Uint8Array(await digestStream.digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      if (digest !== source.checksumSha256.toLowerCase()) {
        throw new Error("fake verified source checksum did not match");
      }
    } catch (error) {
      try { await digestWriter.abort(); } catch { /* Preserve the fixed fake failure. */ }
      void digestStream.digest.catch(() => undefined);
      throw error;
    }
    lastUpload = frozenNullRecord<FakeYouTubeUploadSnapshot>({
      ...lastUpload,
      uploadedBytes,
    });
    if (pauseBeforeResult) await uploadGate;
    if (resultSnapshot.kind === "fake_throw") throw new Error("fake interrupted call");
    const observation = SAFE_STRUCTURED_CLONE(resultSnapshot);
    observations.set(request.idempotencyKey, observation);
    return SAFE_STRUCTURED_CLONE(observation);
  };
  const client = registerPrivateYouTubeAdapter(adapter);
  return frozenNullRecord<ScriptedYouTubePublishController>({
    client,
    sideEffectCount: (idempotencyKey?: string) => {
      if (idempotencyKey) return starts.get(idempotencyKey) ?? 0;
      let total = 0;
      for (const count of starts.values()) total += count;
      return total;
    },
    lastUpload: () => lastUpload,
    waitUntilUploadStarted: () => started,
    resumeUpload: () => releaseUpload(),
  });
}
