import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  APPROVED_DEV_CONFIG_PATH,
  FORBIDDEN_DEPLOY_ENVIRONMENT_KEYS,
  deployApprovedE5OAuthDevelopment,
} from "./deploy-e5-oauth-dev.mjs";

const approvedSource = await readFile(APPROVED_DEV_CONFIG_PATH, "utf8");
const safeToolEnvironment = {
  WRANGLER_LOG_SANITIZE: "true",
  WRANGLER_WRITE_LOGS: "false",
  WRANGLER_SEND_ERROR_REPORTS: "false",
  WRANGLER_SEND_METRICS: "false",
  DO_NOT_TRACK: "1",
};

function testDependencies(sources = [approvedSource, approvedSource]) {
  const calls = [];
  let readIndex = 0;
  return {
    calls,
    options: {
      environment: {},
      readConfig: async (path) => {
        calls.push(["read", path]);
        return sources[Math.min(readIndex++, sources.length - 1)];
      },
      runWrangler: async (args, environment) => { calls.push(["wrangler", args, environment]); },
      makeTemporaryDirectory: async () => {
        calls.push(["make-temp"]);
        return "/tmp/e5-oauth-dev-test-dry-run";
      },
      removeTemporaryDirectory: async (path) => { calls.push(["remove-temp", path]); },
    },
  };
}

test("固定dev設定の検査→dry-run→再検査→配備の順でのみ実行する", async () => {
  const dependencies = testDependencies();
  await deployApprovedE5OAuthDevelopment(dependencies.options);

  assert.deepEqual(dependencies.calls, [
    ["read", APPROVED_DEV_CONFIG_PATH],
    ["make-temp"],
    ["wrangler", [
      "deploy", "--dry-run", "--config", APPROVED_DEV_CONFIG_PATH,
      "--outdir", "/tmp/e5-oauth-dev-test-dry-run",
    ], safeToolEnvironment],
    ["read", APPROVED_DEV_CONFIG_PATH],
    ["wrangler", ["deploy", "--config", APPROVED_DEV_CONFIG_PATH], safeToolEnvironment],
    ["remove-temp", "/tmp/e5-oauth-dev-test-dry-run"],
  ]);
  for (const [, args] of dependencies.calls.filter(([kind]) => kind === "wrangler")) {
    assert.equal(args.includes("--name"), false);
  }
});

test("--nameや--configなどの利用者引数を受け付けない", async () => {
  for (const argv of [["--name", "lr-video-automation"], ["--config", "wrangler.jsonc"]]) {
    const dependencies = testDependencies();
    await assert.rejects(
      deployApprovedE5OAuthDevelopment({ ...dependencies.options, argv }),
      /上書き禁止/,
    );
    assert.deepEqual(dependencies.calls, []);
  }
});

test("配備先・ログ出力の危険な環境変数を拒否し、安全値だけを子processへ渡す", async () => {
  const unsafeValues = {
    WRANGLER_LOG: "debug",
    WRANGLER_LOG_PATH: "/tmp/unsafe-wrangler-log-marker",
    WRANGLER_OUTPUT_FILE_DIRECTORY: "/tmp/unsafe-wrangler-output-marker",
    WRANGLER_OUTPUT_FILE_PATH: "/tmp/unsafe-wrangler-output-marker.json",
    WRANGLER_TRACE_ID: "unsafe-trace-marker",
  };
  for (const key of FORBIDDEN_DEPLOY_ENVIRONMENT_KEYS) {
    const dependencies = testDependencies();
    dependencies.options.environment = { [key]: unsafeValues[key] ?? "unsafe-override-marker" };
    await assert.rejects(
      deployApprovedE5OAuthDevelopment(dependencies.options),
      new RegExp(key),
    );
    assert.deepEqual(dependencies.calls, []);
  }
  for (const [key, value] of [
    ["WRANGLER_LOG_SANITIZE", "false"],
    ["WRANGLER_WRITE_LOGS", "true"],
    ["WRANGLER_SEND_ERROR_REPORTS", "true"],
    ["WRANGLER_SEND_METRICS", "true"],
  ]) {
    const dependencies = testDependencies();
    dependencies.options.environment = { [key]: value };
    await assert.rejects(
      deployApprovedE5OAuthDevelopment(dependencies.options),
      new RegExp(key),
    );
    assert.deepEqual(dependencies.calls, []);
  }

  const emptyDependencies = testDependencies();
  emptyDependencies.options.environment = {
    WRANGLER_CI_OVERRIDE_NAME: "",
    CLOUDFLARE_ENV: "",
    WRANGLER_LOG: "",
    WRANGLER_LOG_PATH: "",
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_WRITE_LOGS: "false",
    WRANGLER_SEND_ERROR_REPORTS: "0",
    WRANGLER_SEND_METRICS: "0",
    WRANGLER_OUTPUT_FILE_DIRECTORY: "",
    WRANGLER_OUTPUT_FILE_PATH: "",
    WRANGLER_TRACE_ID: "",
    CLOUDFLARE_API_TOKEN: "test-auth-marker",
  };
  await deployApprovedE5OAuthDevelopment(emptyDependencies.options);
  const wranglerCalls = emptyDependencies.calls.filter(([kind]) => kind === "wrangler");
  assert.equal(wranglerCalls.length, 2);
  for (const [, , environment] of wranglerCalls) {
    assert.deepEqual(environment, {
      CLOUDFLARE_API_TOKEN: "test-auth-marker",
      ...safeToolEnvironment,
    });
  }
});

test("通常Worker名・通常D1・別redirectの設定ではdry-run前に停止する", async () => {
  const approved = JSON.parse(approvedSource);
  for (const mutate of [
    (config) => { config.name = "lr-video-automation"; },
    (config) => { config.d1_databases[0].database_name = "lr-video-automation-local"; },
    (config) => { config.vars.YOUTUBE_OAUTH_REDIRECT_URI = "https://lr-video-automation.example.invalid/__ops/e5/youtube-oauth/callback"; },
    (config) => { config.env = {}; },
  ]) {
    const invalid = structuredClone(approved);
    mutate(invalid);
    const dependencies = testDependencies([JSON.stringify(invalid)]);
    await assert.rejects(deployApprovedE5OAuthDevelopment(dependencies.options));
    assert.deepEqual(dependencies.calls, [["read", APPROVED_DEV_CONFIG_PATH]]);
  }
});

test("dry-run後の設定変更やdry-run失敗時は配備を実行しない", async () => {
  const changed = JSON.parse(approvedSource);
  changed.name = "lr-video-automation";
  const changedDependencies = testDependencies([approvedSource, JSON.stringify(changed)]);
  await assert.rejects(
    deployApprovedE5OAuthDevelopment(changedDependencies.options),
    /dry-run後に変更/,
  );
  assert.equal(changedDependencies.calls.filter(([kind]) => kind === "wrangler").length, 1);

  const failedDependencies = testDependencies();
  failedDependencies.options.runWrangler = async (args, environment) => {
    failedDependencies.calls.push(["wrangler", args, environment]);
    throw new Error("dry-run failed");
  };
  await assert.rejects(
    deployApprovedE5OAuthDevelopment(failedDependencies.options),
    /dry-run failed/,
  );
  assert.equal(failedDependencies.calls.filter(([kind]) => kind === "wrangler").length, 1);
});
