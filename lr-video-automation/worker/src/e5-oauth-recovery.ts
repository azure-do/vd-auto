import { sha256Hex } from "./fingerprint";

export const OAUTH_RECOVERY_REASON = "GOOGLE_REVOCATION_CONFIRMED";

export type OAuthRecoveryBlocker =
  | "GOOGLE_REVOCATION_NOT_CONFIRMED"
  | "CONTROL_MISSING"
  | "EXPECTED_GENERATION_MISMATCH"
  | "CONTROL_NOT_ERROR"
  | "CONTROL_OWNER_PRESENT"
  | "CONTROL_EXPIRY_PRESENT"
  | "ACTIVE_ATTEMPT_PRESENT"
  | "CREDENTIAL_UNSAFE"
  | "RECOVERY_AUDIT_STATE_MISMATCH";

export interface OAuthRecoveryInput {
  expectedGeneration: number;
  operatorId: string;
  googleRevocationConfirmed: boolean;
}

export interface OAuthRecoveryPreview {
  status: "READY_TO_RECOVER" | "ALREADY_RECOVERED" | "BLOCKED";
  expectedGeneration: number;
  currentGeneration: number | null;
  operation: string | null;
  activeAttemptCount: number;
  credentialCount: number;
  blockers: OAuthRecoveryBlocker[];
}

export interface OAuthRecoveryResult {
  status: "RECOVERED" | "ALREADY_RECOVERED";
  previousGeneration: number;
  currentGeneration: number;
  occurredAt: string;
}

export class OAuthRecoveryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OAuthRecoveryError";
  }
}

interface PreviewRow {
  generation: number;
  operation: string;
  operation_owner_present: number;
  operation_expiry_present: number;
  active_attempts: number;
  credential_count: number;
  unsafe_credentials: number;
  recovery_audits: number;
}

function assertInput(input: OAuthRecoveryInput): void {
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
    throw new OAuthRecoveryError("EXPECTED_GENERATION_INVALID");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{2,127}$/.test(input.operatorId) || input.operatorId.includes("@")) {
    throw new OAuthRecoveryError("OPERATOR_ID_INVALID");
  }
}

function recoveryAuditId(generation: number): string {
  return `youtube_oauth_recovery_g${generation}`;
}

function metaChanges(result: D1Result<unknown> | undefined): number {
  return Number(result?.meta?.changes ?? 0);
}

export class E5OAuthRecoveryService {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async preview(input: OAuthRecoveryInput): Promise<OAuthRecoveryPreview> {
    assertInput(input);
    const auditId = recoveryAuditId(input.expectedGeneration);
    const row = await this.db.prepare(
      `SELECT c.generation, c.operation,
              CASE WHEN c.operation_owner IS NULL THEN 0 ELSE 1 END AS operation_owner_present,
              CASE WHEN c.operation_expires_at IS NULL THEN 0 ELSE 1 END AS operation_expiry_present,
              (SELECT COUNT(*) FROM youtube_oauth_attempts
               WHERE status IN ('PENDING', 'CONSUMING')) AS active_attempts,
              (SELECT COUNT(*) FROM youtube_oauth_credentials) AS credential_count,
              (SELECT COUNT(*) FROM youtube_oauth_credentials
               WHERE generation <> ?
                  OR status NOT IN ('ERROR', 'REVOKED')
                  OR access_token_ciphertext IS NOT NULL
                  OR refresh_token_ciphertext IS NOT NULL
                  OR token_expires_at IS NOT NULL
                  OR operation_expires_at IS NOT NULL) AS unsafe_credentials,
              (SELECT COUNT(*) FROM youtube_oauth_audits
               WHERE oauth_audit_id = ? AND action = 'oauth.recovered'
                 AND reason_code = ?) AS recovery_audits
         FROM youtube_oauth_control c WHERE c.control_id = 1`,
    ).bind(input.expectedGeneration, auditId, OAUTH_RECOVERY_REASON).first<PreviewRow>();

    if (!row) {
      return {
        status: "BLOCKED", expectedGeneration: input.expectedGeneration,
        currentGeneration: null, operation: null, activeAttemptCount: 0,
        credentialCount: 0, blockers: ["CONTROL_MISSING"],
      };
    }

    if (row.recovery_audits === 1) {
      const validRetryState = row.generation === input.expectedGeneration + 1
        && row.operation === "READY"
        && row.operation_owner_present === 0
        && row.operation_expiry_present === 0;
      return {
        status: validRetryState ? "ALREADY_RECOVERED" : "BLOCKED",
        expectedGeneration: input.expectedGeneration,
        currentGeneration: row.generation,
        operation: row.operation,
        activeAttemptCount: row.active_attempts,
        credentialCount: row.credential_count,
        blockers: validRetryState ? [] : ["RECOVERY_AUDIT_STATE_MISMATCH"],
      };
    }

    const blockers: OAuthRecoveryBlocker[] = [];
    if (!input.googleRevocationConfirmed) blockers.push("GOOGLE_REVOCATION_NOT_CONFIRMED");
    if (row.generation !== input.expectedGeneration) blockers.push("EXPECTED_GENERATION_MISMATCH");
    if (row.operation !== "ERROR") blockers.push("CONTROL_NOT_ERROR");
    if (row.operation_owner_present !== 0) blockers.push("CONTROL_OWNER_PRESENT");
    if (row.operation_expiry_present !== 0) blockers.push("CONTROL_EXPIRY_PRESENT");
    if (row.active_attempts !== 0) blockers.push("ACTIVE_ATTEMPT_PRESENT");
    if (row.credential_count > 1 || row.unsafe_credentials !== 0) blockers.push("CREDENTIAL_UNSAFE");
    return {
      status: blockers.length === 0 ? "READY_TO_RECOVER" : "BLOCKED",
      expectedGeneration: input.expectedGeneration,
      currentGeneration: row.generation,
      operation: row.operation,
      activeAttemptCount: row.active_attempts,
      credentialCount: row.credential_count,
      blockers,
    };
  }

  async execute(input: OAuthRecoveryInput): Promise<OAuthRecoveryResult> {
    assertInput(input);
    if (!input.googleRevocationConfirmed) {
      throw new OAuthRecoveryError("GOOGLE_REVOCATION_NOT_CONFIRMED");
    }
    const before = await this.preview(input);
    const occurredAt = this.now().toISOString();
    if (before.status === "ALREADY_RECOVERED") {
      return {
        status: "ALREADY_RECOVERED",
        previousGeneration: input.expectedGeneration,
        currentGeneration: input.expectedGeneration + 1,
        occurredAt,
      };
    }
    if (before.status !== "READY_TO_RECOVER") {
      throw new OAuthRecoveryError(before.blockers[0] ?? "OAUTH_RECOVERY_PRECONDITION_FAILED");
    }

    const auditId = recoveryAuditId(input.expectedGeneration);
    const nextGeneration = input.expectedGeneration + 1;
    const actorFingerprint = await sha256Hex(input.operatorId);
    let results: D1Result<unknown>[];
    try {
      results = await this.db.batch([
        this.db.prepare(
          `UPDATE youtube_oauth_control
              SET generation = ?, operation = 'READY', operation_owner = NULL,
                  operation_expires_at = NULL, updated_at = ?
            WHERE control_id = 1 AND generation = ? AND operation = 'ERROR'
              AND operation_owner IS NULL AND operation_expires_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM youtube_oauth_attempts
                 WHERE status IN ('PENDING', 'CONSUMING')
              )
              AND (
                NOT EXISTS (SELECT 1 FROM youtube_oauth_credentials)
                OR EXISTS (
                  SELECT 1 FROM youtube_oauth_credentials
                   WHERE credential_id = 1 AND generation = ?
                     AND status IN ('ERROR', 'REVOKED')
                     AND access_token_ciphertext IS NULL
                     AND refresh_token_ciphertext IS NULL
                     AND token_expires_at IS NULL
                     AND operation_expires_at IS NULL
                )
              )
              AND NOT EXISTS (
                SELECT 1 FROM youtube_oauth_audits WHERE oauth_audit_id = ?
              )`,
        ).bind(nextGeneration, occurredAt, input.expectedGeneration, input.expectedGeneration, auditId),
        this.db.prepare(
          `INSERT INTO youtube_oauth_audits (
             oauth_audit_id, oauth_attempt_id, actor_subject_fingerprint,
             action, reason_code, occurred_at
           )
           SELECT ?, NULL, ?, 'oauth.recovered', ?, ? WHERE changes() = 1`,
        ).bind(auditId, actorFingerprint, OAUTH_RECOVERY_REASON, occurredAt),
        this.db.prepare(
          `UPDATE youtube_oauth_credentials
              SET generation = ?, status = 'REVOKED',
                  access_token_ciphertext = NULL, refresh_token_ciphertext = NULL,
                  token_expires_at = NULL, verified_channel_fingerprint = NULL,
                  verified_at = NULL, operation_expires_at = NULL,
                  last_error_code = 'OAUTH_MANUAL_RECOVERY_COMPLETED',
                  row_version = row_version + 1, updated_at = ?
            WHERE credential_id = 1 AND generation = ?
              AND EXISTS (
                SELECT 1 FROM youtube_oauth_audits
                 WHERE oauth_audit_id = ? AND action = 'oauth.recovered'
              )`,
        ).bind(nextGeneration, occurredAt, input.expectedGeneration, auditId),
        this.db.prepare(
          `UPDATE youtube_oauth_attempts
              SET pkce_verifier_ciphertext = '', updated_at = ?
            WHERE generation <= ? AND status IN ('FAILED', 'EXPIRED')
              AND pkce_verifier_ciphertext <> ''
              AND EXISTS (
                SELECT 1 FROM youtube_oauth_audits
                 WHERE oauth_audit_id = ? AND action = 'oauth.recovered'
              )`,
        ).bind(occurredAt, input.expectedGeneration, auditId),
      ]);
    } catch {
      throw new OAuthRecoveryError("OAUTH_RECOVERY_PERSIST_FAILED");
    }

    if (metaChanges(results[0]) !== 1 || metaChanges(results[1]) !== 1) {
      const after = await this.preview(input);
      if (after.status === "ALREADY_RECOVERED") {
        return {
          status: "ALREADY_RECOVERED",
          previousGeneration: input.expectedGeneration,
          currentGeneration: nextGeneration,
          occurredAt,
        };
      }
      throw new OAuthRecoveryError("OAUTH_RECOVERY_PRECONDITION_CHANGED");
    }
    return {
      status: "RECOVERED",
      previousGeneration: input.expectedGeneration,
      currentGeneration: nextGeneration,
      occurredAt,
    };
  }
}
