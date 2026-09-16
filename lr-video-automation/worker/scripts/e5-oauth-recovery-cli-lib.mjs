import { createHash } from "node:crypto";

export const REMOTE_COMPANY_CONFIRMATION = "hoshinoshita-company-cloudflare";
export const RECOVERY_REASON = "GOOGLE_REVOCATION_CONFIRMED";
export const APPROVED_COMPANY_ACCOUNT_ID = "61c5c0e87a1622e4ffe6bdc62d6d87ad";
export const APPROVED_DEV_DATABASE_NAME = "lr-video-automation-dev-20260824";
export const APPROVED_DEV_DATABASE_ID = "e35cdb5b-2de4-4f62-894f-62fefe904583";

export function parseRecoveryArgs(argv) {
  const options = {
    execute: false,
    remote: false,
    confirmGoogleRevoked: false,
  };
  const valueKeys = new Map([
    ["--expected-generation", "expectedGeneration"],
    ["--operator-id", "operatorId"],
    ["--confirm-company-account", "confirmCompanyAccount"],
    ["--persist-to", "persistTo"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") options.execute = true;
    else if (argument === "--remote") options.remote = true;
    else if (argument === "--confirm-google-revoked") options.confirmGoogleRevoked = true;
    else if (argument === "--help") options.help = true;
    else if (valueKeys.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`missing value: ${argument}`);
      const key = valueKeys.get(argument);
      if (options[key] !== undefined) throw new Error(`duplicate option: ${argument}`);
      options[key] = value;
      index += 1;
    } else {
      throw new Error("unknown option");
    }
  }
  if (options.help) return options;
  if (!/^(0|[1-9][0-9]*)$/.test(options.expectedGeneration ?? "")) {
    throw new Error("expected generation must be a non-negative integer");
  }
  options.expectedGeneration = Number(options.expectedGeneration);
  if (!Number.isSafeInteger(options.expectedGeneration)) throw new Error("expected generation is too large");
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{2,127}$/.test(options.operatorId ?? "")
      || options.operatorId.includes("@")) {
    throw new Error("operator ID must be a non-email opaque ID");
  }
  if (options.execute && !options.confirmGoogleRevoked) {
    throw new Error("execution requires confirmed Google revocation");
  }
  if (options.execute && options.remote
      && options.confirmCompanyAccount !== REMOTE_COMPANY_CONFIRMATION) {
    throw new Error("remote execution requires company account confirmation");
  }
  return options;
}

function quoteSql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildPreviewSql(expectedGeneration) {
  const auditId = `youtube_oauth_recovery_g${expectedGeneration}`;
  return `SELECT c.generation, c.operation,
    (SELECT COUNT(*) FROM youtube_oauth_attempts WHERE status IN ('PENDING','CONSUMING')) AS active_attempts,
    (SELECT COUNT(*) FROM youtube_oauth_credentials) AS credential_count,
    (SELECT COUNT(*) FROM youtube_oauth_credentials
      WHERE generation <> ${expectedGeneration} OR status NOT IN ('ERROR','REVOKED')
        OR access_token_ciphertext IS NOT NULL OR refresh_token_ciphertext IS NOT NULL
        OR token_expires_at IS NOT NULL OR operation_expires_at IS NOT NULL) AS unsafe_credentials,
    CASE WHEN c.operation_owner IS NULL THEN 0 ELSE 1 END AS owner_present,
    CASE WHEN c.operation_expires_at IS NULL THEN 0 ELSE 1 END AS expiry_present,
    (SELECT COUNT(*) FROM youtube_oauth_audits
      WHERE oauth_audit_id = ${quoteSql(auditId)} AND action = 'oauth.recovered'
        AND reason_code = '${RECOVERY_REASON}') AS recovery_audits
    FROM youtube_oauth_control c WHERE c.control_id = 1;`;
}

export function buildExecuteSql({ expectedGeneration, operatorId, occurredAt }) {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error("invalid generation");
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{2,127}$/.test(operatorId) || operatorId.includes("@")) {
    throw new Error("invalid operator ID");
  }
  if (new Date(occurredAt).toISOString() !== occurredAt) throw new Error("invalid timestamp");
  const nextGeneration = expectedGeneration + 1;
  const auditId = `youtube_oauth_recovery_g${expectedGeneration}`;
  const actorFingerprint = createHash("sha256").update(operatorId, "utf8").digest("hex");
  return `UPDATE youtube_oauth_control
    SET generation=${nextGeneration}, operation='READY', operation_owner=NULL,
        operation_expires_at=NULL, updated_at=${quoteSql(occurredAt)}
    WHERE control_id=1 AND generation=${expectedGeneration} AND operation='ERROR'
      AND operation_owner IS NULL AND operation_expires_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM youtube_oauth_attempts WHERE status IN ('PENDING','CONSUMING'))
      AND (NOT EXISTS (SELECT 1 FROM youtube_oauth_credentials)
        OR EXISTS (SELECT 1 FROM youtube_oauth_credentials WHERE credential_id=1
          AND generation=${expectedGeneration} AND status IN ('ERROR','REVOKED')
          AND access_token_ciphertext IS NULL AND refresh_token_ciphertext IS NULL
          AND token_expires_at IS NULL AND operation_expires_at IS NULL))
      AND NOT EXISTS (SELECT 1 FROM youtube_oauth_audits WHERE oauth_audit_id=${quoteSql(auditId)});
  INSERT INTO youtube_oauth_audits (
    oauth_audit_id, oauth_attempt_id, actor_subject_fingerprint, action, reason_code, occurred_at
  ) SELECT ${quoteSql(auditId)}, NULL, ${quoteSql(actorFingerprint)}, 'oauth.recovered',
      '${RECOVERY_REASON}', ${quoteSql(occurredAt)} WHERE changes()=1;
  UPDATE youtube_oauth_credentials SET generation=${nextGeneration}, status='REVOKED',
    access_token_ciphertext=NULL, refresh_token_ciphertext=NULL, token_expires_at=NULL,
    verified_channel_fingerprint=NULL, verified_at=NULL, operation_expires_at=NULL,
    last_error_code='OAUTH_MANUAL_RECOVERY_COMPLETED', row_version=row_version+1,
    updated_at=${quoteSql(occurredAt)}
    WHERE credential_id=1 AND generation=${expectedGeneration}
      AND EXISTS (SELECT 1 FROM youtube_oauth_audits
        WHERE oauth_audit_id=${quoteSql(auditId)} AND action='oauth.recovered');
  UPDATE youtube_oauth_attempts SET pkce_verifier_ciphertext='', updated_at=${quoteSql(occurredAt)}
    WHERE generation<=${expectedGeneration} AND status IN ('FAILED','EXPIRED')
      AND pkce_verifier_ciphertext<>'' AND EXISTS (SELECT 1 FROM youtube_oauth_audits
        WHERE oauth_audit_id=${quoteSql(auditId)} AND action='oauth.recovered');`;
}

export function classifyPreview(row, expectedGeneration, confirmed) {
  if (!row) return { status: "BLOCKED", blockers: ["CONTROL_MISSING"] };
  if (row.recovery_audits === 1) {
    const valid = row.generation === expectedGeneration + 1 && row.operation === "READY"
      && row.owner_present === 0 && row.expiry_present === 0;
    return { status: valid ? "ALREADY_RECOVERED" : "BLOCKED", blockers: valid ? [] : ["RECOVERY_AUDIT_STATE_MISMATCH"] };
  }
  const blockers = [];
  if (!confirmed) blockers.push("GOOGLE_REVOCATION_NOT_CONFIRMED");
  if (row.generation !== expectedGeneration) blockers.push("EXPECTED_GENERATION_MISMATCH");
  if (row.operation !== "ERROR") blockers.push("CONTROL_NOT_ERROR");
  if (row.owner_present !== 0) blockers.push("CONTROL_OWNER_PRESENT");
  if (row.expiry_present !== 0) blockers.push("CONTROL_EXPIRY_PRESENT");
  if (row.active_attempts !== 0) blockers.push("ACTIVE_ATTEMPT_PRESENT");
  if (row.credential_count > 1 || row.unsafe_credentials !== 0) blockers.push("CREDENTIAL_UNSAFE");
  return { status: blockers.length === 0 ? "READY_TO_RECOVER" : "BLOCKED", blockers };
}

export function assertCompanyMembership(whoami, expectedAccountId) {
  if (!/^[0-9a-f]{32}$/.test(expectedAccountId ?? "")) throw new Error("company account ID is invalid");
  if (!whoami || whoami.loggedIn !== true || !Array.isArray(whoami.accounts)) {
    throw new Error("Wrangler is not authenticated");
  }
  if (whoami.accounts.length !== 1) throw new Error("Cloudflare membership is ambiguous");
  if (whoami.accounts[0]?.id !== expectedAccountId) throw new Error("Cloudflare account mismatch");
}

export function assertApprovedRecoveryConfig(config) {
  if (config?.account_id !== APPROVED_COMPANY_ACCOUNT_ID) {
    throw new Error("recovery config account is not approved");
  }
  if (!Array.isArray(config.d1_databases) || config.d1_databases.length !== 1) {
    throw new Error("recovery config database is ambiguous");
  }
  const database = config.d1_databases[0];
  if (database?.binding !== "DB"
      || database.database_name !== APPROVED_DEV_DATABASE_NAME
      || database.database_id !== APPROVED_DEV_DATABASE_ID) {
    throw new Error("recovery config database is not approved");
  }
  return {
    accountId: APPROVED_COMPANY_ACCOUNT_ID,
    databaseName: APPROVED_DEV_DATABASE_NAME,
    databaseId: APPROVED_DEV_DATABASE_ID,
  };
}

export function runRecoveryFlow(options, dependencies) {
  if (options.remote) {
    dependencies.verifyApprovedConfig();
    dependencies.verifyRemoteAccount();
  }
  const preview = dependencies.readPreview();
  if (!options.execute) return preview;
  if (preview.status === "ALREADY_RECOVERED") return { ...preview, result: "NO_CHANGE" };
  if (preview.status !== "READY_TO_RECOVER") {
    throw new Error(`Recovery blocked: ${preview.blockers.join(",")}`);
  }
  dependencies.executeRecovery(dependencies.now().toISOString());
  const after = dependencies.readPreview();
  if (after.status !== "ALREADY_RECOVERED") throw new Error("postcondition not satisfied");
  return { ...after, result: "RECOVERED", actorFingerprintRecorded: true };
}
