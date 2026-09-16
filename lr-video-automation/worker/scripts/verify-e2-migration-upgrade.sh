#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
worker_dir="$(cd "$script_dir/.." && pwd)"
persist_dir="$(mktemp -d /tmp/lr-e2-upgrade.XXXXXX)"
demo_port="${E2_UPGRADE_DEMO_PORT:-8792}"
demo_pid=""

cleanup() {
  if [[ -n "$demo_pid" ]] && kill -0 "$demo_pid" 2>/dev/null; then
    kill "$demo_pid"
    wait "$demo_pid" 2>/dev/null || true
  fi
  if [[ -n "$persist_dir" && -d "$persist_dir" && "$persist_dir" == /tmp/lr-e2-upgrade.* ]]; then
    rm -rf -- "$persist_dir"
  fi
}

interrupt() {
  exit 130
}

trap cleanup EXIT
trap interrupt INT TERM HUP

cd "$worker_dir"

# Reproduce a database whose 0001 and the original 0002 were already applied.
npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$persist_dir" \
  --file migrations/0001_e1_common_foundation.sql >/dev/null
npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$persist_dir" \
  --file migrations/0002_e2_local_identity_class_read_model.sql >/dev/null
npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$persist_dir" \
  --command "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT INTO d1_migrations(name) VALUES ('0001_e1_common_foundation.sql'), ('0002_e2_local_identity_class_read_model.sql');" >/dev/null

# Reproduce rows written by the original demo. Its random local subject binding used the
# unversioned teacher/class/submission namespace, which must not collide with the current demo.
npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$persist_dir" \
  --command "INSERT INTO class_read_model_versions (source_version, fetched_at, ttl_seconds, content_fingerprint, imported_at) VALUES (41, '2026-08-17T00:00:00.000Z', 3600, printf('%064d', 6), '2026-08-17T00:00:00.000Z'); UPDATE class_read_model_head SET active_source_version = 41, read_status = 'AVAILABLE', updated_at = '2026-08-17T00:00:00.000Z' WHERE singleton_id = 1; INSERT INTO class_read_model_entries (source_version, class_id, branch_id, studio_id, teacher_id, teacher_email_fingerprint, lesson_on) VALUES (41, 'class_one', 'branch_dummy', 'studio_dummy', 'teacher_registered', printf('%064d', 7), '2099-08-17'); INSERT INTO teacher_identity_bindings (teacher_id, subject_fingerprint, bound_at, bound_by) VALUES ('teacher_registered', printf('%064d', 8), '2026-08-17T00:00:00.000Z', 'system_identity'); INSERT INTO submission_intakes (submission_id, intended_video_job_id, request_fingerprint, subject_fingerprint, teacher_id, lesson_on, status, source_version, decision_fingerprint, video_job_id, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000211', printf('%064d', 9), printf('%064d', 8), 'teacher_registered', '2099-08-17', 'RESOLVED', 41, printf('%064d', 10), NULL, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z'); INSERT INTO submission_candidate_snapshots (submission_id, class_id, branch_id, studio_id, teacher_id, source_version) VALUES ('00000000-0000-4000-8000-000000000201', 'class_one', 'branch_dummy', 'studio_dummy', 'teacher_registered', 41);" >/dev/null

# Existing PENDING and DELIVERED rows must survive the table rebuild unchanged.
npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$persist_dir" \
  --command "INSERT INTO submission_intakes (submission_id, intended_video_job_id, request_fingerprint, subject_fingerprint, teacher_id, lesson_on, status, reason_code, decision_fingerprint, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000901', '00000000-0000-4000-8000-000000000911', printf('%064d', 0), printf('%064d', 1), 'teacher_migration', '2099-08-17', 'UNRESOLVED', 'NO_CLASS_MATCH', printf('%064d', 2), '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z'), ('00000000-0000-4000-8000-000000000902', '00000000-0000-4000-8000-000000000912', printf('%064d', 3), printf('%064d', 4), 'teacher_migration', '2099-08-17', 'UNRESOLVED', 'SOURCE_TTL_EXPIRED', printf('%064d', 5), '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z'); INSERT INTO fake_notification_outbox (notification_id, submission_id, decision_fingerprint, reason_code, status, attempt_count, delivered_at, created_at, updated_at) VALUES ('fake_migration_pending', '00000000-0000-4000-8000-000000000901', printf('%064d', 2), 'NO_CLASS_MATCH', 'PENDING', 7, NULL, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z'), ('fake_migration_delivered', '00000000-0000-4000-8000-000000000902', printf('%064d', 5), 'SOURCE_TTL_EXPIRED', 'DELIVERED', 4, '2026-08-17T00:01:00.000Z', '2026-08-17T00:00:00.000Z', '2026-08-17T00:01:00.000Z');" >/dev/null

npx wrangler d1 migrations apply lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$persist_dir" >/dev/null

npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$persist_dir" --json \
  --command "SELECT notification_id, status, attempt_count, delivered_at, lease_token, lease_expires_at FROM fake_notification_outbox WHERE notification_id LIKE 'fake_migration_%' ORDER BY notification_id;" \
  | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const parsed = JSON.parse(input);
      const rows = parsed[0]?.results ?? [];
      const expected = [
        { notification_id: "fake_migration_delivered", status: "DELIVERED", attempt_count: 4, delivered_at: "2026-08-17T00:01:00.000Z", lease_token: null, lease_expires_at: null },
        { notification_id: "fake_migration_pending", status: "PENDING", attempt_count: 7, delivered_at: null, lease_token: null, lease_expires_at: null },
      ];
      if (JSON.stringify(rows) !== JSON.stringify(expected)) {
        throw new Error(`notification rows changed during upgrade: ${JSON.stringify(rows)}`);
      }
    });
  '

npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$persist_dir" --json \
  --command "SELECT decision_version FROM submission_intakes WHERE submission_id = '00000000-0000-4000-8000-000000000901';" \
  | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const parsed = JSON.parse(input);
      if (parsed[0]?.results?.[0]?.decision_version !== 0) {
        throw new Error("decision_version was not added with the safe default");
      }
    });
  '

npx wrangler dev --local --ip 127.0.0.1 --port "$demo_port" \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$persist_dir" \
  >"$persist_dir/demo.log" 2>&1 &
demo_pid=$!

for _ in {1..50}; do
  if curl --fail --silent --output /dev/null "http://127.0.0.1:$demo_port/"; then
    break
  fi
  sleep 0.1
done

for _ in 1 2 3; do
  curl --fail --silent "http://127.0.0.1:$demo_port/" \
    | grep -q '外部通信: <strong>0件</strong>'
done

npx wrangler d1 execute lr-video-automation-e2-demo --local \
  --config demo/wrangler.e2-demo.jsonc --persist-to "$persist_dir" --json \
  --command "SELECT (SELECT COUNT(*) FROM teacher_identity_bindings WHERE teacher_id = 'teacher_registered' AND subject_fingerprint = printf('%064d', 8)) old_binding, (SELECT COUNT(*) FROM submission_intakes WHERE submission_id = '00000000-0000-4000-8000-000000000201' AND status = 'RESOLVED') old_intake, (SELECT COUNT(*) FROM class_read_model_entries WHERE source_version = 41 AND class_id = 'class_one') old_read_model, (SELECT COUNT(*) FROM video_jobs) jobs;" \
  | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const parsed = JSON.parse(input);
      const row = parsed[0]?.results?.[0];
      const expected = { old_binding: 1, old_intake: 1, old_read_model: 1, jobs: 0 };
      if (JSON.stringify(row) !== JSON.stringify(expected)) {
        throw new Error(`old demo rows changed or E-2.1 created a job: ${JSON.stringify(row)}`);
      }
    });
  '

echo "E-2 migration upgrade and repeated demo GET verified; temporary data removed on exit"
