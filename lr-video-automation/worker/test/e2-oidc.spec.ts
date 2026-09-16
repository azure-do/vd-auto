import { describe, expect, it } from "vitest";
import {
  LOCAL_TEST_ISSUER,
  LocalOidcVerificationError,
  verifyLocalTestIdToken,
} from "../src/e2-oidc";
import { createLocalIdentityFixture } from "./e2-test-identity";

const NOW = "2026-08-17T00:00:00.000Z";

describe("local-only OIDC verification boundary", () => {
  it("accepts a correctly signed local token and returns fingerprints only", async () => {
    const fixture = await createLocalIdentityFixture(NOW);
    const token = await fixture.sign();
    const verified = await verifyLocalTestIdToken(token, fixture.config, NOW);
    expect(verified.subjectFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(verified.emailFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(verified).sort()).toEqual(["emailFingerprint", "subjectFingerprint"]);
  });

  it.each([
    ["AUDIENCE_INVALID", { aud: "wrong-audience" }],
    ["ISSUER_INVALID", { iss: "https://wrong.local.invalid" }],
    ["TOKEN_EXPIRED", { exp: Math.floor(Date.parse(NOW) / 1000) }],
    ["EMAIL_NOT_VERIFIED", { email_verified: false }],
  ])("rejects %s independently", async (code, overrides) => {
    const fixture = await createLocalIdentityFixture(NOW);
    const token = await fixture.sign(overrides);
    await expect(verifyLocalTestIdToken(token, fixture.config, NOW)).rejects.toMatchObject({
      code,
    });
  });

  it("rejects a token signed by another key", async () => {
    const trusted = await createLocalIdentityFixture(NOW);
    const attacker = await createLocalIdentityFixture(NOW);
    const token = await attacker.sign({
      iss: trusted.config.issuer,
      aud: trusted.config.audience,
    }, { kid: trusted.config.publicJwk.kid });
    await expect(verifyLocalTestIdToken(token, trusted.config, NOW)).rejects.toMatchObject({
      code: "SIGNATURE_INVALID",
    });
  });

  it("cannot be configured as a production verifier", async () => {
    const fixture = await createLocalIdentityFixture(NOW);
    const token = await fixture.sign();
    await expect(
      verifyLocalTestIdToken(token, {
        ...fixture.config,
        environment: "production" as "local-test",
      }, NOW),
    ).rejects.toBeInstanceOf(LocalOidcVerificationError);
    expect(fixture.config.issuer).toBe(LOCAL_TEST_ISSUER);
  });
});
