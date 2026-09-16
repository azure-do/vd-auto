#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
worker_dir="$(cd "$script_dir/.." && pwd)"
fresh_dir="$(mktemp -d /tmp/lr-e4-fresh.XXXXXX)"
upgrade_dir="$(mktemp -d /tmp/lr-e4-upgrade.XXXXXX)"
failure_dir="$(mktemp -d /tmp/lr-e4-failure.XXXXXX)"

cleanup() {
  for temporary_dir in "$fresh_dir" "$upgrade_dir" "$failure_dir"; do
    if [[ -d "$temporary_dir" && "$temporary_dir" == /tmp/lr-e4-*.?????? ]]; then
      rm -rf -- "$temporary_dir"
    fi
  done
}
trap cleanup EXIT INT TERM HUP

cd "$worker_dir"

execute_file() {
  npx wrangler d1 execute lr-video-automation-e2-demo --local \
    --config demo/wrangler.e2-demo.jsonc --persist-to "$1" --file "$2" >/dev/null
}

apply_current() {
  npx wrangler d1 migrations apply lr-video-automation-e2-demo --local \
    --config demo/wrangler.e2-demo.jsonc --persist-to "$1" >/dev/null
}

query_json() {
  npx wrangler d1 execute lr-video-automation-e2-demo --local \
    --config demo/wrangler.e2-demo.jsonc --persist-to "$1" --json --command "$2"
}

# Fresh creation and reapplication.
apply_current "$fresh_dir"
apply_current "$fresh_dir"
query_json "$fresh_dir" \
  "SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('fake_approval_allowlist','approval_requests','approval_decision_claims','fake_approval_notification_outbox','fake_approval_notification_deliveries','approval_security_audits','approval_publisher_outbox','fake_publisher_deliveries')) tables_created, (SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_approval_requests_one_active_job') active_index, (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_approval_requests_snapshot_immutable','trg_approval_decision_claims_immutable','trg_fake_approval_notification_snapshot_immutable','trg_approval_publisher_snapshot_immutable')) immutable_triggers, (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_approval_requests_decision_guard') decision_guard, (SELECT COUNT(*) FROM d1_migrations WHERE name = '0008_e4_fake_approval_contracts.sql') migration_recorded, (SELECT COUNT(*) FROM pragma_foreign_key_check) fk_errors;" \
  | node -e '
    let input = "";
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      const row = JSON.parse(input)[0]?.results?.[0];
      const expected = { tables_created: 8, active_index: 1, immutable_triggers: 4, decision_guard: 1, migration_recorded: 1, fk_errors: 0 };
      if (JSON.stringify(row) !== JSON.stringify(expected)) {
        throw new Error(`fresh E-4 migration differs: ${JSON.stringify(row)}`);
      }
    });
  '

# Existing E-1/E-2/E-3/E-5 database keeps its rows while receiving E-4.
for migration in migrations/000{1,2,3,4,5,6,7}_*.sql; do
  execute_file "$upgrade_dir" "$migration"
done
query_json "$upgrade_dir" \
  "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT INTO d1_migrations(name) VALUES ('0001_e1_common_foundation.sql'),('0002_e2_local_identity_class_read_model.sql'),('0003_e2_intake_decision_and_notification_leases.sql'),('0004_e5_publication_error_details.sql'),('0005_e3_fake_upload_receipt_contracts.sql'),('0006_e3_upload_receipt_object_ref.sql'),('0007_e3_completed_checksum_fence.sql'); INSERT INTO video_jobs (video_job_id, submission_id, branch_id, studio_id, class_id, teacher_id, state, creation_token, creation_fingerprint, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000916','00000000-0000-4000-8000-000000010916','branch_fake','studio_fake','class_fake','teacher_fake','WAITING_APPROVAL','creation_e4_upgrade',printf('%064d', 1),'2026-08-25T00:00:00.000Z','2026-08-25T00:00:00.000Z');" >/dev/null
apply_current "$upgrade_dir"
apply_current "$upgrade_dir"
query_json "$upgrade_dir" \
  "SELECT (SELECT COUNT(*) FROM video_jobs WHERE creation_token = 'creation_e4_upgrade') old_jobs, (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_approval_requests_snapshot_immutable','trg_approval_decision_claims_immutable','trg_fake_approval_notification_snapshot_immutable','trg_approval_publisher_snapshot_immutable')) immutable_triggers, (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_approval_requests_decision_guard') decision_guard, (SELECT COUNT(*) FROM d1_migrations WHERE name = '0008_e4_fake_approval_contracts.sql') migration_recorded, (SELECT COUNT(*) FROM pragma_foreign_key_check) fk_errors;" \
  | node -e '
    let input = "";
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      const row = JSON.parse(input)[0]?.results?.[0];
      const expected = { old_jobs: 1, immutable_triggers: 4, decision_guard: 1, migration_recorded: 1, fk_errors: 0 };
      if (JSON.stringify(row) !== JSON.stringify(expected)) {
        throw new Error(`upgrade E-4 migration differs: ${JSON.stringify(row)}`);
      }
    });
  '

# A conflicting legacy object must abort the complete migration transaction.
for migration in migrations/000{1,2,3,4,5,6,7}_*.sql; do
  execute_file "$failure_dir" "$migration"
done
query_json "$failure_dir" \
  "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT INTO d1_migrations(name) VALUES ('0001_e1_common_foundation.sql'),('0002_e2_local_identity_class_read_model.sql'),('0003_e2_intake_decision_and_notification_leases.sql'),('0004_e5_publication_error_details.sql'),('0005_e3_fake_upload_receipt_contracts.sql'),('0006_e3_upload_receipt_object_ref.sql'),('0007_e3_completed_checksum_fence.sql'); CREATE TABLE approval_requests(sentinel TEXT); INSERT INTO approval_requests VALUES ('legacy_preserved');" >/dev/null
if apply_current "$failure_dir" >/dev/null 2>&1; then
  echo "0008 unexpectedly accepted a conflicting table" >&2
  exit 1
fi
query_json "$failure_dir" \
  "SELECT (SELECT COUNT(*) FROM approval_requests WHERE sentinel = 'legacy_preserved') legacy_rows, (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'fake_approval_allowlist') partial_tables, (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'approval_decision_claims') partial_claim_tables, (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_approval_requests_snapshot_immutable','trg_approval_decision_claims_immutable','trg_fake_approval_notification_snapshot_immutable','trg_approval_publisher_snapshot_immutable','trg_approval_requests_decision_guard')) partial_triggers, (SELECT COUNT(*) FROM d1_migrations WHERE name = '0008_e4_fake_approval_contracts.sql') migration_recorded;" \
  | node -e '
    let input = "";
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      const row = JSON.parse(input)[0]?.results?.[0];
      const expected = { legacy_rows: 1, partial_tables: 0, partial_claim_tables: 0, partial_triggers: 0, migration_recorded: 0 };
      if (JSON.stringify(row) !== JSON.stringify(expected)) {
        throw new Error(`failed E-4 migration did not roll back: ${JSON.stringify(row)}`);
      }
    });
  '

echo "E-4 fresh, upgrade, reapply, and fail-closed rollback paths verified; temporary data removed on exit"
