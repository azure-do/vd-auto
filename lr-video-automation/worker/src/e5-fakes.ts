import type {
  R2ObjectMetadata,
  R2RangeRequest,
  R2RangeResponse,
  R2ReadClient,
  YouTubePublishObservation,
} from "./e5-contracts";
import {
  createScriptedYouTubePublishController,
  type GuardedYouTubePublishClient,
  type ScriptedYouTubePublishController,
} from "./e5-youtube-private-request";
import {
  YOUTUBE_READONLY_SCOPE,
  type YoutubeOAuthProvider,
  type YoutubeOAuthTokenSet,
} from "./e5-youtube-oauth";
import type {
  YouTubeReconciliationClient,
  YouTubeReconciliationObservation,
} from "./e5-youtube-reconciliation";

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function fakeObjectFixture(
  objectKey: string,
  bytes: Uint8Array,
  overrides: {
    reportedSize?: number;
    reportedChecksumSha256?: string;
    corruptRanges?: boolean;
  } = {},
): Promise<FakeR2Object> {
  return {
    objectKey,
    bytes: new Uint8Array(bytes),
    reportedSize: overrides.reportedSize ?? bytes.byteLength,
    reportedChecksumSha256: overrides.reportedChecksumSha256 ?? await sha256Bytes(bytes),
    corruptRanges: overrides.corruptRanges ?? false,
  };
}

export interface FakeR2Object {
  objectKey: string;
  bytes: Uint8Array;
  reportedSize: number;
  reportedChecksumSha256: string;
  corruptRanges: boolean;
}

export class FakeR2ReadClient implements R2ReadClient {
  private readonly objects: Map<string, FakeR2Object>;
  private readonly rangeRequests: R2RangeRequest[] = [];

  constructor(objects: readonly FakeR2Object[]) {
    this.objects = new Map(objects.map((object) => [object.objectKey, object]));
  }

  async headObject(objectKey: string): Promise<R2ObjectMetadata> {
    const object = this.objects.get(objectKey);
    if (!object) throw new Error("FAKE_R2_OBJECT_NOT_FOUND");
    return {
      size: object.reportedSize,
      checksumSha256: object.reportedChecksumSha256,
    };
  }

  async readRange(request: R2RangeRequest): Promise<R2RangeResponse> {
    if (!Number.isSafeInteger(request.offset) || request.offset < 0) {
      throw new TypeError("Range offset must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(request.length) || request.length <= 0) {
      throw new TypeError("Range length must be a positive safe integer");
    }
    const object = this.objects.get(request.objectKey);
    if (!object) throw new Error("FAKE_R2_OBJECT_NOT_FOUND");
    const end = request.offset + request.length;
    if (
      !Number.isSafeInteger(end) ||
      request.offset >= object.bytes.byteLength ||
      end > object.bytes.byteLength
    ) {
      throw new RangeError("Fake R2 range is not satisfiable");
    }
    this.rangeRequests.push({ ...request });
    const bytes = new Uint8Array(object.bytes.slice(request.offset, end));
    if (object.corruptRanges && bytes.byteLength > 0) bytes[0] = bytes[0]! ^ 0xff;
    return { offset: request.offset, totalSize: object.reportedSize, bytes };
  }

  requests(): readonly R2RangeRequest[] {
    return this.rangeRequests.map((request) => ({ ...request }));
  }
}

export class FakeYouTubePublishClient {
  private readonly controller: ScriptedYouTubePublishController;
  readonly client: GuardedYouTubePublishClient;

  constructor(scriptedObservation: YouTubePublishObservation) {
    this.controller = createScriptedYouTubePublishController(scriptedObservation);
    this.client = this.controller.client;
  }

  sideEffectCount(idempotencyKey?: string): number {
    return this.controller.sideEffectCount(idempotencyKey);
  }
}

export class FakeYouTubeReconciliationClient implements YouTubeReconciliationClient {
  private readonly observations: Map<string, YouTubeReconciliationObservation>;
  private readonly requestedVideoIds: string[] = [];

  constructor(entries: Readonly<Record<string, YouTubeReconciliationObservation>>) {
    this.observations = new Map(Object.entries(entries));
  }

  async listVideo(videoId: string): Promise<YouTubeReconciliationObservation> {
    this.requestedVideoIds.push(videoId);
    return this.observations.get(videoId) ?? { kind: "unknown" };
  }

  requests(): readonly string[] {
    return [...this.requestedVideoIds];
  }
}

export type FakeYoutubeOAuthOperation =
  | "authorization"
  | "exchange"
  | "channels.list.mine"
  | "refresh"
  | "revoke";

/** Local-only E-5.2 fake. It has no upload, videos.insert, or resumable operation. */
export class FakeYoutubeOAuthProvider implements YoutubeOAuthProvider {
  private readonly operationLog: FakeYoutubeOAuthOperation[] = [];
  private readonly secrets: string[] = [];
  private readonly secretGrants = new Map<string, string>();
  private readonly activeGrants = new Set<string>();
  private channelIds: string[];
  private scopes: string[] = [YOUTUBE_READONLY_SCOPE];
  private failure: FakeYoutubeOAuthOperation | null = null;
  private codedFailure: { operation: FakeYoutubeOAuthOperation; error: Error } | null = null;
  private exchangeDelay: Promise<void> | null = null;
  private refreshDelay: Promise<void> | null = null;
  private revokeDelay: Promise<void> | null = null;
  private channelLookupDelay: Promise<void> | null = null;

  constructor(channelIds: readonly string[]) {
    this.channelIds = [...channelIds];
  }

  authorizationUrl(input: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    scope: typeof YOUTUBE_READONLY_SCOPE;
    accessType: "offline";
  }): string {
    this.record("authorization");
    const url = new URL("https://oauth.invalid/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", input.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("scope", input.scope);
    url.searchParams.set("access_type", input.accessType);
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async exchangeCode(input: {
    authorizationCode: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<YoutubeOAuthTokenSet> {
    this.record("exchange");
    if (this.exchangeDelay) await this.exchangeDelay;
    if (!input.authorizationCode || !input.codeVerifier || !input.redirectUri) {
      throw new Error("FAKE_OAUTH_INPUT_MISSING");
    }
    return this.issue(true, `fake_grant_${crypto.randomUUID()}`);
  }

  async refresh(refreshToken: string): Promise<YoutubeOAuthTokenSet> {
    this.record("refresh");
    if (this.refreshDelay) await this.refreshDelay;
    const grantId = this.activeGrantFor(refreshToken, "FAKE_REFRESH_TOKEN_UNKNOWN");
    return this.issue(false, grantId);
  }

  async revoke(token: string): Promise<void> {
    this.record("revoke");
    if (this.revokeDelay) await this.revokeDelay;
    const grantId = this.secretGrants.get(token);
    if (!grantId) throw new Error("FAKE_REVOKE_TOKEN_UNKNOWN");
    this.activeGrants.delete(grantId);
  }

  async listMineChannels(accessToken: string): Promise<readonly string[]> {
    this.record("channels.list.mine");
    if (this.channelLookupDelay) await this.channelLookupDelay;
    this.activeGrantFor(accessToken, "FAKE_ACCESS_TOKEN_UNKNOWN");
    return [...this.channelIds];
  }

  setChannels(channelIds: readonly string[]): void {
    this.channelIds = [...channelIds];
  }

  setScopes(scopes: readonly string[]): void {
    this.scopes = [...scopes];
  }

  failNext(operation: FakeYoutubeOAuthOperation): void {
    this.failure = operation;
  }

  failNextWith(operation: FakeYoutubeOAuthOperation, error: Error): void {
    this.codedFailure = { operation, error };
  }

  delayExchangeUntil(promise: Promise<void>): void {
    this.exchangeDelay = promise;
  }

  delayRefreshUntil(promise: Promise<void>): void {
    this.refreshDelay = promise;
  }

  delayRevokeUntil(promise: Promise<void>): void {
    this.revokeDelay = promise;
  }

  delayChannelLookupUntil(promise: Promise<void>): void {
    this.channelLookupDelay = promise;
  }

  operations(): readonly FakeYoutubeOAuthOperation[] {
    return [...this.operationLog];
  }

  issuedSecretValues(): readonly string[] {
    return [...this.secrets];
  }

  activeGrantCount(): number {
    return this.activeGrants.size;
  }

  private activeGrantFor(token: string, errorCode: string): string {
    const grantId = this.secretGrants.get(token);
    if (!grantId || !this.activeGrants.has(grantId)) throw new Error(errorCode);
    return grantId;
  }

  private issue(includeRefresh: boolean, grantId: string): YoutubeOAuthTokenSet {
    const accessToken = `fake_access_${crypto.randomUUID()}`;
    const refreshToken = includeRefresh ? `fake_refresh_${crypto.randomUUID()}` : undefined;
    this.activeGrants.add(grantId);
    this.secrets.push(accessToken);
    this.secretGrants.set(accessToken, grantId);
    if (refreshToken) this.secrets.push(refreshToken);
    if (refreshToken) this.secretGrants.set(refreshToken, grantId);
    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      expiresInSeconds: 3_600,
      scopes: [...this.scopes],
    };
  }

  private record(operation: FakeYoutubeOAuthOperation): void {
    this.operationLog.push(operation);
    if (this.codedFailure?.operation === operation) {
      const failure = this.codedFailure.error;
      this.codedFailure = null;
      throw failure;
    }
    if (this.failure === operation) {
      this.failure = null;
      throw new Error(`FAKE_${operation.replaceAll(".", "_").toUpperCase()}_FAILED`);
    }
  }
}
