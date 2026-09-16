# E-2.1 本人確認・クラス判定 ローカル実演

- Status: local/fake implementation
- 対象: Issue #7
- 外部接続: なし

## 目的

実アカウントや個人情報を使わず、本人確認、講師との紐付け、クラス候補判定、未確定隔離を同じ実装サービスで確認する。これは製品画面ではなく、非エンジニア向けの受入証拠である。

## 実行

```bash
cd worker
npm ci
npm run check
npm run demo:e2
```

ブラウザで `http://127.0.0.1:8788/` を開く。画面に「DUMMY／外部接続なし」が表示されることを確認する。停止は`x`または`Ctrl+C`。

旧ローカルDBからの更新と連続表示は`npm run verify:e2:migration-upgrade`で確認する。旧`0002`は変更せず、追加の`0003`で通知leaseと判定versionを導入する。

## 画面で見る項目

| ケース | 期待する結果 |
|---|---|
| 登録済みdummy本人＋候補1件 | 本人確認OK、自動確定、次へ進める |
| 初回dummy照合 | `teacher_id`との紐付け後、自動確定 |
| 不正なローカルtoken | 受付前に拒否 |
| 候補複数 | `SELECTION_REQUIRED`、正本由来候補内の選択待ち、ジョブなし |
| 候補0件 | `UNRESOLVED`、投稿不可、fake通知予定 |
| TTL切れ | `UNRESOLVED`、投稿不可、fake通知予定 |
| 読取障害 | `UNRESOLVED`、投稿不可、fake通知予定 |

各行で本人確認結果、候補数、判定、次へ進めるか、fake通知、外部通信0件を表示する。token、メール、raw `sub`、個人情報は表示しない。

## 保存境界

- 未確定受付は`submission_intakes`へ保存し、既存`video_jobs`の必須IDを架空値で埋めない。
- 正本由来候補は受付時点のsnapshotとして保存する。
- 1件の完全な`branch_id / studio_id / class_id / teacher_id`が確定しても、E-2.1では凍結candidateと`intended_video_job_id`の予約までとし、`video_jobs`は作らない。
- E-3はR2へのアップロード完了をサーバ側で検証した後、予約IDと凍結candidateの完全tupleを既存ジョブ作成境界に渡す。
- raw `sub`とメールは保存せず、検証直後に一方向fingerprintへ変換する。
- 0件、TTL切れ、読取障害、照合不一致は`UNRESOLVED`、複数件は`SELECTION_REQUIRED`として区別する。
- fake通知はdecision fingerprint由来の固定IDと期限付きleaseで原子的にclaimし、並行実行、送信前停止、送信後停止から再開できる。

## Issue #7 成果物対応

| Issue成果物 | 実装・証拠 |
|---|---|
| OIDC検証境界 | `worker/src/e2-oidc.ts`、署名・aud・iss・exp・email_verifiedの個別テスト |
| `teacher_id ↔ sub`基盤 | raw `sub`を一方向fingerprint化したbinding、登録・競合拒否・解除・再登録監査 |
| クラスread model | version/head/entries、TTL、内容差分fingerprint、単調増加version、D1 batch切替 |
| クラス判定 | `worker/src/e2-service.ts`、0/1/多、TTL、読取障害の自動テスト。0/1/多の全経路でE-2.1中はジョブ0件 |
| 通知境界 | `fake_notification_outbox`と`MemoryFakeNotifier`、並行claim・送信前後停止・lease回収テスト |
| 人間向けデモ | `worker/demo/`、`127.0.0.1`限定、同じ`E2LocalService`を使用、再読込テスト |
| 文書 | 本書と`worker/README.md` |

## source_versionの仮定

ローカルfixtureでは正の単調増加整数を使う。同一版・同一内容は冪等、旧版および同一版・別内容は拒否し、新版はD1 batchで一まとまりに切り替える。切替競合だけは再試行可能とする。取得時刻は処理時刻より最大5分先、TTLは最大24時間に制限する。実Sheets側のversion生成規則は外部接続Issueで決める。

## lr-portalへ渡す後続境界

`lr-portal`は別Repositoryのため本Repositoryへ統合しない。後続のポータルIssueではGoogle ID token、`submission_id`、対象日を受付Workerへ渡す。E-2.1は本人確認・候補確定・`intended_video_job_id`予約までを担い、E-3がR2完了確認後に予約IDでジョブを作成する。複数候補の正式UIは別Issueである。

## 未実施

実Google OIDC、実Sheets、実LINE、実個人情報、R2、動画、承認、媒体投稿、Cloudflare本番・課金resource、`lr-portal`画面は未実施である。
