import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/fingerprint";
import {
  E5OAuthRecoveryService,
  OAUTH_RECOVERY_REASON,
  OAuthRecoveryError,
  type OAuthRecoveryInput,
} from "../src/e5-oauth-recovery";

const NOW = "2026-08-30T01:02:03.000Z";
const INPUT: OAuthRecoveryInput = {
  expectedGeneration: 7,
  operatorId: "ops:youtube-recovery",
  googleRevocationConfirmed: true,
};

async function resetControl(operation = "ERROR", generation = 7): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM youtube_oauth_audits"),
    env.DB.prepare("DELETE FROM youtube_oauth_credentials"),
    env.DB.prepare("DELETE FROM youtube_oauth_attempts"),
    env.DB.prepare(
      `UPDATE youtube_oauth_control
          SET generation = ?, operation = ?, operation_owner = NULL,
              operation_expires_at = NULL, updated_at = ?
        WHERE control_id = 1`,
    ).bind(generation, operation, NOW),
  ]);
}

async function insertCredential(status: "ERROR" | "REVOKED" | "CONNECTED" = "ERROR"): Promise<void> {
  const connected = status === "CONNECTED";
  await env.DB.prepare(
    `INSERT INTO youtube_oauth_credentials (
       credential_id, generation, status, access_token_ciphertext,
       refresh_token_ciphertext, token_expires_at, granted_scope,
       expected_channel_fingerprint, verified_channel_fingerprint,
       verified_at, operation_expires_at, last_error_code,
       row_version, created_at, updated_at
     ) VALUES (1, 7, ?, ?, ?, ?,
       'https://www.googleapis.com/auth/youtube.readonly', ?, ?, ?, NULL,
       'TEST_STATE', 1, ?, ?)`,
  ).bind(
    status,
    connected ? "encrypted-access" : null,
    connected ? "encrypted-refresh" : null,
    connected ? "2026-08-30T02:00:00.000Z" : null,
    "a".repeat(64),
    connected ? "a".repeat(64) : null,
    connected ? NOW : null,
    NOW,
    NOW,
  ).run();
}

async function insertAttempt(status: "PENDING" | "EXPIRED"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO youtube_oauth_attempts (
       oauth_attempt_id, generation, state_hash, pkce_verifier_ciphertext,
       requested_scope, status, failure_code, expires_at, consumed_at,
       created_at, updated_at
     ) VALUES (?, 7, ?, 'encrypted-pkce',
       'https://www.googleapis.com/auth/youtube.readonly', ?, ?, ?, NULL, ?, ?)`,
  ).bind(
    `attempt-${status.toLowerCase()}`,
    status === "PENDING" ? "b".repeat(64) : "c".repeat(64),
    status,
    status === "EXPIRED" ? "OAUTH_STATE_EXPIRED" : null,
    "2026-08-30T00:00:00.000Z",
    NOW,
    NOW,
  ).run();
}

function replacePreparedStatement(
  target: D1Database,
  marker: string,
  replacement: string,
): D1Database {
  return new Proxy(target, {
    get(inner, property) {
      if (property === "prepare") {
        return (sql: string) => inner.prepare(sql.includes(marker) ? replacement : sql);
      }
      const value = Reflect.get(inner, property);
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });
}

describe("E5 OAuth ERROR manual recovery", () => {
  beforeEach(async () => resetControl());

  it("previews by default-safe facts and requires explicit Google revocation confirmation", async () => {
    const service = new E5OAuthRecoveryService(env.DB, () => new Date(NOW));
    const preview = await service.preview({ ...INPUT, googleRevocationConfirmed: false });
    expect(preview).toMatchObject({ status: "BLOCKED", blockers: ["GOOGLE_REVOCATION_NOT_CONFIRMED"] });
    await expect(service.execute({ ...INPUT, googleRevocationConfirmed: false }))
      .rejects.toMatchObject({ code: "GOOGLE_REVOCATION_NOT_CONFIRMED" });
  });

  it("recovers an eligible ERROR atomically, advances generation, fences old callbacks, and audits only a fingerprint", async () => {
    await insertCredential("ERROR");
    await insertAttempt("EXPIRED");
    const service = new E5OAuthRecoveryService(env.DB, () => new Date(NOW));
    await expect(service.preview(INPUT)).resolves.toMatchObject({ status: "READY_TO_RECOVER" });
    await expect(service.execute(INPUT)).resolves.toEqual({
      status: "RECOVERED", previousGeneration: 7, currentGeneration: 8, occurredAt: NOW,
    });

    const control = await env.DB.prepare(
      "SELECT generation, operation, operation_owner, operation_expires_at FROM youtube_oauth_control",
    ).first();
    expect(control).toEqual({ generation: 8, operation: "READY", operation_owner: null, operation_expires_at: null });
    const credential = await env.DB.prepare(
      `SELECT generation, status, access_token_ciphertext, refresh_token_ciphertext,
              verified_channel_fingerprint, last_error_code, row_version
         FROM youtube_oauth_credentials`,
    ).first();
    expect(credential).toEqual({
      generation: 8, status: "REVOKED", access_token_ciphertext: null,
      refresh_token_ciphertext: null, verified_channel_fingerprint: null,
      last_error_code: "OAUTH_MANUAL_RECOVERY_COMPLETED", row_version: 2,
    });
    expect(await env.DB.prepare("SELECT pkce_verifier_ciphertext FROM youtube_oauth_attempts").first())
      .toEqual({ pkce_verifier_ciphertext: "" });
    expect(await env.DB.prepare(
      "SELECT oauth_audit_id, actor_subject_fingerprint, action, reason_code, occurred_at FROM youtube_oauth_audits",
    ).first()).toEqual({
      oauth_audit_id: "youtube_oauth_recovery_g7",
      actor_subject_fingerprint: await sha256Hex(INPUT.operatorId),
      action: "oauth.recovered", reason_code: OAUTH_RECOVERY_REASON, occurred_at: NOW,
    });
  });

  it("also accepts a same-generation REVOKED credential only when every secret ciphertext is absent", async () => {
    await insertCredential("REVOKED");
    const service = new E5OAuthRecoveryService(env.DB, () => new Date(NOW));
    await expect(service.execute(INPUT)).resolves.toMatchObject({ status: "RECOVERED", currentGeneration: 8 });
    expect(await env.DB.prepare(
      "SELECT generation, status, access_token_ciphertext, refresh_token_ciphertext FROM youtube_oauth_credentials",
    ).first()).toEqual({
      generation: 8, status: "REVOKED", access_token_ciphertext: null, refresh_token_ciphertext: null,
    });
  });

  it.each([
    ["normal READY", async () => resetControl("READY"), "CONTROL_NOT_ERROR"],
    ["generation mismatch", async () => resetControl("ERROR", 8), "EXPECTED_GENERATION_MISMATCH"],
    ["active operation", async () => insertAttempt("PENDING"), "ACTIVE_ATTEMPT_PRESENT"],
    ["CONNECTED credential with remaining ciphertext", async () => insertCredential("CONNECTED"), "CREDENTIAL_UNSAFE"],
  ] as const)("rejects %s", async (_name, arrange, code) => {
    await arrange();
    const service = new E5OAuthRecoveryService(env.DB, () => new Date(NOW));
    await expect(service.execute(INPUT)).rejects.toMatchObject({ code });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM youtube_oauth_audits").first())
      .toEqual({ count: 0 });
  });

  it("rejects email-like or malformed operator IDs before touching D1", async () => {
    const service = new E5OAuthRecoveryService(env.DB, () => new Date(NOW));
    await expect(service.execute({ ...INPUT, operatorId: "operator@example.invalid" }))
      .rejects.toBeInstanceOf(OAuthRecoveryError);
    await expect(service.execute({ ...INPUT, operatorId: "x';DROP TABLE x;--" }))
      .rejects.toMatchObject({ code: "OPERATOR_ID_INVALID" });
  });

  it("rolls back control when audit persistence fails", async () => {
    const failing = replacePreparedStatement(
      env.DB,
      "INSERT INTO youtube_oauth_audits",
      `INSERT INTO youtube_oauth_audits (
         oauth_audit_id, oauth_attempt_id, actor_subject_fingerprint, action, reason_code, occurred_at
       ) SELECT ?, NULL, ?, 'oauth.invalid', ?, ? WHERE changes() = 1`,
    );
    const service = new E5OAuthRecoveryService(failing, () => new Date(NOW));
    await expect(service.execute(INPUT)).rejects.toMatchObject({ code: "OAUTH_RECOVERY_PERSIST_FAILED" });
    expect(await env.DB.prepare("SELECT generation, operation FROM youtube_oauth_control").first())
      .toEqual({ generation: 7, operation: "ERROR" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM youtube_oauth_audits").first())
      .toEqual({ count: 0 });
  });

  it("rolls back audit and control when a later batch statement fails", async () => {
    await insertCredential("ERROR");
    const failing = replacePreparedStatement(
      env.DB,
      "UPDATE youtube_oauth_credentials",
      "UPDATE youtube_oauth_credentials SET status = 'CONNECTED' WHERE credential_id = 1",
    );
    const service = new E5OAuthRecoveryService(failing, () => new Date(NOW));
    await expect(service.execute(INPUT)).rejects.toMatchObject({ code: "OAUTH_RECOVERY_PERSIST_FAILED" });
    expect(await env.DB.prepare("SELECT generation, operation FROM youtube_oauth_control").first())
      .toEqual({ generation: 7, operation: "ERROR" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM youtube_oauth_audits").first())
      .toEqual({ count: 0 });
  });

  it("is idempotent for a double run and records one recovery audit", async () => {
    const service = new E5OAuthRecoveryService(env.DB, () => new Date(NOW));
    await expect(service.execute(INPUT)).resolves.toMatchObject({ status: "RECOVERED" });
    await expect(service.execute(INPUT)).resolves.toMatchObject({ status: "ALREADY_RECOVERED" });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM youtube_oauth_audits WHERE action = 'oauth.recovered'",
    ).first()).toEqual({ count: 1 });
  });

  it("returns already-recovered safely when the first committed response was lost", async () => {
    let first = true;
    const ambiguous = new Proxy(env.DB, {
      get(inner, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const result = await inner.batch(statements);
            if (first) { first = false; throw new Error("response lost after commit"); }
            return result;
          };
        }
        const value = Reflect.get(inner, property);
        return typeof value === "function" ? value.bind(inner) : value;
      },
    });
    const uncertainService = new E5OAuthRecoveryService(ambiguous, () => new Date(NOW));
    await expect(uncertainService.execute(INPUT)).rejects.toMatchObject({ code: "OAUTH_RECOVERY_PERSIST_FAILED" });
    const retryService = new E5OAuthRecoveryService(env.DB, () => new Date(NOW));
    await expect(retryService.execute(INPUT)).resolves.toMatchObject({ status: "ALREADY_RECOVERED" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM youtube_oauth_audits").first())
      .toEqual({ count: 1 });
  });

  it("serializes concurrent execution into one mutation and one idempotent result", async () => {
    const first = new E5OAuthRecoveryService(env.DB, () => new Date(NOW));
    const second = new E5OAuthRecoveryService(env.DB, () => new Date(NOW));
    const outcomes = await Promise.all([first.execute(INPUT), second.execute(INPUT)]);
    expect(outcomes.map((result) => result.status).sort()).toEqual(["ALREADY_RECOVERED", "RECOVERED"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM youtube_oauth_audits").first())
      .toEqual({ count: 1 });
  });
});
