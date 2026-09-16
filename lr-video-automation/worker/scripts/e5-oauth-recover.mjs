#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertApprovedRecoveryConfig,
  assertCompanyMembership,
  buildExecuteSql,
  buildPreviewSql,
  classifyPreview,
  parseRecoveryArgs,
  REMOTE_COMPANY_CONFIRMATION,
  runRecoveryFlow,
} from "./e5-oauth-recovery-cli-lib.mjs";

const WRANGLER_BIN = fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url));
const CONFIG_PATH = fileURLToPath(new URL("../wrangler.e3-dev.jsonc", import.meta.url));

const USAGE = `Usage:
  npm run e5:oauth-recovery -- --expected-generation N --operator-id OPAQUE_ID [--confirm-google-revoked]
  npm run e5:oauth-recovery -- --expected-generation N --operator-id OPAQUE_ID --confirm-google-revoked --execute
  Remote execution additionally requires --remote --confirm-company-account ${REMOTE_COMPANY_CONFIRMATION}

Without --execute this command only previews safe state facts. It never prints tokens, ciphertext, email, or provider responses.`;

function safeExit(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}

function runtimeConfig(configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  return { ...assertApprovedRecoveryConfig(config), configPath };
}

function executeD1(options, config, sql) {
  const args = ["d1", "execute", config.databaseName, "--config", config.configPath,
    options.remote ? "--remote" : "--local", "--json", "--command", sql];
  if (!options.remote && options.persistTo) args.push("--persist-to", resolve(options.persistTo));
  const stdout = execFileSync(WRANGLER_BIN, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(stdout);
}

function readSafePreview(options, config) {
  const result = executeD1(options, config, buildPreviewSql(options.expectedGeneration));
  const row = result[0]?.results?.[0] ?? null;
  const classification = classifyPreview(row, options.expectedGeneration, options.confirmGoogleRevoked);
  return {
    ...classification,
    expectedGeneration: options.expectedGeneration,
    currentGeneration: row?.generation ?? null,
    operation: row?.operation ?? null,
    activeAttemptCount: row?.active_attempts ?? 0,
    credentialCount: row?.credential_count ?? 0,
    remote: options.remote,
  };
}

function verifyRemoteAccount(config) {
  const stdout = execFileSync(
    WRANGLER_BIN,
    ["whoami", "--json", "--config", config.configPath],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assertCompanyMembership(JSON.parse(stdout), config.accountId);
}

try {
  const options = parseRecoveryArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
  } else {
    const config = runtimeConfig(CONFIG_PATH);
    const result = runRecoveryFlow(options, {
      verifyApprovedConfig: () => runtimeConfig(CONFIG_PATH),
      verifyRemoteAccount: () => verifyRemoteAccount(config),
      readPreview: () => readSafePreview(options, config),
      executeRecovery: (occurredAt) => executeD1(options, config, buildExecuteSql({
        expectedGeneration: options.expectedGeneration,
        operatorId: options.operatorId,
        occurredAt,
      })),
      now: () => new Date(),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch {
  safeExit("OAuth recovery command failed safely. No secret or provider response is displayed.");
}
