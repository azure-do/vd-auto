import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVED_COMPANY_ACCOUNT_ID,
  APPROVED_DEV_DATABASE_ID,
  APPROVED_DEV_DATABASE_NAME,
} from "./e5-oauth-recovery-cli-lib.mjs";

const PRODUCTION_CONFIG = "wrangler.jsonc";
const DEVELOPMENT_CONFIG = "wrangler.e3-dev.jsonc";
const EXPECTED_TARGETS = Object.freeze({
  production: Object.freeze({
    workerName: "lr-video-automation",
    databaseName: "lr-video-automation-local",
    databaseId: "00000000-0000-0000-0000-000000000000",
  }),
  development: Object.freeze({
    workerName: "lr-video-automation-dev-20260824",
    databaseName: APPROVED_DEV_DATABASE_NAME,
    databaseId: APPROVED_DEV_DATABASE_ID,
    redirectUri: "https://lr-video-automation-dev-20260824.lr-video-automation-worker.workers.dev/__ops/e5/youtube-oauth/callback",
  }),
});

function requireEmptyDestinations(value, label) {
  if (!Array.isArray(value) || value.length !== 0) {
    throw new Error(`E-5.2 OAuth経路の${label}送信先は空にしてください`);
  }
}

export function verifyE5OAuthConfig(config, mode) {
  if (mode !== "production" && mode !== "development") {
    throw new Error("E-5.2 OAuth設定検査の対象環境が不明です");
  }
  const observability = config.observability;
  const logs = observability?.logs;
  const traces = observability?.traces;
  const target = EXPECTED_TARGETS[mode];

  if (Object.hasOwn(config, "env")) {
    throw new Error("E-5.2 OAuth設定では別環境へ切り替え可能なenvセクションを許可しません");
  }

  if (config.name !== target.workerName || config.account_id !== APPROVED_COMPANY_ACCOUNT_ID) {
    throw new Error("E-5.2 OAuth設定のWorker名または会社account IDが固定対象と一致しません");
  }
  const databases = config.d1_databases;
  const database = Array.isArray(databases) && databases.length === 1
    ? databases[0]
    : null;
  if (database?.binding !== "DB" || database.database_name !== target.databaseName
    || database.database_id !== target.databaseId || database.migrations_dir !== "migrations") {
    throw new Error("E-5.2 OAuth設定のD1 binding・名前・ID・migration先が固定対象と一致しません");
  }
  if (mode === "development" && config.vars?.YOUTUBE_OAUTH_REDIRECT_URI !== target.redirectUri) {
    throw new Error("E-5.2 OAuth開発環境のredirect URIが固定dev Workerと一致しません");
  }

  if (config.logpush !== false) {
    throw new Error("E-5.2 OAuth経路ではLogpushを無効にしてください");
  }
  if (Object.hasOwn(config, "tail_consumers") || Object.hasOwn(config, "streaming_tail_consumers")) {
    throw new Error("E-5.2 OAuth経路を含むWorkerへtail consumerを設定しないでください");
  }
  requireEmptyDestinations(logs?.destinations, "Workers Logs外部");
  requireEmptyDestinations(traces?.destinations, "trace外部");
  if (traces?.enabled !== false || traces?.persist !== false) {
    throw new Error("E-5.2 OAuth経路ではtracesを無効にしてください");
  }

  if (mode === "development") {
    if (observability?.enabled !== true
      || observability?.redact_query_string !== true
      || logs?.enabled !== true
      || logs?.head_sampling_rate !== 1
      || logs?.invocation_logs !== false
      || logs?.persist !== true) {
      throw new Error("E-5.2 OAuth開発環境はqueryを削除し、invocation logsを除いたWorkers Logsだけを有効にしてください");
    }
  } else if (observability?.enabled !== false
    || Object.hasOwn(observability ?? {}, "redact_query_string")
    || logs?.enabled !== false
    || logs?.invocation_logs !== false
    || logs?.persist !== false) {
    throw new Error("E-5.2 OAuth通常設定ではObservabilityとWorkers Logsを無効にしてください");
  }

  if (!Array.isArray(config.compatibility_flags)
    || !config.compatibility_flags.includes("global_fetch_strictly_public")) {
    throw new Error("E-5.2 OAuthの公開Access署名鍵・Google API取得にglobal_fetch_strictly_publicを有効化してください");
  }
  for (const secretName of [
    "YOUTUBE_OAUTH_CLIENT_SECRET",
    "YOUTUBE_OAUTH_ENCRYPTION_KEY",
    "YOUTUBE_OAUTH_ALLOWED_EMAILS",
  ]) {
    if (Object.hasOwn(config.vars ?? {}, secretName)) {
      throw new Error(`${secretName}はvarsではなくWorker Secretへ設定してください`);
    }
  }
}

async function main() {
  const configPath = process.argv[2]
    ? resolve(process.cwd(), process.argv[2])
    : new URL(`../${PRODUCTION_CONFIG}`, import.meta.url);
  const configName = process.argv[2] ? basename(configPath) : PRODUCTION_CONFIG;
  const mode = configName === DEVELOPMENT_CONFIG
    ? "development"
    : configName === PRODUCTION_CONFIG ? "production" : null;
  if (!mode) throw new Error(`E-5.2 OAuth設定検査の対象外です: ${configName}`);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  verifyE5OAuthConfig(config, mode);
  console.log(`E-5.2 OAuth設定: ${configName} の会社account ID・公開fetch互換性・環境別ログ制限・query削除・外部送信禁止を確認しました`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
