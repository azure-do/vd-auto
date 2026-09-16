# E-3.1 動画受付・アップロード完了確認（local/fake）

- Status: local/fake implementation
- 対象: Issue #12
- 最終ローカル確認: 2026-08-21
- 外部接続: なし

## 受付とIDの境界

E-2.1で確定・凍結した講師、支部、スタジオ、クラスと予約済み`video_job_id`を入口とする。受付開始時に呼出側から受け取るのは、サイズ、SHA-256、動画MIME型の受付条件だけである。`upload_id`と保存先`object_ref`は`crypto.randomUUID()`を使ってサーバー側で内部生成し、呼出側が指定できない。

現在時刻と有効期限も呼出側から受け取らない。サービス内部の`TrustedClock`（通常実行時はシステム時刻、テストでのみ可変fake clock）を使い、`created_at + 15分`を固定の`expires_at`として内部発行する。TTLはコード上の`E3_UPLOAD_TTL_MS = 15 * 60 * 1000`で固定し、adapterが2099年などの任意期限や過去時刻を指定する入力経路を持たない。

同じ受付開始要求の再送・同時実行は、最初に作成したセッションを返す。同じ`submission_id`で受付条件が異なる要求は競合として拒否する。

## 完了確認の境界

完了通知は`submission_id`、発行済み`upload_id`、`event_id`のみを受け取る。現在時刻、期限、サイズ、チェックサム、Content-Type、保存先の自己申告は判定に使わない。期限判定と永続イベントの時刻は内部Clockから取得する。

`UploadObjectInspector`の結果が受付条件と一致したときだけ、完了セッションと`upload_receipt_events`を同じDB batchで確定する。この時点では動画ジョブを作らない。

## Queueとジョブ作成の境界

`video.uploaded`を正式な`QueueEvent`に追加し、非秘密payloadに可逆な`submission_id`と`object_ref`を含める。`normalizeQueueEvent`は時刻をISO正規化し、未定義fieldを除去してもこの2値を保つ。

`handleQueueBatch`の既存lease、event fingerprint、ack/retry、衝突隔離を通じてConsumerを呼ぶ。Consumerは完了session、receipt、Queue payloadの参照値、fingerprintを照合し、一致時のみジョブ・監査・mirrorを別の原子的batchで作る。callbackからjobを直接作る迂回経路はない。イベント確定後・job作成前と、job作成後・Queue完了記録前のどちらの停止も、別message IDの再配信で再開できる。テストはfake `MessageBatch`だけを使い、外部Queueへは送信しない。

`0005_e3_fake_upload_receipt_contracts.sql`は既存適用済みの可能性があるため変更せず、`0006_e3_upload_receipt_object_ref.sql`でreceiptテーブルを再構築する。既存行の`object_ref`は対応するsessionの`expected_object_ref`からbackfillし、event ID、submission、type、fingerprint、発生時刻を保持する。対応sessionがなく全行を移行できない場合はguard制約でmigration全体を失敗・rollbackし、旧receiptを残す。

## fail-closedと再配信

- クラス未確定、予約なし、複数候補は受付を開始できない。
- 保存先でmissing、corrupt、unreadable、non-videoと判定した場合、およびサイズ・チェックサム・Content-Typeの不一致はセッションを拒否し、イベントとジョブを作成しない。
- Queue側のevent ID衝突、`object_ref`改変、未知receipt、未完了session、receipt / job fingerprint不一致はジョブ化しない。
- `PENDING`の初回完了は内部Clockが`now < expires_at`のときだけ許可し、`now == expires_at`を含む期限以後は拒否する。保存先の検証後にもClockを読み直す。
- 期限内に`COMPLETED`となった同一完了通知の再送は、期限後でもfingerprintとreceiptが一致する場合だけ同じQueueEventを返す。
- 同じイベントの同時再配信は1件に集約し、異なる`event_id`の競合は片方だけを完了させる。
- ジョブ作成batch中の停止はrollbackし、確定済みイベントのQueue再配信で再開できる。

## 2026-08-21 ローカル実行根拠

`worker/`で次を実行した。すべて架空ID、Miniflare上のlocal D1、fake inspectorのみを使用した。

| 確認 | 実行コマンド | 結果 |
|---|---|---|
| 型確認 | `npm run typecheck`（`npm run check`内） | 成功 |
| 全自動テスト | `npm run check` | 9 files / 149 tests passed |
| E-3.1契約テスト | `npm run demo:e3` | 1 file / 27 tests passed |
| 旧DBからの更新・再適用 | `npm run verify:e3:migration-upgrade` | 0001〜0004→現行0005+0006、旧0005済みDBの既存receipt backfill・consumer前提保持、欠損session時の全体rollback、再適用no-opを確認 |
| 配備前構成確認 | `npx wrangler deploy --dry-run` | 成功。dry-runで終了し、deployなし |

## 未実施・後続範囲

実R2、署名URL、実動画のバイト検証、尺・縦横比・重複判定、Cloudflare課金resource、OAuth、秘密情報、本番環境は使用・確認していない。これらは接続先、副作用、課金上限、停止方法を明記した後続作業で扱う。
