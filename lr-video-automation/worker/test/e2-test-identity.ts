import {
  LOCAL_TEST_ISSUER,
  type LocalOidcConfig,
  type LocalPublicJwk,
} from "../src/e2-oidc";

function base64Url(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export interface LocalIdentityFixture {
  config: LocalOidcConfig;
  privateKey: CryptoKey;
  makeEmail(): string;
  sign(overrides?: Record<string, unknown>, headerOverrides?: Record<string, unknown>): Promise<string>;
}

export async function createLocalIdentityFixture(now: string): Promise<LocalIdentityFixture> {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey) as LocalPublicJwk;
  publicJwk.kid = `local-${crypto.randomUUID()}`;
  const audience = `local-audience-${crypto.randomUUID()}`;
  const makeEmail = () =>
    `dummy-${crypto.randomUUID()}${String.fromCharCode(64)}local.invalid`;
  return {
    config: {
      environment: "local-test",
      issuer: LOCAL_TEST_ISSUER,
      audience,
      publicJwk,
    },
    privateKey: keys.privateKey,
    makeEmail,
    async sign(overrides = {}, headerOverrides = {}) {
      const header = {
        alg: "RS256",
        typ: "JWT",
        kid: publicJwk.kid,
        ...headerOverrides,
      };
      const claims = {
        iss: LOCAL_TEST_ISSUER,
        aud: audience,
        exp: Math.floor(Date.parse(now) / 1000) + 3_600,
        email_verified: true,
        sub: `dummy-sub-${crypto.randomUUID()}`,
        email: makeEmail(),
        ...overrides,
      };
      const encodedHeader = base64Url(JSON.stringify(header));
      const encodedPayload = base64Url(JSON.stringify(claims));
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        keys.privateKey,
        new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
      );
      return `${encodedHeader}.${encodedPayload}.${base64Url(new Uint8Array(signature))}`;
    },
  };
}
