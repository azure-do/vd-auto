import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyE5OAuthConfig } from "./verify-e5-oauth-config.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WORKER_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");
export const APPROVED_DEV_CONFIG_PATH = resolve(WORKER_DIRECTORY, "wrangler.e3-dev.jsonc");
const WRANGLER_PATH = resolve(WORKER_DIRECTORY, "node_modules/.bin/wrangler");
export const FORBIDDEN_DEPLOY_ENVIRONMENT_KEYS = Object.freeze([
  // Wrangler 4.128 reads these as Worker/config/API-environment overrides.
  "WRANGLER_CI_OVERRIDE_NAME",
  "CLOUDFLARE_ENV",
  "WRANGLER_API_ENVIRONMENT",
  "CLOUDFLARE_API_BASE_URL",
  "CF_API_BASE_URL",
  "CLOUDFLARE_COMPLIANCE_REGION",
  // These can increase console detail, redirect disk/tool output, or attach a
  // caller-provided trace identifier. Defaults are safer than parent overrides.
  "WRANGLER_LOG",
  "WRANGLER_LOG_PATH",
  "WRANGLER_OUTPUT_FILE_DIRECTORY",
  "WRANGLER_OUTPUT_FILE_PATH",
  "WRANGLER_TRACE_ID",
]);
const SAFE_BOOLEAN_TOOL_ENVIRONMENT = Object.freeze({
  WRANGLER_LOG_SANITIZE: true,
  WRANGLER_WRITE_LOGS: false,
  WRANGLER_SEND_ERROR_REPORTS: false,
  WRANGLER_SEND_METRICS: false,
});

function verifyApprovedDevelopmentConfig(source) {
  let config;
  try {
    config = JSON.parse(source);
  } catch {
    throw new Error("E-5.2 OAuth開発設定をJSONとして読み込めません");
  }
  verifyE5OAuthConfig(config, "development");
}

function runLocalWrangler(args, environment) {
  const result = spawnSync(WRANGLER_PATH, args, {
    cwd: WORKER_DIRECTORY,
    encoding: "utf8",
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Wranglerが失敗しました (exit ${result.status ?? "unknown"})`);
  }
}

function safeWranglerEnvironment(environment) {
  for (const key of FORBIDDEN_DEPLOY_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined && value !== "") {
      throw new Error(`E-5.2 OAuth開発配備では${key}による配備先・出力の上書きを許可しません`);
    }
  }
  for (const [key, safeValue] of Object.entries(SAFE_BOOLEAN_TOOL_ENVIRONMENT)) {
    const value = environment[key];
    if (value === undefined || value === "") continue;
    const normalized = value.toLowerCase();
    const safeValues = safeValue ? ["true", "1"] : ["false", "0"];
    if (!safeValues.includes(normalized)) {
      throw new Error(`E-5.2 OAuth開発配備では${key}の危険な値を許可しません`);
    }
  }
  const safeEnvironment = { ...environment };
  for (const key of FORBIDDEN_DEPLOY_ENVIRONMENT_KEYS) delete safeEnvironment[key];
  for (const [key, value] of Object.entries(SAFE_BOOLEAN_TOOL_ENVIRONMENT)) {
    safeEnvironment[key] = String(value);
  }
  // Disable telemetry even if a global Wrangler preference enables it.
  safeEnvironment.DO_NOT_TRACK = "1";
  return safeEnvironment;
}

/**
 * Deploys only the repository's approved development config. The injectable
 * functions exist solely for side-effect-free tests; callers cannot replace the
 * config path or append Wrangler flags such as --name.
 */
export async function deployApprovedE5OAuthDevelopment({
  argv = [],
  environment = process.env,
  readConfig = (path) => readFile(path, "utf8"),
  runWrangler = runLocalWrangler,
  makeTemporaryDirectory = () => mkdtemp(join(tmpdir(), "e5-oauth-dev-dry-run-")),
  removeTemporaryDirectory = (path) => rm(path, { recursive: true, force: true }),
} = {}) {
  if (argv.length !== 0) {
    throw new Error("E-5.2 OAuth開発配備は引数を受け付けません（--name、--config等の上書き禁止）");
  }
  const wranglerEnvironment = safeWranglerEnvironment(environment);

  const configBeforeDryRun = await readConfig(APPROVED_DEV_CONFIG_PATH);
  verifyApprovedDevelopmentConfig(configBeforeDryRun);
  const dryRunDirectory = await makeTemporaryDirectory();
  try {
    await runWrangler([
      "deploy", "--dry-run", "--config", APPROVED_DEV_CONFIG_PATH,
      "--outdir", dryRunDirectory,
    ], wranglerEnvironment);

    const configBeforeDeploy = await readConfig(APPROVED_DEV_CONFIG_PATH);
    if (configBeforeDeploy !== configBeforeDryRun) {
      throw new Error("E-5.2 OAuth開発設定がdry-run後に変更されたため配備を中止しました");
    }
    verifyApprovedDevelopmentConfig(configBeforeDeploy);
    await runWrangler(["deploy", "--config", APPROVED_DEV_CONFIG_PATH], wranglerEnvironment);
  } finally {
    await removeTemporaryDirectory(dryRunDirectory);
  }
}

async function main() {
  await deployApprovedE5OAuthDevelopment({ argv: process.argv.slice(2) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
