import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { verifyE5OAuthConfig } from "./verify-e5-oauth-config.mjs";

const production = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const development = JSON.parse(await readFile(new URL("../wrangler.e3-dev.jsonc", import.meta.url), "utf8"));

test("通常設定はすべてのログ・trace・外部送信を無効にする", () => {
  assert.doesNotThrow(() => verifyE5OAuthConfig(production, "production"));
  for (const mutate of [
    (config) => { config.name = "lr-video-automation-dev-20260824"; },
    (config) => { config.account_id = "00000000000000000000000000000000"; },
    (config) => { config.d1_databases[0].database_name = "lr-video-automation-dev-20260824"; },
    (config) => { config.d1_databases[0].database_id = "e35cdb5b-2de4-4f62-894f-62fefe904583"; },
    (config) => { config.observability.enabled = true; },
    (config) => { config.observability.logs.enabled = true; },
    (config) => { config.observability.logs.invocation_logs = true; },
    (config) => { config.observability.logs.persist = true; },
    (config) => { config.observability.traces.enabled = true; },
  ]) {
    const invalid = structuredClone(production);
    mutate(invalid);
    assert.throws(() => verifyE5OAuthConfig(invalid, "production"));
  }
});

test("開発設定はquery削除済みの固定アプリログだけを保存する", () => {
  assert.doesNotThrow(() => verifyE5OAuthConfig(development, "development"));
  for (const mutate of [
    (config) => { config.name = "lr-video-automation"; },
    (config) => { config.account_id = "00000000000000000000000000000000"; },
    (config) => { config.d1_databases[0].database_name = "lr-video-automation-local"; },
    (config) => { config.d1_databases[0].database_id = "00000000-0000-0000-0000-000000000000"; },
    (config) => { config.env = {}; },
    (config) => { config.d1_databases.push(structuredClone(config.d1_databases[0])); },
    (config) => { config.env = { production: structuredClone(config) }; },
    (config) => { config.vars.YOUTUBE_OAUTH_REDIRECT_URI = "https://lr-video-automation.example.invalid/__ops/e5/youtube-oauth/callback"; },
    (config) => { delete config.observability.redact_query_string; },
    (config) => { config.observability.redact_query_string = false; },
    (config) => { config.observability.enabled = false; },
    (config) => { config.observability.logs.enabled = false; },
    (config) => { config.observability.logs.invocation_logs = true; },
    (config) => { config.observability.logs.persist = false; },
    (config) => { config.observability.logs.head_sampling_rate = 0.5; },
    (config) => { config.observability.traces.enabled = true; },
    (config) => { config.observability.traces.persist = true; },
    (config) => { config.logpush = true; },
    (config) => { config.observability.logs.destinations = ["external"]; },
    (config) => { config.observability.traces.destinations = ["external"]; },
    (config) => { config.tail_consumers = [{ service: "tail" }]; },
    (config) => { config.streaming_tail_consumers = [{ service: "streaming-tail" }]; },
  ]) {
    const invalid = structuredClone(development);
    mutate(invalid);
    assert.throws(() => verifyE5OAuthConfig(invalid, "development"));
  }
});

test("環境名だけを偽って通常Workerへ開発ログを適用できない", () => {
  assert.throws(() => verifyE5OAuthConfig(development, "production"));
  assert.throws(() => verifyE5OAuthConfig(production, "development"));
});

test("ログ設定が安全でも秘密値をvarsへ置くことを拒否する", () => {
  for (const secretName of [
    "YOUTUBE_OAUTH_CLIENT_SECRET",
    "YOUTUBE_OAUTH_ENCRYPTION_KEY",
    "YOUTUBE_OAUTH_ALLOWED_EMAILS",
  ]) {
    const invalid = structuredClone(development);
    invalid.vars[secretName] = "must-not-be-here";
    assert.throws(() => verifyE5OAuthConfig(invalid, "development"));
  }
});
