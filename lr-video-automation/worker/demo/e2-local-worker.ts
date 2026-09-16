import { E2Repository, type ClassReadModelEntryInput } from "../src/e2-repository";
import { E2LocalService } from "../src/e2-service";
import {
  LOCAL_TEST_ISSUER,
  LocalOidcVerificationError,
  type LocalOidcConfig,
  type LocalPublicJwk,
} from "../src/e2-oidc";
import { sha256Hex } from "../src/fingerprint";

interface DemoEnv {
  DB: D1Database;
}

function base64Url(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function localSigner(now: string): Promise<{
  config: LocalOidcConfig;
  email: () => string;
  sign: (overrides?: Record<string, unknown>) => Promise<string>;
}> {
  const keys = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey) as LocalPublicJwk;
  publicJwk.kid = `local-${crypto.randomUUID()}`;
  const audience = `local-audience-${crypto.randomUUID()}`;
  const email = () => `dummy-${crypto.randomUUID()}${String.fromCharCode(64)}local.invalid`;
  return {
    config: { environment: "local-test", issuer: LOCAL_TEST_ISSUER, audience, publicJwk },
    email,
    async sign(overrides = {}) {
      const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: publicJwk.kid }));
      const payload = base64Url(JSON.stringify({
        iss: LOCAL_TEST_ISSUER,
        aud: audience,
        exp: Math.floor(Date.parse(now) / 1000) + 3_600,
        email_verified: true,
        sub: `dummy-sub-${crypto.randomUUID()}`,
        email: email(),
        ...overrides,
      }));
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        keys.privateKey,
        new TextEncoder().encode(`${header}.${payload}`),
      );
      return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
    },
  };
}

async function entry(
  email: string,
  teacherId: string,
  classId: string,
  lessonOn: string,
  studioId = "studio_dummy",
): Promise<ClassReadModelEntryInput> {
  return {
    classId,
    branchId: "branch_e2demo_v2",
    studioId,
    teacherId,
    teacherEmailFingerprint: await sha256Hex(email.trim().toLowerCase()),
    lessonOn,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

async function buildDemo(db: D1Database): Promise<string> {
  const now = new Date().toISOString();
  const lessonOn = "2099-08-17";
  const signer = await localSigner(now);
  const repository = new E2Repository(db);
  const service = new E2LocalService(repository, signer.config);
  const emails = ["registered", "initial", "multiple", "zero", "health"]
    .map((name) => `dummy-e2demo-v2-${name}${String.fromCharCode(64)}local.invalid`);
  const active = await db.prepare(
    "SELECT active_source_version FROM class_read_model_head WHERE singleton_id = 1",
  ).first<{ active_source_version: number | null }>();
  const version = (active?.active_source_version ?? 0) + 1;
  await repository.importClassReadModel({
    sourceVersion: version,
    fetchedAt: now,
    ttlSeconds: 3_600,
    entries: [
      await entry(emails[0]!, "teacher_e2demo_v2_registered", "class_e2demo_v2_one", lessonOn, "studio_e2demo_v2"),
      await entry(emails[1]!, "teacher_e2demo_v2_initial", "class_e2demo_v2_initial", lessonOn, "studio_e2demo_v2"),
      await entry(emails[2]!, "teacher_e2demo_v2_multiple", "class_e2demo_v2_multi_a", lessonOn, "studio_e2demo_v2"),
      await entry(emails[2]!, "teacher_e2demo_v2_multiple", "class_e2demo_v2_multi_b", lessonOn, "studio_e2demo_v2_other"),
      await entry(emails[3]!, "teacher_e2demo_v2_zero", "class_e2demo_v2_other_day", "2099-01-01", "studio_e2demo_v2"),
      await entry(emails[4]!, "teacher_e2demo_v2_health", "class_e2demo_v2_health", lessonOn, "studio_e2demo_v2"),
    ],
    now,
  });
  await repository.importClassReadModel({
    sourceVersion: version,
    fetchedAt: now,
    ttlSeconds: 3_600,
    entries: [
      await entry(emails[0]!, "teacher_e2demo_v2_registered", "class_e2demo_v2_one", lessonOn, "studio_e2demo_v2"),
      await entry(emails[1]!, "teacher_e2demo_v2_initial", "class_e2demo_v2_initial", lessonOn, "studio_e2demo_v2"),
      await entry(emails[2]!, "teacher_e2demo_v2_multiple", "class_e2demo_v2_multi_a", lessonOn, "studio_e2demo_v2"),
      await entry(emails[2]!, "teacher_e2demo_v2_multiple", "class_e2demo_v2_multi_b", lessonOn, "studio_e2demo_v2_other"),
      await entry(emails[3]!, "teacher_e2demo_v2_zero", "class_e2demo_v2_other_day", "2099-01-01", "studio_e2demo_v2"),
      await entry(emails[4]!, "teacher_e2demo_v2_health", "class_e2demo_v2_health", lessonOn, "studio_e2demo_v2"),
    ],
    now,
  });

  const knownSubjects = [
    "dummy-e2demo-v2-registered",
    "dummy-e2demo-v2-zero",
    "dummy-e2demo-v2-health",
  ];
  for (const [index, name] of knownSubjects.entries()) {
    await repository.bindTeacherIdentity({
      teacherId: index === 0
        ? "teacher_e2demo_v2_registered"
        : index === 1
          ? "teacher_e2demo_v2_zero"
          : "teacher_e2demo_v2_health",
      subjectFingerprint: await sha256Hex(`${LOCAL_TEST_ISSUER}\n${name}`),
      actorId: "system_identity",
      now,
    });
  }

  const one = await service.submit({
    idToken: await signer.sign({ sub: knownSubjects[0], email: emails[0] }),
    submissionId: "00000000-0000-4000-8000-000000000301", lessonOn, now,
  });
  const initial = await service.submit({
    idToken: await signer.sign({ sub: "dummy-e2demo-v2-initial", email: emails[1] }),
    submissionId: "00000000-0000-4000-8000-000000000302", lessonOn, now,
  });
  let invalid = "拒否";
  try {
    await service.submit({
      idToken: await signer.sign({ aud: "wrong-local-audience", email: emails[0] }),
      submissionId: "00000000-0000-4000-8000-000000000303", lessonOn, now,
    });
    invalid = "誤って受理";
  } catch (error) {
    invalid = error instanceof LocalOidcVerificationError ? "拒否" : "エラー";
  }
  const multiple = await service.submit({
    idToken: await signer.sign({ sub: "dummy-e2demo-v2-multiple", email: emails[2] }),
    submissionId: "00000000-0000-4000-8000-000000000304", lessonOn, now,
  });
  const zero = await service.submit({
    idToken: await signer.sign({ sub: knownSubjects[1], email: emails[3] }),
    submissionId: "00000000-0000-4000-8000-000000000305", lessonOn, now,
  });

  const expiredVersion = version + 1;
  const oldFetchedAt = new Date(Date.parse(now) - 120_000).toISOString();
  await repository.importClassReadModel({
    sourceVersion: expiredVersion,
    fetchedAt: oldFetchedAt,
    ttlSeconds: 60,
    entries: [await entry(
      emails[4]!,
      "teacher_e2demo_v2_health",
      "class_e2demo_v2_health",
      lessonOn,
      "studio_e2demo_v2",
    )],
    now,
  });
  const expired = await service.submit({
    idToken: await signer.sign({ sub: knownSubjects[2], email: emails[4] }),
    submissionId: "00000000-0000-4000-8000-000000000306", lessonOn, now,
  });
  await repository.markClassReadUnavailable("SOURCE_READ_FAILED", now);
  const unavailable = await service.submit({
    idToken: await signer.sign({ sub: knownSubjects[2], email: emails[4] }),
    submissionId: "00000000-0000-4000-8000-000000000307", lessonOn, now,
  });

  const rows = [
    ["登録済み＋候補1件", "本人確認OK", "1", one.intake.status, "進める", "なし"],
    ["初回照合", "登録して確認OK", "1", initial.intake.status, "進める", "なし"],
    ["不正なtoken", invalid, "-", "受付なし", "進めない", "なし"],
    ["候補複数", "本人確認OK", String(multiple.candidates.length), multiple.intake.status, "選択待ち", "なし"],
    ["候補0件", "本人確認OK", "0", `${zero.intake.status} / ${zero.intake.reason_code}`, "進めない", "予定"],
    ["期限切れ", "本人確認OK", "0", `${expired.intake.status} / ${expired.intake.reason_code}`, "進めない", "予定"],
    ["読取障害", "本人確認OK", "0", `${unavailable.intake.status} / ${unavailable.intake.reason_code}`, "進めない", "予定"],
  ];
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>E-2.1 DUMMY確認</title>
  <style>body{font-family:system-ui;margin:2rem;line-height:1.6} .warn{padding:1rem;background:#fff3cd;border:1px solid #d39e00} table{border-collapse:collapse;width:100%;margin-top:1rem}th,td{border:1px solid #bbb;padding:.6rem;text-align:left}th{background:#eee}</style></head><body>
  <h1>E-2.1 本人確認・クラス判定 DUMMY実演</h1>
  <p class="warn"><strong>DUMMY／外部接続なし／製品画面ではありません</strong><br>localhost限定の受入確認です。token・メール・sub・個人情報は表示していません。</p>
  <table><thead><tr><th>ケース</th><th>本人確認</th><th>候補数</th><th>判定</th><th>次へ</th><th>fake通知</th></tr></thead><tbody>
  ${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell ?? "")}</td>`).join("")}</tr>`).join("")}
  </tbody></table><p>外部通信: <strong>0件</strong></p></body></html>`;
}

export default {
  async fetch(request: Request, env: DemoEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!(url.hostname === "127.0.0.1" || url.hostname === "localhost")) {
      return new Response("Not found", { status: 404 });
    }
    if (url.pathname !== "/") return new Response("Not found", { status: 404 });
    try {
      return new Response(await buildDemo(env.DB), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    } catch {
      return new Response(
        "DUMMY実演の準備に失敗しました。ローカルDB migrationを再適用してください。",
        { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
  },
};
