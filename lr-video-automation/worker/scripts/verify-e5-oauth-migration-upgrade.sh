#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
worker_dir="$(cd "$script_dir/.." && pwd)"
fresh_dir="$(mktemp -d /tmp/lr-e5-oauth-fresh.XXXXXX)"
upgrade_dir="$(mktemp -d /tmp/lr-e5-oauth-upgrade.XXXXXX)"
conflict_dir="$(mktemp -d /tmp/lr-e5-oauth-conflict.XXXXXX)"
recovery_conflict_dir="$(mktemp -d /tmp/lr-e5-oauth-recovery-conflict.XXXXXX)"

cleanup() {
  for candidate in "$fresh_dir" "$upgrade_dir" "$conflict_dir" "$recovery_conflict_dir"; do
    if [[ -d "$candidate" && "$candidate" == /tmp/lr-e5-oauth-* ]]; then
      rm -rf -- "$candidate"
    fi
  done
}
trap cleanup EXIT INT TERM HUP

cd "$worker_dir"

apply_all() {
  local persist_dir="$1"
  npx wrangler d1 migrations apply lr-video-automation-e2-demo --local \
    --config demo/wrangler.e2-demo.jsonc --persist-to "$persist_dir" >/dev/null
}

assert_oauth_schema() {
  local persist_dir="$1"
  npx wrangler d1 execute lr-video-automation-e2-demo --local \
    --config demo/wrangler.e2-demo.jsonc --persist-to "$persist_dir" --json \
    --command "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('youtube_oauth_control', 'youtube_oauth_attempts', 'youtube_oauth_credentials', 'youtube_oauth_audits') ORDER BY name; SELECT COUNT(*) AS plaintext_token_columns FROM pragma_table_info('youtube_oauth_credentials') WHERE name IN ('access_token', 'refresh_token'); SELECT COUNT(*) AS actor_columns FROM pragma_table_info('youtube_oauth_audits') WHERE name = 'actor_subject_fingerprint' AND \"notnull\" = 1; SELECT generation, operation, operation_owner, operation_expires_at FROM youtube_oauth_control WHERE control_id = 1; SELECT COUNT(*) AS applied FROM d1_migrations WHERE name IN ('0009_e5_youtube_oauth_channel_binding.sql', '0010_e5_youtube_oauth_manual_recovery.sql'); SELECT COUNT(*) AS recovery_action FROM sqlite_schema WHERE type = 'table' AND name = 'youtube_oauth_audits' AND sql LIKE '%oauth.recovered%';" \
    | node -e '
      let input = "";
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        const output = JSON.parse(input);
        const tables = output[0]?.results?.map((row) => row.name) ?? [];
        const expected = ["youtube_oauth_attempts", "youtube_oauth_audits", "youtube_oauth_control", "youtube_oauth_credentials"];
        if (JSON.stringify(tables) !== JSON.stringify(expected)) {
          throw new Error(`OAuth tables differ: ${JSON.stringify(tables)}`);
        }
        if (output[1]?.results?.[0]?.plaintext_token_columns !== 0) {
          throw new Error("plaintext token column detected");
        }
        if (output[2]?.results?.[0]?.actor_columns !== 1) {
          throw new Error("actor fingerprint audit column missing");
        }
        const control = output[3]?.results?.[0];
        if (JSON.stringify(control) !== JSON.stringify({ generation: 0, operation: "READY", operation_owner: null, operation_expires_at: null })) {
          throw new Error(`OAuth control differs: ${JSON.stringify(control)}`);
        }
        if (output[4]?.results?.[0]?.applied !== 2) {
          throw new Error("OAuth migration record missing or duplicated");
        }
        if (output[5]?.results?.[0]?.recovery_action !== 1) {
          throw new Error("oauth.recovered audit action missing");
        }
      });
    '
}

# Fresh database and no-op reapplication.
apply_all "$fresh_dir"
apply_all "$fresh_dir"
assert_oauth_schema "$fresh_dir"

# Upgrade from every migration that preceded E-5.2 while preserving existing state.
for migration in migrations/000{1..8}_*.sql; do
  npx wrangler d1 execute lr-video-automation-e2-demo --local \
    --config demo/wrangler.e2-demo.jsonc --persist-to "$upgrade_dir" \
    --file "$migration" >/dev/null
done
npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$upgrade_dir" \
  --command "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT INTO d1_migrations(name) VALUES ('0001_e1_common_foundation.sql'), ('0002_e2_local_identity_class_read_model.sql'), ('0003_e2_intake_decision_and_notification_leases.sql'), ('0004_e5_publication_error_details.sql'), ('0005_e3_fake_upload_receipt_contracts.sql'), ('0006_e3_upload_receipt_object_ref.sql'), ('0007_e3_completed_checksum_fence.sql'), ('0008_e4_fake_approval_contracts.sql'); INSERT INTO video_jobs (video_job_id, submission_id, branch_id, studio_id, class_id, teacher_id, state, creation_token, creation_fingerprint, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000918', '00000000-0000-4000-8000-000000010918', 'branch_fake', 'studio_fake', 'class_fake', 'teacher_fake', 'WAITING_APPROVAL', 'creation_oauth_upgrade', printf('%064d', 18), '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z');" >/dev/null
apply_all "$upgrade_dir"
apply_all "$upgrade_dir"
assert_oauth_schema "$upgrade_dir"
npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$upgrade_dir" --json \
  --command "SELECT video_job_id, state, creation_token FROM video_jobs WHERE video_job_id = '00000000-0000-4000-8000-000000000918';" \
  | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const row = JSON.parse(input)[0]?.results?.[0];
      const expected = { video_job_id: "00000000-0000-4000-8000-000000000918", state: "WAITING_APPROVAL", creation_token: "creation_oauth_upgrade" };
      if (JSON.stringify(row) !== JSON.stringify(expected)) {
        throw new Error(`existing row changed: ${JSON.stringify(row)}`);
      }
    });
  '

# A conflicting legacy table must fail without creating the other OAuth tables or recording 0009.
for migration in migrations/000{1..8}_*.sql; do
  npx wrangler d1 execute lr-video-automation-e2-demo --local \
    --config demo/wrangler.e2-demo.jsonc --persist-to "$conflict_dir" \
    --file "$migration" >/dev/null
done
npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$conflict_dir" \
  --command "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT INTO d1_migrations(name) VALUES ('0001_e1_common_foundation.sql'), ('0002_e2_local_identity_class_read_model.sql'), ('0003_e2_intake_decision_and_notification_leases.sql'), ('0004_e5_publication_error_details.sql'), ('0005_e3_fake_upload_receipt_contracts.sql'), ('0006_e3_upload_receipt_object_ref.sql'), ('0007_e3_completed_checksum_fence.sql'), ('0008_e4_fake_approval_contracts.sql'); CREATE TABLE youtube_oauth_attempts(sentinel TEXT PRIMARY KEY); INSERT INTO youtube_oauth_attempts VALUES ('preserve');" >/dev/null
if apply_all "$conflict_dir" 2>/dev/null; then
  echo "expected conflicting migration to fail" >&2
  exit 1
fi
npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$conflict_dir" --json \
  --command "SELECT sentinel FROM youtube_oauth_attempts; SELECT COUNT(*) AS partial_tables FROM sqlite_schema WHERE type = 'table' AND name IN ('youtube_oauth_control', 'youtube_oauth_credentials', 'youtube_oauth_audits'); SELECT COUNT(*) AS applied FROM d1_migrations WHERE name = '0009_e5_youtube_oauth_channel_binding.sql';" \
  | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const output = JSON.parse(input);
      if (output[0]?.results?.[0]?.sentinel !== "preserve") throw new Error("sentinel changed");
      if (output[1]?.results?.[0]?.partial_tables !== 0) throw new Error("partial OAuth tables remained");
      if (output[2]?.results?.[0]?.applied !== 0) throw new Error("failed migration was recorded");
    });
  '

# A conflict in 0010 must preserve the 0009 audit table and leave 0010 unapplied.
for migration in migrations/000{1..9}_*.sql; do
  npx wrangler d1 execute lr-video-automation-e2-demo --local \
    --config demo/wrangler.e2-demo.jsonc --persist-to "$recovery_conflict_dir" \
    --file "$migration" >/dev/null
done
npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$recovery_conflict_dir" \
  --command "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT INTO d1_migrations(name) VALUES ('0001_e1_common_foundation.sql'), ('0002_e2_local_identity_class_read_model.sql'), ('0003_e2_intake_decision_and_notification_leases.sql'), ('0004_e5_publication_error_details.sql'), ('0005_e3_fake_upload_receipt_contracts.sql'), ('0006_e3_upload_receipt_object_ref.sql'), ('0007_e3_completed_checksum_fence.sql'), ('0008_e4_fake_approval_contracts.sql'), ('0009_e5_youtube_oauth_channel_binding.sql'); INSERT INTO youtube_oauth_audits(oauth_audit_id, oauth_attempt_id, actor_subject_fingerprint, action, reason_code, occurred_at) VALUES ('preserve-audit', NULL, printf('%064d', 1), 'oauth.failed', 'PRESERVE', '2026-08-30T00:00:00.000Z'); CREATE TABLE youtube_oauth_audits_recovery(sentinel TEXT PRIMARY KEY); INSERT INTO youtube_oauth_audits_recovery VALUES ('preserve');" >/dev/null
if apply_all "$recovery_conflict_dir" 2>/dev/null; then
  echo "expected recovery migration conflict to fail" >&2
  exit 1
fi
npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$recovery_conflict_dir" --json \
  --command "SELECT action, reason_code FROM youtube_oauth_audits WHERE oauth_audit_id = 'preserve-audit'; SELECT sentinel FROM youtube_oauth_audits_recovery; SELECT COUNT(*) AS applied FROM d1_migrations WHERE name = '0010_e5_youtube_oauth_manual_recovery.sql';" \
  | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const output = JSON.parse(input);
      const audit = output[0]?.results?.[0];
      if (JSON.stringify(audit) !== JSON.stringify({ action: "oauth.failed", reason_code: "PRESERVE" })) throw new Error("original audit changed");
      if (output[1]?.results?.[0]?.sentinel !== "preserve") throw new Error("conflicting table changed");
      if (output[2]?.results?.[0]?.applied !== 0) throw new Error("failed 0010 migration was recorded");
    });
  '

echo "E-5.2 OAuth fresh, reapply, upgrade preservation, 0009 conflict rollback, and 0010 conflict rollback verified"
