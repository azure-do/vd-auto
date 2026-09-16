import { sha256Hex } from "./fingerprint";

export const LOCAL_TEST_ISSUER = "https://oidc.local.invalid" as const;

export interface LocalPublicJwk extends JsonWebKey {
  kid?: string;
}

export interface LocalOidcConfig {
  environment: "local-test";
  issuer: typeof LOCAL_TEST_ISSUER;
  audience: string;
  publicJwk: LocalPublicJwk;
}

export interface VerifiedLocalIdentity {
  subjectFingerprint: string;
  emailFingerprint: string;
}

export class LocalOidcVerificationError extends Error {
  constructor(readonly code: string) {
    super("The local test identity token was rejected");
    this.name = "LocalOidcVerificationError";
  }
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new LocalOidcVerificationError("TOKEN_FORMAT_INVALID");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new LocalOidcVerificationError("TOKEN_FORMAT_INVALID");
  }
}

function decodeJsonSegment(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof LocalOidcVerificationError) throw error;
    throw new LocalOidcVerificationError("TOKEN_FORMAT_INVALID");
  }
}

function audienceMatches(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  return Array.isArray(value) && value.every((item) => typeof item === "string") &&
    value.includes(expected);
}

export async function verifyLocalTestIdToken(
  token: string,
  config: LocalOidcConfig,
  now: string,
): Promise<VerifiedLocalIdentity> {
  if (config.environment !== "local-test" || config.issuer !== LOCAL_TEST_ISSUER) {
    throw new LocalOidcVerificationError("TEST_CONFIGURATION_REJECTED");
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new TypeError("now must be an ISO-8601 timestamp");
  const parts = token.split(".");
  if (parts.length !== 3) throw new LocalOidcVerificationError("TOKEN_FORMAT_INVALID");
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = decodeJsonSegment(encodedHeader);
  const claims = decodeJsonSegment(encodedPayload);
  if (header.alg !== "RS256") throw new LocalOidcVerificationError("SIGNATURE_INVALID");
  if (config.publicJwk.kid && header.kid !== config.publicJwk.kid) {
    throw new LocalOidcVerificationError("SIGNATURE_INVALID");
  }

  let publicKey: CryptoKey;
  try {
    publicKey = await crypto.subtle.importKey(
      "jwk",
      config.publicJwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new LocalOidcVerificationError("SIGNATURE_INVALID");
  }
  const signatureValid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    new Uint8Array([...decodeBase64Url(encodedSignature)]),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!signatureValid) throw new LocalOidcVerificationError("SIGNATURE_INVALID");
  if (claims.iss !== config.issuer) throw new LocalOidcVerificationError("ISSUER_INVALID");
  if (!audienceMatches(claims.aud, config.audience)) {
    throw new LocalOidcVerificationError("AUDIENCE_INVALID");
  }
  if (typeof claims.exp !== "number" || !Number.isInteger(claims.exp) || claims.exp <= nowMs / 1000) {
    throw new LocalOidcVerificationError("TOKEN_EXPIRED");
  }
  if (claims.email_verified !== true) {
    throw new LocalOidcVerificationError("EMAIL_NOT_VERIFIED");
  }
  if (typeof claims.sub !== "string" || claims.sub.length === 0 || claims.sub.length > 255) {
    throw new LocalOidcVerificationError("SUBJECT_INVALID");
  }
  if (typeof claims.email !== "string" || claims.email.length === 0 || claims.email.length > 320) {
    throw new LocalOidcVerificationError("EMAIL_INVALID");
  }

  return {
    subjectFingerprint: await sha256Hex(`${config.issuer}\n${claims.sub}`),
    emailFingerprint: await sha256Hex(claims.email.trim().toLowerCase()),
  };
}
