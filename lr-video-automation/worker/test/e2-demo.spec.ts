import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import demoWorker from "../demo/e2-local-worker";

async function clearDatabase(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM fake_notification_outbox"),
    env.DB.prepare("DELETE FROM intake_audit_logs"),
    env.DB.prepare("DELETE FROM submission_candidate_snapshots"),
    env.DB.prepare("DELETE FROM submission_intakes"),
    env.DB.prepare("DELETE FROM teacher_identity_audits"),
    env.DB.prepare("DELETE FROM teacher_identity_bindings"),
    env.DB.prepare("DELETE FROM class_read_model_entries"),
    env.DB.prepare("DELETE FROM class_read_model_versions"),
    env.DB.prepare("DELETE FROM mirror_outbox"),
    env.DB.prepare("DELETE FROM audit_logs"),
    env.DB.prepare("DELETE FROM idempotency_records"),
    env.DB.prepare("DELETE FROM applied_mutations"),
    env.DB.prepare("DELETE FROM video_jobs"),
    env.DB.prepare(
      `UPDATE class_read_model_head
       SET active_source_version = NULL, read_status = 'UNAVAILABLE',
           failure_code = NULL, updated_at = '1970-01-01T00:00:00.000Z'
       WHERE singleton_id = 1`,
    ),
  ]);
}

describe("E-2.1 localhost demo", () => {
  beforeEach(clearDatabase);

  it("renders the same route across reload and a recreated request context", async () => {
    const first = await demoWorker.fetch(new Request("http://127.0.0.1:8788/"), { DB: env.DB });
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("外部通信: <strong>0件</strong>");

    const second = await demoWorker.fetch(new Request("http://127.0.0.1:8788/"), { DB: env.DB });
    expect(second.status).toBe(200);
    const html = await second.text();
    expect(html).toContain("登録済み＋候補1件");
    expect(html).toContain("読取障害");
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM video_jobs")
      .first<{ count: number }>()).toEqual({ count: 0 });
  });
});
