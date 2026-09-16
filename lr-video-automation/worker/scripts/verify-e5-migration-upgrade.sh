#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
worker_dir="$(cd "$script_dir/.." && pwd)"
fresh_dir="$(mktemp -d /tmp/lr-e5-fresh.XXXXXX)"
upgrade_dir="$(mktemp -d /tmp/lr-e5-upgrade.XXXXXX)"

cleanup() {
  if [[ -d "$fresh_dir" && "$fresh_dir" == /tmp/lr-e5-fresh.* ]]; then
    rm -rf -- "$fresh_dir"
  fi
  if [[ -d "$upgrade_dir" && "$upgrade_dir" == /tmp/lr-e5-upgrade.* ]]; then
    rm -rf -- "$upgrade_dir"
  fi
}
trap cleanup EXIT INT TERM HUP

cd "$worker_dir"

# Fresh database: apply every migration, then prove a second application is a no-op.
npx wrangler d1 migrations apply lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$fresh_dir" >/dev/null
npx wrangler d1 migrations apply lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$fresh_dir" >/dev/null

npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$fresh_dir" --json \
  --command "SELECT name FROM pragma_table_info('idempotency_records') WHERE name IN ('error_code', 'provider_reason_code', 'retryable', 'yt_committed_offset', 'yt_video_id', 'yt_session_state', 'yt_reconciled_at') ORDER BY name;" \
  | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const rows = JSON.parse(input)[0]?.results ?? [];
      const names = rows.map((row) => row.name);
      const expected = ["error_code", "provider_reason_code", "retryable", "yt_committed_offset", "yt_reconciled_at", "yt_session_state", "yt_video_id"];
      if (JSON.stringify(names) !== JSON.stringify(expected)) {
        throw new Error(`fresh migration columns differ: ${JSON.stringify(names)}`);
      }
    });
  '

npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$fresh_dir" --json \
  --command "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('youtube_publication_attempts', 'youtube_reconciliation_observations') ORDER BY name;" \
  | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const names = (JSON.parse(input)[0]?.results ?? []).map((row) => row.name);
      const expected = ["youtube_publication_attempts", "youtube_reconciliation_observations"];
      if (JSON.stringify(names) !== JSON.stringify(expected)) {
        throw new Error(`fresh E-5.4 tables differ: ${JSON.stringify(names)}`);
      }
    });
  '

# Upgrade database: reproduce 0001-0003 as already applied and preserve an existing row.
for migration in \
  migrations/0001_e1_common_foundation.sql \
  migrations/0002_e2_local_identity_class_read_model.sql \
  migrations/0003_e2_intake_decision_and_notification_leases.sql; do
  npx wrangler d1 execute lr-video-automation-e2-demo --local \
    --config demo/wrangler.e2-demo.jsonc --persist-to "$upgrade_dir" \
    --file "$migration" >/dev/null
done
npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$upgrade_dir" \
  --command "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT INTO d1_migrations(name) VALUES ('0001_e1_common_foundation.sql'), ('0002_e2_local_identity_class_read_model.sql'), ('0003_e2_intake_decision_and_notification_leases.sql'); INSERT INTO video_jobs (video_job_id, submission_id, branch_id, studio_id, class_id, teacher_id, state, approved_content_version, creation_token, creation_fingerprint, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000991', '00000000-0000-4000-8000-000000010991', 'branch_fake', 'studio_fake', 'class_fake', 'teacher_fake', 'PUBLISHING', 'approved-v1', 'creation_e5_upgrade', printf('%064d', 1), '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z'); INSERT INTO idempotency_records (idempotency_key, video_job_id, destination, target_account_id, approved_content_version, status, result_ref, created_at, updated_at) VALUES ('upgrade_record', '00000000-0000-4000-8000-000000000991', 'youtube', 'youtube_account_fake', 'approved-v1', 'FAILED', NULL, '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z');" >/dev/null

npx wrangler d1 migrations apply lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$upgrade_dir" >/dev/null
npx wrangler d1 migrations apply lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$upgrade_dir" >/dev/null

npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$upgrade_dir" --json \
  --command "SELECT idempotency_key, status, result_ref, error_code, provider_reason_code, retryable, yt_committed_offset, yt_video_id, yt_session_state, yt_reconciled_at FROM idempotency_records WHERE idempotency_key = 'upgrade_record';" \
  | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const row = JSON.parse(input)[0]?.results?.[0];
      const expected = {
        idempotency_key: "upgrade_record",
        status: "FAILED",
        result_ref: null,
        error_code: null,
        provider_reason_code: null,
        retryable: null,
        yt_committed_offset: 0,
        yt_video_id: null,
        yt_session_state: "NONE",
        yt_reconciled_at: null,
      };
      if (JSON.stringify(row) !== JSON.stringify(expected)) {
        throw new Error(`existing publication row changed: ${JSON.stringify(row)}`);
      }
    });
  '

echo "E-5 fresh, reapply, and 0001-0003 upgrade migrations verified; temporary data removed on exit"
