import { sha256Hex } from "./fingerprint";

const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const TEAM_DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUDIENCE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FETCH_TIMEOUT_MS = 5_000;
const VERIFIED_ACCESS_MARKER = Symbol("verified-cloudflare-access");

export class CloudflareAccessError extends Error {
  constructor(readonly code: string) { super(code); }
}

export class VerifiedAccessSession {
  private readonly verified = true;
  constructor(marker: symbol, readonly subjectFingerprint: string) {
    if (marker !== VERIFIED_ACCESS_MARKER) throw new CloudflareAccessError("ACCESS_SESSION_INVALID");
  }

  isVerified(): boolean { return this.verified; }
}

export interface CloudflareAccessConfig {
  teamDomain: string;
  audience: string;
  allowedEmails: readonly string[];
}

interface AccessClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  sub?: unknown;
  email?: unknown;
}

interface Jwk {
  kid?: unknown;
  kty?: unknown;
  alg?: unknown;
  use?: unknown;
  n?: unknown;
  e?: unknown;
}

function decodeBase64Url(value: string): Uint8Array {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(base64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new CloudflareAccessError("ACCESS_JWT_INVALID");
  }
}

function parseJsonPart<T>(part: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(part))) as T;
  } catch {
    throw new CloudflareAccessError("ACCESS_JWT_INVALID");
  }
}

function assertConfig(config: CloudflareAccessConfig): void {
  if (!TEAM_DOMAIN_PATTERN.test(config.teamDomain)) throw new CloudflareAccessError("ACCESS_CONFIG_INVALID");
  if (!AUDIENCE_PATTERN.test(config.audience)) throw new CloudflareAccessError("ACCESS_CONFIG_INVALID");
  if (config.allowedEmails.length < 1 || config.allowedEmails.some((email) => !EMAIL_PATTERN.test(email))) {
    throw new CloudflareAccessError("ACCESS_CONFIG_INVALID");
  }
}

export class CloudflareAccessVerifier {
  constructor(
    private readonly config: CloudflareAccessConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date(),
    private readonly fetchTimeoutMs: number = FETCH_TIMEOUT_MS,
  ) {
    assertConfig(config);
    if (!Number.isSafeInteger(fetchTimeoutMs) || fetchTimeoutMs < 1 || fetchTimeoutMs > FETCH_TIMEOUT_MS) {
      throw new CloudflareAccessError("ACCESS_CONFIG_INVALID");
    }
  }

  async verify(request: Request): Promise<VerifiedAccessSession> {
    const token = request.headers.get("cf-access-jwt-assertion") ?? this.cookieToken(request);
    if (!token || token.length > 16_384 || !JWT_PATTERN.test(token)) {
      throw new CloudflareAccessError("ACCESS_JWT_MISSING");
    }
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".") as [string, string, string];
    const header = parseJsonPart<{ alg?: unknown; kid?: unknown; typ?: unknown }>(encodedHeader);
    const claims = parseJsonPart<AccessClaims>(encodedPayload);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 256) {
      throw new CloudflareAccessError("ACCESS_JWT_INVALID");
    }
    const jwk = await this.jwk(header.kid);
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    ).catch(() => { throw new CloudflareAccessError("ACCESS_JWK_IMPORT_FAILED"); });
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      Uint8Array.from(decodeBase64Url(encodedSignature)),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    ).catch(() => false);
    if (!valid) throw new CloudflareAccessError("ACCESS_JWT_SIGNATURE_INVALID");

    const seconds = Math.floor(this.clock().getTime() / 1_000);
    const issuer = `https://${this.config.teamDomain}`;
    const audiences = typeof claims.aud === "string"
      ? [claims.aud]
      : Array.isArray(claims.aud) ? claims.aud : [];
    if (claims.iss !== issuer || !audiences.includes(this.config.audience)
      || typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) || claims.exp <= seconds
      || (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > seconds + 30))
      || typeof claims.sub !== "string" || claims.sub.length < 1 || claims.sub.length > 512
      || claims.sub.trim() !== claims.sub || /[\u0000-\u001f\u007f]/u.test(claims.sub)
      || typeof claims.email !== "string" || !EMAIL_PATTERN.test(claims.email)) {
      throw new CloudflareAccessError("ACCESS_CLAIMS_INVALID");
    }
    const allowed = new Set(this.config.allowedEmails.map((email) => email.toLowerCase()));
    if (!allowed.has(claims.email.toLowerCase())) throw new CloudflareAccessError("ACCESS_DENIED");
    return new VerifiedAccessSession(
      VERIFIED_ACCESS_MARKER,
      await sha256Hex(claims.sub),
    );
  }

  private async jwk(kid: string): Promise<Jwk> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    let body: string;
    try {
      const response = await this.fetcher(`https://${this.config.teamDomain}/cdn-cgi/access/certs`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new CloudflareAccessError("ACCESS_JWKS_HTTP_REJECTED");
      body = await response.text();
    } catch (error) {
      if (error instanceof CloudflareAccessError) throw error;
      if (controller.signal.aborted) throw new CloudflareAccessError("ACCESS_JWKS_TIMEOUT");
      throw new CloudflareAccessError("ACCESS_JWKS_FETCH_FAILED");
    } finally {
      clearTimeout(timeout);
    }
    let payload: { keys?: unknown };
    try { payload = JSON.parse(body) as { keys?: unknown }; }
    catch { throw new CloudflareAccessError("ACCESS_JWKS_INVALID"); }
    if (!Array.isArray(payload.keys)) throw new CloudflareAccessError("ACCESS_JWKS_INVALID");
    const key = payload.keys.find((candidate): candidate is Jwk => {
      if (!candidate || typeof candidate !== "object") return false;
      const value = candidate as Jwk;
      return value.kid === kid && value.kty === "RSA" && value.alg === "RS256"
        && (value.use === undefined || value.use === "sig")
        && typeof value.n === "string" && typeof value.e === "string";
    });
    if (!key) throw new CloudflareAccessError("ACCESS_JWK_NOT_FOUND");
    return key;
  }

  private cookieToken(request: Request): string | null {
    const cookie = request.headers.get("cookie");
    if (!cookie) return null;
    for (const item of cookie.split(";")) {
      const [name, ...parts] = item.trim().split("=");
      if (name === "CF_Authorization") return parts.join("=");
    }
    return null;
  }
}
