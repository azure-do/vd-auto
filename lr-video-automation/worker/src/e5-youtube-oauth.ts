import { canonicalJson, sha256Hex } from "./fingerprint";
import { VerifiedAccessSession } from "./cloudflare-access";

export const YOUTUBE_READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1_000;
const OAUTH_OPERATION_LEASE_MS = 60 * 1_000;
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

export interface YoutubeOAuthConfig {
  clientId: string;
  redirectUri: string;
  expectedChannelId: string;
  encryptionKey: string;
}

export interface YoutubeOAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds: number;
  scopes: readonly string[];
}

/**
 * E-5.2 intentionally exposes no upload or resumable-session method. The only
 * YouTube API read is the adapter operation corresponding to channels.list with mine=true.
 */
export interface YoutubeOAuthProvider {
  authorizationUrl(input: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    scope: typeof YOUTUBE_READONLY_SCOPE;
    accessType: "offline";
  }): string;
  exchangeCode(input: {
    authorizationCode: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<YoutubeOAuthTokenSet>;
  refresh(refreshToken: string): Promise<YoutubeOAuthTokenSet>;
  revoke(token: string): Promise<void>;
  listMineChannels(accessToken: string): Promise<readonly string[]>;
}

export type YoutubeOAuthStatusName =
  | "NOT_CONNECTED"
  | "PENDING"
  | "CONNECTED"
  | "REFRESH_REQUIRED"
  | "REVOKED"
  | "ERROR";

export interface YoutubeOAuthStatus {
  status: YoutubeOAuthStatusName;
}

export type YoutubeOAuthCallbackResult = YoutubeOAuthStatus & { replayed?: true };

export interface YoutubeOAuthStartResult {
  status: "PENDING";
  authorizationUrl: string;
  expiresAt: string;
}

export class YoutubeOAuthError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
  }
}

interface OAuthAttemptRow {
  oauth_attempt_id: string;
  generation: number;
  state_hash: string;
  pkce_verifier_ciphertext: string;
  status: "PENDING" | "CONSUMING" | "COMPLETED" | "FAILED" | "EXPIRED";
  expires_at: string;
}

interface CredentialRow {
  generation: number;
  status: "CONNECTED" | "REFRESHING" | "REVOKING" | "REVOKED" | "ERROR";
  access_token_ciphertext: string | null;
  refresh_token_ciphertext: string | null;
  token_expires_at: string | null;
  expected_channel_fingerprint: string;
  verified_channel_fingerprint: string | null;
  verified_at: string | null;
  row_version: number;
  operation_expires_at: string | null;
}

type ActiveOAuthOperation = "STARTING" | "CALLBACK" | "VERIFYING" | "REFRESHING" | "REVOKING";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomOpaque(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function assertOpaque(value: unknown, name: string, maximumLength = 4_096): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new YoutubeOAuthError(`${name.toUpperCase()}_INVALID`);
  }
}

function assertConfig(config: YoutubeOAuthConfig): void {
  assertOpaque(config.clientId, "oauth_client_id", 512);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(config.encryptionKey)
    || fromBase64Url(config.encryptionKey).byteLength !== 32) {
    throw new YoutubeOAuthError("OAUTH_ENCRYPTION_KEY_INVALID");
  }
  if (!CHANNEL_ID_PATTERN.test(config.expectedChannelId)) {
    throw new YoutubeOAuthError("EXPECTED_CHANNEL_INVALID");
  }
  let redirect: URL;
  try { redirect = new URL(config.redirectUri); } catch { throw new YoutubeOAuthError("REDIRECT_URI_INVALID"); }
  if (redirect.protocol !== "https:" || redirect.username || redirect.password || redirect.hash) {
    throw new YoutubeOAuthError("REDIRECT_URI_INVALID");
  }
}

function assertTokenSet(tokens: YoutubeOAuthTokenSet, requireRefreshToken: boolean): void {
  assertOpaque(tokens.accessToken, "access_token");
  if (requireRefreshToken || tokens.refreshToken !== undefined) {
    assertOpaque(tokens.refreshToken, "refresh_token");
  }
  if (!Number.isSafeInteger(tokens.expiresInSeconds)
    || tokens.expiresInSeconds < 1 || tokens.expiresInSeconds > 86_400) {
    throw new YoutubeOAuthError("TOKEN_EXPIRY_INVALID");
  }
  const scopes = [...new Set(tokens.scopes)].sort();
  if (scopes.length !== 1 || scopes[0] !== YOUTUBE_READONLY_SCOPE) {
    throw new YoutubeOAuthError("OAUTH_SCOPE_MISMATCH");
  }
}

class OAuthSecretBox {
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(private readonly secret: string) {}

  private key(): Promise<CryptoKey> {
    this.keyPromise ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.secret))
      .then((digest) => crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]));
    return this.keyPromise;
  }

  async encrypt(value: string, purpose: string): Promise<string> {
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(purpose) },
      await this.key(),
      new TextEncoder().encode(value),
    );
    return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
  }

  async decrypt(value: string, purpose: string): Promise<string> {
    const parts = value.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") throw new YoutubeOAuthError("CIPHERTEXT_INVALID");
    try {
      const iv = Uint8Array.from(fromBase64Url(parts[1]!));
      const ciphertext = Uint8Array.from(fromBase64Url(parts[2]!));
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: new TextEncoder().encode(purpose),
        },
        await this.key(),
        ciphertext,
      );
      return new TextDecoder().decode(plaintext);
    } catch {
      throw new YoutubeOAuthError("CIPHERTEXT_INVALID");
    }
  }
}

function nowValue(clock: () => Date): { iso: string; milliseconds: number } {
  const value = clock();
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) throw new YoutubeOAuthError("CLOCK_INVALID");
  return { iso: value.toISOString(), milliseconds };
}

export class E5YoutubeOAuthService {
  private readonly box: OAuthSecretBox;
  private readonly actorSubjectFingerprint: string;

  constructor(
    private readonly db: D1Database,
    private readonly provider: YoutubeOAuthProvider,
    private readonly config: YoutubeOAuthConfig,
    private readonly access: VerifiedAccessSession,
    private readonly clock: () => Date = () => new Date(),
  ) {
    assertConfig(config);
    if (!(access instanceof VerifiedAccessSession) || !access.isVerified()) {
      throw new YoutubeOAuthError("OAUTH_ACCESS_REQUIRED");
    }
    if (!/^[0-9a-f]{64}$/u.test(access.subjectFingerprint)) {
      throw new YoutubeOAuthError("OAUTH_ACCESS_REQUIRED");
    }
    this.actorSubjectFingerprint = access.subjectFingerprint;
    this.box = new OAuthSecretBox(config.encryptionKey);
  }

  async start(): Promise<YoutubeOAuthStartResult> {
    this.assertAccessBoundary();
    const timestamp = nowValue(this.clock);
    await this.recoverExpiredOperation(timestamp.iso);
    const control = await this.db.prepare(
      `SELECT generation, operation, operation_owner FROM youtube_oauth_control WHERE control_id = 1`,
    ).first<{ generation: number; operation: string; operation_owner: string | null }>();
    if (!control || control.operation === "ERROR") {
      throw new YoutubeOAuthError("OAUTH_MANUAL_RECOVERY_REQUIRED");
    }
    if (control.operation !== "READY") throw new YoutubeOAuthError("OAUTH_OPERATION_IN_PROGRESS", true);
    const existing = await this.credential();
    if (existing?.status === "ERROR") {
      throw new YoutubeOAuthError("OAUTH_MANUAL_RECOVERY_REQUIRED");
    }
    if (existing && ["CONNECTED", "REFRESHING", "REVOKING"].includes(existing.status)) {
      throw new YoutubeOAuthError("OAUTH_ALREADY_CONNECTED");
    }
    const state = randomOpaque(32);
    const verifier = randomOpaque(64);
    const stateHash = await sha256Hex(state);
    const attemptId = `yt_oauth_${crypto.randomUUID()}`;
    const expiresAt = new Date(timestamp.milliseconds + OAUTH_ATTEMPT_TTL_MS).toISOString();
    const verifierCiphertext = await this.box.encrypt(verifier, `pkce:${attemptId}`);
    const authorizationUrl = this.provider.authorizationUrl({
      clientId: this.config.clientId,
      redirectUri: this.config.redirectUri,
      state,
      codeChallenge: await pkceChallenge(verifier),
      scope: YOUTUBE_READONLY_SCOPE,
      accessType: "offline",
    });
    const parsedUrl = new URL(authorizationUrl);
    if (parsedUrl.protocol !== "https:" || authorizationUrl.includes(verifier)) {
      throw new YoutubeOAuthError("AUTHORIZATION_URL_INVALID");
    }
    const operationOwner = `start_${crypto.randomUUID()}`;
    const operationExpiresAt = new Date(timestamp.milliseconds + OAUTH_OPERATION_LEASE_MS).toISOString();
    const claim = await this.db.prepare(
      `UPDATE youtube_oauth_control SET generation = generation + 1, operation = 'STARTING',
         operation_owner = ?, operation_expires_at = ?, updated_at = ?
       WHERE control_id = 1 AND generation = ? AND operation = 'READY'
         AND NOT EXISTS (SELECT 1 FROM youtube_oauth_credentials WHERE credential_id = 1
           AND status IN ('CONNECTED', 'REFRESHING', 'REVOKING', 'ERROR'))`,
    ).bind(operationOwner, operationExpiresAt, timestamp.iso, control.generation).run();
    if ((claim.meta.changes ?? 0) !== 1) {
      throw new YoutubeOAuthError("OAUTH_OPERATION_IN_PROGRESS", true);
    }
    const generation = control.generation + 1;
    try {
      const results = await this.db.batch([
        this.db.prepare(
          `UPDATE youtube_oauth_attempts SET status = 'EXPIRED', failure_code = 'OAUTH_ATTEMPT_SUPERSEDED',
             pkce_verifier_ciphertext = '', updated_at = ?
           WHERE status IN ('PENDING', 'CONSUMING') AND generation < ?
             AND EXISTS (SELECT 1 FROM youtube_oauth_control WHERE control_id = 1
               AND generation = ? AND operation = 'STARTING' AND operation_owner = ?)`,
        ).bind(timestamp.iso, generation, generation, operationOwner),
        this.db.prepare(
          `INSERT INTO youtube_oauth_attempts (
             oauth_attempt_id, generation, state_hash, pkce_verifier_ciphertext, requested_scope,
             status, expires_at, created_at, updated_at
           ) SELECT ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM youtube_oauth_control WHERE control_id = 1
               AND generation = ? AND operation = 'STARTING' AND operation_owner = ?
               AND operation_expires_at > ?)`,
        ).bind(
          attemptId, generation, stateHash, verifierCiphertext, YOUTUBE_READONLY_SCOPE,
          expiresAt, timestamp.iso, timestamp.iso,
          generation, operationOwner, timestamp.iso,
        ),
        this.db.prepare(
          `UPDATE youtube_oauth_control SET operation = 'READY', operation_owner = NULL,
             operation_expires_at = NULL, updated_at = ?
           WHERE control_id = 1 AND generation = ? AND operation = 'STARTING'
             AND operation_owner = ?
             AND EXISTS (SELECT 1 FROM youtube_oauth_attempts WHERE oauth_attempt_id = ?
               AND generation = ? AND status = 'PENDING')`,
        ).bind(timestamp.iso, generation, operationOwner, attemptId, generation),
        this.db.prepare(
          `INSERT INTO youtube_oauth_audits (
             oauth_audit_id, oauth_attempt_id, actor_subject_fingerprint,
             action, reason_code, occurred_at
           ) SELECT ?, ?, ?, 'oauth.started', NULL, ?
             WHERE EXISTS (SELECT 1 FROM youtube_oauth_control WHERE control_id = 1
               AND generation = ? AND operation = 'READY')
               AND EXISTS (SELECT 1 FROM youtube_oauth_attempts WHERE oauth_attempt_id = ?
                 AND generation = ? AND status = 'PENDING')`,
        ).bind(`yt_oauth_audit_${crypto.randomUUID()}`, attemptId,
          this.actorSubjectFingerprint, timestamp.iso,
          generation, attemptId, generation),
      ]);
      if ((results[1]?.meta.changes ?? 0) !== 1 || (results[2]?.meta.changes ?? 0) !== 1
        || (results[3]?.meta.changes ?? 0) !== 1) {
        throw new YoutubeOAuthError("OAUTH_START_COMMIT_AMBIGUOUS");
      }
      return { status: "PENDING", authorizationUrl, expiresAt };
    } catch (error) {
      await this.markOperationError(
        generation,
        "STARTING",
        operationOwner,
        "OAUTH_START_COMMIT_AMBIGUOUS",
        timestamp.iso,
      );
      throw error instanceof YoutubeOAuthError
        ? error
        : new YoutubeOAuthError("OAUTH_START_COMMIT_AMBIGUOUS");
    }
  }

  async callback(input: { state: string; authorizationCode: string }): Promise<YoutubeOAuthCallbackResult> {
    this.assertAccessBoundary();
    assertOpaque(input.state, "oauth_state", 256);
    assertOpaque(input.authorizationCode, "authorization_code", 2_048);
    const timestamp = nowValue(this.clock);
    const stateHash = await sha256Hex(input.state);
    const attempt = await this.db.prepare(
      `SELECT oauth_attempt_id, generation, state_hash, pkce_verifier_ciphertext, status, expires_at
       FROM youtube_oauth_attempts WHERE state_hash = ?`,
    ).bind(stateHash).first<OAuthAttemptRow>();
    if (!attempt) throw new YoutubeOAuthError("OAUTH_STATE_INVALID");
    if (attempt.status === "COMPLETED") {
      await this.audit(attempt.oauth_attempt_id, "oauth.replayed", null, timestamp.iso);
      return { ...(await this.status()), replayed: true };
    }
    if (attempt.status !== "PENDING") {
      throw new YoutubeOAuthError(
        attempt.status === "CONSUMING" ? "OAUTH_CALLBACK_IN_PROGRESS" : "OAUTH_STATE_USED",
        attempt.status === "CONSUMING",
      );
    }
    if (timestamp.milliseconds >= Date.parse(attempt.expires_at)) {
      let writes: D1Result[];
      try {
        writes = await this.db.batch([
          this.db.prepare(
            `UPDATE youtube_oauth_attempts SET status = 'EXPIRED', failure_code = 'OAUTH_STATE_EXPIRED',
               pkce_verifier_ciphertext = '', updated_at = ?
             WHERE oauth_attempt_id = ? AND generation = ? AND status = 'PENDING'
               AND EXISTS (SELECT 1 FROM youtube_oauth_control WHERE control_id = 1
                 AND generation = ? AND operation = 'READY')`,
          ).bind(timestamp.iso, attempt.oauth_attempt_id, attempt.generation, attempt.generation),
          this.db.prepare(
             `INSERT INTO youtube_oauth_audits (
               oauth_audit_id, oauth_attempt_id, actor_subject_fingerprint,
               action, reason_code, occurred_at
             ) SELECT ?, ?, ?, 'oauth.failed', 'OAUTH_STATE_EXPIRED', ?
               WHERE changes() = 1
                 AND EXISTS (SELECT 1 FROM youtube_oauth_attempts WHERE oauth_attempt_id = ?
                 AND generation = ? AND status = 'EXPIRED'
                 AND failure_code = 'OAUTH_STATE_EXPIRED')`,
          ).bind(`yt_oauth_expired_${attempt.oauth_attempt_id}`, attempt.oauth_attempt_id,
            this.actorSubjectFingerprint, timestamp.iso,
            attempt.oauth_attempt_id, attempt.generation),
        ]);
      } catch {
        throw new YoutubeOAuthError("OAUTH_STATE_PERSIST_FAILED", true);
      }
      if ((writes[0]?.meta.changes ?? 0) !== 1) {
        throw new YoutubeOAuthError("OAUTH_CALLBACK_IN_PROGRESS", true);
      }
      if ((writes[1]?.meta.changes ?? 0) !== 1) {
        throw new YoutubeOAuthError("OAUTH_STATE_PERSIST_FAILED", true);
      }
      throw new YoutubeOAuthError("OAUTH_STATE_EXPIRED");
    }
    const operationExpiresAt = new Date(timestamp.milliseconds + OAUTH_OPERATION_LEASE_MS).toISOString();
    const operationOwner = `callback_${crypto.randomUUID()}`;
    const claims = await this.db.batch([
      this.db.prepare(
        `UPDATE youtube_oauth_control SET operation = 'CALLBACK', operation_owner = ?, operation_expires_at = ?, updated_at = ?
         WHERE control_id = 1 AND operation = 'READY' AND generation = ?`,
      ).bind(operationOwner, operationExpiresAt, timestamp.iso, attempt.generation),
      this.db.prepare(
        `UPDATE youtube_oauth_attempts SET status = 'CONSUMING', consumed_at = ?, updated_at = ?
         WHERE oauth_attempt_id = ? AND status = 'PENDING' AND expires_at > ? AND generation = ?
           AND EXISTS (SELECT 1 FROM youtube_oauth_control WHERE control_id = 1
             AND operation = 'CALLBACK' AND generation = ? AND operation_owner = ?)`,
      ).bind(timestamp.iso, timestamp.iso, attempt.oauth_attempt_id, timestamp.iso,
        attempt.generation, attempt.generation, operationOwner),
    ]);
    if ((claims[0]?.meta.changes ?? 0) !== 1 || (claims[1]?.meta.changes ?? 0) !== 1) {
      await this.db.prepare(
        `UPDATE youtube_oauth_control SET operation = 'READY', operation_owner = NULL,
           operation_expires_at = NULL, updated_at = ?
         WHERE control_id = 1 AND operation = 'CALLBACK' AND generation = ? AND operation_owner = ?`,
      ).bind(timestamp.iso, attempt.generation, operationOwner).run();
      throw new YoutubeOAuthError("OAUTH_CALLBACK_IN_PROGRESS", true);
    }

    let tokens: YoutubeOAuthTokenSet | null = null;
    let releasedCallbackRowVersion: number | null = null;
    let credentialCommitOutcome: "NOT_ATTEMPTED" | "AMBIGUOUS" | "COMMITTED" | "NOT_COMMITTED"
      = "NOT_ATTEMPTED";
    try {
      const previousCredential = await this.db.prepare(
        `SELECT row_version FROM youtube_oauth_credentials WHERE credential_id = 1`,
      ).first<{ row_version: number }>();
      releasedCallbackRowVersion = (previousCredential?.row_version ?? 0) + 1;
      const verifier = await this.box.decrypt(
        attempt.pkce_verifier_ciphertext,
        `pkce:${attempt.oauth_attempt_id}`,
      );
      tokens = await this.provider.exchangeCode({
        authorizationCode: input.authorizationCode,
        codeVerifier: verifier,
        redirectUri: this.config.redirectUri,
      });
      assertTokenSet(tokens, true);
      await this.assertExpectedChannel(tokens.accessToken);
      const tokenExpiresAt = new Date(
        timestamp.milliseconds + tokens.expiresInSeconds * 1_000,
      ).toISOString();
      const commitTimestamp = nowValue(this.clock).iso;
      const [accessCiphertext, refreshCiphertext, expectedFingerprint] = await Promise.all([
        this.box.encrypt(tokens.accessToken, "youtube:access"),
        this.box.encrypt(tokens.refreshToken!, "youtube:refresh"),
        sha256Hex(this.config.expectedChannelId),
      ]);
      credentialCommitOutcome = "AMBIGUOUS";
      const commits = await this.db.batch([
        this.db.prepare(
          `INSERT INTO youtube_oauth_credentials (
             credential_id, generation, status, access_token_ciphertext, refresh_token_ciphertext,
             token_expires_at, granted_scope, expected_channel_fingerprint,
             verified_channel_fingerprint, verified_at, last_error_code,
             operation_expires_at, row_version, created_at, updated_at
           ) SELECT 1, ?, 'CONNECTED', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?
             WHERE EXISTS (SELECT 1 FROM youtube_oauth_control
               WHERE control_id = 1 AND generation = ? AND operation = 'CALLBACK'
                 AND operation_owner = ? AND operation_expires_at > ?)
               AND EXISTS (SELECT 1 FROM youtube_oauth_attempts
                 WHERE oauth_attempt_id = ? AND generation = ? AND status = 'CONSUMING')
           ON CONFLICT(credential_id) DO UPDATE SET
             generation = excluded.generation, status = 'CONNECTED', access_token_ciphertext = excluded.access_token_ciphertext,
             refresh_token_ciphertext = excluded.refresh_token_ciphertext,
             token_expires_at = excluded.token_expires_at,
             granted_scope = excluded.granted_scope,
             expected_channel_fingerprint = excluded.expected_channel_fingerprint,
             verified_channel_fingerprint = excluded.verified_channel_fingerprint,
             verified_at = excluded.verified_at, last_error_code = NULL,
             operation_expires_at = NULL,
             row_version = youtube_oauth_credentials.row_version + 1,
             updated_at = excluded.updated_at`,
        ).bind(
          attempt.generation, accessCiphertext, refreshCiphertext, tokenExpiresAt, YOUTUBE_READONLY_SCOPE,
          expectedFingerprint, expectedFingerprint, timestamp.iso, timestamp.iso, timestamp.iso,
          attempt.generation, operationOwner, commitTimestamp, attempt.oauth_attempt_id, attempt.generation,
        ),
        this.db.prepare(
          `UPDATE youtube_oauth_attempts
           SET status = 'COMPLETED', pkce_verifier_ciphertext = '', updated_at = ?
           WHERE oauth_attempt_id = ? AND generation = ? AND status = 'CONSUMING'
             AND generation = (SELECT generation FROM youtube_oauth_control
               WHERE control_id = 1 AND operation = 'CALLBACK' AND operation_owner = ?)`,
        ).bind(timestamp.iso, attempt.oauth_attempt_id, attempt.generation, operationOwner),
        this.db.prepare(
          `UPDATE youtube_oauth_control SET operation = 'READY', operation_owner = NULL,
             operation_expires_at = NULL, updated_at = ?
           WHERE control_id = 1 AND generation = ? AND operation = 'CALLBACK' AND operation_owner = ?
             AND EXISTS (SELECT 1 FROM youtube_oauth_attempts WHERE oauth_attempt_id = ?
               AND generation = ? AND status = 'COMPLETED')
             AND EXISTS (SELECT 1 FROM youtube_oauth_credentials WHERE credential_id = 1
               AND generation = ? AND status = 'CONNECTED')`,
        ).bind(timestamp.iso, attempt.generation, operationOwner,
          attempt.oauth_attempt_id, attempt.generation, attempt.generation),
        this.db.prepare(
          `INSERT INTO youtube_oauth_audits (
             oauth_audit_id, oauth_attempt_id, actor_subject_fingerprint,
             action, reason_code, occurred_at
           ) SELECT ?, ?, ?, 'oauth.connected', NULL, ?
             WHERE EXISTS (SELECT 1 FROM youtube_oauth_control WHERE control_id = 1
               AND generation = ? AND operation = 'READY')
               AND EXISTS (SELECT 1 FROM youtube_oauth_attempts WHERE oauth_attempt_id = ?
                 AND generation = ? AND status = 'COMPLETED')
               AND EXISTS (SELECT 1 FROM youtube_oauth_credentials WHERE credential_id = 1
                 AND generation = ? AND status = 'CONNECTED')`,
        ).bind(`yt_oauth_audit_${crypto.randomUUID()}`, attempt.oauth_attempt_id,
          this.actorSubjectFingerprint, timestamp.iso,
          attempt.generation, attempt.oauth_attempt_id, attempt.generation, attempt.generation),
      ]);
      credentialCommitOutcome = (commits[0]?.meta.changes ?? 0) === 1
        ? "COMMITTED"
        : "NOT_COMMITTED";
      if ((commits[0]?.meta.changes ?? 0) !== 1 || (commits[1]?.meta.changes ?? 0) !== 1
        || (commits[2]?.meta.changes ?? 0) !== 1 || (commits[3]?.meta.changes ?? 0) !== 1) {
        throw new YoutubeOAuthError("OAUTH_CALLBACK_COMMIT_AMBIGUOUS");
      }
      const credentialWrite = (await this.db.prepare(
        `SELECT status, generation FROM youtube_oauth_credentials WHERE credential_id = 1`,
      ).first<{ status: string; generation: number }>());
      if (credentialWrite?.status !== "CONNECTED" || credentialWrite.generation !== attempt.generation) {
        throw new YoutubeOAuthError("OAUTH_GENERATION_STALE");
      }
    } catch (error) {
      const code = error instanceof YoutubeOAuthError ? error.code : "OAUTH_EXCHANGE_FAILED";
      let markedError = false;
      try {
        markedError = await this.markOperationError(
          attempt.generation,
          "CALLBACK",
          operationOwner,
          code,
          timestamp.iso,
          attempt.oauth_attempt_id,
          releasedCallbackRowVersion,
        );
      } catch { /* lease recovery will mark the operation ambiguous */ }
      if (tokens && (markedError || credentialCommitOutcome === "NOT_ATTEMPTED"
        || credentialCommitOutcome === "NOT_COMMITTED")) {
        await this.bestEffortRevoke(tokens.refreshToken ?? tokens.accessToken);
      }
      throw error instanceof YoutubeOAuthError
        ? error
        : new YoutubeOAuthError("OAUTH_EXCHANGE_FAILED", true);
    }
    return { status: "CONNECTED" };
  }

  async denyCallback(input: { state: string }): Promise<YoutubeOAuthCallbackResult> {
    this.assertAccessBoundary();
    assertOpaque(input.state, "oauth_state", 256);
    const timestamp = nowValue(this.clock);
    const stateHash = await sha256Hex(input.state);
    const attempt = await this.db.prepare(
      `SELECT oauth_attempt_id, generation, status FROM youtube_oauth_attempts WHERE state_hash = ?`,
    ).bind(stateHash).first<{ oauth_attempt_id: string; generation: number; status: string }>();
    if (!attempt) throw new YoutubeOAuthError("OAUTH_STATE_INVALID");
    const replayed = attempt.status !== "PENDING";
    if (attempt.status === "PENDING") {
      let writes: D1Result[];
      try {
        writes = await this.db.batch([
          this.db.prepare(
            `UPDATE youtube_oauth_attempts SET status = 'FAILED', failure_code = 'OAUTH_CONSENT_DENIED',
               pkce_verifier_ciphertext = '', updated_at = ?
             WHERE oauth_attempt_id = ? AND generation = ? AND status = 'PENDING'
               AND EXISTS (SELECT 1 FROM youtube_oauth_control WHERE control_id = 1
                 AND generation = ? AND operation = 'READY')`,
          ).bind(timestamp.iso, attempt.oauth_attempt_id, attempt.generation, attempt.generation),
          this.db.prepare(
             `INSERT INTO youtube_oauth_audits (
               oauth_audit_id, oauth_attempt_id, actor_subject_fingerprint,
               action, reason_code, occurred_at
             ) SELECT ?, ?, ?, 'oauth.failed', 'OAUTH_CONSENT_DENIED', ?
               WHERE changes() = 1
                 AND EXISTS (SELECT 1 FROM youtube_oauth_attempts WHERE oauth_attempt_id = ?
                 AND generation = ? AND status = 'FAILED'
                 AND failure_code = 'OAUTH_CONSENT_DENIED')`,
          ).bind(`yt_oauth_denied_${attempt.oauth_attempt_id}`, attempt.oauth_attempt_id,
            this.actorSubjectFingerprint, timestamp.iso,
            attempt.oauth_attempt_id, attempt.generation),
        ]);
      } catch {
        throw new YoutubeOAuthError("OAUTH_DENIAL_PERSIST_FAILED", true);
      }
      if ((writes[0]?.meta.changes ?? 0) !== 1) {
        throw new YoutubeOAuthError("OAUTH_CALLBACK_IN_PROGRESS", true);
      }
      if ((writes[1]?.meta.changes ?? 0) !== 1) {
        throw new YoutubeOAuthError("OAUTH_DENIAL_PERSIST_FAILED", true);
      }
    } else if (attempt.status === "CONSUMING") {
      throw new YoutubeOAuthError("OAUTH_CALLBACK_IN_PROGRESS", true);
    }
    const status = await this.status();
    return replayed ? { ...status, replayed: true } : status;
  }

  async refresh(): Promise<YoutubeOAuthStatus> {
    this.assertAccessBoundary();
    const timestamp = nowValue(this.clock);
    await this.recoverExpiredOperation(timestamp.iso);
    const credential = await this.credential();
    if (credential?.status === "ERROR") {
      throw new YoutubeOAuthError("OAUTH_MANUAL_RECOVERY_REQUIRED");
    }
    if (!credential || credential.status === "REVOKED") {
      await this.audit(null, "oauth.refresh_failed", "OAUTH_NOT_CONNECTED", timestamp.iso);
      throw new YoutubeOAuthError("OAUTH_NOT_CONNECTED");
    }
    if (credential.status !== "CONNECTED") {
      throw new YoutubeOAuthError("OAUTH_OPERATION_IN_PROGRESS", true);
    }
    const operationExpiresAt = new Date(timestamp.milliseconds + OAUTH_OPERATION_LEASE_MS).toISOString();
    const operationOwner = `refresh_${crypto.randomUUID()}`;
    const claims = await this.db.batch([
      this.db.prepare(
        `UPDATE youtube_oauth_control SET operation = 'REFRESHING', operation_owner = ?, operation_expires_at = ?, updated_at = ?
         WHERE control_id = 1 AND operation = 'READY' AND generation = ?`,
      ).bind(operationOwner, operationExpiresAt, timestamp.iso, credential.generation),
      this.db.prepare(
        `UPDATE youtube_oauth_credentials
         SET status = 'REFRESHING', operation_expires_at = ?, row_version = row_version + 1, updated_at = ?
         WHERE credential_id = 1 AND status = 'CONNECTED' AND row_version = ? AND generation = ?
           AND EXISTS (SELECT 1 FROM youtube_oauth_control WHERE control_id = 1
             AND operation = 'REFRESHING' AND generation = ? AND operation_owner = ?)`,
      ).bind(operationExpiresAt, timestamp.iso, credential.row_version, credential.generation,
        credential.generation, operationOwner),
    ]);
    if ((claims[0]?.meta.changes ?? 0) !== 1 || (claims[1]?.meta.changes ?? 0) !== 1) {
      await this.db.prepare(
        `UPDATE youtube_oauth_control SET operation = 'READY', operation_owner = NULL,
           operation_expires_at = NULL, updated_at = ?
         WHERE control_id = 1 AND operation = 'REFRESHING' AND generation = ? AND operation_owner = ?`,
      ).bind(timestamp.iso, credential.generation, operationOwner).run();
      throw new YoutubeOAuthError("OAUTH_OPERATION_IN_PROGRESS", true);
    }
    let issuedTokens: YoutubeOAuthTokenSet | null = null;
    let refreshCommitAttempted = false;
    try {
      const refreshToken = await this.box.decrypt(
        credential.refresh_token_ciphertext!,
        "youtube:refresh",
      );
      const tokens = await this.provider.refresh(refreshToken);
      issuedTokens = tokens;
      assertTokenSet(tokens, false);
      await this.assertExpectedChannel(tokens.accessToken);
      const newRefreshToken = tokens.refreshToken ?? refreshToken;
      const [accessCiphertext, refreshCiphertext] = await Promise.all([
        this.box.encrypt(tokens.accessToken, "youtube:access"),
        this.box.encrypt(newRefreshToken, "youtube:refresh"),
      ]);
      const expiresAt = new Date(
        timestamp.milliseconds + tokens.expiresInSeconds * 1_000,
      ).toISOString();
      const commitTimestamp = nowValue(this.clock).iso;
      refreshCommitAttempted = true;
      const writes = await this.db.batch([
        this.db.prepare(
          `UPDATE youtube_oauth_credentials SET
             status = 'CONNECTED', access_token_ciphertext = ?, refresh_token_ciphertext = ?,
             token_expires_at = ?, verified_at = ?, last_error_code = NULL,
             operation_expires_at = NULL, row_version = row_version + 1, updated_at = ?
           WHERE credential_id = 1 AND status = 'REFRESHING' AND generation = ?
             AND EXISTS (SELECT 1 FROM youtube_oauth_control WHERE control_id = 1
               AND operation = 'REFRESHING' AND generation = ? AND operation_owner = ?
                 AND operation_expires_at > ?)`,
        ).bind(accessCiphertext, refreshCiphertext, expiresAt, timestamp.iso, timestamp.iso,
          credential.generation, credential.generation, operationOwner, commitTimestamp),
        this.db.prepare(
          `UPDATE youtube_oauth_control SET operation = 'READY', operation_owner = NULL,
             operation_expires_at = NULL, updated_at = ?
           WHERE control_id = 1 AND operation = 'REFRESHING' AND generation = ? AND operation_owner = ?
             AND EXISTS (SELECT 1 FROM youtube_oauth_credentials WHERE credential_id = 1
               AND generation = ? AND status = 'CONNECTED')`,
        ).bind(timestamp.iso, credential.generation, operationOwner, credential.generation),
        this.db.prepare(
          `INSERT INTO youtube_oauth_audits (
             oauth_audit_id, oauth_attempt_id, actor_subject_fingerprint,
             action, reason_code, occurred_at
           ) SELECT ?, NULL, ?, 'oauth.refreshed', NULL, ?
             WHERE EXISTS (SELECT 1 FROM youtube_oauth_control WHERE control_id = 1
               AND generation = ? AND operation = 'READY')
               AND EXISTS (SELECT 1 FROM youtube_oauth_credentials WHERE credential_id = 1
                 AND generation = ? AND status = 'CONNECTED')`,
        ).bind(`yt_oauth_audit_${crypto.randomUUID()}`, this.actorSubjectFingerprint, timestamp.iso,
          credential.generation, credential.generation),
      ]);
      if ((writes[0]?.meta.changes ?? 0) !== 1 || (writes[1]?.meta.changes ?? 0) !== 1
        || (writes[2]?.meta.changes ?? 0) !== 1) {
        throw new YoutubeOAuthError("OAUTH_REFRESH_COMMIT_AMBIGUOUS");
      }
    } catch (error) {
      const code = error instanceof YoutubeOAuthError
        ? error.code
        : refreshCommitAttempted
          ? "OAUTH_REFRESH_COMMIT_AMBIGUOUS"
          : "OAUTH_REFRESH_FAILED";
      const terminal = code === "CHANNEL_MISMATCH" || code === "CHANNEL_COUNT_INVALID"
        || code === "OAUTH_SCOPE_MISMATCH" || code === "OAUTH_GRANT_INVALID"
        || code === "CIPHERTEXT_INVALID" || issuedTokens !== null
        || (error instanceof YoutubeOAuthError && !error.retryable);
      // A refresh request can have succeeded remotely even when its response or the
      // following D1 write failed. Claim ERROR in D1 before revoking because a
      // newer refresh may already have reused the same Google grant.
      const markedError = await this.markOperationError(
        credential.generation,
        "REFRESHING",
        operationOwner,
        terminal ? code : "OAUTH_REFRESH_AMBIGUOUS",
        timestamp.iso,
        null,
        credential.row_version + 2,
      );
      if (issuedTokens && markedError) {
        await this.bestEffortRevoke(issuedTokens.refreshToken ?? issuedTokens.accessToken);
      }
      throw error instanceof YoutubeOAuthError
        ? error
        : new YoutubeOAuthError("OAUTH_REFRESH_FAILED", true);
    }
    return { status: "CONNECTED" };
  }

  async revoke(): Promise<YoutubeOAuthStatus> {
    this.assertAccessBoundary();
    const timestamp = nowValue(this.clock);
    await this.recoverExpiredOperation(timestamp.iso);
    const control = await this.db.prepare(
      `SELECT generation, operation, operation_owner FROM youtube_oauth_control WHERE control_id = 1`,
    ).first<{ generation: number; operation: string; operation_owner: string | null }>();
    if (!control || control.operation === "ERROR") {
      throw new YoutubeOAuthError("OAUTH_MANUAL_RECOVERY_REQUIRED");
    }
    const credential = await this.credential();
    if (credential?.status === "ERROR") {
      throw new YoutubeOAuthError("OAUTH_MANUAL_RECOVERY_REQUIRED");
    }
    if (credential?.status === "REVOKED"
      && credential.generation === control.generation
      && control.operation === "READY") {
      const fence = await this.db.prepare(
        `UPDATE youtube_oauth_control SET updated_at = updated_at
         WHERE control_id = 1 AND generation = ? AND operation = 'READY'
           AND EXISTS (SELECT 1 FROM youtube_oauth_credentials WHERE credential_id = 1
             AND status = 'REVOKED' AND generation = ?)
           AND NOT EXISTS (SELECT 1 FROM youtube_oauth_attempts
             WHERE status IN ('PENDING', 'CONSUMING'))`,
      ).bind(control.generation, credential.generation).run();
      if ((fence.meta.changes ?? 0) === 1) return { status: "REVOKED" };
      throw new YoutubeOAuthError("OAUTH_OPERATION_IN_PROGRESS", true);
    }
    const operationExpiresAt = new Date(timestamp.milliseconds + OAUTH_OPERATION_LEASE_MS).toISOString();
    const operationOwner = `revoke_${crypto.randomUUID()}`;
    if (!credential || credential.status === "REVOKED") {
      if (control.operation === "CALLBACK") {
        if (!control.operation_owner) throw new YoutubeOAuthError("OAUTH_OPERATION_IN_PROGRESS", true);
        await this.markOperationError(
          control.generation,
          "CALLBACK",
          control.operation_owner,
          "OAUTH_CALLBACK_OUTCOME_AMBIGUOUS",
          timestamp.iso,
        );
        throw new YoutubeOAuthError("OAUTH_MANUAL_RECOVERY_REQUIRED");
      }
      if (control.operation !== "READY") {
        throw new YoutubeOAuthError("OAUTH_OPERATION_IN_PROGRESS", true);
      }
      const writes = await this.db.batch([
        this.db.prepare(
          `UPDATE youtube_oauth_control SET generation = generation + 1, operation = 'READY',
             operation_owner = NULL, operation_expires_at = NULL, updated_at = ?
           WHERE control_id = 1 AND generation = ? AND operation = 'READY'
             AND ((? IS NULL AND NOT EXISTS (
               SELECT 1 FROM youtube_oauth_credentials WHERE credential_id = 1
             )) OR EXISTS (
               SELECT 1 FROM youtube_oauth_credentials WHERE credential_id = 1
                 AND status = 'REVOKED' AND generation = ?
             ))`,
        ).bind(timestamp.iso, control.generation,
          credential?.generation ?? null, credential?.generation ?? null),
        this.db.prepare(
          `UPDATE youtube_oauth_attempts SET status = 'EXPIRED', failure_code = 'OAUTH_REVOKED',
             pkce_verifier_ciphertext = '', updated_at = ?
           WHERE status IN ('PENDING', 'CONSUMING') AND generation <= ?
             AND EXISTS (SELECT 1 FROM youtube_oauth_control WHERE control_id = 1
               AND generation = ? AND operation = 'READY')`,
        ).bind(timestamp.iso, control.generation, control.generation + 1),
        this.db.prepare(
          `UPDATE youtube_oauth_credentials SET generation = ?,
             row_version = row_version + 1, updated_at = ?
           WHERE credential_id = 1 AND status = 'REVOKED' AND generation = ?
             AND EXISTS (SELECT 1 FROM youtube_oauth_control WHERE control_id = 1
               AND generation = ? AND operation = 'READY')`,
        ).bind(control.generation + 1, timestamp.iso,
          credential?.generation ?? null, control.generation + 1),
        this.db.prepare(
          `INSERT INTO youtube_oauth_audits (
             oauth_audit_id, oauth_attempt_id, actor_subject_fingerprint,
             action, reason_code, occurred_at
           ) SELECT ?, NULL, ?, 'oauth.revoked', NULL, ?
             WHERE EXISTS (SELECT 1 FROM youtube_oauth_control WHERE control_id = 1
               AND generation = ? AND operation = 'READY')
               AND NOT EXISTS (SELECT 1 FROM youtube_oauth_attempts
                 WHERE status IN ('PENDING', 'CONSUMING'))
               AND ((? IS NULL AND NOT EXISTS (
                 SELECT 1 FROM youtube_oauth_credentials WHERE credential_id = 1
               )) OR EXISTS (
                 SELECT 1 FROM youtube_oauth_credentials WHERE credential_id = 1
                   AND status = 'REVOKED' AND generation = ?
               ))`,
        ).bind(`yt_oauth_audit_${crypto.randomUUID()}`, this.actorSubjectFingerprint,
          timestamp.iso, control.generation + 1,
          credential?.generation ?? null, control.generation + 1),
      ]);
      const expectedCredentialWrites = credential?.status === "REVOKED" ? 1 : 0;
      if ((writes[0]?.meta.changes ?? 0) !== 1
        || (writes[2]?.meta.changes ?? 0) !== expectedCredentialWrites
        || (writes[3]?.meta.changes ?? 0) !== 1) {
        const latest = await this.db.prepare(
          `SELECT generation, operation, operation_owner FROM youtube_oauth_control WHERE control_id = 1`,
        ).first<{ generation: number; operation: string; operation_owner: string | null }>();
        if (latest?.operation === "CALLBACK" && latest.operation_owner) {
          await this.markOperationError(
            latest.generation,
            "CALLBACK",
            latest.operation_owner,
            "OAUTH_CALLBACK_OUTCOME_AMBIGUOUS",
            timestamp.iso,
          );
          throw new YoutubeOAuthError("OAUTH_MANUAL_RECOVERY_REQUIRED");
        }
        throw new YoutubeOAuthError("OAUTH_OPERATION_IN_PROGRESS", true);
      }
      return { status: "REVOKED" };
    }
    if (credential.status !== "CONNECTED") {
      throw new YoutubeOAuthError("OAUTH_OPERATION_IN_PROGRESS", true);
    }
    const claims = await this.db.batch([
      this.db.prepare(
        `UPDATE youtube_oauth_attempts SET status = 'EXPIRED', failure_code = 'OAUTH_REVOKED',
           pkce_verifier_ciphertext = '', updated_at = ? WHERE status IN ('PENDING', 'CONSUMING')`,
      ).bind(timestamp.iso),
      this.db.prepare(
        `UPDATE youtube_oauth_control SET generation = generation + 1, operation = 'REVOKING',
           operation_owner = ?, operation_expires_at = ?, updated_at = ?
         WHERE control_id = 1 AND operation IN ('READY', 'VERIFYING') AND generation = ?`,
      ).bind(operationOwner, operationExpiresAt, timestamp.iso, credential.generation),
      this.db.prepare(
        `UPDATE youtube_oauth_credentials SET generation = generation + 1, status = 'REVOKING',
           operation_expires_at = ?, row_version = row_version + 1, updated_at = ?
         WHERE credential_id = 1 AND status = 'CONNECTED' AND row_version = ? AND generation = ?
           AND EXISTS (SELECT 1 FROM youtube_oauth_control WHERE control_id = 1
             AND operation = 'REVOKING' AND generation = ? AND operation_owner = ?)`,
      ).bind(operationExpiresAt, timestamp.iso, credential.row_version, credential.generation,
        credential.generation + 1, operationOwner),
    ]);
    if ((claims[1]?.meta.changes ?? 0) !== 1 || (claims[2]?.meta.changes ?? 0) !== 1) {
      await this.markOperationError(
        credential.generation + 1,
        "REVOKING",
        operationOwner,
        "OAUTH_REVOKE_CLAIM_AMBIGUOUS",
        timestamp.iso,
      );
      throw new YoutubeOAuthError("OAUTH_OPERATION_IN_PROGRESS", true);
    }
    let token: string;
    try {
      token = await this.box.decrypt(credential.refresh_token_ciphertext!, "youtube:refresh");
    } catch {
      await this.markOperationError(
        credential.generation + 1, "REVOKING", operationOwner, "CIPHERTEXT_INVALID", timestamp.iso,
      );
      throw new YoutubeOAuthError("CIPHERTEXT_INVALID");
    }
    try {
      await this.provider.revoke(token);
    } catch (error) {
      const code = error instanceof YoutubeOAuthError ? error.code : "OAUTH_REVOKE_FAILED";
      await this.markOperationError(
        credential.generation + 1, "REVOKING", operationOwner, code, timestamp.iso,
      );
      throw error instanceof YoutubeOAuthError
        ? error
        : new YoutubeOAuthError("OAUTH_REVOKE_FAILED", true);
    }
    try {
      const writes = await this.db.batch([
        this.db.prepare(
          `UPDATE youtube_oauth_credentials SET status = 'REVOKED',
             access_token_ciphertext = NULL, refresh_token_ciphertext = NULL,
             token_expires_at = NULL, verified_channel_fingerprint = NULL, verified_at = NULL,
             operation_expires_at = NULL, last_error_code = NULL,
             row_version = row_version + 1, updated_at = ?
           WHERE credential_id = 1 AND generation = ? AND status = 'REVOKING'
             AND EXISTS (SELECT 1 FROM youtube_oauth_control WHERE control_id = 1
               AND generation = ? AND operation = 'REVOKING' AND operation_owner = ?)`,
        ).bind(timestamp.iso, credential.generation + 1, credential.generation + 1, operationOwner),
        this.db.prepare(
          `UPDATE youtube_oauth_control SET operation = 'READY', operation_owner = NULL,
             operation_expires_at = NULL, updated_at = ?
           WHERE control_id = 1 AND generation = ? AND operation = 'REVOKING' AND operation_owner = ?
             AND EXISTS (SELECT 1 FROM youtube_oauth_credentials WHERE credential_id = 1
               AND generation = ? AND status = 'REVOKED')`,
        ).bind(timestamp.iso, credential.generation + 1, operationOwner, credential.generation + 1),
        this.db.prepare(
          `INSERT INTO youtube_oauth_audits (
             oauth_audit_id, oauth_attempt_id, actor_subject_fingerprint,
             action, reason_code, occurred_at
           ) SELECT ?, NULL, ?, 'oauth.revoked', NULL, ?
             WHERE EXISTS (SELECT 1 FROM youtube_oauth_control WHERE control_id = 1
               AND generation = ? AND operation = 'READY')
               AND EXISTS (SELECT 1 FROM youtube_oauth_credentials WHERE credential_id = 1
                 AND generation = ? AND status = 'REVOKED')`,
        ).bind(`yt_oauth_audit_${crypto.randomUUID()}`, this.actorSubjectFingerprint, timestamp.iso,
          credential.generation + 1, credential.generation + 1),
      ]);
      if ((writes[0]?.meta.changes ?? 0) !== 1 || (writes[1]?.meta.changes ?? 0) !== 1
        || (writes[2]?.meta.changes ?? 0) !== 1) {
        throw new YoutubeOAuthError("OAUTH_REVOKE_PERSIST_FAILED");
      }
      return { status: "REVOKED" };
    } catch {
      // The provider already accepted revocation. Never restore CONNECTED after that side effect.
      try {
        await this.markOperationError(
          credential.generation + 1,
          "REVOKING",
          operationOwner,
          "OAUTH_REVOKE_PERSIST_FAILED",
          timestamp.iso,
        );
      } catch { /* leave REVOKING/PENDING rather than claiming the credential is usable */ }
      throw new YoutubeOAuthError("OAUTH_REVOKE_PERSIST_FAILED");
    }
  }

  async status(): Promise<YoutubeOAuthStatus> {
    const timestamp = nowValue(this.clock);
    await this.recoverExpiredOperation(timestamp.iso);
    const control = await this.db.prepare(
      `SELECT operation FROM youtube_oauth_control WHERE control_id = 1`,
    ).first<{ operation: string }>();
    if (!control || control.operation === "ERROR") return { status: "ERROR" };
    if (control.operation !== "READY") return { status: "PENDING" };
    const credential = await this.credential();
    if (!credential) return { status: "NOT_CONNECTED" };
    if (credential.status === "REVOKED") return { status: "REVOKED" };
    if (credential.status === "ERROR") return { status: "ERROR" };
    if (credential.status !== "CONNECTED") return { status: "PENDING" };
    const currentExpected = await sha256Hex(this.config.expectedChannelId);
    if (!credential.verified_channel_fingerprint
      || credential.expected_channel_fingerprint !== currentExpected
      || credential.verified_channel_fingerprint !== currentExpected) {
      return { status: "ERROR" };
    }
    if (!credential.token_expires_at
      || timestamp.milliseconds >= Date.parse(credential.token_expires_at)) {
      return { status: "REFRESH_REQUIRED" };
    }
    return { status: "CONNECTED" };
  }

  async assertReadyForPublishing(): Promise<YoutubeOAuthStatus> {
    const status = await this.status();
    if (status.status !== "CONNECTED") {
      await this.audit(null, "oauth.readiness_rejected", status.status, nowValue(this.clock).iso);
      throw new YoutubeOAuthError("YOUTUBE_OAUTH_NOT_READY");
    }
    const credential = await this.credential();
    if (!credential || credential.status !== "CONNECTED") throw new YoutubeOAuthError("YOUTUBE_OAUTH_NOT_READY");
    const timestamp = nowValue(this.clock);
    const operationExpiresAt = new Date(timestamp.milliseconds + OAUTH_OPERATION_LEASE_MS).toISOString();
    const operationOwner = `verify_${crypto.randomUUID()}`;
    const claims = await this.db.batch([
      this.db.prepare(
        `UPDATE youtube_oauth_control SET operation = 'VERIFYING', operation_owner = ?,
           operation_expires_at = ?, updated_at = ?
         WHERE control_id = 1 AND operation = 'READY' AND generation = ?
           AND EXISTS (SELECT 1 FROM youtube_oauth_credentials WHERE credential_id = 1
             AND generation = ? AND status = 'CONNECTED' AND row_version = ?)`,
      ).bind(operationOwner, operationExpiresAt, timestamp.iso,
        credential.generation, credential.generation, credential.row_version),
      this.db.prepare(
        `UPDATE youtube_oauth_credentials SET row_version = row_version + 1, updated_at = ?
         WHERE credential_id = 1 AND generation = ? AND status = 'CONNECTED' AND row_version = ?
           AND EXISTS (SELECT 1 FROM youtube_oauth_control WHERE control_id = 1
             AND generation = ? AND operation = 'VERIFYING' AND operation_owner = ?)`,
      ).bind(timestamp.iso, credential.generation, credential.row_version,
        credential.generation, operationOwner),
    ]);
    if ((claims[0]?.meta.changes ?? 0) !== 1 || (claims[1]?.meta.changes ?? 0) !== 1) {
      throw new YoutubeOAuthError("YOUTUBE_OAUTH_NOT_READY");
    }
    try {
      const currentExpected = await sha256Hex(this.config.expectedChannelId);
      if (credential.expected_channel_fingerprint !== currentExpected
        || credential.verified_channel_fingerprint !== currentExpected) {
        throw new YoutubeOAuthError("EXPECTED_CHANNEL_CONFIG_CHANGED");
      }
      const [accessToken] = await Promise.all([
        this.box.decrypt(credential.access_token_ciphertext!, "youtube:access"),
        this.box.decrypt(credential.refresh_token_ciphertext!, "youtube:refresh"),
      ]);
      await this.assertExpectedChannel(accessToken);
      const completion = nowValue(this.clock).iso;
      const release = await this.db.prepare(
        `UPDATE youtube_oauth_control SET operation = 'READY', operation_owner = NULL,
           operation_expires_at = NULL, updated_at = ?
         WHERE control_id = 1 AND operation = 'VERIFYING' AND generation = ? AND operation_owner = ?
           AND operation_expires_at > ?
           AND EXISTS (SELECT 1 FROM youtube_oauth_credentials WHERE credential_id = 1
             AND generation = ? AND status = 'CONNECTED'
             AND expected_channel_fingerprint = ? AND verified_channel_fingerprint = ?)`,
      ).bind(completion, credential.generation, operationOwner, completion, credential.generation,
        currentExpected, currentExpected).run();
      if ((release.meta.changes ?? 0) !== 1) throw new YoutubeOAuthError("READINESS_FENCE_STALE");
      return status;
    } catch {
      const current = await this.db.prepare(
        `SELECT generation, operation, operation_owner FROM youtube_oauth_control WHERE control_id = 1`,
      ).first<{ generation: number; operation: string; operation_owner: string | null }>();
      if (current?.generation === credential.generation && current.operation === "VERIFYING"
        && current.operation_owner === operationOwner) {
        try {
          const refreshToken = await this.box.decrypt(
            credential.refresh_token_ciphertext!,
            "youtube:refresh",
          );
          await this.bestEffortRevoke(refreshToken);
        } catch { /* ciphertext authentication failure is already terminal */ }
        await this.markOperationError(
          credential.generation,
          "VERIFYING",
          operationOwner,
          "READINESS_REVALIDATION_FAILED",
          nowValue(this.clock).iso,
        );
      }
      throw new YoutubeOAuthError("YOUTUBE_OAUTH_NOT_READY");
    }
  }

  private assertAccessBoundary(): void {
    if (!(this.access instanceof VerifiedAccessSession) || !this.access.isVerified()) {
      throw new YoutubeOAuthError("OAUTH_ACCESS_REQUIRED");
    }
  }

  private async assertExpectedChannel(accessToken: string): Promise<void> {
    const channels = await this.provider.listMineChannels(accessToken);
    if (!Array.isArray(channels) || channels.length !== 1) {
      throw new YoutubeOAuthError("CHANNEL_COUNT_INVALID");
    }
    if (!CHANNEL_ID_PATTERN.test(channels[0]!) || channels[0] !== this.config.expectedChannelId) {
      throw new YoutubeOAuthError("CHANNEL_MISMATCH");
    }
  }

  private credential(): Promise<CredentialRow | null> {
    return this.db.prepare(
      `SELECT generation, status, access_token_ciphertext, refresh_token_ciphertext,
              token_expires_at, expected_channel_fingerprint,
              verified_channel_fingerprint, verified_at, row_version, operation_expires_at
       FROM youtube_oauth_credentials WHERE credential_id = 1`,
    ).first<CredentialRow>();
  }

  private async recoverExpiredOperation(timestamp: string): Promise<void> {
    const control = await this.db.prepare(
      `SELECT generation, operation, operation_owner, operation_expires_at
       FROM youtube_oauth_control WHERE control_id = 1`,
    ).first<{
      generation: number;
      operation: string;
      operation_owner: string | null;
      operation_expires_at: string | null;
    }>();
    if (!control || control.operation === "READY" || control.operation === "ERROR" || !control.operation_expires_at
      || control.operation_expires_at > timestamp) return;
    if (!control.operation_owner) return;
    const operation = control.operation as ActiveOAuthOperation;
    const action = operation === "REFRESHING"
      ? "oauth.refresh_failed"
      : operation === "REVOKING"
        ? "oauth.revoke_failed"
        : operation === "VERIFYING"
          ? "oauth.readiness_rejected"
          : "oauth.failed";
    const auditId = `yt_oauth_recovery_${crypto.randomUUID()}`;
    const writes = await this.db.batch([
      this.db.prepare(
        `UPDATE youtube_oauth_control SET operation = 'ERROR', operation_owner = NULL,
           operation_expires_at = NULL, updated_at = ?
         WHERE control_id = 1 AND generation = ? AND operation = ? AND operation_owner = ?
           AND operation_expires_at = ? AND operation_expires_at <= ?`,
      ).bind(timestamp, control.generation, operation, control.operation_owner,
        control.operation_expires_at, timestamp),
      this.db.prepare(
        `INSERT INTO youtube_oauth_audits (
           oauth_audit_id, oauth_attempt_id, actor_subject_fingerprint,
           action, reason_code, occurred_at
         ) SELECT ?, NULL, ?, ?, 'OAUTH_OPERATION_AMBIGUOUS', ? WHERE changes() = 1`,
      ).bind(auditId, this.actorSubjectFingerprint, action, timestamp),
      this.db.prepare(
        `UPDATE youtube_oauth_attempts SET status = 'FAILED', failure_code = 'OAUTH_OPERATION_AMBIGUOUS',
           pkce_verifier_ciphertext = '', updated_at = ?
         WHERE generation <= ? AND status IN ('PENDING', 'CONSUMING')
           AND EXISTS (SELECT 1 FROM youtube_oauth_audits WHERE oauth_audit_id = ?)`,
      ).bind(timestamp, control.generation, auditId),
      this.db.prepare(
        `UPDATE youtube_oauth_credentials SET status = 'ERROR',
           access_token_ciphertext = NULL, refresh_token_ciphertext = NULL,
           token_expires_at = NULL, verified_channel_fingerprint = NULL,
           verified_at = NULL, operation_expires_at = NULL,
           last_error_code = 'OAUTH_OPERATION_AMBIGUOUS', row_version = row_version + 1,
           updated_at = ? WHERE credential_id = 1 AND generation = ?
           AND EXISTS (SELECT 1 FROM youtube_oauth_audits WHERE oauth_audit_id = ?)`,
      ).bind(timestamp, control.generation, auditId),
    ]);
    if ((writes[0]?.meta.changes ?? 0) !== 1) return;
    if ((writes[1]?.meta.changes ?? 0) !== 1) {
      throw new YoutubeOAuthError("OAUTH_OPERATION_RECOVERY_FAILED");
    }
  }

  private async markOperationError(
    generation: number,
    operation: ActiveOAuthOperation,
    operationOwner: string,
    errorCode: string,
    timestamp: string,
    attemptId: string | null = null,
    releasedCredentialRowVersion: number | null = null,
  ): Promise<boolean> {
    const auditId = `yt_oauth_error_${crypto.randomUUID()}`;
    const action = operation === "REFRESHING"
      ? "oauth.refresh_failed"
      : operation === "REVOKING"
        ? "oauth.revoke_failed"
        : operation === "VERIFYING"
          ? "oauth.readiness_rejected"
          : "oauth.failed";
    const writes = await this.db.batch([
      this.db.prepare(
        `UPDATE youtube_oauth_control SET operation = 'ERROR', operation_owner = NULL,
           operation_expires_at = NULL, updated_at = ?
         WHERE control_id = 1 AND generation = ?
           AND ((operation = ? AND operation_owner = ?)
             OR (? IS NOT NULL AND operation = 'READY' AND operation_owner IS NULL
               AND EXISTS (SELECT 1 FROM youtube_oauth_credentials
                 WHERE credential_id = 1 AND generation = ? AND status = 'CONNECTED'
                   AND row_version = ?)
               AND (? = 'REFRESHING' OR (? = 'CALLBACK' AND ? IS NOT NULL
                 AND EXISTS (SELECT 1 FROM youtube_oauth_attempts
                   WHERE oauth_attempt_id = ? AND generation = ? AND status = 'COMPLETED')))))`,
      ).bind(
        timestamp,
        generation,
        operation,
        operationOwner,
        releasedCredentialRowVersion,
        generation,
        releasedCredentialRowVersion,
        operation,
        operation,
        attemptId,
        attemptId,
        generation,
      ),
      this.db.prepare(
        `INSERT INTO youtube_oauth_audits (
           oauth_audit_id, oauth_attempt_id, actor_subject_fingerprint,
           action, reason_code, occurred_at
         ) SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
      ).bind(auditId, attemptId, this.actorSubjectFingerprint, action, errorCode, timestamp),
      this.db.prepare(
        `UPDATE youtube_oauth_credentials SET status = 'ERROR',
           access_token_ciphertext = NULL, refresh_token_ciphertext = NULL,
           token_expires_at = NULL, verified_channel_fingerprint = NULL, verified_at = NULL,
           operation_expires_at = NULL, last_error_code = ?, row_version = row_version + 1,
           updated_at = ? WHERE credential_id = 1 AND generation = ?
             AND EXISTS (SELECT 1 FROM youtube_oauth_audits WHERE oauth_audit_id = ?)`,
      ).bind(errorCode, timestamp, generation, auditId),
      this.db.prepare(
        `UPDATE youtube_oauth_attempts SET status = 'FAILED', failure_code = ?,
           pkce_verifier_ciphertext = '', updated_at = ?
         WHERE generation <= ? AND status IN ('PENDING', 'CONSUMING')
           AND EXISTS (SELECT 1 FROM youtube_oauth_audits WHERE oauth_audit_id = ?)`,
      ).bind(errorCode, timestamp, generation, auditId),
    ]);
    if ((writes[0]?.meta.changes ?? 0) !== 1) return false;
    if ((writes[1]?.meta.changes ?? 0) !== 1) {
      throw new YoutubeOAuthError("OAUTH_ERROR_PERSIST_FAILED");
    }
    return true;
  }

  private async bestEffortRevoke(token: string): Promise<void> {
    try { await this.provider.revoke(token); } catch { /* token is never logged or persisted */ }
  }

  private auditStatement(
    attemptId: string | null,
    action: string,
    reasonCode: string | null,
    timestamp: string,
  ): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO youtube_oauth_audits (
         oauth_audit_id, oauth_attempt_id, actor_subject_fingerprint,
         action, reason_code, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(`yt_oauth_audit_${crypto.randomUUID()}`, attemptId, this.actorSubjectFingerprint,
      action, reasonCode, timestamp);
  }

  private async audit(
    attemptId: string | null,
    action: string,
    reasonCode: string | null,
    timestamp: string,
  ): Promise<void> {
    await this.auditStatement(attemptId, action, reasonCode, timestamp).run();
  }
}

export function youtubeOAuthStatusJson(status: YoutubeOAuthStatus): string {
  return canonicalJson(status);
}
