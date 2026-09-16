import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeYoutubeOAuthProvider } from "../src/e5-fakes";
import { CloudflareAccessVerifier, VerifiedAccessSession } from "../src/cloudflare-access";
import { sha256Hex } from "../src/fingerprint";
import {
  E5YoutubeOAuthService,
  YOUTUBE_READONLY_SCOPE,
  YoutubeOAuthError,
  type YoutubeOAuthConfig,
} from "../src/e5-youtube-oauth";

const NOW = "2026-08-26T00:00:00.000Z";
const ACCESS_DOMAIN = "service-test.cloudflareaccess.com";
const ACCESS_AUD = "service_test_audience_12345";
const ACCESS_EMAIL = "operator@local.invalid";
let accessPrivateKey: CryptoKey;
let accessPublicJwk: JsonWebKey;

function encodeBase64Url(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function verifiedAccess(): Promise<VerifiedAccessSession> {
  const header = encodeBase64Url(JSON.stringify({ alg: "RS256", kid: "service-test-key" }));
  const payload = encodeBase64Url(JSON.stringify({
    iss: `https://${ACCESS_DOMAIN}`, aud: ACCESS_AUD,
    exp: Math.floor(Date.now() / 1_000) + 600, email: ACCESS_EMAIL,
    sub: "service-test-subject",
  }));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", accessPrivateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  const token = `${header}.${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
  return new CloudflareAccessVerifier(
    { teamDomain: ACCESS_DOMAIN, audience: ACCESS_AUD, allowedEmails: [ACCESS_EMAIL] },
    (async () => Response.json({ keys: [{
      ...accessPublicJwk, kid: "service-test-key", alg: "RS256", use: "sig",
    }] })) as typeof fetch,
  ).verify(new Request("https://app.invalid/", {
    headers: { "cf-access-jwt-assertion": token },
  }));
}

class MutableClock {
  constructor(private value: string) {}
  now = (): Date => new Date(this.value);
  set(value: string): void { this.value = value; }
}

function randomChannelId(): string {
  return `UC${crypto.randomUUID().replaceAll("-", "").slice(0, 22)}`;
}

function config(expectedChannelId: string): YoutubeOAuthConfig {
  const keyBytes = new Uint8Array(32);
  crypto.getRandomValues(keyBytes);
  let binary = "";
  for (const byte of keyBytes) binary += String.fromCharCode(byte);
  return {
    clientId: `local_client_${crypto.randomUUID()}`,
    redirectUri: "https://oauth.invalid/callback",
    expectedChannelId,
    encryptionKey: btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""),
  };
}

function callbackInput(start: { authorizationUrl: string }): {
  state: string;
  authorizationCode: string;
} {
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("fake authorization URL omitted state");
  return { state, authorizationCode: `local_code_${crypto.randomUUID()}` };
}

async function clearDatabase(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM youtube_oauth_audits"),
    env.DB.prepare("DELETE FROM youtube_oauth_credentials"),
    env.DB.prepare("DELETE FROM youtube_oauth_attempts"),
    env.DB.prepare(
      `UPDATE youtube_oauth_control SET generation = 0, operation = 'READY',
         operation_owner = NULL, operation_expires_at = NULL,
         updated_at = '1970-01-01T00:00:00.000Z'`,
    ),
  ]);
}

async function harness() {
  const expectedChannelId = randomChannelId();
  const provider = new FakeYoutubeOAuthProvider([expectedChannelId]);
  const clock = new MutableClock(NOW);
  const access = await verifiedAccess();
  const settings = config(expectedChannelId);
  const service = new E5YoutubeOAuthService(
    env.DB,
    provider,
    settings,
    access,
    clock.now,
  );
  return { expectedChannelId, provider, clock, service, settings, access };
}

async function connect(context: Awaited<ReturnType<typeof harness>>) {
  const start = await context.service.start();
  const input = callbackInput(start);
  const status = await context.service.callback(input);
  return { start, input, status };
}

function barrierDatabase(target: D1Database, sqlFragment: string | readonly string[], requiredCount = 2): {
  db: D1Database;
  enable: () => void;
  waitForBoth: Promise<void>;
  release: () => void;
} {
  let enabled = false;
  let waiting = 0;
  let release!: () => void;
  let both!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const waitForBoth = new Promise<void>((resolve) => { both = resolve; });
  const wrap = (statement: D1PreparedStatement, selected: boolean): D1PreparedStatement => new Proxy(
    statement,
    {
      get(inner, property) {
        const value = Reflect.get(inner, property);
        if (property === "bind" && typeof value === "function") {
          return (...args: unknown[]) => wrap(Reflect.apply(value, inner, args), selected);
        }
        if (property === "first" && typeof value === "function" && selected) {
          return async (...args: unknown[]) => {
            const row = await Reflect.apply(value, inner, args);
            if (enabled && waiting < requiredCount) {
              waiting += 1;
              if (waiting === requiredCount) both();
              await gate;
            }
            return row;
          };
        }
        return typeof value === "function" ? value.bind(inner) : value;
      },
    },
  );
  const db = new Proxy(target, {
    get(inner, property) {
      if (property === "prepare") {
        return (sql: string) => {
          const fragments = typeof sqlFragment === "string" ? [sqlFragment] : sqlFragment;
          return wrap(inner.prepare(sql), fragments.some((fragment) => sql.includes(fragment)));
        };
      }
      const value = Reflect.get(inner, property);
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });
  return { db, enable: () => { enabled = true; }, waitForBoth, release };
}

function failNthStatusReadDatabase(
  target: D1Database,
  failureAt: number,
): { db: D1Database; statusReads: () => number } {
  let statusReads = 0;
  const marker = "SELECT generation, operation, operation_owner, operation_expires_at";
  const db = new Proxy(target, {
    get(inner, property) {
      if (property === "prepare") {
        return (sql: string) => {
          if (sql.includes(marker)) {
            statusReads += 1;
            if (statusReads === failureAt) throw new Error("LOCAL_POST_COMMIT_STATUS_READ_FAILURE");
          }
          return inner.prepare(sql);
        };
      }
      const value = Reflect.get(inner, property);
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });
  return { db, statusReads: () => statusReads };
}

function loseBatchResponseAfterCommit(
  target: D1Database,
  sqlMarker: string,
  afterCommit?: () => Promise<void>,
): D1Database {
  let loseNextBatchResponse = false;
  let lost = false;
  return new Proxy(target, {
    get(inner, property) {
      if (property === "prepare") {
        return (sql: string) => {
          if (!lost && sql.includes(sqlMarker)) loseNextBatchResponse = true;
          return inner.prepare(sql);
        };
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const shouldLoseResponse = loseNextBatchResponse && !lost;
          loseNextBatchResponse = false;
          const results = await inner.batch(statements);
          if (shouldLoseResponse) {
            lost = true;
            await afterCommit?.();
            throw new Error("LOCAL_D1_RESPONSE_LOST_AFTER_COMMIT");
          }
          return results;
        };
      }
      const value = Reflect.get(inner, property);
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });
}

function failAuditInsertDatabase(
  target: D1Database,
  marker: "OAUTH_STATE_EXPIRED" | "OAUTH_CONSENT_DENIED" | "oauth.revoked",
): D1Database {
  return new Proxy(target, {
    get(inner, property) {
      if (property === "prepare") {
        return (sql: string) => {
          if (sql.includes("INSERT INTO youtube_oauth_audits") && sql.includes(marker)) {
            if (marker === "oauth.revoked") {
              return inner.prepare(
                `INSERT INTO youtube_oauth_audits (
                   oauth_audit_id, oauth_attempt_id, actor_subject_fingerprint,
                   action, reason_code, occurred_at
                 ) SELECT ?, NULL, ?, 'oauth.invalid', NULL, ? WHERE ? = ?`,
              );
            }
            return inner.prepare(
              `INSERT INTO youtube_oauth_audits (
                 oauth_audit_id, oauth_attempt_id, actor_subject_fingerprint,
                 action, reason_code, occurred_at
               ) SELECT ?, ?, ?, 'oauth.invalid', NULL, ?
                 WHERE ? IS NOT NULL AND ? IS NOT NULL`,
            );
          }
          return inner.prepare(sql);
        };
      }
      const value = Reflect.get(inner, property);
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });
}

function failAtomicErrorAuditDatabase(
  target: D1Database,
  recovery = false,
): D1Database {
  return new Proxy(target, {
    get(inner, property) {
      if (property === "prepare") {
        return (sql: string) => {
          const isTarget = recovery
            ? sql.includes("'OAUTH_OPERATION_AMBIGUOUS'") && sql.includes("INSERT INTO youtube_oauth_audits")
            : sql.includes("SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1");
          if (isTarget) {
            return recovery
              ? inner.prepare(
                `INSERT INTO youtube_oauth_audits (
                   oauth_audit_id, oauth_attempt_id, actor_subject_fingerprint,
                   action, reason_code, occurred_at
                 ) SELECT ?, NULL, ?, 'oauth.invalid', NULL, ? WHERE ? IS NOT NULL`,
              )
              : inner.prepare(
                `INSERT INTO youtube_oauth_audits (
                   oauth_audit_id, oauth_attempt_id, actor_subject_fingerprint,
                   action, reason_code, occurred_at
                 ) SELECT ?, ?, ?, 'oauth.invalid', ?, ? WHERE ? IS NOT NULL`,
              );
          }
          return inner.prepare(sql);
        };
      }
      const value = Reflect.get(inner, property);
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  accessPrivateKey = pair.privateKey;
  accessPublicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
});

beforeEach(clearDatabase);
afterEach(() => vi.restoreAllMocks());

describe("E-5.2 local YouTube OAuth and channel binding", () => {
  it("refuses to start or consume OAuth when the public callback is not protected by Cloudflare Access", async () => {
    const expectedChannelId = randomChannelId();
    expect(() => new E5YoutubeOAuthService(
      env.DB,
      new FakeYoutubeOAuthProvider([expectedChannelId]),
      config(expectedChannelId),
      {} as VerifiedAccessSession,
    )).toThrowError("OAUTH_ACCESS_REQUIRED");
  });

  it("starts with offline access, readonly scope, state hashing, PKCE S256, and a ten-minute TTL", async () => {
    const context = await harness();
    const start = await context.service.start();
    const url = new URL(start.authorizationUrl);
    const state = url.searchParams.get("state")!;
    expect(start).toMatchObject({ status: "PENDING", expiresAt: "2026-08-26T00:10:00.000Z" });
    expect(url.searchParams.get("scope")).toBe(YOUTUBE_READONLY_SCOPE);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.has("code_verifier")).toBe(false);

    const row = await env.DB.prepare(
      `SELECT state_hash, pkce_verifier_ciphertext, requested_scope, status
       FROM youtube_oauth_attempts`,
    ).first<{
      state_hash: string;
      pkce_verifier_ciphertext: string;
      requested_scope: string;
      status: string;
    }>();
    expect(row).toMatchObject({ requested_scope: YOUTUBE_READONLY_SCOPE, status: "PENDING" });
    expect(row!.state_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.state_hash).not.toContain(state);
    expect(row!.pkce_verifier_ciphertext).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(row!.pkce_verifier_ciphertext).not.toContain(url.searchParams.get("code_challenge")!);
  });

  it("allows only one of two starts read at the same READY generation to replace attempts", async () => {
    const context = await harness();
    const barrier = barrierDatabase(
      env.DB,
      "SELECT generation, operation, operation_owner FROM youtube_oauth_control",
    );
    const service = new E5YoutubeOAuthService(
      barrier.db, context.provider, context.settings, context.access, context.clock.now,
    );
    barrier.enable();
    const requests = [service.start(), service.start()]
      .map(async (request) => request.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ));
    await barrier.waitForBoth;
    barrier.release();
    const results = await Promise.all(requests);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(context.access.subjectFingerprint).toBe(await sha256Hex("service-test-subject"));
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_attempts WHERE status = 'PENDING'",
    ).first()).toEqual({ count: 1 });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE action = 'oauth.started'",
    ).first()).toEqual({ count: 1 });
  });

  it("allows only the winning start or callback to change the previously pending attempt", async () => {
    const context = await harness();
    const original = await context.service.start();
    const barrier = barrierDatabase(env.DB, [
      "SELECT generation, operation, operation_owner FROM youtube_oauth_control",
      "FROM youtube_oauth_attempts WHERE state_hash = ?",
    ]);
    const service = new E5YoutubeOAuthService(
      barrier.db, context.provider, context.settings, context.access, context.clock.now,
    );
    barrier.enable();
    const requests = [service.start(), service.callback(callbackInput(original))]
      .map(async (request) => request.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ));
    await barrier.waitForBoth;
    barrier.release();
    const results = await Promise.all(requests);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const attempts = (await env.DB.prepare(
      "SELECT status FROM youtube_oauth_attempts ORDER BY generation",
    ).all<{ status: string }>()).results.map((row) => row.status);
    if (results[0]!.status === "fulfilled") {
      expect(attempts).toEqual(["EXPIRED", "PENDING"]);
      expect(await env.DB.prepare("SELECT COUNT(*) count FROM youtube_oauth_credentials").first())
        .toEqual({ count: 0 });
    } else {
      expect(attempts).toEqual(["COMPLETED"]);
      expect(await env.DB.prepare("SELECT status FROM youtube_oauth_credentials").first())
        .toEqual({ status: "CONNECTED" });
    }
  });

  it("connects only one matching mine=true channel and returns status without tokens or channel IDs", async () => {
    const context = await harness();
    const { status } = await connect(context);
    expect(status).toEqual({ status: "CONNECTED" });
    expect(context.provider.operations()).toEqual([
      "authorization", "exchange", "channels.list.mine",
    ]);

    const persisted = await env.DB.prepare(
      `SELECT status, access_token_ciphertext, refresh_token_ciphertext,
              expected_channel_fingerprint, verified_channel_fingerprint
       FROM youtube_oauth_credentials WHERE credential_id = 1`,
    ).first<Record<string, unknown>>();
    const serialized = JSON.stringify(persisted);
    expect(persisted).toMatchObject({ status: "CONNECTED" });
    expect(persisted!.expected_channel_fingerprint)
      .toBe(persisted!.verified_channel_fingerprint);
    expect(await env.DB.prepare(
      `SELECT COUNT(DISTINCT actor_subject_fingerprint) actor_count,
              MIN(actor_subject_fingerprint) actor
       FROM youtube_oauth_audits`,
    ).first()).toEqual({ actor_count: 1, actor: context.access.subjectFingerprint });
    expect(serialized).not.toContain(context.expectedChannelId);
    for (const secret of context.provider.issuedSecretValues()) {
      expect(serialized).not.toContain(secret);
      expect(JSON.stringify(status)).not.toContain(secret);
    }
  });

  it("fails status closed when the configured expected channel changes after connection", async () => {
    const context = await harness();
    await connect(context);
    const changedService = new E5YoutubeOAuthService(
      env.DB,
      context.provider,
      { ...context.settings, expectedChannelId: randomChannelId() },
      context.access,
      context.clock.now,
    );

    await expect(changedService.status()).resolves.toEqual({ status: "ERROR" });
  });

  it.each([
    ["zero", []],
    ["multiple", [randomChannelId(), randomChannelId()]],
    ["different", [randomChannelId()]],
  ])("fails closed for %s returned channels and stores no credential", async (_name, channels) => {
    const context = await harness();
    context.provider.setChannels(channels);
    const start = await context.service.start();
    await expect(context.service.callback(callbackInput(start))).rejects.toBeInstanceOf(YoutubeOAuthError);
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM youtube_oauth_credentials").first())
      .toEqual({ count: 0 });
    expect(await env.DB.prepare(
      "SELECT status, failure_code FROM youtube_oauth_attempts",
    ).first()).toMatchObject({ status: "FAILED" });
    expect(context.provider.operations()).toContain("revoke");
  });

  it("rejects missing or broader scopes and never calls channel lookup", async () => {
    for (const scopes of [[], [YOUTUBE_READONLY_SCOPE, "scope_not_allowed"]]) {
      await clearDatabase();
      const context = await harness();
      context.provider.setScopes(scopes);
      const start = await context.service.start();
      await expect(context.service.callback(callbackInput(start)))
        .rejects.toMatchObject({ code: "OAUTH_SCOPE_MISMATCH" });
      expect(context.provider.operations()).not.toContain("channels.list.mine");
      expect(await env.DB.prepare("SELECT COUNT(*) count FROM youtube_oauth_credentials").first())
        .toEqual({ count: 0 });
    }
  });

  it("expires state, rejects unknown state, and never exchanges an authorization code", async () => {
    const context = await harness();
    const start = await context.service.start();
    context.clock.set("2026-08-26T00:10:00.000Z");
    await expect(context.service.callback(callbackInput(start)))
      .rejects.toMatchObject({ code: "OAUTH_STATE_EXPIRED" });
    await expect(context.service.callback({
      state: `unknown_${crypto.randomUUID()}`,
      authorizationCode: `code_${crypto.randomUUID()}`,
    })).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
    expect(context.provider.operations()).toEqual(["authorization"]);
  });

  it("rolls back expiry when its required failed audit cannot be inserted", async () => {
    const context = await harness();
    const start = await context.service.start();
    context.clock.set("2026-08-26T00:10:00.000Z");
    const service = new E5YoutubeOAuthService(
      failAuditInsertDatabase(env.DB, "OAUTH_STATE_EXPIRED"),
      context.provider, context.settings, context.access, context.clock.now,
    );
    await expect(service.callback(callbackInput(start)))
      .rejects.toMatchObject({ code: "OAUTH_STATE_PERSIST_FAILED" });
    expect(await env.DB.prepare(
      "SELECT status, failure_code FROM youtube_oauth_attempts",
    ).first()).toEqual({ status: "PENDING", failure_code: null });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE reason_code = 'OAUTH_STATE_EXPIRED'",
    ).first()).toEqual({ count: 0 });
  });

  it("rolls back consent denial when its required failed audit cannot be inserted", async () => {
    const context = await harness();
    const start = await context.service.start();
    const input = callbackInput(start);
    const service = new E5YoutubeOAuthService(
      failAuditInsertDatabase(env.DB, "OAUTH_CONSENT_DENIED"),
      context.provider, context.settings, context.access, context.clock.now,
    );
    await expect(service.denyCallback({ state: input.state }))
      .rejects.toMatchObject({ code: "OAUTH_DENIAL_PERSIST_FAILED" });
    expect(await env.DB.prepare(
      "SELECT status, failure_code FROM youtube_oauth_attempts",
    ).first()).toEqual({ status: "PENDING", failure_code: null });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE reason_code = 'OAUTH_CONSENT_DENIED'",
    ).first()).toEqual({ count: 0 });
  });

  it("records one expiry audit when two expired callbacks read the same PENDING attempt", async () => {
    const context = await harness();
    const start = await context.service.start();
    context.clock.set("2026-08-26T00:10:00.000Z");
    const barrier = barrierDatabase(env.DB, "FROM youtube_oauth_attempts WHERE state_hash = ?");
    const service = new E5YoutubeOAuthService(
      barrier.db, context.provider, context.settings, context.access, context.clock.now,
    );
    barrier.enable();
    const requests = [service.callback(callbackInput(start)), service.callback(callbackInput(start))]
      .map(async (request) => request.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ));
    await barrier.waitForBoth;
    barrier.release();
    const results = await Promise.all(requests);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(await env.DB.prepare(
      "SELECT status, failure_code FROM youtube_oauth_attempts",
    ).first()).toEqual({ status: "EXPIRED", failure_code: "OAUTH_STATE_EXPIRED" });
    expect(await env.DB.prepare(
      `SELECT COUNT(*) count FROM youtube_oauth_audits
       WHERE action = 'oauth.failed' AND reason_code = 'OAUTH_STATE_EXPIRED'`,
    ).first()).toEqual({ count: 1 });
  });

  it("records one denial audit when two denials read the same PENDING attempt", async () => {
    const context = await harness();
    const start = await context.service.start();
    const input = callbackInput(start);
    const barrier = barrierDatabase(env.DB, "FROM youtube_oauth_attempts WHERE state_hash = ?");
    const service = new E5YoutubeOAuthService(
      barrier.db, context.provider, context.settings, context.access, context.clock.now,
    );
    barrier.enable();
    const requests = [service.denyCallback({ state: input.state }), service.denyCallback({ state: input.state })]
      .map(async (request) => request.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ));
    await barrier.waitForBoth;
    barrier.release();
    const results = await Promise.all(requests);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await env.DB.prepare(
      "SELECT status, failure_code FROM youtube_oauth_attempts",
    ).first()).toEqual({ status: "FAILED", failure_code: "OAUTH_CONSENT_DENIED" });
    expect(await env.DB.prepare(
      `SELECT COUNT(*) count FROM youtube_oauth_audits
       WHERE action = 'oauth.failed' AND reason_code = 'OAUTH_CONSENT_DENIED'`,
    ).first()).toEqual({ count: 1 });
  });

  it("consumes state once under concurrency and exact callback replay has no second exchange", async () => {
    const context = await harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    context.provider.delayExchangeUntil(gate);
    const start = await context.service.start();
    const input = callbackInput(start);
    const first = context.service.callback(input);
    await vi.waitFor(async () => {
      expect(await env.DB.prepare("SELECT status FROM youtube_oauth_attempts").first())
        .toEqual({ status: "CONSUMING" });
    });
    await expect(context.service.callback(input))
      .rejects.toMatchObject({ code: "OAUTH_CALLBACK_IN_PROGRESS", retryable: true });
    release();
    await expect(first).resolves.toMatchObject({ status: "CONNECTED" });
    await expect(context.service.callback(input)).resolves.toMatchObject({ status: "CONNECTED", replayed: true });
    expect(context.provider.operations().filter((operation) => operation === "exchange"))
      .toHaveLength(1);
  });

  it("does not let a losing callback release the winning callback owner lease", async () => {
    const context = await harness();
    const barrier = barrierDatabase(env.DB, "FROM youtube_oauth_attempts WHERE state_hash = ?");
    const service = new E5YoutubeOAuthService(
      barrier.db, context.provider, context.settings, context.access, context.clock.now,
    );
    const start = await service.start();
    const input = callbackInput(start);
    let releaseExchange!: () => void;
    context.provider.delayExchangeUntil(new Promise<void>((resolve) => { releaseExchange = resolve; }));
    barrier.enable();
    const requests = [service.callback(input), service.callback(input)]
      .map(async (request) => request.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ));
    await barrier.waitForBoth;
    barrier.release();
    await vi.waitFor(() => {
      expect(context.provider.operations().filter((operation) => operation === "exchange"))
        .toHaveLength(1);
    });
    expect(await env.DB.prepare(
      "SELECT operation, operation_owner FROM youtube_oauth_control",
    ).first()).toMatchObject({ operation: "CALLBACK", operation_owner: expect.stringMatching(/^callback_/) });
    releaseExchange();
    const results = await Promise.all(requests);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await service.status()).toEqual({ status: "CONNECTED" });
  });

  it("does not let a denied callback fail a code callback that already owns the lease", async () => {
    const context = await harness();
    let release!: () => void;
    context.provider.delayExchangeUntil(new Promise<void>((resolve) => { release = resolve; }));
    const start = await context.service.start();
    const input = callbackInput(start);
    const callback = context.service.callback(input);
    await vi.waitFor(async () => {
      expect(await env.DB.prepare("SELECT status FROM youtube_oauth_attempts").first())
        .toEqual({ status: "CONSUMING" });
    });
    await expect(context.service.denyCallback({ state: input.state }))
      .rejects.toMatchObject({ code: "OAUTH_CALLBACK_IN_PROGRESS" });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE action = 'oauth.failed'",
    ).first()).toEqual({ count: 0 });
    release();
    await expect(callback).resolves.toEqual({ status: "CONNECTED" });
  });

  it("does not let an expired stale reader overwrite a callback that became CONSUMING", async () => {
    const context = await harness();
    const start = await context.service.start();
    let releaseExchange!: () => void;
    context.provider.delayExchangeUntil(new Promise<void>((resolve) => { releaseExchange = resolve; }));
    const barrier = barrierDatabase(env.DB, "FROM youtube_oauth_attempts WHERE state_hash = ?", 1);
    const expiredClock = new MutableClock("2026-08-26T00:10:00.000Z");
    const staleService = new E5YoutubeOAuthService(
      barrier.db, context.provider, context.settings, context.access, expiredClock.now,
    );
    barrier.enable();
    const stale = staleService.callback(callbackInput(start));
    const staleResult = stale.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    await barrier.waitForBoth;
    const winner = context.service.callback(callbackInput(start));
    await vi.waitFor(async () => {
      expect(await env.DB.prepare("SELECT status FROM youtube_oauth_attempts").first())
        .toEqual({ status: "CONSUMING" });
    });
    barrier.release();
    await expect(staleResult).resolves.toMatchObject({ status: "rejected" });
    expect(await env.DB.prepare(
      "SELECT status, failure_code FROM youtube_oauth_attempts",
    ).first()).toEqual({ status: "CONSUMING", failure_code: null });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE reason_code = 'OAUTH_STATE_EXPIRED'",
    ).first()).toEqual({ count: 0 });
    releaseExchange();
    await expect(winner).resolves.toEqual({ status: "CONNECTED" });
  });

  it("keeps exchange timeout or 5xx in manual-recovery ERROR and blocks a new start", async () => {
    const context = await harness();
    const failedStart = await context.service.start();
    const failedInput = callbackInput(failedStart);
    context.provider.failNext("exchange");
    await expect(context.service.callback(failedInput))
      .rejects.toMatchObject({ code: "OAUTH_EXCHANGE_FAILED", retryable: true });
    await expect(context.service.callback(failedInput))
      .rejects.toMatchObject({ code: "OAUTH_STATE_USED" });
    expect(await context.service.status()).toEqual({ status: "ERROR" });
    expect(await env.DB.prepare(
      "SELECT status, pkce_verifier_ciphertext FROM youtube_oauth_attempts",
    ).first()).toEqual({ status: "FAILED", pkce_verifier_ciphertext: "" });
    await expect(context.service.start())
      .rejects.toMatchObject({ code: "OAUTH_MANUAL_RECOVERY_REQUIRED" });
  });

  it("blocks restart when token cleanup fails after channel rejection", async () => {
    const context = await harness();
    context.provider.setChannels([randomChannelId()]);
    context.provider.failNext("revoke");
    const start = await context.service.start();
    await expect(context.service.callback(callbackInput(start)))
      .rejects.toMatchObject({ code: "CHANNEL_MISMATCH" });
    expect(await context.service.status()).toEqual({ status: "ERROR" });
    await expect(context.service.start())
      .rejects.toMatchObject({ code: "OAUTH_MANUAL_RECOVERY_REQUIRED" });
  });

  it("rolls back callback ERROR changes when the required failure audit cannot be inserted", async () => {
    const context = await harness();
    context.provider.setChannels([randomChannelId()]);
    const start = await context.service.start();
    const service = new E5YoutubeOAuthService(
      failAtomicErrorAuditDatabase(env.DB),
      context.provider, context.settings, context.access, context.clock.now,
    );
    await expect(service.callback(callbackInput(start))).rejects.toBeInstanceOf(Error);
    expect(await env.DB.prepare(
      "SELECT operation FROM youtube_oauth_control",
    ).first()).toEqual({ operation: "CALLBACK" });
    expect(await env.DB.prepare(
      "SELECT status FROM youtube_oauth_attempts",
    ).first()).toEqual({ status: "CONSUMING" });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE action = 'oauth.failed'",
    ).first()).toEqual({ count: 0 });
  });

  it("refreshes, rechecks the same channel, replaces ciphertext, and remains ready", async () => {
    const context = await harness();
    await connect(context);
    const before = await env.DB.prepare(
      "SELECT access_token_ciphertext, row_version FROM youtube_oauth_credentials",
    ).first<{ access_token_ciphertext: string; row_version: number }>();
    context.clock.set("2026-08-26T00:30:00.000Z");
    await expect(context.service.refresh()).resolves.toMatchObject({ status: "CONNECTED" });
    const after = await env.DB.prepare(
      "SELECT access_token_ciphertext, row_version FROM youtube_oauth_credentials",
    ).first<{ access_token_ciphertext: string; row_version: number }>();
    expect(after!.access_token_ciphertext).not.toBe(before!.access_token_ciphertext);
    expect(after!.row_version).toBeGreaterThan(before!.row_version);
    expect(context.provider.operations().slice(-2)).toEqual(["refresh", "channels.list.mine"]);
    await expect(context.service.assertReadyForPublishing())
      .resolves.toMatchObject({ status: "CONNECTED" });
  });

  it("does not let a losing refresh release the winning refresh owner lease", async () => {
    const context = await harness();
    await connect(context);
    const barrier = barrierDatabase(env.DB, "FROM youtube_oauth_credentials WHERE credential_id = 1");
    const service = new E5YoutubeOAuthService(
      barrier.db, context.provider, context.settings, context.access, context.clock.now,
    );
    let releaseRefresh!: () => void;
    context.provider.delayRefreshUntil(new Promise<void>((resolve) => { releaseRefresh = resolve; }));
    barrier.enable();
    const requests = [service.refresh(), service.refresh()]
      .map(async (request) => request.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ));
    await barrier.waitForBoth;
    barrier.release();
    await vi.waitFor(() => {
      expect(context.provider.operations().filter((operation) => operation === "refresh"))
        .toHaveLength(1);
    });
    expect(await env.DB.prepare(
      "SELECT operation, operation_owner FROM youtube_oauth_control",
    ).first()).toMatchObject({ operation: "REFRESHING", operation_owner: expect.stringMatching(/^refresh_/) });
    releaseRefresh();
    const results = await Promise.all(requests);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await service.status()).toEqual({ status: "CONNECTED" });
  });

  it("fails closed and removes encrypted credentials when refresh changes channel", async () => {
    const context = await harness();
    await connect(context);
    context.provider.setChannels([randomChannelId()]);
    await expect(context.service.refresh()).rejects.toMatchObject({ code: "CHANNEL_MISMATCH" });
    expect(context.provider.operations()).toContain("revoke");
    expect(await context.service.status()).toEqual({ status: "ERROR" });
    expect(await env.DB.prepare(
      `SELECT status, access_token_ciphertext, refresh_token_ciphertext
       FROM youtube_oauth_credentials`,
    ).first()).toEqual({
      status: "ERROR", access_token_ciphertext: null, refresh_token_ciphertext: null,
    });
    await expect(context.service.assertReadyForPublishing())
      .rejects.toMatchObject({ code: "YOUTUBE_OAUTH_NOT_READY" });
  });

  it("fails closed after an ambiguous transient refresh failure and requires manual recovery", async () => {
    const context = await harness();
    await connect(context);
    context.provider.failNext("refresh");
    await expect(context.service.refresh())
      .rejects.toMatchObject({ code: "OAUTH_REFRESH_FAILED", retryable: true });
    expect(await context.service.status()).toMatchObject({ status: "ERROR" });
    await expect(context.service.start())
      .rejects.toMatchObject({ code: "OAUTH_MANUAL_RECOVERY_REQUIRED" });
  });

  it("rolls back refresh ERROR changes when the required failure audit cannot be inserted", async () => {
    const context = await harness();
    await connect(context);
    context.provider.failNext("refresh");
    const service = new E5YoutubeOAuthService(
      failAtomicErrorAuditDatabase(env.DB),
      context.provider, context.settings, context.access, context.clock.now,
    );
    await expect(service.refresh()).rejects.toBeInstanceOf(Error);
    expect(await env.DB.prepare(
      "SELECT operation FROM youtube_oauth_control",
    ).first()).toEqual({ operation: "REFRESHING" });
    expect(await env.DB.prepare(
      "SELECT status FROM youtube_oauth_credentials",
    ).first()).toEqual({ status: "REFRESHING" });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE action = 'oauth.refresh_failed'",
    ).first()).toEqual({ count: 0 });
  });

  it("blocks readiness after expiry until refresh revalidates the expected channel", async () => {
    const context = await harness();
    await connect(context);
    context.clock.set("2026-08-26T01:00:00.000Z");
    expect(await context.service.status()).toMatchObject({ status: "REFRESH_REQUIRED" });
    await expect(context.service.assertReadyForPublishing())
      .rejects.toMatchObject({ code: "YOUTUBE_OAUTH_NOT_READY" });
    await expect(context.service.refresh()).resolves.toMatchObject({ status: "CONNECTED" });
  });

  it("revokes idempotently, clears ciphertext, and prevents any later publishing readiness", async () => {
    const context = await harness();
    await connect(context);
    await expect(context.service.revoke()).resolves.toEqual({ status: "REVOKED" });
    const revokeCalls = context.provider.operations().filter((operation) => operation === "revoke").length;
    const generationAfterFirst = await env.DB.prepare(
      "SELECT generation FROM youtube_oauth_control",
    ).first();
    const auditCountAfterFirst = await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE action = 'oauth.revoked'",
    ).first();
    await expect(context.service.revoke()).resolves.toEqual({ status: "REVOKED" });
    expect(context.provider.operations().filter((operation) => operation === "revoke"))
      .toHaveLength(revokeCalls);
    expect(await env.DB.prepare("SELECT generation FROM youtube_oauth_control").first())
      .toEqual(generationAfterFirst);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE action = 'oauth.revoked'",
    ).first()).toEqual(auditCountAfterFirst);
    expect(await env.DB.prepare(
      `SELECT status, access_token_ciphertext, refresh_token_ciphertext
       FROM youtube_oauth_credentials`,
    ).first()).toEqual({
      status: "REVOKED", access_token_ciphertext: null, refresh_token_ciphertext: null,
    });
    await expect(context.service.assertReadyForPublishing())
      .rejects.toMatchObject({ code: "YOUTUBE_OAUTH_NOT_READY" });
  });

  it("revokes a pending reconnect after a previously revoked credential and rejects its late callback", async () => {
    const context = await harness();
    await connect(context);
    await context.service.revoke();
    const reconnect = await context.service.start();
    const reconnectInput = callbackInput(reconnect);
    const exchangeCount = context.provider.operations()
      .filter((operation) => operation === "exchange").length;

    await expect(context.service.revoke()).resolves.toEqual({ status: "REVOKED" });
    expect(await env.DB.prepare(
      "SELECT status, failure_code, pkce_verifier_ciphertext FROM youtube_oauth_attempts ORDER BY generation DESC LIMIT 1",
    ).first()).toEqual({
      status: "EXPIRED",
      failure_code: "OAUTH_REVOKED",
      pkce_verifier_ciphertext: "",
    });
    await expect(context.service.callback(reconnectInput))
      .rejects.toMatchObject({ code: "OAUTH_STATE_USED" });
    expect(context.provider.operations().filter((operation) => operation === "exchange"))
      .toHaveLength(exchangeCount);
    expect(await context.service.status()).toEqual({ status: "REVOKED" });

    const generationAfterCancellation = await env.DB.prepare(
      "SELECT generation FROM youtube_oauth_control",
    ).first();
    const auditCountAfterCancellation = await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE action = 'oauth.revoked'",
    ).first();
    await expect(context.service.revoke()).resolves.toEqual({ status: "REVOKED" });
    expect(await env.DB.prepare("SELECT generation FROM youtube_oauth_control").first())
      .toEqual(generationAfterCancellation);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE action = 'oauth.revoked'",
    ).first()).toEqual(auditCountAfterCancellation);
  });

  it("does not report a stale revoked success when start wins the same-generation race", async () => {
    const context = await harness();
    await connect(context);
    await context.service.revoke();
    const barrier = barrierDatabase(
      env.DB,
      "FROM youtube_oauth_credentials WHERE credential_id = 1",
      1,
    );
    const revokingService = new E5YoutubeOAuthService(
      barrier.db, context.provider, context.settings, context.access, context.clock.now,
    );

    barrier.enable();
    const revocation = revokingService.revoke();
    await barrier.waitForBoth;
    await expect(context.service.start()).resolves.toMatchObject({ status: "PENDING" });
    barrier.release();

    await expect(revocation)
      .rejects.toMatchObject({ code: "OAUTH_OPERATION_IN_PROGRESS", retryable: true });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_attempts WHERE status = 'PENDING'",
    ).first()).toEqual({ count: 1 });
  });

  it("does not report revoked when a pending reconnect becomes connected after revoke reads stale state", async () => {
    const context = await harness();
    await connect(context);
    await context.service.revoke();
    const reconnect = await context.service.start();
    const reconnectInput = callbackInput(reconnect);
    const barrier = barrierDatabase(
      env.DB,
      "FROM youtube_oauth_credentials WHERE credential_id = 1",
      1,
    );
    const revokingService = new E5YoutubeOAuthService(
      barrier.db, context.provider, context.settings, context.access, context.clock.now,
    );

    barrier.enable();
    const revocation = revokingService.revoke();
    await barrier.waitForBoth;
    await expect(context.service.callback(reconnectInput))
      .resolves.toEqual({ status: "CONNECTED" });
    barrier.release();

    await expect(revocation)
      .rejects.toMatchObject({ code: "OAUTH_OPERATION_IN_PROGRESS", retryable: true });
    expect(await env.DB.prepare(
      "SELECT status FROM youtube_oauth_credentials",
    ).first()).toEqual({ status: "CONNECTED" });
    expect(await context.service.status()).toEqual({ status: "CONNECTED" });
  });

  it("does not let a losing revoke release the winning revoke owner lease", async () => {
    const context = await harness();
    await connect(context);
    const barrier = barrierDatabase(env.DB, "FROM youtube_oauth_credentials WHERE credential_id = 1");
    const service = new E5YoutubeOAuthService(
      barrier.db, context.provider, context.settings, context.access, context.clock.now,
    );
    let releaseRevoke!: () => void;
    context.provider.delayRevokeUntil(new Promise<void>((resolve) => { releaseRevoke = resolve; }));
    barrier.enable();
    const requests = [service.revoke(), service.revoke()]
      .map(async (request) => request.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ));
    await barrier.waitForBoth;
    barrier.release();
    await vi.waitFor(() => {
      expect(context.provider.operations().filter((operation) => operation === "revoke"))
        .toHaveLength(1);
    });
    expect(await env.DB.prepare(
      "SELECT operation, operation_owner FROM youtube_oauth_control",
    ).first()).toMatchObject({ operation: "REVOKING", operation_owner: expect.stringMatching(/^revoke_/) });
    releaseRevoke();
    const results = await Promise.all(requests);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await service.status()).toEqual({ status: "REVOKED" });
  });

  it("does not persist REVOKED without its required success audit", async () => {
    const context = await harness();
    await connect(context);
    const service = new E5YoutubeOAuthService(
      failAuditInsertDatabase(env.DB, "oauth.revoked"),
      context.provider, context.settings, context.access, context.clock.now,
    );
    await expect(service.revoke())
      .rejects.toMatchObject({ code: "OAUTH_REVOKE_PERSIST_FAILED" });
    expect(await context.service.status()).toEqual({ status: "ERROR" });
    expect(await env.DB.prepare(
      "SELECT status FROM youtube_oauth_credentials",
    ).first()).toEqual({ status: "ERROR" });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE action = 'oauth.revoked'",
    ).first()).toEqual({ count: 0 });
  });

  it("rolls back revoke ERROR changes when the required failure audit cannot be inserted", async () => {
    const context = await harness();
    await connect(context);
    context.provider.failNext("revoke");
    const service = new E5YoutubeOAuthService(
      failAtomicErrorAuditDatabase(env.DB),
      context.provider, context.settings, context.access, context.clock.now,
    );
    await expect(service.revoke()).rejects.toBeInstanceOf(Error);
    expect(await env.DB.prepare(
      "SELECT operation FROM youtube_oauth_control",
    ).first()).toEqual({ operation: "REVOKING" });
    expect(await env.DB.prepare(
      "SELECT status FROM youtube_oauth_credentials",
    ).first()).toEqual({ status: "REVOKING" });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE action = 'oauth.revoke_failed'",
    ).first()).toEqual({ count: 0 });
  });

  it("fails closed after an ambiguous transient revoke failure", async () => {
    const context = await harness();
    await connect(context);
    context.provider.failNext("revoke");
    await expect(context.service.revoke())
      .rejects.toMatchObject({ code: "OAUTH_REVOKE_FAILED", retryable: true });
    expect(await context.service.status()).toMatchObject({ status: "ERROR" });
    await expect(context.service.revoke())
      .rejects.toMatchObject({ code: "OAUTH_MANUAL_RECOVERY_REQUIRED" });
  });

  it("treats a non-retryable remote revoke rejection as terminal", async () => {
    const context = await harness();
    await connect(context);
    context.provider.failNextWith("revoke", new YoutubeOAuthError("OAUTH_REVOKE_REJECTED"));
    await expect(context.service.revoke())
      .rejects.toMatchObject({ code: "OAUTH_REVOKE_REJECTED", retryable: false });
    expect(await context.service.status()).toEqual({ status: "ERROR" });
  });

  it("supersedes an older start and accepts only the newest generation", async () => {
    const context = await harness();
    const older = await context.service.start();
    const newer = await context.service.start();
    await expect(context.service.callback(callbackInput(older)))
      .rejects.toMatchObject({ code: "OAUTH_STATE_USED" });
    await expect(context.service.callback(callbackInput(newer)))
      .resolves.toEqual({ status: "CONNECTED" });
    expect(context.provider.operations().filter((operation) => operation === "exchange"))
      .toHaveLength(1);
  });

  it("makes an in-flight credentialless callback ambiguous when revoke cannot track its token", async () => {
    const context = await harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    context.provider.delayExchangeUntil(gate);
    const start = await context.service.start();
    const callback = context.service.callback(callbackInput(start));
    await vi.waitFor(async () => {
      expect(await env.DB.prepare("SELECT operation FROM youtube_oauth_control").first())
        .toEqual({ operation: "CALLBACK" });
    });
    await expect(context.service.revoke())
      .rejects.toMatchObject({ code: "OAUTH_MANUAL_RECOVERY_REQUIRED" });
    release();
    await expect(callback).rejects.toBeInstanceOf(YoutubeOAuthError);
    expect(await context.service.status()).toEqual({ status: "ERROR" });
    await expect(context.service.revoke())
      .rejects.toMatchObject({ code: "OAUTH_MANUAL_RECOVERY_REQUIRED" });
    expect(await env.DB.prepare(
      `SELECT COUNT(*) count FROM youtube_oauth_audits
       WHERE action IN ('oauth.connected', 'oauth.revoked')`,
    ).first()).toEqual({ count: 0 });
    expect(context.provider.operations()).toContain("revoke");
  });

  it("does not permit a second consent while already connected", async () => {
    const context = await harness();
    await connect(context);
    await expect(context.service.start()).rejects.toMatchObject({ code: "OAUTH_ALREADY_CONNECTED" });
  });

  it("treats invalid_grant as terminal and removes stored ciphertext", async () => {
    const context = await harness();
    await connect(context);
    context.provider.failNextWith("refresh", new YoutubeOAuthError("OAUTH_GRANT_INVALID"));
    await expect(context.service.refresh()).rejects.toMatchObject({ code: "OAUTH_GRANT_INVALID" });
    expect(await context.service.status()).toEqual({ status: "ERROR" });
    expect(await env.DB.prepare(
      "SELECT access_token_ciphertext, refresh_token_ciphertext FROM youtube_oauth_credentials",
    ).first()).toEqual({ access_token_ciphertext: null, refresh_token_ciphertext: null });
    await env.DB.prepare(
      `UPDATE youtube_oauth_control SET operation = 'READY', operation_owner = NULL,
         operation_expires_at = NULL`,
    ).run();
    await expect(context.service.refresh())
      .rejects.toMatchObject({ code: "OAUTH_MANUAL_RECOVERY_REQUIRED" });
    await expect(context.service.revoke())
      .rejects.toMatchObject({ code: "OAUTH_MANUAL_RECOVERY_REQUIRED" });
  });

  it("fails closed when provider refresh succeeds but the generation changes before D1 commit", async () => {
    const context = await harness();
    await connect(context);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    context.provider.delayRefreshUntil(gate);
    const refresh = context.service.refresh();
    await vi.waitFor(async () => {
      expect(await env.DB.prepare("SELECT operation FROM youtube_oauth_control").first())
        .toEqual({ operation: "REFRESHING" });
    });
    await env.DB.prepare(
      `UPDATE youtube_oauth_control SET generation = generation + 1, operation = 'ERROR',
         operation_owner = NULL, operation_expires_at = NULL`,
    ).run();
    release();
    await expect(refresh).rejects.toMatchObject({ code: "OAUTH_REFRESH_COMMIT_AMBIGUOUS" });
    expect(await context.service.status()).toEqual({ status: "ERROR" });
    expect(context.provider.operations()).not.toContain("revoke");
    expect(context.provider.activeGrantCount()).toBe(1);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE action = 'oauth.refreshed'",
    ).first()).toEqual({ count: 0 });
  });

  it("returns the known callback result without a fallible post-commit status read", async () => {
    const context = await harness();
    const injected = failNthStatusReadDatabase(env.DB, 2);
    const service = new E5YoutubeOAuthService(
      injected.db,
      context.provider,
      context.settings,
      context.access,
      context.clock.now,
    );
    const start = await service.start();
    await expect(service.callback(callbackInput(start))).resolves.toEqual({ status: "CONNECTED" });
    expect(injected.statusReads()).toBe(1);
    expect(await env.DB.prepare(
      `SELECT status, access_token_ciphertext IS NOT NULL access_saved,
              refresh_token_ciphertext IS NOT NULL refresh_saved, last_error_code
       FROM youtube_oauth_credentials`,
    ).first()).toEqual({
      status: "CONNECTED", access_saved: 1, refresh_saved: 1, last_error_code: null,
    });
    expect(await env.DB.prepare(
      "SELECT status, failure_code FROM youtube_oauth_attempts",
    ).first()).toEqual({ status: "COMPLETED", failure_code: null });
    expect(await env.DB.prepare(
      "SELECT generation, operation FROM youtube_oauth_control",
    ).first()).toEqual({ generation: 1, operation: "READY" });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE action = 'oauth.connected'",
    ).first()).toEqual({ count: 1 });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE action = 'oauth.failed'",
    ).first()).toEqual({ count: 0 });
    expect(context.provider.operations()).not.toContain("revoke");
  });

  it("still fails closed when the callback credential confirmation is indeterminate", async () => {
    const context = await harness();
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            if (sql.includes("SELECT status, generation FROM youtube_oauth_credentials")) {
              throw new Error("LOCAL_POST_COMMIT_READ_FAILURE");
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = new E5YoutubeOAuthService(
      db,
      context.provider,
      context.settings,
      context.access,
      context.clock.now,
    );
    const start = await service.start();
    await expect(service.callback(callbackInput(start)))
      .rejects.toMatchObject({ code: "OAUTH_EXCHANGE_FAILED" });
    expect(await env.DB.prepare(
      "SELECT status, access_token_ciphertext, refresh_token_ciphertext FROM youtube_oauth_credentials",
    ).first()).toEqual({
      status: "ERROR", access_token_ciphertext: null, refresh_token_ciphertext: null,
    });
    expect(context.provider.operations()).toContain("revoke");
    expect(context.provider.activeGrantCount()).toBe(0);
  });

  it("does not revoke the shared grant or overwrite a newer refresh after callback response loss", async () => {
    const context = await harness();
    const service = new E5YoutubeOAuthService(
      loseBatchResponseAfterCommit(env.DB, "'oauth.connected'", async () => {
        await context.service.refresh();
      }),
      context.provider,
      context.settings,
      context.access,
      context.clock.now,
    );
    const start = await service.start();

    await expect(service.callback(callbackInput(start)))
      .rejects.toMatchObject({ code: "OAUTH_EXCHANGE_FAILED" });
    expect(await context.service.status()).toEqual({ status: "CONNECTED" });
    expect(context.provider.activeGrantCount()).toBe(1);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE action = 'oauth.failed'",
    ).first()).toEqual({ count: 0 });
    await expect(context.service.refresh()).resolves.toEqual({ status: "CONNECTED" });
  });

  it("does not overwrite a completed readiness check after callback response loss", async () => {
    const context = await harness();
    const service = new E5YoutubeOAuthService(
      loseBatchResponseAfterCommit(env.DB, "'oauth.connected'", async () => {
        await expect(context.service.assertReadyForPublishing())
          .resolves.toEqual({ status: "CONNECTED" });
      }),
      context.provider,
      context.settings,
      context.access,
      context.clock.now,
    );
    const start = await service.start();

    await expect(service.callback(callbackInput(start)))
      .rejects.toMatchObject({ code: "OAUTH_EXCHANGE_FAILED" });
    expect(await context.service.status()).toEqual({ status: "CONNECTED" });
    expect(context.provider.activeGrantCount()).toBe(1);
  });

  it("does not overwrite a replacement callback after callback response loss", async () => {
    const context = await harness();
    const service = new E5YoutubeOAuthService(
      loseBatchResponseAfterCommit(env.DB, "'oauth.connected'", async () => {
        await context.service.revoke();
        const replacement = await context.service.start();
        await context.service.callback(callbackInput(replacement));
      }),
      context.provider,
      context.settings,
      context.access,
      context.clock.now,
    );
    const start = await service.start();

    await expect(service.callback(callbackInput(start)))
      .rejects.toMatchObject({ code: "OAUTH_EXCHANGE_FAILED" });
    expect(await context.service.status()).toEqual({ status: "CONNECTED" });
    expect(context.provider.activeGrantCount()).toBe(1);
    expect(context.provider.operations().filter((operation) => operation === "revoke"))
      .toHaveLength(1);
    await expect(context.service.refresh()).resolves.toEqual({ status: "CONNECTED" });
  });

  it("returns the known refresh result without a fallible post-commit status read", async () => {
    const context = await harness();
    await connect(context);
    const before = await env.DB.prepare(
      "SELECT row_version FROM youtube_oauth_credentials",
    ).first<{ row_version: number }>();
    const revokeCalls = context.provider.operations().filter((operation) => operation === "revoke").length;
    const injected = failNthStatusReadDatabase(env.DB, 2);
    const service = new E5YoutubeOAuthService(
      injected.db,
      context.provider,
      context.settings,
      context.access,
      context.clock.now,
    );

    await expect(service.refresh()).resolves.toEqual({ status: "CONNECTED" });
    expect(injected.statusReads()).toBe(1);
    expect(await env.DB.prepare(
      `SELECT status, access_token_ciphertext IS NOT NULL access_saved,
              refresh_token_ciphertext IS NOT NULL refresh_saved, last_error_code, row_version
       FROM youtube_oauth_credentials`,
    ).first()).toEqual({
      status: "CONNECTED", access_saved: 1, refresh_saved: 1,
      last_error_code: null, row_version: before!.row_version + 2,
    });
    expect(await env.DB.prepare(
      "SELECT generation, operation FROM youtube_oauth_control",
    ).first()).toEqual({ generation: 1, operation: "READY" });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE action = 'oauth.refreshed'",
    ).first()).toEqual({ count: 1 });
    expect(await env.DB.prepare(
      `SELECT COUNT(*) count FROM youtube_oauth_audits
       WHERE action IN ('oauth.failed', 'oauth.refresh_failed')`,
    ).first()).toEqual({ count: 0 });
    expect(context.provider.operations().filter((operation) => operation === "revoke"))
      .toHaveLength(revokeCalls);
  });

  it("fails closed when the refresh D1 commit succeeds but its response is lost", async () => {
    const context = await harness();
    await connect(context);
    const service = new E5YoutubeOAuthService(
      loseBatchResponseAfterCommit(env.DB, "'oauth.refreshed'"),
      context.provider,
      context.settings,
      context.access,
      context.clock.now,
    );

    await expect(service.refresh()).rejects.toMatchObject({ code: "OAUTH_REFRESH_FAILED" });
    expect(await context.service.status()).toEqual({ status: "ERROR" });
    expect(await env.DB.prepare(
      `SELECT status, access_token_ciphertext, refresh_token_ciphertext, last_error_code
       FROM youtube_oauth_credentials`,
    ).first()).toEqual({
      status: "ERROR",
      access_token_ciphertext: null,
      refresh_token_ciphertext: null,
      last_error_code: "OAUTH_REFRESH_COMMIT_AMBIGUOUS",
    });
    expect(await env.DB.prepare(
      `SELECT action, COUNT(*) count FROM youtube_oauth_audits
       WHERE action IN ('oauth.refreshed', 'oauth.refresh_failed') GROUP BY action ORDER BY action`,
    ).all()).toMatchObject({
      results: [
        { action: "oauth.refresh_failed", count: 1 },
        { action: "oauth.refreshed", count: 1 },
      ],
    });
    expect(context.provider.activeGrantCount()).toBe(0);
    await expect(context.service.assertReadyForPublishing())
      .rejects.toMatchObject({ code: "YOUTUBE_OAUTH_NOT_READY" });
  });

  it("does not overwrite a revoke that completes after a refresh commit response is lost", async () => {
    const context = await harness();
    await connect(context);
    const service = new E5YoutubeOAuthService(
      loseBatchResponseAfterCommit(env.DB, "'oauth.refreshed'", async () => {
        await context.service.revoke();
      }),
      context.provider,
      context.settings,
      context.access,
      context.clock.now,
    );

    await expect(service.refresh()).rejects.toMatchObject({ code: "OAUTH_REFRESH_FAILED" });
    expect(await context.service.status()).toEqual({ status: "REVOKED" });
    expect(await env.DB.prepare(
      `SELECT status, access_token_ciphertext, refresh_token_ciphertext, last_error_code
       FROM youtube_oauth_credentials`,
    ).first()).toEqual({
      status: "REVOKED",
      access_token_ciphertext: null,
      refresh_token_ciphertext: null,
      last_error_code: null,
    });
    expect(await env.DB.prepare(
      "SELECT operation FROM youtube_oauth_control",
    ).first()).toEqual({ operation: "READY" });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE action = 'oauth.refresh_failed'",
    ).first()).toEqual({ count: 0 });
    expect(context.provider.operations().filter((operation) => operation === "revoke"))
      .toHaveLength(1);
    expect(context.provider.activeGrantCount()).toBe(0);
  });

  it("does not revoke the shared grant after a newer refresh completes", async () => {
    const context = await harness();
    await connect(context);
    const service = new E5YoutubeOAuthService(
      loseBatchResponseAfterCommit(env.DB, "'oauth.refreshed'", async () => {
        await context.service.refresh();
      }),
      context.provider,
      context.settings,
      context.access,
      context.clock.now,
    );

    await expect(service.refresh()).rejects.toMatchObject({ code: "OAUTH_REFRESH_FAILED" });
    expect(await context.service.status()).toEqual({ status: "CONNECTED" });
    expect(context.provider.activeGrantCount()).toBe(1);
    await expect(context.service.refresh()).resolves.toEqual({ status: "CONNECTED" });
  });

  it("rejects current-setting drift, corrupted ciphertext, and live channel drift at readiness", async () => {
    const configDrift = await harness();
    await connect(configDrift);
    configDrift.settings.expectedChannelId = randomChannelId();
    await expect(configDrift.service.assertReadyForPublishing())
      .rejects.toMatchObject({ code: "YOUTUBE_OAUTH_NOT_READY" });

    await clearDatabase();
    const ciphertext = await harness();
    await connect(ciphertext);
    await env.DB.prepare(
      "UPDATE youtube_oauth_credentials SET access_token_ciphertext = 'v1.invalid.invalid'",
    ).run();
    await expect(ciphertext.service.assertReadyForPublishing())
      .rejects.toMatchObject({ code: "YOUTUBE_OAUTH_NOT_READY" });

    await clearDatabase();
    const liveDrift = await harness();
    await connect(liveDrift);
    liveDrift.provider.setChannels([randomChannelId()]);
    await expect(liveDrift.service.assertReadyForPublishing())
      .rejects.toMatchObject({ code: "YOUTUBE_OAUTH_NOT_READY" });
  });

  it("recovers an expired operation lease to an ambiguous ERROR without restoring CONNECTED", async () => {
    const context = await harness();
    await connect(context);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE youtube_oauth_control SET operation = 'REFRESHING', operation_owner = ?, operation_expires_at = ?",
      ).bind(`refresh_${crypto.randomUUID()}`, "2026-08-25T23:59:00.000Z"),
      env.DB.prepare(
        "UPDATE youtube_oauth_credentials SET status = 'REFRESHING', operation_expires_at = ?",
      ).bind("2026-08-25T23:59:00.000Z"),
    ]);
    expect(await context.service.status()).toEqual({ status: "ERROR" });
  });

  it("rolls back expired-operation recovery when its required audit cannot be inserted", async () => {
    const context = await harness();
    await connect(context);
    const owner = `refresh_${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE youtube_oauth_control SET operation = 'REFRESHING', operation_owner = ?,
           operation_expires_at = ?`,
      ).bind(owner, "2026-08-25T23:59:00.000Z"),
      env.DB.prepare(
        "UPDATE youtube_oauth_credentials SET status = 'REFRESHING', operation_expires_at = ?",
      ).bind("2026-08-25T23:59:00.000Z"),
    ]);
    const service = new E5YoutubeOAuthService(
      failAtomicErrorAuditDatabase(env.DB, true),
      context.provider, context.settings, context.access, context.clock.now,
    );
    await expect(service.status()).rejects.toBeInstanceOf(Error);
    expect(await env.DB.prepare(
      "SELECT operation, operation_owner FROM youtube_oauth_control",
    ).first()).toEqual({ operation: "REFRESHING", operation_owner: owner });
    expect(await env.DB.prepare(
      "SELECT status FROM youtube_oauth_credentials",
    ).first()).toEqual({ status: "REFRESHING" });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE reason_code = 'OAUTH_OPERATION_AMBIGUOUS'",
    ).first()).toEqual({ count: 0 });
  });

  it("does not let stale lease recovery damage a newer operation owner", async () => {
    const context = await harness();
    await connect(context);
    const staleOwner = `refresh_${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE youtube_oauth_control SET operation = 'REFRESHING', operation_owner = ?,
           operation_expires_at = ?`,
      ).bind(staleOwner, "2026-08-25T23:59:00.000Z"),
      env.DB.prepare(
        "UPDATE youtube_oauth_credentials SET status = 'REFRESHING', operation_expires_at = ?",
      ).bind("2026-08-25T23:59:00.000Z"),
    ]);
    const barrier = barrierDatabase(env.DB, "SELECT generation, operation, operation_owner", 1);
    const service = new E5YoutubeOAuthService(
      barrier.db, context.provider, context.settings, context.access, context.clock.now,
    );
    barrier.enable();
    const status = service.status();
    await barrier.waitForBoth;
    const newerOwner = `refresh_${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE youtube_oauth_control SET operation_owner = ?, operation_expires_at = ?
         WHERE operation = 'REFRESHING' AND operation_owner = ?`,
      ).bind(newerOwner, "2026-08-26T00:01:00.000Z", staleOwner),
      env.DB.prepare(
        "UPDATE youtube_oauth_credentials SET operation_expires_at = ? WHERE status = 'REFRESHING'",
      ).bind("2026-08-26T00:01:00.000Z"),
    ]);
    barrier.release();
    await expect(status).resolves.toEqual({ status: "PENDING" });
    expect(await env.DB.prepare(
      "SELECT operation, operation_owner FROM youtube_oauth_control",
    ).first()).toEqual({ operation: "REFRESHING", operation_owner: newerOwner });
    expect(await env.DB.prepare(
      "SELECT status FROM youtube_oauth_credentials",
    ).first()).toEqual({ status: "REFRESHING" });
  });

  it("does not leave REVOKING when encrypted credentials cannot be authenticated", async () => {
    const context = await harness();
    await connect(context);
    await env.DB.prepare(
      "UPDATE youtube_oauth_credentials SET refresh_token_ciphertext = 'v1.invalid.invalid'",
    ).run();
    await expect(context.service.revoke()).rejects.toMatchObject({ code: "CIPHERTEXT_INVALID" });
    expect(await context.service.status()).toEqual({ status: "ERROR" });
  });

  it("does not return ready when revoke wins during live readiness verification", async () => {
    const context = await harness();
    await connect(context);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    context.provider.delayChannelLookupUntil(gate);
    const readiness = context.service.assertReadyForPublishing();
    await vi.waitFor(async () => {
      expect(await env.DB.prepare("SELECT operation FROM youtube_oauth_control").first())
        .toEqual({ operation: "VERIFYING" });
    });
    await expect(context.service.revoke()).resolves.toEqual({ status: "REVOKED" });
    release();
    await expect(readiness).rejects.toMatchObject({ code: "YOUTUBE_OAUTH_NOT_READY" });
    expect(await context.service.status()).toEqual({ status: "REVOKED" });
  });

  it("turns an expired callback lease into persistent ambiguous ERROR and erases PKCE", async () => {
    const context = await harness();
    await context.service.start();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE youtube_oauth_attempts SET status = 'CONSUMING', consumed_at = ?, updated_at = ?
         WHERE status = 'PENDING'`,
      ).bind("2026-08-25T23:58:00.000Z", "2026-08-25T23:58:00.000Z"),
      env.DB.prepare(
        `UPDATE youtube_oauth_control SET operation = 'CALLBACK', operation_owner = ?,
           operation_expires_at = ?, updated_at = ?`,
      ).bind(`callback_${crypto.randomUUID()}`, "2026-08-25T23:59:00.000Z", "2026-08-25T23:58:00.000Z"),
    ]);
    expect(await context.service.status()).toEqual({ status: "ERROR" });
    expect(await env.DB.prepare(
      "SELECT status, failure_code, pkce_verifier_ciphertext FROM youtube_oauth_attempts",
    ).first()).toEqual({
      status: "FAILED",
      failure_code: "OAUTH_OPERATION_AMBIGUOUS",
      pkce_verifier_ciphertext: "",
    });
    expect(await env.DB.prepare("SELECT operation FROM youtube_oauth_control").first())
      .toEqual({ operation: "ERROR" });
    await expect(context.service.start())
      .rejects.toMatchObject({ code: "OAUTH_MANUAL_RECOVERY_REQUIRED" });
  });

  it("does not persist or log state, code, token, channel ID, or any upload operation", async () => {
    const context = await harness();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const start = await context.service.start();
    const input = callbackInput(start);
    const status = await context.service.callback(input);
    const dump = JSON.stringify({
      attempts: (await env.DB.prepare("SELECT * FROM youtube_oauth_attempts").all()).results,
      credentials: (await env.DB.prepare("SELECT * FROM youtube_oauth_credentials").all()).results,
      audits: (await env.DB.prepare("SELECT * FROM youtube_oauth_audits").all()).results,
      status,
    });
    expect(dump).not.toContain(input.state);
    expect(dump).not.toContain(input.authorizationCode);
    expect(dump).not.toContain(context.expectedChannelId);
    expect(dump).not.toContain(ACCESS_EMAIL);
    for (const secret of context.provider.issuedSecretValues()) expect(dump).not.toContain(secret);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(context.provider.operations()).toEqual([
      "authorization", "exchange", "channels.list.mine",
    ]);
    expect(context.provider.operations().some((operation) =>
      operation.includes("upload") || operation.includes("insert") || operation.includes("resumable"),
    )).toBe(false);
  });
});
