import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareAccessVerifier } from "../src/cloudflare-access";
import { classifyOAuthCallbackFailureForLog, handleE5YoutubeOAuthHttp } from "../src/e5-oauth-http";
import { YoutubeOAuthError } from "../src/e5-youtube-oauth";
import { GoogleYoutubeOAuthProvider } from "../src/google-youtube-oauth-provider";

const TEAM_DOMAIN = "local-team.cloudflareaccess.com";
const AUDIENCE = "local_audience_1234567890";
const EMAIL = "operator@local.invalid";
const EXPECTED_CHANNEL = "UC0000000000000000000000";
const NOW_SECONDS = Math.floor(Date.now() / 1_000);
let signingKey: CryptoKey;
let publicJwk: JsonWebKey;
let infoLogCalls: unknown[][] = [];
let warnLogCalls: unknown[][] = [];

const OAUTH_LOG_STAGES = ["REQUEST_GATE", "CALLBACK", "STATUS"] as const;
const OAUTH_LOG_OUTCOMES = ["STARTED", "SUCCEEDED", "REJECTED", "REPLAYED", "RETRYING", "UNAVAILABLE"] as const;
const OAUTH_LOG_REASONS = [
  "CONFIG_INVALID", "REDIRECT_INVALID", "ACCESS_REJECTED", "SERVICE_INIT_FAILED",
  "TOKEN_MISSING", "JWT_INVALID", "CLAIMS_INVALID", "SIGNATURE_INVALID", "JWKS_TIMEOUT",
  "JWKS_FETCH_FAILED", "JWKS_HTTP_REJECTED", "JWKS_INVALID", "JWK_NOT_FOUND",
  "JWK_IMPORT_FAILED", "ALLOWLIST_DENIED", "ACCESS_CONFIG_INVALID", "ORIGIN_REJECTED",
  "CSRF_COOKIE_MISSING_OR_INVALID", "FORM_CONTENT_TYPE_REJECTED", "FORM_BODY_REJECTED",
  "CSRF_TOKEN_MISSING_OR_INVALID", "CSRF_TOKEN_MISMATCH", "CODE_RECEIVED",
  "CONSENT_DENIAL_RECEIVED", "CONNECTED", "CONSENT_DENIED", "STATE_REJECTED",
  "STATE_ALREADY_USED", "OPERATION_IN_PROGRESS", "TOKEN_EXCHANGE_REJECTED", "SCOPE_REJECTED",
  "CHANNEL_REJECTED", "PERSISTENCE_REJECTED", "UNEXPECTED_FAILURE", "READ_FAILED",
  "CURRENT_NOT_CONNECTED", "CURRENT_PENDING", "CURRENT_CONNECTED", "CURRENT_REFRESH_REQUIRED",
  "CURRENT_REVOKED", "CURRENT_ERROR",
] as const;

function oauthLogRecords(): Array<Record<string, unknown>> {
  return [...infoLogCalls, ...warnLogCalls]
    .map(([record]) => record as Record<string, unknown>);
}

function clearOAuthLogs(): void {
  infoLogCalls = [];
  warnLogCalls = [];
}

function expectFixedOAuthLogs(records: Array<Record<string, unknown>>): void {
  for (const record of records) {
    expect(Object.keys(record).sort()).toEqual(["event", "outcome", "reason", "stage"]);
    expect(record.event).toBe("YOUTUBE_OAUTH_HTTP");
    expect(OAUTH_LOG_STAGES).toContain(record.stage);
    expect(OAUTH_LOG_OUTCOMES).toContain(record.outcome);
    expect(OAUTH_LOG_REASONS).toContain(record.reason);
  }
}

function base64Url(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function jwt(overrides: Record<string, unknown> = {}, kid = "local-kid"): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const payload = base64Url(JSON.stringify({
    iss: `https://${TEAM_DOMAIN}`,
    aud: AUDIENCE,
    exp: NOW_SECONDS + 600,
    nbf: NOW_SECONDS - 10,
    email: EMAIL,
    sub: "local-subject",
    ...overrides,
  }));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

function jwksResponse(): Response {
  return Response.json({ keys: [{ ...publicJwk, kid: "local-kid", alg: "RS256", use: "sig" }] });
}

function accessRequest(token: string): Request {
  return new Request("https://app.invalid/__ops/e5/youtube-oauth/status", {
    headers: { "cf-access-jwt-assertion": token },
  });
}

function randomEncryptionKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function routeEnv(): Env {
  return {
    DB: env.DB,
    VIDEO_JOBS_QUEUE: env.VIDEO_JOBS_QUEUE,
    DLQ_QUEUE_NAME: "local-dlq",
    RETENTION_DAYS: "30",
    OPERATOR_IDS: "local-operator",
    TEST_MIGRATIONS: env.TEST_MIGRATIONS,
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    CLOUDFLARE_ACCESS_AUD: AUDIENCE,
    YOUTUBE_OAUTH_ALLOWED_EMAILS: EMAIL,
    YOUTUBE_OAUTH_CLIENT_ID: "local-client-id",
    YOUTUBE_OAUTH_CLIENT_SECRET: `secret_${crypto.randomUUID()}`,
    YOUTUBE_OAUTH_ENCRYPTION_KEY: randomEncryptionKey(),
    YOUTUBE_EXPECTED_CHANNEL_ID: EXPECTED_CHANNEL,
    YOUTUBE_OAUTH_REDIRECT_URI: "https://app.invalid/__ops/e5/youtube-oauth/callback",
  };
}

async function csrfMaterial(
  settings: Env,
  headers: HeadersInit,
  fetcher: typeof fetch,
): Promise<{ response: Response; body: string; token: string; cookie: string }> {
  const response = await handleE5YoutubeOAuthHttp(
    new Request("https://app.invalid/__ops/e5/youtube-oauth/start", { headers }),
    settings,
    fetcher,
  );
  const body = await response.text();
  const token = body.match(/name="csrf_token" value="([A-Za-z0-9_-]{43})"/u)?.[1];
  const setCookie = response.headers.get("set-cookie");
  if (!token || !setCookie) throw new Error("CSRF confirmation material missing");
  return { response, body, token, cookie: setCookie.split(";", 1)[0]! };
}

function csrfForm(token: string): string {
  return new URLSearchParams({ csrf_token: token }).toString();
}

function failStatusReads(
  target: D1Database,
  failureLimit: number,
): { db: D1Database; failures: () => number } {
  let failures = 0;
  const statusRead = "SELECT generation, operation, operation_owner, operation_expires_at";
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
            if (failures < failureLimit) {
              failures += 1;
              throw new Error("temporary local D1 read failure");
            }
            return Reflect.apply(value, inner, args);
          };
        }
        return typeof value === "function" ? value.bind(inner) : value;
      },
    },
  );
  const db = new Proxy(target, {
    get(inner, property) {
      if (property === "prepare") {
        return (sql: string) => wrap(inner.prepare(sql), sql.includes(statusRead));
      }
      const value = Reflect.get(inner, property);
      return typeof value === "function" ? value.bind(inner) : value;
    },
  }) as D1Database;
  return { db, failures: () => failures };
}

function failCallbackCredentialConfirmation(target: D1Database): D1Database {
  return new Proxy(target, {
    get(inner, property) {
      if (property === "prepare") {
        return (sql: string) => {
          if (sql.includes("SELECT status, generation FROM youtube_oauth_credentials")) {
            throw new Error("private post-commit D1 read marker");
          }
          return inner.prepare(sql);
        };
      }
      const value = Reflect.get(inner, property);
      return typeof value === "function" ? value.bind(inner) : value;
    },
  }) as D1Database;
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  signingKey = pair.privateKey;
  publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
});

beforeEach(async () => {
  infoLogCalls = [];
  warnLogCalls = [];
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => { infoLogCalls.push(args); });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnLogCalls.push(args); });
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Cloudflare Access JWT verification", () => {
  it("cryptographically verifies issuer, audience, expiry, key, and allowed email", async () => {
    const verifier = new CloudflareAccessVerifier(
      { teamDomain: TEAM_DOMAIN, audience: AUDIENCE, allowedEmails: [EMAIL] },
      vi.fn(async () => jwksResponse()),
      () => new Date(NOW_SECONDS * 1_000),
    );
    const session = await verifier.verify(accessRequest(await jwt()));
    expect(session.isVerified()).toBe(true);
    expect(session.subjectFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(session.subjectFingerprint).not.toContain(EMAIL);
  });

  it("derives the audit actor from Access sub rather than email", async () => {
    const secondEmail = "second-operator@local.invalid";
    const verifier = new CloudflareAccessVerifier(
      { teamDomain: TEAM_DOMAIN, audience: AUDIENCE, allowedEmails: [EMAIL, secondEmail] },
      vi.fn(async () => jwksResponse()),
      () => new Date(NOW_SECONDS * 1_000),
    );
    const first = await verifier.verify(accessRequest(await jwt({ sub: "subject-one", email: EMAIL })));
    const differentSubject = await verifier.verify(
      accessRequest(await jwt({ sub: "subject-two", email: EMAIL })),
    );
    const sameSubjectDifferentEmail = await verifier.verify(
      accessRequest(await jwt({ sub: "subject-one", email: secondEmail })),
    );

    expect(first.subjectFingerprint).not.toBe(differentSubject.subjectFingerprint);
    expect(first.subjectFingerprint).toBe(sameSubjectDifferentEmail.subjectFingerprint);
  });

  it.each([
    ["expired", { exp: NOW_SECONDS }],
    ["issuer", { iss: "https://wrong.cloudflareaccess.com" }],
    ["audience", { aud: "wrong_audience_123456789" }],
    ["future", { nbf: NOW_SECONDS + 120 }],
    ["email", { email: "other@local.invalid" }],
    ["missing subject", { sub: undefined }],
    ["empty subject", { sub: "" }],
    ["blank subject", { sub: "   " }],
    ["invalid subject type", { sub: 123 }],
  ])("rejects invalid %s claims", async (_name, claims) => {
    const verifier = new CloudflareAccessVerifier(
      { teamDomain: TEAM_DOMAIN, audience: AUDIENCE, allowedEmails: [EMAIL] },
      vi.fn(async () => jwksResponse()),
      () => new Date(NOW_SECONDS * 1_000),
    );
    await expect(verifier.verify(accessRequest(await jwt(claims)))).rejects.toBeTruthy();
  });

  it("rejects a forged signature, unknown kid, malformed JWKS, and separates JWKS fetch failures", async () => {
    const valid = await jwt();
    const parts = valid.split(".");
    const forgedBytes = decodeBase64Url(parts[2]!);
    forgedBytes[Math.floor(forgedBytes.length / 2)]! ^= 0x01;
    const forged = `${parts[0]}.${parts[1]}.${base64Url(forgedBytes)}`;
    const validFetcher = vi.fn(async () => jwksResponse());
    const make = (fetcher: typeof fetch) => new CloudflareAccessVerifier(
      { teamDomain: TEAM_DOMAIN, audience: AUDIENCE, allowedEmails: [EMAIL] },
      fetcher,
      () => new Date(NOW_SECONDS * 1_000),
    );
    await expect(make(validFetcher as typeof fetch).verify(accessRequest(forged))).rejects.toBeTruthy();
    await expect(make(validFetcher as typeof fetch).verify(accessRequest(await jwt({}, "unknown"))))
      .rejects.toBeTruthy();
    await expect(make(vi.fn(async () => Response.json({ bad: true })) as typeof fetch)
      .verify(accessRequest(valid))).rejects.toBeTruthy();
    await expect(make(vi.fn(async () => { throw new Error("offline"); }) as typeof fetch)
      .verify(accessRequest(valid))).rejects.toMatchObject({ code: "ACCESS_JWKS_FETCH_FAILED" });
    await expect(make(vi.fn(async () => new Response("private", { status: 503 })) as typeof fetch)
      .verify(accessRequest(valid))).rejects.toMatchObject({ code: "ACCESS_JWKS_HTTP_REJECTED" });
    const timeoutVerifier = new CloudflareAccessVerifier(
      { teamDomain: TEAM_DOMAIN, audience: AUDIENCE, allowedEmails: [EMAIL] },
      vi.fn(async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("private", "AbortError")));
      })) as typeof fetch,
      () => new Date(NOW_SECONDS * 1_000),
      1,
    );
    await expect(timeoutVerifier.verify(accessRequest(valid)))
      .rejects.toMatchObject({ code: "ACCESS_JWKS_TIMEOUT" });
    const bodyTimeoutVerifier = new CloudflareAccessVerifier(
      { teamDomain: TEAM_DOMAIN, audience: AUDIENCE, allowedEmails: [EMAIL] },
      vi.fn(async (_input, init) => new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("private", "AbortError"));
          });
        },
      }))) as typeof fetch,
      () => new Date(NOW_SECONDS * 1_000),
      1,
    );
    await expect(bodyTimeoutVerifier.verify(accessRequest(valid)))
      .rejects.toMatchObject({ code: "ACCESS_JWKS_TIMEOUT" });
  });
});

describe("official Google OAuth/YouTube read-only adapter", () => {
  it("uses only OAuth endpoints and channels.list part=id&mine=true", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.includes("/token")) return Response.json({
        access_token: "runtime-access", refresh_token: "runtime-refresh",
        expires_in: 3600, scope: "https://www.googleapis.com/auth/youtube.readonly",
      });
      if (url.includes("/channels")) return Response.json({ items: [{ id: EXPECTED_CHANNEL }] });
      return new Response(null, { status: 200 });
    });
    const provider = new GoogleYoutubeOAuthProvider("client", "runtime-secret", fetcher as typeof fetch);
    const authorization = new URL(provider.authorizationUrl({
      clientId: "client", redirectUri: "https://app.invalid/callback", state: "state",
      codeChallenge: "challenge", scope: "https://www.googleapis.com/auth/youtube.readonly",
      accessType: "offline",
    }));
    expect(authorization.origin + authorization.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(authorization.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/youtube.readonly");
    expect(authorization.searchParams.get("prompt")).toBe("consent");
    const tokens = await provider.exchangeCode({
      authorizationCode: "runtime-code", codeVerifier: "runtime-verifier",
      redirectUri: "https://app.invalid/callback",
    });
    expect(tokens.scopes).toEqual(["https://www.googleapis.com/auth/youtube.readonly"]);
    expect(await provider.listMineChannels(tokens.accessToken)).toEqual([EXPECTED_CHANNEL]);
    const channels = new URL(calls.find((call) => call.url.includes("/channels"))!.url);
    expect([...channels.searchParams.entries()]).toEqual([["part", "id"], ["mine", "true"]]);
    expect(calls.some((call) => /videos|upload|resumable/u.test(call.url))).toBe(false);
  });

  it.each([
    ["missing scope", Response.json({ access_token: "a", refresh_token: "r", expires_in: 3600 })],
    ["bad JSON", new Response("not-json", { status: 200 })],
    ["HTTP error", new Response("sensitive remote body", { status: 400 })],
  ])("rejects %s without reflecting remote content", async (_name, response) => {
    const provider = new GoogleYoutubeOAuthProvider("client", "secret", vi.fn(async () => response) as typeof fetch);
    await expect(provider.exchangeCode({ authorizationCode: "code", codeVerifier: "verifier", redirectUri: "https://app.invalid/callback" }))
      .rejects.not.toThrow("sensitive remote body");
  });

  it("turns a network timeout into a safe retryable error", async () => {
    const provider = new GoogleYoutubeOAuthProvider(
      "client", "secret", vi.fn(async () => { throw new DOMException("timeout", "AbortError"); }) as typeof fetch,
    );
    await expect(provider.refresh("runtime-refresh")).rejects.toMatchObject({ retryable: true });
  });

  it("classifies invalid_grant as terminal and treats already-invalid revoke as complete", async () => {
    const invalidGrant = new GoogleYoutubeOAuthProvider(
      "client", "secret",
      vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as typeof fetch,
    );
    await expect(invalidGrant.refresh("runtime-refresh"))
      .rejects.toMatchObject({ code: "OAUTH_GRANT_INVALID", retryable: false });
    const invalidToken = new GoogleYoutubeOAuthProvider(
      "client", "secret",
      vi.fn(async () => Response.json({ error: "invalid_token" }, { status: 400 })) as typeof fetch,
    );
    await expect(invalidToken.revoke("runtime-refresh")).resolves.toBeUndefined();
  });
});

describe("Access-protected operational routes", () => {
  it("returns 404 when configuration or a valid Access JWT is missing", async () => {
    const expectSafeNotFound = async (response: Response): Promise<void> => {
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe("text/plain;charset=UTF-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.text()).toBe("Not found");
    };
    const callbackUrl = "https://app.invalid/__ops/e5/youtube-oauth/callback?code=dummy-code&state=dummy-state";
    const incomplete = routeEnv();
    delete incomplete.YOUTUBE_OAUTH_CLIENT_SECRET;
    await expectSafeNotFound(await handleE5YoutubeOAuthHttp(new Request(callbackUrl), incomplete));
    await expectSafeNotFound(await handleE5YoutubeOAuthHttp(
      new Request(callbackUrl), routeEnv(), vi.fn(async () => jwksResponse()) as typeof fetch,
    ));
    await expectSafeNotFound(await handleE5YoutubeOAuthHttp(
      new Request(callbackUrl, { headers: { "cf-access-jwt-assertion": await jwt() } }),
      routeEnv(),
      vi.fn(async () => { throw new Error("offline"); }) as typeof fetch,
    ));
    const serviceInvalid = routeEnv();
    serviceInvalid.YOUTUBE_EXPECTED_CHANNEL_ID = "invalid-channel";
    await expectSafeNotFound(await handleE5YoutubeOAuthHttp(
      new Request(callbackUrl, { headers: { "cf-access-jwt-assertion": await jwt() } }),
      serviceInvalid,
      vi.fn(async () => jwksResponse()) as typeof fetch,
    ));
    await expectSafeNotFound(await handleE5YoutubeOAuthHttp(
      new Request("https://app.invalid/__ops/e5/youtube-oauth/missing", {
        headers: { "cf-access-jwt-assertion": await jwt() },
      }),
      routeEnv(),
      vi.fn(async () => jwksResponse()) as typeof fetch,
    ));
  });

  it("logs only fixed enums and never request or authentication material", async () => {
    const authorizationCode = "private-authorization-code-marker";
    const state = "private-state-marker";
    const accessToken = "private-access-jwt-marker";
    const settings = routeEnv();
    const clientSecret = settings.YOUTUBE_OAUTH_CLIENT_SECRET!;
    delete settings.YOUTUBE_OAUTH_CLIENT_SECRET;
    const response = await handleE5YoutubeOAuthHttp(new Request(
      `https://app.invalid/__ops/e5/youtube-oauth/callback?code=${authorizationCode}&state=${state}`,
      { headers: { "cf-access-jwt-assertion": accessToken, cookie: "private-cookie-marker" } },
    ), settings);

    expect(response.status).toBe(404);
    const records = oauthLogRecords();
    expect(records).toEqual([{
      event: "YOUTUBE_OAUTH_HTTP",
      stage: "REQUEST_GATE",
      outcome: "REJECTED",
      reason: "CONFIG_INVALID",
    }]);
    expectFixedOAuthLogs(records);
    const serialized = JSON.stringify(records);
    for (const secret of [
      authorizationCode, state, accessToken, "private-cookie-marker", EMAIL,
      EXPECTED_CHANNEL, clientSecret,
    ]) expect(serialized).not.toContain(secret);
  });

  it("keeps ambiguous and input-validation callback errors in the non-assertive log category", () => {
    for (const code of [
      "OAUTH_EXCHANGE_FAILED",
      "AUTHORIZATION_CODE_INVALID",
      "ACCESS_TOKEN_INVALID",
      "REFRESH_TOKEN_INVALID",
      "CIPHERTEXT_INVALID",
      "CLOCK_INVALID",
      "OAUTH_ACCESS_REQUIRED",
    ]) {
      expect(classifyOAuthCallbackFailureForLog(new YoutubeOAuthError(code)))
        .toBe("UNEXPECTED_FAILURE");
    }
    expect(classifyOAuthCallbackFailureForLog(new Error("private raw error marker")))
      .toBe("UNEXPECTED_FAILURE");
    expect(classifyOAuthCallbackFailureForLog(new YoutubeOAuthError("OAUTH_STATE_USED")))
      .toBe("STATE_ALREADY_USED");
  });

  it("keeps generic 404 by default and exposes only coarse safe stages when diagnostics are enabled", async () => {
    const requestUrl = "https://app.invalid/__ops/e5/youtube-oauth/status";
    const incomplete = routeEnv();
    delete incomplete.YOUTUBE_OAUTH_CLIENT_SECRET;
    const generic = await handleE5YoutubeOAuthHttp(new Request(requestUrl), incomplete);
    expect(generic.status).toBe(404);
    expect(generic.headers.get("referrer-policy")).toBe("no-referrer");
    expect(generic.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await generic.text()).toBe("Not found");

    const diagnose = async (
      settings: Env,
      request: Request,
      fetcher: typeof fetch = fetch,
    ): Promise<unknown> => {
      settings.YOUTUBE_OAUTH_DIAGNOSTICS_ENABLED = "true";
      const response = await handleE5YoutubeOAuthHttp(request, settings, fetcher);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const body = await response.json();
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(EMAIL);
      expect(serialized).not.toContain(settings.YOUTUBE_OAUTH_CLIENT_SECRET ?? "never-present");
      expect(serialized).not.toContain(settings.YOUTUBE_OAUTH_ENCRYPTION_KEY ?? "never-present");
      expect(serialized).not.toContain(settings.YOUTUBE_OAUTH_ALLOWED_EMAILS ?? "never-present");
      return body;
    };

    expect(await diagnose(incomplete, new Request(requestUrl)))
      .toEqual({ status: "NOT_FOUND", diagnosticStage: "CONFIG_INVALID" });

    const redirectInvalid = routeEnv();
    redirectInvalid.YOUTUBE_OAUTH_REDIRECT_URI = "https://other.invalid/__ops/e5/youtube-oauth/callback";
    expect(await diagnose(redirectInvalid, new Request(requestUrl)))
      .toEqual({ status: "NOT_FOUND", diagnosticStage: "REDIRECT_INVALID" });

    const accessRejected = routeEnv();
    expect(await diagnose(
      accessRejected,
      new Request(requestUrl),
      vi.fn(async () => jwksResponse()) as typeof fetch,
    )).toEqual({
      status: "NOT_FOUND", diagnosticStage: "ACCESS_REJECTED", diagnosticReason: "TOKEN_MISSING",
    });

    const accessCase = async (
      token: string,
      fetcher: typeof fetch,
    ): Promise<unknown> => {
      const result = await diagnose(
        routeEnv(),
        new Request(requestUrl, { headers: { "cf-access-jwt-assertion": token } }),
        fetcher,
      );
      expect(JSON.stringify(result)).not.toContain(token);
      return result;
    };
    expect(await accessCase("not.a.jwt", vi.fn(async () => jwksResponse()) as typeof fetch))
      .toEqual({
        status: "NOT_FOUND", diagnosticStage: "ACCESS_REJECTED", diagnosticReason: "JWT_INVALID",
      });
    expect(await accessCase(
      await jwt({ exp: NOW_SECONDS }),
      vi.fn(async () => jwksResponse()) as typeof fetch,
    )).toEqual({
      status: "NOT_FOUND", diagnosticStage: "ACCESS_REJECTED", diagnosticReason: "CLAIMS_INVALID",
    });
    const signed = await jwt();
    const signedParts = signed.split(".");
    const alteredSignature = decodeBase64Url(signedParts[2]!);
    alteredSignature[0]! ^= 0x01;
    const forged = `${signedParts[0]}.${signedParts[1]}.${base64Url(alteredSignature)}`;
    expect(await accessCase(forged, vi.fn(async () => jwksResponse()) as typeof fetch))
      .toEqual({
        status: "NOT_FOUND", diagnosticStage: "ACCESS_REJECTED", diagnosticReason: "SIGNATURE_INVALID",
      });
    expect(await accessCase(
      await jwt(),
      vi.fn(async () => Response.json({ bad: true })) as typeof fetch,
    )).toEqual({
      status: "NOT_FOUND", diagnosticStage: "ACCESS_REJECTED", diagnosticReason: "JWKS_INVALID",
    });
    expect(await accessCase(
      await jwt(),
      vi.fn(async () => { throw new Error("offline with sensitive details"); }) as typeof fetch,
    )).toEqual({
      status: "NOT_FOUND", diagnosticStage: "ACCESS_REJECTED", diagnosticReason: "JWKS_FETCH_FAILED",
    });
    expect(await accessCase(
      await jwt(),
      vi.fn(async () => new Response("sensitive remote body", { status: 503 })) as typeof fetch,
    )).toEqual({
      status: "NOT_FOUND", diagnosticStage: "ACCESS_REJECTED", diagnosticReason: "JWKS_HTTP_REJECTED",
    });
    expect(await (async () => {
      const settings = routeEnv();
      settings.YOUTUBE_OAUTH_DIAGNOSTICS_ENABLED = "true";
      const token = await jwt();
      const response = await handleE5YoutubeOAuthHttp(
        new Request(requestUrl, { headers: { "cf-access-jwt-assertion": token } }),
        settings,
        vi.fn(async (_input, init) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("private", "AbortError")));
        })) as typeof fetch,
        1,
      );
      const body = await response.json();
      expect(JSON.stringify(body)).not.toContain(token);
      return body;
    })()).toEqual({
      status: "NOT_FOUND", diagnosticStage: "ACCESS_REJECTED", diagnosticReason: "JWKS_TIMEOUT",
    });
    expect(await accessCase(
      await jwt({}, "unknown-kid"),
      vi.fn(async () => jwksResponse()) as typeof fetch,
    )).toEqual({
      status: "NOT_FOUND", diagnosticStage: "ACCESS_REJECTED", diagnosticReason: "JWK_NOT_FOUND",
    });
    expect(await accessCase(
      await jwt(),
      vi.fn(async () => Response.json({ keys: [{
        ...publicJwk, kid: "local-kid", alg: "RS256", use: "sig", n: "AQ",
      }] })) as typeof fetch,
    )).toEqual({
      status: "NOT_FOUND", diagnosticStage: "ACCESS_REJECTED", diagnosticReason: "JWK_IMPORT_FAILED",
    });
    expect(await accessCase(
      await jwt({ email: "other@local.invalid" }),
      vi.fn(async () => jwksResponse()) as typeof fetch,
    )).toEqual({
      status: "NOT_FOUND", diagnosticStage: "ACCESS_REJECTED", diagnosticReason: "ALLOWLIST_DENIED",
    });

    const accessConfigInvalid = routeEnv();
    accessConfigInvalid.CLOUDFLARE_ACCESS_TEAM_DOMAIN = "invalid";
    expect(await diagnose(
      accessConfigInvalid,
      new Request(requestUrl, { headers: { "cf-access-jwt-assertion": await jwt() } }),
      vi.fn(async () => jwksResponse()) as typeof fetch,
    )).toEqual({
      status: "NOT_FOUND", diagnosticStage: "ACCESS_REJECTED", diagnosticReason: "ACCESS_CONFIG_INVALID",
    });

    const serviceInvalid = routeEnv();
    serviceInvalid.YOUTUBE_EXPECTED_CHANNEL_ID = "invalid-channel";
    expect(await diagnose(
      serviceInvalid,
      new Request(requestUrl, { headers: { "cf-access-jwt-assertion": await jwt() } }),
      vi.fn(async () => jwksResponse()) as typeof fetch,
    )).toEqual({ status: "NOT_FOUND", diagnosticStage: "SERVICE_INIT_FAILED" });

    const records = oauthLogRecords();
    expectFixedOAuthLogs(records);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(EMAIL);
    expect(serialized).not.toContain("offline with sensitive details");
    expect(serialized).not.toContain("sensitive remote body");
  });

  it("logs callback provider failure by a fixed stage without code, state, JWT, or external response", async () => {
    const accessToken = await jwt();
    const authorizationCode = "private-callback-code-marker";
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/cdn-cgi/access/certs")) return jwksResponse();
      return new Response("private provider response marker", { status: 503 });
    });
    const settings = routeEnv();
    const headers = { "cf-access-jwt-assertion": accessToken };
    const csrf = await csrfMaterial(settings, headers, fetcher as typeof fetch);
    const started = await handleE5YoutubeOAuthHttp(
      new Request("https://app.invalid/__ops/e5/youtube-oauth/start", {
        method: "POST",
        headers: {
          ...headers,
          origin: "https://app.invalid",
          "sec-fetch-site": "same-origin",
          cookie: csrf.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: csrfForm(csrf.token),
      }),
      settings,
      fetcher as typeof fetch,
    );
    const state = new URL(started.headers.get("location")!).searchParams.get("state")!;
    const callback = new URL(settings.YOUTUBE_OAUTH_REDIRECT_URI!);
    callback.searchParams.set("code", authorizationCode);
    callback.searchParams.set("state", state);
    clearOAuthLogs();
    const response = await handleE5YoutubeOAuthHttp(
      new Request(callback, { headers }),
      settings,
      fetcher as typeof fetch,
    );

    expect(response.status).toBe(303);
    const records = oauthLogRecords();
    expect(records).toEqual([{
      event: "YOUTUBE_OAUTH_HTTP",
      stage: "CALLBACK",
      outcome: "STARTED",
      reason: "CODE_RECEIVED",
    }, {
      event: "YOUTUBE_OAUTH_HTTP",
      stage: "CALLBACK",
      outcome: "REJECTED",
      reason: "TOKEN_EXCHANGE_REJECTED",
    }]);
    expectFixedOAuthLogs(records);
    const serialized = JSON.stringify(records);
    for (const secret of [
      authorizationCode, state, accessToken, EMAIL, EXPECTED_CHANNEL,
      "private provider response marker",
    ]) expect(serialized).not.toContain(secret);
  });

  it("does not misclassify an indeterminate post-commit D1 confirmation as token exchange failure", async () => {
    const accessToken = await jwt();
    const authorizationCode = "private-post-commit-code-marker";
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const target = String(input);
      if (target.includes("/cdn-cgi/access/certs")) return jwksResponse();
      if (target.includes("oauth2.googleapis.com/token")) return Response.json({
        access_token: "private-post-commit-access-marker",
        refresh_token: "private-post-commit-refresh-marker",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/youtube.readonly",
      });
      if (target.includes("youtube/v3/channels")) {
        return Response.json({ items: [{ id: EXPECTED_CHANNEL }] });
      }
      if (target.includes("oauth2.googleapis.com/revoke")) return new Response(null, { status: 204 });
      throw new Error("private unexpected endpoint marker");
    });
    const settings = { ...routeEnv(), DB: failCallbackCredentialConfirmation(env.DB) };
    const headers = { "cf-access-jwt-assertion": accessToken };
    const csrf = await csrfMaterial(settings, headers, fetcher as typeof fetch);
    const started = await handleE5YoutubeOAuthHttp(
      new Request("https://app.invalid/__ops/e5/youtube-oauth/start", {
        method: "POST",
        headers: {
          ...headers,
          origin: "https://app.invalid",
          "sec-fetch-site": "same-origin",
          cookie: csrf.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: csrfForm(csrf.token),
      }),
      settings,
      fetcher as typeof fetch,
    );
    const callback = new URL(settings.YOUTUBE_OAUTH_REDIRECT_URI!);
    const state = new URL(started.headers.get("location")!).searchParams.get("state")!;
    callback.searchParams.set("code", authorizationCode);
    callback.searchParams.set("state", state);
    clearOAuthLogs();

    const response = await handleE5YoutubeOAuthHttp(
      new Request(callback, { headers }), settings, fetcher as typeof fetch,
    );

    expect(response.status).toBe(303);
    const records = oauthLogRecords();
    expect(records).toEqual([{
      event: "YOUTUBE_OAUTH_HTTP",
      stage: "CALLBACK",
      outcome: "STARTED",
      reason: "CODE_RECEIVED",
    }, {
      event: "YOUTUBE_OAUTH_HTTP",
      stage: "CALLBACK",
      outcome: "REJECTED",
      reason: "UNEXPECTED_FAILURE",
    }]);
    expect(records).not.toContainEqual(expect.objectContaining({ reason: "TOKEN_EXCHANGE_REJECTED" }));
    expectFixedOAuthLogs(records);
    const serialized = JSON.stringify(records);
    for (const secret of [
      authorizationCode, state, accessToken, EXPECTED_CHANNEL,
      "private-post-commit-access-marker", "private-post-commit-refresh-marker",
      "private post-commit D1 read marker", "private unexpected endpoint marker",
    ]) expect(serialized).not.toContain(secret);
    expect(await env.DB.prepare(
      "SELECT status, access_token_ciphertext, refresh_token_ciphertext FROM youtube_oauth_credentials",
    ).first()).toEqual({
      status: "ERROR", access_token_ciphertext: null, refresh_token_ciphertext: null,
    });
  });

  it("diagnoses mutation rejection with fixed reasons only and never changes D1", async () => {
    const settings = routeEnv();
    const accessToken = await jwt();
    const accessHeaders = { "cf-access-jwt-assertion": accessToken };
    const fetcher = vi.fn(async () => jwksResponse()) as typeof fetch;
    const csrf = await csrfMaterial(settings, accessHeaders, fetcher);
    const baseHeaders = {
      ...accessHeaders,
      origin: "https://app.invalid",
      "sec-fetch-site": "same-origin",
      cookie: csrf.cookie,
      "content-type": "application/x-www-form-urlencoded",
    };
    const url = "https://app.invalid/__ops/e5/youtube-oauth/start";

    const generic = await handleE5YoutubeOAuthHttp(
      new Request(url, {
        method: "POST",
        headers: { ...baseHeaders, origin: "https://other.invalid" },
        body: csrfForm(csrf.token),
      }),
      settings,
      fetcher,
    );
    expect(generic.status).toBe(404);
    expect(generic.headers.get("content-type")).toBe("text/plain;charset=UTF-8");
    expect(generic.headers.get("referrer-policy")).toBe("no-referrer");
    expect(generic.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await generic.text()).toBe("Not found");

    settings.YOUTUBE_OAUTH_DIAGNOSTICS_ENABLED = "true";
    const diagnose = async (request: Request, reason: string): Promise<void> => {
      const response = await handleE5YoutubeOAuthHttp(request, settings, fetcher);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body).toEqual({
        status: "NOT_FOUND",
        diagnosticStage: "MUTATION_REJECTED",
        diagnosticReason: reason,
      });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(accessToken);
      expect(serialized).not.toContain(csrf.token);
      expect(serialized).not.toContain(csrf.cookie);
      expect(serialized).not.toContain(EMAIL);
      expect(serialized).not.toContain(settings.YOUTUBE_OAUTH_CLIENT_SECRET!);
    };

    await diagnose(new Request(url, {
      method: "POST",
      headers: { ...baseHeaders, origin: "https://other.invalid" },
      body: csrfForm(csrf.token),
    }), "ORIGIN_REJECTED");
    await diagnose(new Request(url, {
      method: "POST",
      headers: { ...baseHeaders, origin: "null" },
      body: csrfForm(csrf.token),
    }), "ORIGIN_REJECTED");
    await diagnose(new Request(url, {
      method: "POST",
      headers: { ...baseHeaders, "sec-fetch-site": "cross-site" },
      body: csrfForm(csrf.token),
    }), "ORIGIN_REJECTED");
    const { origin: _origin, "sec-fetch-site": _fetchSite, ...headersWithoutSource } = baseHeaders;
    await diagnose(new Request(url, {
      method: "POST",
      headers: headersWithoutSource,
      body: csrfForm(csrf.token),
    }), "ORIGIN_REJECTED");
    await diagnose(new Request(url, {
      method: "POST",
      headers: {
        ...accessHeaders,
        origin: "https://app.invalid",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: csrfForm(csrf.token),
    }), "CSRF_COOKIE_MISSING_OR_INVALID");
    await diagnose(new Request(url, {
      method: "POST",
      headers: { ...baseHeaders, "content-type": "application/json" },
      body: JSON.stringify({ csrf_token: csrf.token }),
    }), "FORM_CONTENT_TYPE_REJECTED");
    await diagnose(new Request(url, {
      method: "POST",
      headers: baseHeaders,
      body: `csrf_token=${csrf.token}&padding=${"x".repeat(1_100)}`,
    }), "FORM_BODY_REJECTED");
    await diagnose(new Request(url, {
      method: "POST",
      headers: baseHeaders,
      body: "csrf_token=invalid",
    }), "CSRF_TOKEN_MISSING_OR_INVALID");
    await diagnose(new Request(url, {
      method: "POST",
      headers: baseHeaders,
      body: csrfForm("A".repeat(43)),
    }), "CSRF_TOKEN_MISMATCH");

    for (const operation of ["start", "refresh", "revoke"]) {
      await diagnose(new Request(`https://app.invalid/__ops/e5/youtube-oauth/${operation}`, {
        method: "POST",
        headers: {
          ...accessHeaders,
          origin: "https://app.invalid",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: csrfForm(csrf.token),
      }), "CSRF_COOKIE_MISSING_OR_INVALID");
    }
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM youtube_oauth_attempts").first())
      .toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM youtube_oauth_audits").first())
      .toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT generation, operation FROM youtube_oauth_control").first())
      .toEqual({ generation: 0, operation: "READY" });

    const accepted = await handleE5YoutubeOAuthHttp(new Request(url, {
      method: "POST",
      headers: { ...baseHeaders, origin: "https://app.invalid", "sec-fetch-site": "same-origin" },
      body: csrfForm(csrf.token),
    }), settings, fetcher);
    expect(accepted.status).toBe(303);
  });

  it("uses no-referrer for terminal and retryable OAuth error responses", async () => {
    const settings = routeEnv();
    const accessHeaders = { "cf-access-jwt-assertion": await jwt() };
    const fetcher = vi.fn(async () => jwksResponse()) as typeof fetch;
    const csrf = await csrfMaterial(settings, accessHeaders, fetcher);
    const mutationHeaders = {
      ...accessHeaders,
      origin: "https://app.invalid",
      "sec-fetch-site": "same-origin",
      cookie: csrf.cookie,
      "content-type": "application/x-www-form-urlencoded",
    };
    const request = (operation: "start" | "refresh"): Request => new Request(
      `https://app.invalid/__ops/e5/youtube-oauth/${operation}`,
      { method: "POST", headers: mutationHeaders, body: csrfForm(csrf.token) },
    );
    const assertSafeError = async (response: Response, status: 409 | 503): Promise<void> => {
      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.json()).toEqual({ status: "ERROR" });
    };

    await assertSafeError(
      await handleE5YoutubeOAuthHttp(request("refresh"), settings, fetcher),
      409,
    );
    await env.DB.prepare(
      `UPDATE youtube_oauth_control SET operation = 'STARTING', operation_owner = ?,
         operation_expires_at = ?, updated_at = ? WHERE control_id = 1`,
    ).bind(
      "test-operation-owner",
      "2999-01-01T00:00:00.000Z",
      "2026-08-30T00:00:00.000Z",
    ).run();
    await assertSafeError(
      await handleE5YoutubeOAuthHttp(request("start"), settings, fetcher),
      503,
    );
  });

  it.each([
    ["path", "https://app.invalid/wrong/callback"],
    ["trailing slash", "https://app.invalid/__ops/e5/youtube-oauth/callback/"],
    ["query", "https://app.invalid/__ops/e5/youtube-oauth/callback?unsafe=1"],
    ["fragment", "https://app.invalid/__ops/e5/youtube-oauth/callback#unsafe"],
  ])("returns 404 for a redirect URI with a wrong %s", async (_name, redirectUri) => {
    const settings = routeEnv();
    settings.YOUTUBE_OAUTH_REDIRECT_URI = redirectUri;
    const fetcher = vi.fn(async () => jwksResponse());
    const response = await handleE5YoutubeOAuthHttp(
      new Request("https://app.invalid/__ops/e5/youtube-oauth/status", {
        headers: { "cf-access-jwt-assertion": await jwt() },
      }),
      settings,
      fetcher as typeof fetch,
    );
    expect(response.status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects redirect origin mismatch and requires HTTPS even when HTTP origins match", async () => {
    const fetcher = vi.fn(async () => jwksResponse());
    const before = {
      attempts: await env.DB.prepare("SELECT COUNT(*) count FROM youtube_oauth_attempts").first(),
      audits: await env.DB.prepare("SELECT COUNT(*) count FROM youtube_oauth_audits").first(),
      control: await env.DB.prepare("SELECT generation, operation FROM youtube_oauth_control").first(),
    };
    const cases = [
      {
        requestUrl: "https://app.invalid/__ops/e5/youtube-oauth/status",
        redirectUri: "https://other.invalid/__ops/e5/youtube-oauth/callback",
      },
      {
        requestUrl: "http://app.invalid/__ops/e5/youtube-oauth/status",
        redirectUri: "http://app.invalid/__ops/e5/youtube-oauth/callback",
      },
    ];

    for (const { requestUrl, redirectUri } of cases) {
      const settings = routeEnv();
      settings.YOUTUBE_OAUTH_REDIRECT_URI = redirectUri;
      const response = await handleE5YoutubeOAuthHttp(
        new Request(requestUrl, { headers: { "cf-access-jwt-assertion": await jwt() } }),
        settings,
        fetcher as typeof fetch,
      );
      expect(response.status).toBe(404);
    }

    expect(fetcher).not.toHaveBeenCalled();
    expect({
      attempts: await env.DB.prepare("SELECT COUNT(*) count FROM youtube_oauth_attempts").first(),
      audits: await env.DB.prepare("SELECT COUNT(*) count FROM youtube_oauth_audits").first(),
      control: await env.DB.prepare("SELECT generation, operation FROM youtube_oauth_control").first(),
    }).toEqual(before);
  });

  it.each([
    ["the exact configured Origin", { origin: "https://app.invalid" }],
    ["normal Chrome metadata", {
      origin: "https://app.invalid",
      "sec-fetch-site": "same-origin",
    }],
    ["same-origin Fetch Metadata when Origin is absent", { "sec-fetch-site": "same-origin" }],
  ])("uses a non-mutating GET confirmation and accepts %s for the complete operation cycle", async (
    _sourceName,
    sourceHeaders,
  ) => {
    const token = await jwt();
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/cdn-cgi/access/certs")) return jwksResponse();
      if (url.includes("oauth2.googleapis.com/token")) return Response.json({
        access_token: "runtime-route-access", refresh_token: "runtime-route-refresh",
        expires_in: 3600, scope: "https://www.googleapis.com/auth/youtube.readonly",
      });
      if (url.includes("oauth2.googleapis.com/revoke")) return new Response(null, { status: 200 });
      if (url.includes("youtube/v3/channels")) return Response.json({ items: [{ id: EXPECTED_CHANNEL }] });
      throw new Error("unexpected external endpoint");
    });
    const headers = { "cf-access-jwt-assertion": token };
    const settings = routeEnv();
    const before = {
      attempts: await env.DB.prepare("SELECT COUNT(*) count FROM youtube_oauth_attempts").first(),
      audits: await env.DB.prepare("SELECT COUNT(*) count FROM youtube_oauth_audits").first(),
      control: await env.DB.prepare("SELECT generation, operation FROM youtube_oauth_control").first(),
    };
    const csrf = await csrfMaterial(settings, headers, fetcher as typeof fetch);
    const confirmation = csrf.response;
    expect(confirmation.status).toBe(200);
    const contentSecurityPolicy = confirmation.headers.get("content-security-policy");
    expect(contentSecurityPolicy).toBe(
      "default-src 'none'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(contentSecurityPolicy).not.toContain("*");
    expect(contentSecurityPolicy).not.toContain("https://google.com");
    expect(confirmation.headers.get("referrer-policy")).toBe("same-origin");
    const confirmationBody = csrf.body;
    expect(confirmationBody).toContain("YouTube接続の確認");
    expect(confirmationBody).toContain('method="post"');
    expect(confirmationBody).toContain(`name="csrf_token" value="${csrf.token}"`);
    expect(confirmation.headers.get("set-cookie")).toContain("Secure");
    expect(confirmation.headers.get("set-cookie")).toContain("HttpOnly");
    expect(confirmation.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(confirmation.headers.get("set-cookie")).toContain("Path=/");
    expect(confirmation.headers.get("set-cookie")).toContain("Max-Age=600");
    expect(confirmation.headers.get("set-cookie")).not.toMatch(/Domain=/iu);
    expect(confirmationBody).not.toContain(EXPECTED_CHANNEL);
    expect(confirmationBody).not.toContain(settings.YOUTUBE_OAUTH_CLIENT_SECRET!);
    expect({
      attempts: await env.DB.prepare("SELECT COUNT(*) count FROM youtube_oauth_attempts").first(),
      audits: await env.DB.prepare("SELECT COUNT(*) count FROM youtube_oauth_audits").first(),
      control: await env.DB.prepare("SELECT generation, operation FROM youtube_oauth_control").first(),
    }).toEqual(before);

    const validMutationHeaders = {
      ...headers,
      ...sourceHeaders,
      cookie: csrf.cookie,
      "content-type": "application/x-www-form-urlencoded",
    };
    const csrfHeaders = {
      ...headers,
      cookie: csrf.cookie,
      "content-type": "application/x-www-form-urlencoded",
    };
    const rejectedSourceHeaders = [
      csrfHeaders,
      { ...csrfHeaders, origin: "null", "sec-fetch-site": "same-origin" },
      { ...csrfHeaders, origin: "http://app.invalid", "sec-fetch-site": "same-origin" },
      { ...csrfHeaders, origin: "https://other.invalid", "sec-fetch-site": "same-origin" },
      { ...csrfHeaders, origin: "https://sub.app.invalid", "sec-fetch-site": "same-origin" },
      { ...csrfHeaders, origin: "https://app.invalid:8443", "sec-fetch-site": "same-origin" },
      { ...csrfHeaders, origin: "https://app.invalid/", "sec-fetch-site": "same-origin" },
      { ...csrfHeaders, origin: "https://app.invalid", "sec-fetch-site": "same-site" },
      { ...csrfHeaders, origin: "https://app.invalid", "sec-fetch-site": "cross-site" },
      { ...csrfHeaders, origin: "https://app.invalid", "sec-fetch-site": "none" },
      { ...csrfHeaders, "sec-fetch-site": "same-site" },
      { ...csrfHeaders, "sec-fetch-site": "cross-site" },
      { ...csrfHeaders, "sec-fetch-site": "none" },
    ];
    const rejectedRequests = [
      new Request("https://app.invalid/__ops/e5/youtube-oauth/start", { method: "POST", headers }),
      ...rejectedSourceHeaders.map((rejectedHeaders) => new Request(
        "https://app.invalid/__ops/e5/youtube-oauth/start",
        { method: "POST", headers: rejectedHeaders, body: csrfForm(csrf.token) },
      )),
      new Request("https://app.invalid/__ops/e5/youtube-oauth/start", {
        method: "POST", headers: validMutationHeaders, body: "",
      }),
      new Request("https://app.invalid/__ops/e5/youtube-oauth/start", {
        method: "POST", headers: validMutationHeaders, body: csrfForm("A".repeat(43)),
      }),
      new Request("https://app.invalid/__ops/e5/youtube-oauth/start", {
        method: "POST", headers: { ...validMutationHeaders, cookie: `${csrf.cookie}; ${csrf.cookie}` },
        body: csrfForm(csrf.token),
      }),
      new Request("https://app.invalid/__ops/e5/youtube-oauth/start", {
        method: "POST", headers: { ...validMutationHeaders, cookie: "__Host-e5-oauth-csrf=invalid" },
        body: csrfForm(csrf.token),
      }),
      new Request("https://app.invalid/__ops/e5/youtube-oauth/start", {
        method: "POST", headers: { ...validMutationHeaders, "content-type": "application/json" },
        body: JSON.stringify({ csrf_token: csrf.token }),
      }),
      new Request("https://app.invalid/__ops/e5/youtube-oauth/start", {
        method: "POST", headers: validMutationHeaders, body: `csrf_token=${csrf.token}&padding=${"x".repeat(1100)}`,
      }),
    ];
    for (const rejectedRequest of rejectedRequests) {
      const rejected = await handleE5YoutubeOAuthHttp(
        rejectedRequest, settings, fetcher as typeof fetch,
      );
      expect(rejected.status).toBe(404);
    }
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM youtube_oauth_attempts").first())
      .toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT generation, operation FROM youtube_oauth_control").first())
      .toEqual({ generation: 0, operation: "READY" });

    const start = await handleE5YoutubeOAuthHttp(
      new Request("https://app.invalid/__ops/e5/youtube-oauth/start", {
        method: "POST", headers: validMutationHeaders, body: csrfForm(csrf.token),
      }), settings, fetcher as typeof fetch,
    );
    expect(start.status).toBe(303);
    expect(start.headers.get("referrer-policy")).toBe("no-referrer");
    expect(start.headers.get("set-cookie")).toContain("Max-Age=0");
    const consent = new URL(start.headers.get("location")!);
    expect(consent.origin).toBe("https://accounts.google.com");
    const callback = new URL(settings.YOUTUBE_OAUTH_REDIRECT_URI!);
    callback.searchParams.set("state", consent.searchParams.get("state")!);
    callback.searchParams.set("code", "runtime-route-code");
    const completed = await handleE5YoutubeOAuthHttp(
      new Request(callback, { headers }), settings, fetcher as typeof fetch,
    );
    expect(completed.status).toBe(303);
    expect(completed.headers.get("location")).toBe("https://app.invalid/__ops/e5/youtube-oauth/status");
    const status = await handleE5YoutubeOAuthHttp(
      new Request("https://app.invalid/__ops/e5/youtube-oauth/status", { headers }), settings, fetcher as typeof fetch,
    );
    expect(await status.json()).toEqual({ status: "CONNECTED" });
    const auditsBeforeRefresh = await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits",
    ).first();
    const refreshCsrf = await csrfMaterial(settings, headers, fetcher as typeof fetch);
    const refreshHeaders = {
      ...headers, ...sourceHeaders, cookie: refreshCsrf.cookie,
      "content-type": "application/x-www-form-urlencoded",
    };
    const refreshCsrfHeaders = {
      ...headers, cookie: refreshCsrf.cookie,
      "content-type": "application/x-www-form-urlencoded",
    };
    for (const rejectedHeaders of [
      headers,
      { ...refreshHeaders, cookie: "__Host-e5-oauth-csrf=invalid" },
      ...rejectedSourceHeaders.map(({ cookie: _cookie, ...sourceHeaders }) => ({
        ...sourceHeaders,
        cookie: refreshCsrf.cookie,
      })),
      refreshCsrfHeaders,
    ]) {
      const rejected = await handleE5YoutubeOAuthHttp(
        new Request("https://app.invalid/__ops/e5/youtube-oauth/refresh", {
          method: "POST", headers: rejectedHeaders,
          ...(rejectedHeaders === headers ? {} : { body: csrfForm(refreshCsrf.token) }),
        }), settings, fetcher as typeof fetch,
      );
      expect(rejected.status).toBe(404);
    }
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM youtube_oauth_audits").first())
      .toEqual(auditsBeforeRefresh);
    expect(await env.DB.prepare("SELECT status FROM youtube_oauth_credentials").first())
      .toEqual({ status: "CONNECTED" });
    const refreshed = await handleE5YoutubeOAuthHttp(
      new Request("https://app.invalid/__ops/e5/youtube-oauth/refresh", {
        method: "POST", headers: refreshHeaders, body: csrfForm(refreshCsrf.token),
      }), settings, fetcher as typeof fetch,
    );
    expect(await refreshed.json()).toEqual({ status: "CONNECTED" });
    expect(refreshed.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE action = 'oauth.refreshed'",
    ).first()).toEqual({ count: 1 });

    const auditsBeforeRevoke = await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits",
    ).first();
    const revokeCsrf = await csrfMaterial(settings, headers, fetcher as typeof fetch);
    const revokeHeaders = {
      ...headers, ...sourceHeaders, cookie: revokeCsrf.cookie,
      "content-type": "application/x-www-form-urlencoded",
    };
    const revokeCsrfHeaders = {
      ...headers, cookie: revokeCsrf.cookie,
      "content-type": "application/x-www-form-urlencoded",
    };
    for (const rejectedHeaders of [
      headers,
      { ...revokeHeaders, cookie: "__Host-e5-oauth-csrf=invalid" },
      ...rejectedSourceHeaders.map(({ cookie: _cookie, ...sourceHeaders }) => ({
        ...sourceHeaders,
        cookie: revokeCsrf.cookie,
      })),
      revokeCsrfHeaders,
    ]) {
      const rejected = await handleE5YoutubeOAuthHttp(
        new Request("https://app.invalid/__ops/e5/youtube-oauth/revoke", {
          method: "POST", headers: rejectedHeaders,
          ...(rejectedHeaders === headers ? {} : { body: csrfForm(revokeCsrf.token) }),
        }), settings, fetcher as typeof fetch,
      );
      expect(rejected.status).toBe(404);
    }
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM youtube_oauth_audits").first())
      .toEqual(auditsBeforeRevoke);
    expect(await env.DB.prepare("SELECT status FROM youtube_oauth_credentials").first())
      .toEqual({ status: "CONNECTED" });
    const revoked = await handleE5YoutubeOAuthHttp(
      new Request("https://app.invalid/__ops/e5/youtube-oauth/revoke", {
        method: "POST", headers: revokeHeaders, body: csrfForm(revokeCsrf.token),
      }), settings, fetcher as typeof fetch,
    );
    expect(await revoked.json()).toEqual({ status: "REVOKED" });
    expect(revoked.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE action = 'oauth.revoked'",
    ).first()).toEqual({ count: 1 });
    const exposed = JSON.stringify([
      await env.DB.prepare("SELECT action, reason_code, actor_subject_fingerprint FROM youtube_oauth_audits").all(),
      await handleE5YoutubeOAuthHttp(
        new Request("https://app.invalid/__ops/e5/youtube-oauth/status", { headers }),
        settings,
        fetcher as typeof fetch,
      ).then((response) => response.text()),
    ]);
    expect(exposed).not.toContain(EXPECTED_CHANNEL);
    expect(exposed).not.toContain(settings.YOUTUBE_OAUTH_CLIENT_SECRET!);
    expect(exposed).not.toContain("runtime-route-access");
    expect(exposed).not.toContain("runtime-route-refresh");
    expect(JSON.stringify([...fetcher.mock.calls])).not.toContain(EMAIL);
  });

  it("retries a temporary status read after callback and never misreports a display failure as OAuth ERROR", async () => {
    const token = await jwt();
    const headers = { "cf-access-jwt-assertion": token };
    const settings = routeEnv();
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/cdn-cgi/access/certs")) return jwksResponse();
      if (url.includes("oauth2.googleapis.com/token")) return Response.json({
        access_token: "temporary-status-access", refresh_token: "temporary-status-refresh",
        expires_in: 3600, scope: "https://www.googleapis.com/auth/youtube.readonly",
      });
      if (url.includes("youtube/v3/channels")) {
        return Response.json({ items: [{ id: EXPECTED_CHANNEL }] });
      }
      throw new Error("unexpected external endpoint");
    });
    const csrf = await csrfMaterial(settings, headers, fetcher as typeof fetch);
    const started = await handleE5YoutubeOAuthHttp(
      new Request("https://app.invalid/__ops/e5/youtube-oauth/start", {
        method: "POST",
        headers: {
          ...headers,
          origin: "https://app.invalid",
          "sec-fetch-site": "same-origin",
          cookie: csrf.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: csrfForm(csrf.token),
      }),
      settings,
      fetcher as typeof fetch,
    );
    const consent = new URL(started.headers.get("location")!);
    const state = consent.searchParams.get("state")!;
    const authorizationCode = "temporary-status-code";
    const callback = new URL(settings.YOUTUBE_OAUTH_REDIRECT_URI!);
    callback.searchParams.set("state", state);
    callback.searchParams.set("code", authorizationCode);
    clearOAuthLogs();
    const completed = await handleE5YoutubeOAuthHttp(
      new Request(callback, { headers }), settings, fetcher as typeof fetch,
    );
    expect(completed.status).toBe(303);
    expect(completed.headers.get("location")).toBe("https://app.invalid/__ops/e5/youtube-oauth/status");
    expect(oauthLogRecords()).toEqual([{
      event: "YOUTUBE_OAUTH_HTTP", stage: "CALLBACK", outcome: "STARTED", reason: "CODE_RECEIVED",
    }, {
      event: "YOUTUBE_OAUTH_HTTP", stage: "CALLBACK", outcome: "SUCCEEDED", reason: "CONNECTED",
    }]);
    expectFixedOAuthLogs(oauthLogRecords());
    expect(JSON.stringify(oauthLogRecords())).not.toContain(state);
    expect(JSON.stringify(oauthLogRecords())).not.toContain(authorizationCode);

    const expectReplayLog = async (reason: string): Promise<void> => {
      clearOAuthLogs();
      const replayed = await handleE5YoutubeOAuthHttp(
        new Request(callback, { headers }), settings, fetcher as typeof fetch,
      );
      expect(replayed.status).toBe(303);
      expect(oauthLogRecords()).toEqual([{
        event: "YOUTUBE_OAUTH_HTTP", stage: "CALLBACK", outcome: "STARTED", reason: "CODE_RECEIVED",
      }, {
        event: "YOUTUBE_OAUTH_HTTP", stage: "CALLBACK", outcome: "REPLAYED", reason,
      }]);
      expectFixedOAuthLogs(oauthLogRecords());
      expect(JSON.stringify(oauthLogRecords())).not.toContain(state);
      expect(JSON.stringify(oauthLogRecords())).not.toContain(authorizationCode);
    };
    await expectReplayLog("CURRENT_CONNECTED");
    await env.DB.prepare(
      "UPDATE youtube_oauth_credentials SET token_expires_at = '1970-01-01T00:00:00.000Z'",
    ).run();
    await expectReplayLog("CURRENT_REFRESH_REQUIRED");
    await env.DB.prepare(
      "UPDATE youtube_oauth_control SET operation = 'ERROR', operation_owner = NULL, operation_expires_at = NULL",
    ).run();
    await expectReplayLog("CURRENT_ERROR");
    await env.DB.prepare(
      "UPDATE youtube_oauth_control SET operation = 'STARTING', operation_owner = 'replay-test-owner', operation_expires_at = '2999-01-01T00:00:00.000Z'",
    ).run();
    await expectReplayLog("CURRENT_PENDING");
    await env.DB.prepare(
      "UPDATE youtube_oauth_control SET operation = 'READY', operation_owner = NULL, operation_expires_at = NULL",
    ).run();
    await env.DB.prepare(
      "UPDATE youtube_oauth_credentials SET token_expires_at = '2999-01-01T00:00:00.000Z'",
    ).run();
    const googleCallsAfterCallback = fetcher.mock.calls.filter(
      ([input]) => !String(input).includes("/cdn-cgi/access/certs"),
    ).length;

    clearOAuthLogs();
    const temporary = failStatusReads(env.DB, 1);
    const recovered = await handleE5YoutubeOAuthHttp(
      new Request("https://app.invalid/__ops/e5/youtube-oauth/status", { headers }),
      { ...settings, DB: temporary.db },
      fetcher as typeof fetch,
    );
    expect(temporary.failures()).toBe(1);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ status: "CONNECTED" });
    expect(oauthLogRecords()).toEqual([{
      event: "YOUTUBE_OAUTH_HTTP", stage: "STATUS", outcome: "RETRYING", reason: "READ_FAILED",
    }]);

    clearOAuthLogs();
    const unavailableReads = failStatusReads(env.DB, 2);
    const unavailable = await handleE5YoutubeOAuthHttp(
      new Request("https://app.invalid/__ops/e5/youtube-oauth/status", { headers }),
      { ...settings, DB: unavailableReads.db },
      fetcher as typeof fetch,
    );
    const unavailableBody = await unavailable.text();
    expect(unavailableReads.failures()).toBe(2);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect(unavailable.headers.get("referrer-policy")).toBe("no-referrer");
    expect(unavailable.headers.get("x-content-type-options")).toBe("nosniff");
    expect(JSON.parse(unavailableBody)).toEqual({ status: "UNAVAILABLE" });
    expect(unavailableBody).not.toContain(state);
    expect(unavailableBody).not.toContain(authorizationCode);
    expect(oauthLogRecords()).toEqual([{
      event: "YOUTUBE_OAUTH_HTTP", stage: "STATUS", outcome: "RETRYING", reason: "READ_FAILED",
    }, {
      event: "YOUTUBE_OAUTH_HTTP", stage: "STATUS", outcome: "UNAVAILABLE", reason: "READ_FAILED",
    }]);
    expectFixedOAuthLogs(oauthLogRecords());
    expect(JSON.stringify(oauthLogRecords())).not.toContain(state);
    expect(JSON.stringify(oauthLogRecords())).not.toContain(authorizationCode);
    clearOAuthLogs();
    const visibleAgain = await handleE5YoutubeOAuthHttp(
      new Request("https://app.invalid/__ops/e5/youtube-oauth/status", { headers }),
      settings,
      fetcher as typeof fetch,
    );
    expect(visibleAgain.status).toBe(200);
    expect(await visibleAgain.json()).toEqual({ status: "CONNECTED" });
    expect(oauthLogRecords()).toEqual([]);
    expect(await env.DB.prepare(
      "SELECT status, failure_code FROM youtube_oauth_attempts",
    ).first()).toEqual({ status: "COMPLETED", failure_code: null });
    expect(await env.DB.prepare(
      "SELECT status, last_error_code FROM youtube_oauth_credentials",
    ).first()).toEqual({ status: "CONNECTED", last_error_code: null });
    expect(await env.DB.prepare(
      "SELECT generation, operation FROM youtube_oauth_control",
    ).first()).toEqual({ generation: 1, operation: "READY" });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE action = 'oauth.connected'",
    ).first()).toEqual({ count: 1 });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE action = 'oauth.failed'",
    ).first()).toEqual({ count: 0 });
    expect(fetcher.mock.calls.filter(
      ([input]) => !String(input).includes("/cdn-cgi/access/certs"),
    )).toHaveLength(googleCallsAfterCallback);
    expect(JSON.stringify(fetcher.mock.calls)).not.toMatch(/videos|upload|resumable/u);

    await env.DB.prepare(
      `UPDATE youtube_oauth_credentials SET status = 'REVOKED',
         access_token_ciphertext = NULL, refresh_token_ciphertext = NULL,
         token_expires_at = NULL, operation_expires_at = NULL`,
    ).run();
    await expectReplayLog("CURRENT_REVOKED");
    expect(await env.DB.prepare(
      "SELECT COUNT(*) count FROM youtube_oauth_audits WHERE action = 'oauth.replayed'",
    ).first()).toEqual({ count: 5 });
  });

  it("handles a denied callback without token exchange and removes query values from the redirect", async () => {
    const token = await jwt();
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/cdn-cgi/access/certs")) return jwksResponse();
      throw new Error("Google API must not be called");
    });
    const headers = { "cf-access-jwt-assertion": token };
    const settings = routeEnv();
    const csrf = await csrfMaterial(settings, headers, fetcher as typeof fetch);
    const start = await handleE5YoutubeOAuthHttp(
      new Request("https://app.invalid/__ops/e5/youtube-oauth/start", {
        method: "POST",
        headers: {
          ...headers,
          origin: "https://app.invalid",
          cookie: csrf.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: csrfForm(csrf.token),
      }), settings, fetcher as typeof fetch,
    );
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const denied = await handleE5YoutubeOAuthHttp(
      new Request(`https://app.invalid/__ops/e5/youtube-oauth/callback?error=access_denied&state=${encodeURIComponent(state)}`, { headers }),
      settings,
      fetcher as typeof fetch,
    );
    expect(denied.status).toBe(303);
    expect(denied.headers.get("location")).toBe("https://app.invalid/__ops/e5/youtube-oauth/status");
    expect(oauthLogRecords()).toEqual([{
      event: "YOUTUBE_OAUTH_HTTP", stage: "CALLBACK", outcome: "STARTED", reason: "CONSENT_DENIAL_RECEIVED",
    }, {
      event: "YOUTUBE_OAUTH_HTTP", stage: "CALLBACK", outcome: "REJECTED", reason: "CONSENT_DENIED",
    }]);
    clearOAuthLogs();
    const replayed = await handleE5YoutubeOAuthHttp(
      new Request(`https://app.invalid/__ops/e5/youtube-oauth/callback?error=access_denied&state=${encodeURIComponent(state)}`, { headers }),
      settings,
      fetcher as typeof fetch,
    );
    expect(replayed.status).toBe(303);
    expect(oauthLogRecords()).toEqual([{
      event: "YOUTUBE_OAUTH_HTTP", stage: "CALLBACK", outcome: "STARTED", reason: "CONSENT_DENIAL_RECEIVED",
    }, {
      event: "YOUTUBE_OAUTH_HTTP", stage: "CALLBACK", outcome: "REPLAYED", reason: "CURRENT_NOT_CONNECTED",
    }]);
    expectFixedOAuthLogs(oauthLogRecords());
    expect(JSON.stringify(oauthLogRecords())).not.toContain(state);

    clearOAuthLogs();
    const usedByCode = await handleE5YoutubeOAuthHttp(
      new Request(`https://app.invalid/__ops/e5/youtube-oauth/callback?code=unused-code-marker&state=${encodeURIComponent(state)}`, { headers }),
      settings,
      fetcher as typeof fetch,
    );
    expect(usedByCode.status).toBe(303);
    expect(oauthLogRecords()).toEqual([{
      event: "YOUTUBE_OAUTH_HTTP", stage: "CALLBACK", outcome: "STARTED", reason: "CODE_RECEIVED",
    }, {
      event: "YOUTUBE_OAUTH_HTTP", stage: "CALLBACK", outcome: "REJECTED", reason: "STATE_ALREADY_USED",
    }]);
    expectFixedOAuthLogs(oauthLogRecords());
    expect(JSON.stringify(oauthLogRecords())).not.toContain(state);
    expect(JSON.stringify(oauthLogRecords())).not.toContain("unused-code-marker");
    expect(fetcher.mock.calls.filter(([input]) => !String(input).includes("/cdn-cgi/access/certs"))).toHaveLength(0);
  });
});
