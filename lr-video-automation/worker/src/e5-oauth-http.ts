import { CloudflareAccessError, CloudflareAccessVerifier } from "./cloudflare-access";
import {
  E5YoutubeOAuthService,
  YoutubeOAuthError,
  type YoutubeOAuthCallbackResult,
  type YoutubeOAuthStatusName,
} from "./e5-youtube-oauth";
import { GoogleYoutubeOAuthProvider } from "./google-youtube-oauth-provider";

const PREFIX = "/__ops/e5/youtube-oauth";
const GOOGLE_OAUTH_ORIGIN = "https://accounts.google.com";
const CSRF_COOKIE_NAME = "__Host-e5-oauth-csrf";
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_FORM_BODY_BYTES = 1_024;
const STATUS_READ_ATTEMPTS = 2;
type OAuthDiagnosticStage =
  | "CONFIG_INVALID"
  | "REDIRECT_INVALID"
  | "ACCESS_REJECTED"
  | "SERVICE_INIT_FAILED"
  | "MUTATION_REJECTED";
type OAuthAccessDiagnosticReason =
  | "TOKEN_MISSING"
  | "JWT_INVALID"
  | "CLAIMS_INVALID"
  | "SIGNATURE_INVALID"
  | "JWKS_TIMEOUT"
  | "JWKS_FETCH_FAILED"
  | "JWKS_HTTP_REJECTED"
  | "JWKS_INVALID"
  | "JWK_NOT_FOUND"
  | "JWK_IMPORT_FAILED"
  | "ALLOWLIST_DENIED"
  | "ACCESS_CONFIG_INVALID";
type OAuthMutationDiagnosticReason =
  | "ORIGIN_REJECTED"
  | "CSRF_COOKIE_MISSING_OR_INVALID"
  | "FORM_CONTENT_TYPE_REJECTED"
  | "FORM_BODY_REJECTED"
  | "CSRF_TOKEN_MISSING_OR_INVALID"
  | "CSRF_TOKEN_MISMATCH";
type OAuthDiagnosticReason = OAuthAccessDiagnosticReason | OAuthMutationDiagnosticReason;
type OAuthLogStage = "REQUEST_GATE" | "CALLBACK" | "STATUS";
type OAuthLogOutcome = "STARTED" | "SUCCEEDED" | "REJECTED" | "REPLAYED" | "RETRYING" | "UNAVAILABLE";
type OAuthLogReason =
  | "CONFIG_INVALID"
  | "REDIRECT_INVALID"
  | "ACCESS_REJECTED"
  | "SERVICE_INIT_FAILED"
  | OAuthAccessDiagnosticReason
  | OAuthMutationDiagnosticReason
  | "CODE_RECEIVED"
  | "CONSENT_DENIAL_RECEIVED"
  | "CONNECTED"
  | "CONSENT_DENIED"
  | "STATE_REJECTED"
  | "STATE_ALREADY_USED"
  | "OPERATION_IN_PROGRESS"
  | "TOKEN_EXCHANGE_REJECTED"
  | "SCOPE_REJECTED"
  | "CHANNEL_REJECTED"
  | "PERSISTENCE_REJECTED"
  | "UNEXPECTED_FAILURE"
  | "READ_FAILED"
  | "CURRENT_NOT_CONNECTED"
  | "CURRENT_PENDING"
  | "CURRENT_CONNECTED"
  | "CURRENT_REFRESH_REQUIRED"
  | "CURRENT_REVOKED"
  | "CURRENT_ERROR";
type MutationValidation =
  | { ok: true }
  | { ok: false; reason: OAuthMutationDiagnosticReason };

interface OAuthHttpConfig {
  accessTeamDomain: string;
  accessAudience: string;
  allowedEmails: string[];
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
  expectedChannelId: string;
  redirectUri: string;
}

function oauthLog(stage: OAuthLogStage, outcome: OAuthLogOutcome, reason: OAuthLogReason): void {
  // Keep this record closed over fixed enum values. Request data, identifiers,
  // exceptions, provider responses, and authentication material must never be added.
  const record = { event: "YOUTUBE_OAUTH_HTTP", stage, outcome, reason } as const;
  if (outcome === "STARTED" || outcome === "SUCCEEDED") console.info(record);
  else console.warn(record);
}

function oauthErrorHeaders(contentType: string): HeadersInit {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function config(env: Env): OAuthHttpConfig | null {
  const values = {
    accessTeamDomain: env.CLOUDFLARE_ACCESS_TEAM_DOMAIN,
    accessAudience: env.CLOUDFLARE_ACCESS_AUD,
    allowedEmails: env.YOUTUBE_OAUTH_ALLOWED_EMAILS?.split(",").map((value) => value.trim()).filter(Boolean),
    clientId: env.YOUTUBE_OAUTH_CLIENT_ID,
    clientSecret: env.YOUTUBE_OAUTH_CLIENT_SECRET,
    encryptionKey: env.YOUTUBE_OAUTH_ENCRYPTION_KEY,
    expectedChannelId: env.YOUTUBE_EXPECTED_CHANNEL_ID,
    redirectUri: env.YOUTUBE_OAUTH_REDIRECT_URI,
  };
  if (!values.accessTeamDomain || !values.accessAudience || !values.allowedEmails?.length
    || !values.clientId || !values.clientSecret || !values.encryptionKey
    || !values.expectedChannelId || !values.redirectUri) return null;
  return values as OAuthHttpConfig;
}

function accessDiagnosticReason(error: unknown): OAuthAccessDiagnosticReason | undefined {
  if (!(error instanceof CloudflareAccessError)) return undefined;
  const reasons: Readonly<Record<string, OAuthAccessDiagnosticReason>> = {
    ACCESS_JWT_MISSING: "TOKEN_MISSING",
    ACCESS_JWT_INVALID: "JWT_INVALID",
    ACCESS_CLAIMS_INVALID: "CLAIMS_INVALID",
    ACCESS_JWT_SIGNATURE_INVALID: "SIGNATURE_INVALID",
    ACCESS_JWKS_TIMEOUT: "JWKS_TIMEOUT",
    ACCESS_JWKS_FETCH_FAILED: "JWKS_FETCH_FAILED",
    ACCESS_JWKS_HTTP_REJECTED: "JWKS_HTTP_REJECTED",
    ACCESS_JWKS_INVALID: "JWKS_INVALID",
    ACCESS_JWK_NOT_FOUND: "JWK_NOT_FOUND",
    ACCESS_JWK_IMPORT_FAILED: "JWK_IMPORT_FAILED",
    ACCESS_DENIED: "ALLOWLIST_DENIED",
    ACCESS_CONFIG_INVALID: "ACCESS_CONFIG_INVALID",
  };
  return reasons[error.code];
}

export function classifyOAuthCallbackFailureForLog(error: unknown): OAuthLogReason {
  if (!(error instanceof YoutubeOAuthError)) return "UNEXPECTED_FAILURE";
  switch (error.code) {
    case "OAUTH_STATE_INVALID":
    case "OAUTH_STATE_EXPIRED":
      return "STATE_REJECTED";
    case "OAUTH_STATE_USED":
      return "STATE_ALREADY_USED";
    case "OAUTH_CALLBACK_IN_PROGRESS":
      return "OPERATION_IN_PROGRESS";
    case "OAUTH_SCOPE_MISMATCH":
      return "SCOPE_REJECTED";
    case "CHANNEL_COUNT_INVALID":
    case "CHANNEL_MISMATCH":
    case "CHANNEL_LOOKUP_FAILED":
    case "CHANNEL_RESPONSE_INVALID":
      return "CHANNEL_REJECTED";
    case "OAUTH_STATE_PERSIST_FAILED":
    case "OAUTH_CALLBACK_COMMIT_AMBIGUOUS":
    case "OAUTH_DENIAL_PERSIST_FAILED":
    case "OAUTH_GENERATION_STALE":
      return "PERSISTENCE_REJECTED";
    case "OAUTH_TOKEN_RESPONSE_INVALID":
    case "OAUTH_TOKEN_REQUEST_FAILED":
    case "OAUTH_GRANT_INVALID":
    case "TOKEN_EXPIRY_INVALID":
      return "TOKEN_EXCHANGE_REJECTED";
    default:
      // OAUTH_EXCHANGE_FAILED is deliberately included here: it wraps unknown
      // PKCE, encryption, D1, and post-commit confirmation failures, so the
      // HTTP boundary must not claim that token exchange was the failed stage.
      return "UNEXPECTED_FAILURE";
  }
}

function currentStatusLogReason(status: YoutubeOAuthStatusName): OAuthLogReason {
  const reasons: Readonly<Record<YoutubeOAuthStatusName, OAuthLogReason>> = {
    NOT_CONNECTED: "CURRENT_NOT_CONNECTED",
    PENDING: "CURRENT_PENDING",
    CONNECTED: "CURRENT_CONNECTED",
    REFRESH_REQUIRED: "CURRENT_REFRESH_REQUIRED",
    REVOKED: "CURRENT_REVOKED",
    ERROR: "CURRENT_ERROR",
  };
  return reasons[status];
}

function logCodeCallbackResult(result: YoutubeOAuthCallbackResult): void {
  if (result.replayed) {
    oauthLog("CALLBACK", "REPLAYED", currentStatusLogReason(result.status));
  } else if (result.status === "CONNECTED") {
    oauthLog("CALLBACK", "SUCCEEDED", "CONNECTED");
  } else {
    oauthLog("CALLBACK", "REJECTED", "UNEXPECTED_FAILURE");
  }
}

function logDeniedCallbackResult(result: YoutubeOAuthCallbackResult): void {
  if (result.replayed) {
    oauthLog("CALLBACK", "REPLAYED", currentStatusLogReason(result.status));
  } else {
    oauthLog("CALLBACK", "REJECTED", "CONSENT_DENIED");
  }
}

function notFound(
  env: Env,
  diagnosticStage?: OAuthDiagnosticStage,
  diagnosticReason?: OAuthDiagnosticReason,
): Response {
  if (env.YOUTUBE_OAUTH_DIAGNOSTICS_ENABLED !== "true" || !diagnosticStage) {
    return new Response("Not found", {
      status: 404,
      headers: oauthErrorHeaders("text/plain;charset=UTF-8"),
    });
  }
  return new Response(JSON.stringify({
    status: "NOT_FOUND",
    diagnosticStage,
    ...(diagnosticReason ? { diagnosticReason } : {}),
  }), {
    status: 404,
    headers: oauthErrorHeaders("application/json; charset=utf-8"),
  });
}

function statusResponse(status: string): Response {
  return new Response(JSON.stringify({ status }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function statusUnavailableResponse(): Response {
  return new Response(JSON.stringify({ status: "UNAVAILABLE" }), {
    status: 503,
    headers: oauthErrorHeaders("application/json; charset=utf-8"),
  });
}

async function readStatusForDisplay(service: E5YoutubeOAuthService): Promise<string> {
  // The callback redirects to a separate, queryless request. A transient D1 read
  // failure in that display request must not be presented as durable OAuth ERROR.
  for (let attempt = 1; attempt <= STATUS_READ_ATTEMPTS; attempt += 1) {
    try {
      return (await service.status()).status;
    } catch (error) {
      if (error instanceof YoutubeOAuthError || attempt === STATUS_READ_ATTEMPTS) throw error;
      oauthLog("STATUS", "RETRYING", "READ_FAILED");
    }
  }
  throw new Error("OAUTH_STATUS_UNAVAILABLE");
}

function csrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function csrfCookie(value: string, maxAge: number): string {
  return `${CSRF_COOKIE_NAME}=${value}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function startConfirmationResponse(): Response {
  const token = csrfToken();
  const body = `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>YouTube接続の確認</title></head>
<body>
<main>
<h1>YouTube接続の確認</h1>
<p>会社指定のGoogleアカウントと読み取り専用権限を確認し、問題がなければ開始してください。</p>
<form method="post" action="${PREFIX}/start"><input type="hidden" name="csrf_token" value="${token}"><button type="submit">Googleの同意画面へ進む</button></form>
</main>
</body>
</html>`;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; form-action 'self' ${GOOGLE_OAUTH_ORIGIN}; frame-ancestors 'none'; base-uri 'none'`,
      "set-cookie": csrfCookie(token, 600),
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

function redirectMatchesWorker(request: Request, redirectUri: string): boolean {
  try {
    const requestUrl = new URL(request.url);
    const redirect = new URL(redirectUri);
    return redirect.protocol === "https:"
      && redirect.origin === requestUrl.origin
      && redirect.pathname === `${PREFIX}/callback`
      && redirect.search === ""
      && redirect.hash === ""
      && redirect.username === ""
      && redirect.password === "";
  } catch {
    return false;
  }
}

function requestOriginIsSafe(request: Request, expectedOrigin: string): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") return false;
  if (origin !== null) return origin === expectedOrigin;
  return fetchSite === "same-origin";
}

function csrfCookieValue(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const values: string[] = [];
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === CSRF_COOKIE_NAME) values.push(rest.join("="));
  }
  if (values.length !== 1 || !CSRF_TOKEN_PATTERN.test(values[0]!)) return null;
  return values[0]!;
}

function constantTimeTokenEqual(left: string, right: string): boolean {
  if (!CSRF_TOKEN_PATTERN.test(left) || !CSRF_TOKEN_PATTERN.test(right)) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function limitedFormBody(request: Request): Promise<string | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_FORM_BODY_BYTES)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_FORM_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  return body + decoder.decode();
}

async function validateMutationRequest(request: Request, expectedOrigin: string): Promise<MutationValidation> {
  if (!requestOriginIsSafe(request, expectedOrigin)) return { ok: false, reason: "ORIGIN_REJECTED" };
  const cookie = csrfCookieValue(request);
  if (!cookie) return { ok: false, reason: "CSRF_COOKIE_MISSING_OR_INVALID" };
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    return { ok: false, reason: "FORM_CONTENT_TYPE_REJECTED" };
  }
  let body: string | null;
  try {
    body = await limitedFormBody(request);
  } catch {
    body = null;
  }
  if (body === null) return { ok: false, reason: "FORM_BODY_REJECTED" };
  const params = new URLSearchParams(body);
  const tokens = params.getAll("csrf_token");
  if (tokens.length !== 1 || !CSRF_TOKEN_PATTERN.test(tokens[0]!)
    || [...params.keys()].some((key) => key !== "csrf_token")) {
    return { ok: false, reason: "CSRF_TOKEN_MISSING_OR_INVALID" };
  }
  if (!constantTimeTokenEqual(tokens[0]!, cookie)) {
    return { ok: false, reason: "CSRF_TOKEN_MISMATCH" };
  }
  return { ok: true };
}

function redirectToStatus(request: Request): Response {
  const destination = new URL(`${PREFIX}/status`, request.url);
  return new Response(null, {
    status: 303,
    headers: {
      location: destination.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

export async function handleE5YoutubeOAuthHttp(
  request: Request,
  env: Env,
  fetcher: typeof fetch = fetch,
  accessFetchTimeoutMs?: number,
): Promise<Response> {
  const settings = config(env);
  if (!settings) {
    oauthLog("REQUEST_GATE", "REJECTED", "CONFIG_INVALID");
    return notFound(env, "CONFIG_INVALID");
  }
  if (!redirectMatchesWorker(request, settings.redirectUri)) {
    oauthLog("REQUEST_GATE", "REJECTED", "REDIRECT_INVALID");
    return notFound(env, "REDIRECT_INVALID");
  }
  let access;
  try {
    access = await new CloudflareAccessVerifier({
      teamDomain: settings.accessTeamDomain,
      audience: settings.accessAudience,
      allowedEmails: settings.allowedEmails,
    }, fetcher, undefined, accessFetchTimeoutMs).verify(request);
  } catch (error) {
    const reason = accessDiagnosticReason(error);
    oauthLog("REQUEST_GATE", "REJECTED", reason ?? "ACCESS_REJECTED");
    return notFound(env, "ACCESS_REJECTED", reason);
  }
  let service: E5YoutubeOAuthService;
  try {
    service = new E5YoutubeOAuthService(
      env.DB,
      new GoogleYoutubeOAuthProvider(settings.clientId, settings.clientSecret, fetcher),
      {
        clientId: settings.clientId,
        redirectUri: settings.redirectUri,
        expectedChannelId: settings.expectedChannelId,
        encryptionKey: settings.encryptionKey,
      },
      access,
    );
  } catch {
    oauthLog("REQUEST_GATE", "REJECTED", "SERVICE_INIT_FAILED");
    return notFound(env, "SERVICE_INIT_FAILED");
  }
  const url = new URL(request.url);
  try {
    if (url.pathname === `${PREFIX}/start` && request.method === "GET") {
      return startConfirmationResponse();
    }
    if (url.pathname === `${PREFIX}/start` && request.method === "POST") {
      const expectedOrigin = new URL(settings.redirectUri).origin;
      const validation = await validateMutationRequest(request, expectedOrigin);
      if (!validation.ok) {
        oauthLog("REQUEST_GATE", "REJECTED", validation.reason);
        return notFound(env, "MUTATION_REJECTED", validation.reason);
      }
      const started = await service.start();
      return new Response(null, {
        status: 303,
        headers: {
          location: started.authorizationUrl,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "set-cookie": csrfCookie("", 0),
        },
      });
    }
    if (url.pathname === `${PREFIX}/callback` && request.method === "GET") {
      const state = url.searchParams.get("state") ?? "";
      if (url.searchParams.has("error")) {
        oauthLog("CALLBACK", "STARTED", "CONSENT_DENIAL_RECEIVED");
        logDeniedCallbackResult(await service.denyCallback({ state }));
      } else {
        oauthLog("CALLBACK", "STARTED", "CODE_RECEIVED");
        logCodeCallbackResult(await service.callback({
          state,
          authorizationCode: url.searchParams.get("code") ?? "",
        }));
      }
      return redirectToStatus(request);
    }
    if (url.pathname === `${PREFIX}/status` && request.method === "GET") {
      try {
        return statusResponse(await readStatusForDisplay(service));
      } catch (error) {
        if (error instanceof YoutubeOAuthError) throw error;
        oauthLog("STATUS", "UNAVAILABLE", "READ_FAILED");
        return statusUnavailableResponse();
      }
    }
    if ((url.pathname === `${PREFIX}/refresh` || url.pathname === `${PREFIX}/revoke`)
      && request.method === "POST") {
      const expectedOrigin = new URL(settings.redirectUri).origin;
      const validation = await validateMutationRequest(request, expectedOrigin);
      if (!validation.ok) {
        oauthLog("REQUEST_GATE", "REJECTED", validation.reason);
        return notFound(env, "MUTATION_REJECTED", validation.reason);
      }
      const result = url.pathname.endsWith("/refresh")
        ? await service.refresh()
        : await service.revoke();
      const response = statusResponse(result.status);
      response.headers.set("set-cookie", csrfCookie("", 0));
      return response;
    }
  } catch (error) {
    if (url.pathname === `${PREFIX}/callback`) {
      oauthLog("CALLBACK", "REJECTED", classifyOAuthCallbackFailureForLog(error));
      return redirectToStatus(request);
    }
    const retryable = error instanceof YoutubeOAuthError && error.retryable;
    return new Response(JSON.stringify({ status: "ERROR" }), {
      status: retryable ? 503 : 409,
      headers: oauthErrorHeaders("application/json; charset=utf-8"),
    });
  }
  return notFound(env);
}
