#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
worker_dir="$(cd "$script_dir/.." && pwd)"
fresh_dir="$(mktemp -d /tmp/lr-e3-fresh.XXXXXX)"
upgrade_dir="$(mktemp -d /tmp/lr-e3-upgrade.XXXXXX)"
failure_dir="$(mktemp -d /tmp/lr-e3-failure.XXXXXX)"
duplicate_dir="$(mktemp -d /tmp/lr-e3-duplicate.XXXXXX)"

cleanup() {
  for temporary_dir in "$fresh_dir" "$upgrade_dir" "$failure_dir" "$duplicate_dir"; do
    if [[ -d "$temporary_dir" && "$temporary_dir" == /tmp/lr-e3-*.?????? ]]; then
      rm -rf -- "$temporary_dir"
    fi
  done
}
trap cleanup EXIT INT TERM HUP

cd "$worker_dir"

execute_file() {
  local persist_dir="$1"
  local migration_file="$2"
  npx wrangler d1 execute lr-video-automation-e2-demo --local \
    --config demo/wrangler.e2-demo.jsonc --persist-to "$persist_dir" \
    --file "$migration_file" >/dev/null
}

record_migrations() {
  local persist_dir="$1"
  local names_sql="$2"
  npx wrangler d1 execute lr-video-automation-e2-demo --local \
    --config demo/wrangler.e2-demo.jsonc --persist-to "$persist_dir" \
    --command "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT INTO d1_migrations(name) VALUES $names_sql;" >/dev/null
}

apply_current() {
  local persist_dir="$1"
  npx wrangler d1 migrations apply lr-video-automation-e2-demo --local \
    --config demo/wrangler.e2-demo.jsonc --persist-to "$persist_dir" >/dev/null
}

base_names="('0001_e1_common_foundation.sql'), ('0002_e2_local_identity_class_read_model.sql'), ('0003_e2_intake_decision_and_notification_leases.sql'), ('0004_e5_publication_error_details.sql')"
old_e3_names="$base_names, ('0005_e3_fake_upload_receipt_contracts.sql')"
pre_checksum_fence_names="$old_e3_names, ('0006_e3_upload_receipt_object_ref.sql')"

# Path A: an E-1/E-2/E-5 database receives current E-3 migrations, and reapply is a no-op.
for migration in \
  migrations/0001_e1_common_foundation.sql \
  migrations/0002_e2_local_identity_class_read_model.sql \
  migrations/0003_e2_intake_decision_and_notification_leases.sql \
  migrations/0004_e5_publication_error_details.sql; do
  execute_file "$fresh_dir" "$migration"
done
record_migrations "$fresh_dir" "$base_names"
npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$fresh_dir" \
  --command "INSERT INTO video_jobs (video_job_id, submission_id, branch_id, studio_id, class_id, teacher_id, state, creation_token, creation_fingerprint, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000981', '00000000-0000-4000-8000-000000010981', 'branch_fake', 'studio_fake', 'class_fake', 'teacher_fake', 'RECEIVED', 'creation_e3_upgrade', printf('%064d', 1), '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z');" >/dev/null
apply_current "$fresh_dir"
apply_current "$fresh_dir"

npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$fresh_dir" --json \
  --command "SELECT (SELECT COUNT(*) FROM video_jobs WHERE creation_token = 'creation_e3_upgrade') old_jobs, (SELECT COUNT(*) FROM pragma_table_info('fake_upload_sessions')) session_columns, (SELECT COUNT(*) FROM pragma_table_info('upload_receipt_events')) event_columns, (SELECT COUNT(*) FROM pragma_table_info('upload_receipt_events') WHERE name = 'object_ref' AND \"notnull\" = 1) event_object_ref, (SELECT COUNT(*) FROM d1_migrations WHERE name IN ('0005_e3_fake_upload_receipt_contracts.sql', '0006_e3_upload_receipt_object_ref.sql', '0007_e3_completed_checksum_fence.sql')) e3_migrations, (SELECT COUNT(*) FROM pragma_table_info('completed_upload_checksum_claims')) claim_columns, (SELECT COUNT(*) FROM completed_upload_checksum_claims) claims;" \
  | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const row = JSON.parse(input)[0]?.results?.[0];
      const expected = { old_jobs: 1, session_columns: 14, event_columns: 6, event_object_ref: 1, e3_migrations: 3, claim_columns: 3, claims: 0 };
      if (JSON.stringify(row) !== JSON.stringify(expected)) {
        throw new Error(`fresh E-3 path differs: ${JSON.stringify(row)}`);
      }
    });
  '

# Path B: reproduce 0005 already applied with a completed session and legacy receipt.
for migration in \
  migrations/0001_e1_common_foundation.sql \
  migrations/0002_e2_local_identity_class_read_model.sql \
  migrations/0003_e2_intake_decision_and_notification_leases.sql \
  migrations/0004_e5_publication_error_details.sql \
  migrations/0005_e3_fake_upload_receipt_contracts.sql; do
  execute_file "$upgrade_dir" "$migration"
done
record_migrations "$upgrade_dir" "$old_e3_names"
npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$upgrade_dir" \
  --command "INSERT INTO submission_intakes (submission_id, intended_video_job_id, request_fingerprint, subject_fingerprint, teacher_id, lesson_on, status, source_version, decision_fingerprint, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000982', '00000000-0000-4000-8000-000000000983', printf('%064d', 2), printf('%064d', 3), 'teacher_upgrade', '2026-08-20', 'RESOLVED', 1, printf('%064d', 4), '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'); INSERT INTO submission_candidate_snapshots (submission_id, class_id, branch_id, studio_id, teacher_id, source_version) VALUES ('00000000-0000-4000-8000-000000000982', 'class_upgrade', 'branch_upgrade', 'studio_upgrade', 'teacher_upgrade', 1); INSERT INTO fake_upload_sessions (submission_id, upload_id, request_fingerprint, expected_object_ref, expected_size_bytes, expected_checksum_sha256, expected_content_type, expires_at, status, completion_event_id, completed_at, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000982', '00000000-0000-4000-8000-000000000984', printf('%064d', 5), 'fake_object_upgrade', 1024, printf('%064d', 6), 'video/mp4', '2026-08-20T00:15:00.000Z', 'COMPLETED', '00000000-0000-4000-8000-000000000985', '2026-08-20T00:01:00.000Z', '2026-08-20T00:00:00.000Z', '2026-08-20T00:01:00.000Z'); INSERT INTO upload_receipt_events (event_id, submission_id, event_type, receipt_fingerprint, occurred_at) VALUES ('00000000-0000-4000-8000-000000000985', '00000000-0000-4000-8000-000000000982', 'video.uploaded', 'c664b524ab898de7c171b835296b49e2f2b7bceb33b40b95027fcec07dd5674d', '2026-08-20T00:01:00.000Z');" >/dev/null
apply_current "$upgrade_dir"
apply_current "$upgrade_dir"

npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$upgrade_dir" --json \
  --command "SELECT e.event_id, e.submission_id, e.object_ref, e.event_type, e.receipt_fingerprint, e.occurred_at, (e.object_ref = s.expected_object_ref) object_matches, (SELECT COUNT(*) FROM submission_candidate_snapshots c JOIN submission_intakes i ON i.submission_id = c.submission_id JOIN fake_upload_sessions cs ON cs.submission_id = i.submission_id JOIN upload_receipt_events ce ON ce.submission_id = i.submission_id WHERE i.submission_id = e.submission_id AND i.status = 'RESOLVED' AND i.video_job_id IS NULL AND cs.status = 'COMPLETED' AND cs.completion_event_id = ce.event_id AND cs.expected_object_ref = ce.object_ref AND ce.receipt_fingerprint = 'c664b524ab898de7c171b835296b49e2f2b7bceb33b40b95027fcec07dd5674d') consumer_ready, (SELECT COUNT(*) FROM pragma_foreign_key_check) fk_errors, (SELECT COUNT(*) FROM d1_migrations WHERE name = '0006_e3_upload_receipt_object_ref.sql') migration_recorded, (SELECT COUNT(*) FROM d1_migrations WHERE name = '0007_e3_completed_checksum_fence.sql') checksum_migration_recorded, (SELECT COUNT(*) FROM completed_upload_checksum_claims c WHERE c.checksum_sha256 = s.expected_checksum_sha256 AND c.owner_submission_id = s.submission_id AND c.claimed_at = s.completed_at) checksum_claim FROM upload_receipt_events e JOIN fake_upload_sessions s ON s.submission_id = e.submission_id;" \
  | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const row = JSON.parse(input)[0]?.results?.[0];
      const expected = {
        event_id: "00000000-0000-4000-8000-000000000985",
        submission_id: "00000000-0000-4000-8000-000000000982",
        object_ref: "fake_object_upgrade",
        event_type: "video.uploaded",
        receipt_fingerprint: "c664b524ab898de7c171b835296b49e2f2b7bceb33b40b95027fcec07dd5674d",
        occurred_at: "2026-08-20T00:01:00.000Z",
        object_matches: 1,
        consumer_ready: 1,
        fk_errors: 0,
        migration_recorded: 1,
        checksum_migration_recorded: 1,
        checksum_claim: 1,
      };
      if (JSON.stringify(row) !== JSON.stringify(expected)) {
        throw new Error(`legacy 0005 upgrade differs: ${JSON.stringify(row)}`);
      }
    });
  '

# 0007 must preserve duplicate legacy history while deterministically claiming
# one owner for all future completions of that checksum.
for migration in \
  migrations/0001_e1_common_foundation.sql \
  migrations/0002_e2_local_identity_class_read_model.sql \
  migrations/0003_e2_intake_decision_and_notification_leases.sql \
  migrations/0004_e5_publication_error_details.sql \
  migrations/0005_e3_fake_upload_receipt_contracts.sql \
  migrations/0006_e3_upload_receipt_object_ref.sql; do
  execute_file "$duplicate_dir" "$migration"
done
record_migrations "$duplicate_dir" "$pre_checksum_fence_names"
npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$duplicate_dir" \
  --command "INSERT INTO submission_intakes (submission_id, intended_video_job_id, request_fingerprint, subject_fingerprint, teacher_id, lesson_on, status, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000971', '00000000-0000-4000-8000-000000000972', printf('%064d', 11), printf('%064d', 12), 'teacher_duplicate_1', '2026-08-20', 'RESOLVED', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'), ('00000000-0000-4000-8000-000000000973', '00000000-0000-4000-8000-000000000974', printf('%064d', 13), printf('%064d', 14), 'teacher_duplicate_2', '2026-08-20', 'RESOLVED', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'); INSERT INTO fake_upload_sessions (submission_id, upload_id, request_fingerprint, expected_object_ref, expected_size_bytes, expected_checksum_sha256, expected_content_type, expires_at, status, completion_event_id, completed_at, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000971', '00000000-0000-4000-8000-000000000975', printf('%064d', 15), 'fake_object_duplicate_1', 1024, printf('%064d', 16), 'video/mp4', '2026-08-20T00:15:00.000Z', 'COMPLETED', '00000000-0000-4000-8000-000000000976', '2026-08-20T00:01:00.000Z', '2026-08-20T00:00:00.000Z', '2026-08-20T00:01:00.000Z'), ('00000000-0000-4000-8000-000000000973', '00000000-0000-4000-8000-000000000977', printf('%064d', 17), 'fake_object_duplicate_2', 1024, printf('%064d', 16), 'video/mp4', '2026-08-20T00:15:00.000Z', 'COMPLETED', '00000000-0000-4000-8000-000000000978', '2026-08-20T00:02:00.000Z', '2026-08-20T00:00:00.000Z', '2026-08-20T00:02:00.000Z'); INSERT INTO upload_receipt_events (event_id, submission_id, object_ref, event_type, receipt_fingerprint, occurred_at) VALUES ('00000000-0000-4000-8000-000000000976', '00000000-0000-4000-8000-000000000971', 'fake_object_duplicate_1', 'video.uploaded', printf('%064d', 18), '2026-08-20T00:01:00.000Z'), ('00000000-0000-4000-8000-000000000978', '00000000-0000-4000-8000-000000000973', 'fake_object_duplicate_2', 'video.uploaded', printf('%064d', 19), '2026-08-20T00:02:00.000Z'); INSERT INTO video_jobs (video_job_id, submission_id, branch_id, studio_id, class_id, teacher_id, state, creation_token, creation_fingerprint, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000972', '00000000-0000-4000-8000-000000000971', 'branch_duplicate', 'studio_duplicate', 'class_duplicate', 'teacher_duplicate_1', 'RECEIVED', 'creation_duplicate_1', printf('%064d', 18), '2026-08-20T00:01:00.000Z', '2026-08-20T00:01:00.000Z'), ('00000000-0000-4000-8000-000000000974', '00000000-0000-4000-8000-000000000973', 'branch_duplicate', 'studio_duplicate', 'class_duplicate', 'teacher_duplicate_2', 'RECEIVED', 'creation_duplicate_2', printf('%064d', 19), '2026-08-20T00:02:00.000Z', '2026-08-20T00:02:00.000Z');" >/dev/null
apply_current "$duplicate_dir"
apply_current "$duplicate_dir"
npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$duplicate_dir" --json \
  --command "SELECT (SELECT COUNT(*) FROM fake_upload_sessions WHERE status = 'COMPLETED') completed_rows, (SELECT COUNT(*) FROM upload_receipt_events) receipt_rows, (SELECT COUNT(*) FROM video_jobs WHERE creation_token IN ('creation_duplicate_1', 'creation_duplicate_2')) job_rows, (SELECT COUNT(*) FROM completed_upload_checksum_claims) claims, (SELECT owner_submission_id FROM completed_upload_checksum_claims) owner_submission_id, (SELECT claimed_at FROM completed_upload_checksum_claims) claimed_at, (SELECT COUNT(*) FROM d1_migrations WHERE name = '0007_e3_completed_checksum_fence.sql') migration_recorded, (SELECT COUNT(*) FROM pragma_foreign_key_check) fk_errors;" \
  | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const row = JSON.parse(input)[0]?.results?.[0];
      const expected = { completed_rows: 2, receipt_rows: 2, job_rows: 2, claims: 1, owner_submission_id: "00000000-0000-4000-8000-000000000971", claimed_at: "2026-08-20T00:01:00.000Z", migration_recorded: 1, fk_errors: 0 };
      if (JSON.stringify(row) !== JSON.stringify(expected)) {
        throw new Error(`duplicate-checksum migration changed legacy history: ${JSON.stringify(row)}`);
      }
    });
  '

# A legacy receipt without a matching session must abort 0006 and preserve 0005 data.
for migration in \
  migrations/0001_e1_common_foundation.sql \
  migrations/0002_e2_local_identity_class_read_model.sql \
  migrations/0003_e2_intake_decision_and_notification_leases.sql \
  migrations/0004_e5_publication_error_details.sql \
  migrations/0005_e3_fake_upload_receipt_contracts.sql; do
  execute_file "$failure_dir" "$migration"
done
record_migrations "$failure_dir" "$old_e3_names"
npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$failure_dir" \
  --command "INSERT INTO submission_intakes (submission_id, intended_video_job_id, request_fingerprint, subject_fingerprint, teacher_id, lesson_on, status, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000986', '00000000-0000-4000-8000-000000000987', printf('%064d', 8), printf('%064d', 9), 'teacher_missing_session', '2026-08-20', 'RESOLVED', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'); INSERT INTO upload_receipt_events (event_id, submission_id, event_type, receipt_fingerprint, occurred_at) VALUES ('00000000-0000-4000-8000-000000000988', '00000000-0000-4000-8000-000000000986', 'video.uploaded', printf('%064d', 10), '2026-08-20T00:01:00.000Z');" >/dev/null
if apply_current "$failure_dir" >/dev/null 2>&1; then
  echo "0006 unexpectedly accepted a receipt without a session" >&2
  exit 1
fi
npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$failure_dir" --json \
  --command "SELECT (SELECT COUNT(*) FROM upload_receipt_events WHERE event_id = '00000000-0000-4000-8000-000000000988') legacy_row, (SELECT COUNT(*) FROM pragma_table_info('upload_receipt_events')) legacy_columns, (SELECT COUNT(*) FROM d1_migrations WHERE name = '0006_e3_upload_receipt_object_ref.sql') migration_recorded;" \
  | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const row = JSON.parse(input)[0]?.results?.[0];
      const expected = { legacy_row: 1, legacy_columns: 5, migration_recorded: 0 };
      if (JSON.stringify(row) !== JSON.stringify(expected)) {
        throw new Error(`failed migration did not roll back: ${JSON.stringify(row)}`);
      }
    });
  '

echo "E-3 fresh, legacy upgrade, checksum claim fence, fail-closed rollback, and reapply paths verified; temporary data removed on exit"
