# 共通契約 v1: ID / 状態 / イベント / エラー / 冪等性 / 保存

- Status: accepted（v1）
- 所有者: 本Repositoryの技術責任者
- 準拠: ADR-0002 / ADR-0003 / ADR-0006 / ADR-0007 / ADR-0008 / ADR-0010 / ADR-0011
- 注記: 実データ値・秘密値を含めない。構造とキー名のみ。

## 1. 共通ID

| ID | 正 / 由来 | 備考 |
|---|---|---|
| `branch_id` | 支部マスタ | 安定ID。URL・表記に依存しない。旧表記はエイリアスで吸収 |
| `studio_id` | スタジオマスタ | `branch_id` + slug/連番。エイリアスで旧表記吸収 |
| `class_id` | クラスマスタ（クラスコード） | 正は `レッスンマスタ` タブ①（ADR-0002） |
| `teacher_id` | クラスマスタ | 内部ID。**Google sub と紐付け**（ADR-0006）。メールは非公開の本人確認キー |
| `submission_id` | 受付Worker | 講師の1回の提出（UUID） |
| `video_job_id` | Consumer | 媒体横断の投稿ジョブ（UUID） |
| `approved_content_version` | 承認時に確定 | 承認済みコンテンツ版。冪等キー要素（ADR-0010） |
| `idempotency_key` | Publisher | `video_job_id + 投稿先(媒体+アカウント) + approved_content_version` |
| `attempt_no` | Publisher | 試行番号。**冪等キーには含めない**（監視・リトライ計数用） |

## 2. ジョブ状態

```
RECEIVED → VALIDATING → (VALIDATION_FAILED)
         → (CLASS_UNRESOLVED)                       ← 隔離・投稿不可・障害通知（ADR-0007）
         → PROCESSING → WAITING_APPROVAL → (REJECTED)
         → APPROVED → PUBLISHING → PARTIALLY_PUBLISHED → PUBLISHED
                                  → FAILED
```

状態正本は運用DB。遷移は条件付き更新／トランザクションで排他（ADR-0008）。

## 3. 媒体別サブ状態

- `instagram_status` ∈ `{PENDING, PUBLISHING, PUBLISHED, FAILED, SKIPPED}`
- `youtube_status` ∈ `{PENDING, PUBLISHING, PUBLISHED, FAILED, SKIPPED, OUTCOME_UNKNOWN, RECONCILIATION_REQUIRED}`
  - `OUTCOME_UNKNOWN`: 送信は行ったが**最終結果を確認できていない**（応答途絶・タイムアウト・session期限切れ・ポーリング未確定）。自動再投稿しない。
  - `RECONCILIATION_REQUIRED`: `OUTCOME_UNKNOWN` を照合待ちに確定した状態。**照合完了まで新規セッション・新規投稿を禁止**する。
- `tiktok_status` ∈ `{PENDING, READY_FOR_MANUAL_POST, HANDED_OFF, CONFIRMED_PUBLISHED, FAILED, SKIPPED}`
  - 手動投稿では `PUBLISHED` を自動設定せず、担当者が投稿URLを登録して `CONFIRMED_PUBLISHED` とする。

ジョブ全体状態は媒体別サブ状態の集約で決まる（全 PUBLISHED/CONFIRMED → PUBLISHED、一部 FAILED → PARTIALLY_PUBLISHED）。いずれかの媒体が `OUTCOME_UNKNOWN`/`RECONCILIATION_REQUIRED` の間は当該ジョブを `PUBLISHED` にしない（`PUBLISHING` 相当で保留）。

### 3.1 YouTube完了・失敗判定

投稿の最終判定は文字列ログではなくAPIステータスで行う（§6 構造化エラー準拠）:

| 判定 | 条件 | 遷移 |
|---|---|---|
| **完了** | `uploadStatus = processed` かつ `processingStatus = succeeded` かつ `privacyStatus = private` | `PUBLISHED`（private確認込み） |
| **処理中** | `processingStatus = processing` | `PUBLISHING` 保留・ポーリング継続 |
| **失敗** | `uploadStatus = failed` または `processingStatus = failed / terminated` | `FAILED`（`failureReason` 記録・retryable判定） |
| **拒否** | `uploadStatus = rejected`（`rejectionReason`: copyright/duplicate/tos 等） | `FAILED`（端末的・`retryable=false`・要人手） |
| **結果不明/期限切れ** | 応答途絶・session URI 期限切れ・確認不能 | `OUTCOME_UNKNOWN → RECONCILIATION_REQUIRED` |

### 3.2 YouTube投稿の追跡フィールド

冪等台帳／状態レコードに以下を保持する（秘密は暗号化保存し値は非表示・非記録）:

| フィールド | 内容 | 秘密扱い |
|---|---|---|
| `yt_resumable_session_uri` | resumable upload session URI | **秘密・保存時暗号化（at-rest）**。表示・平文ログ・スクショ禁止 |
| `yt_committed_offset` | YouTubeが返した確定バイト位置（Range） | 非秘密（進捗・再開用） |
| `yt_video_id` | 投稿で採番された動画ID（判明後） | 非秘密（照合キー） |
| `yt_session_expires_at` | session URI 有効期限 | 非秘密 |
| `attempt_no` | 試行番号（冪等キーには含めない） | 非秘密 |

### 3.3 再セッション禁止条件

**新規 resumable session の開始は重複動画を生む**ため、次のいずれかに該当する間は新規セッションを開始しない（fail-closed）:

1. `yt_committed_offset > 0`（既にバイト送信済み）で最終結果未確認。
2. `yt_video_id` が判明している（既に動画が採番された可能性）。
3. `youtube_status ∈ {OUTCOME_UNKNOWN, RECONCILIATION_REQUIRED}`。

許容される回復動作:
- **既存 session URI が有効**: 既存セッションを `yt_committed_offset` から**再開**（全量再送しない）。
- **照合（reconciliation）**: `videos.list`（自チャンネル）で `yt_video_id` の有無・`privacyStatus` を確認。
  - 動画が存在し private 完了 → `PUBLISHED` に確定（新規投稿しない）。
  - 動画が存在しない、かつ session URI が失効/使用不能と確認 → **その時点で初めて**新規セッション開始を許可。
- 照合が確定するまでは `RECONCILIATION_REQUIRED` を維持し、二重投稿を構造的に防ぐ。

## 4. 保存ライフサイクル（ADR-0011）

- `retention_state` ∈ `{HOLD(起算前), RETAINED(起算済), DUE_FOR_DELETION, DELETED}`
- `retention_start_at` — 投稿完了 or 最終処理確定で設定（失敗・承認保留中は設定しない）
- `delete_due_at` — `retention_start_at + 30日`（暫定・設定変更可）
- 投稿記録・URL・承認履歴・エラー履歴は継続保存（削除対象外）。

## 5. イベント（Queue / 監査）

| イベント | 発生元 | 非秘密ペイロード |
|---|---|---|
| `video.submitted` | 受付Worker | submission_id, teacher_id, 候補class群 |
| `video.uploaded` | R2通知 | submission_id, object参照 |
| `job.created` | Consumer | video_job_id, branch/studio/class/teacher |
| `video.validated` / `video.validation_failed` | 検証 | video_job_id, 検証結果 |
| `class.unresolved` | Consumer | video_job_id, 理由（PII除く） |
| `video.processed` | 加工 | video_job_id, 生成物参照 |
| `approval.requested` | 承認Worker | video_job_id, プレビュー参照 |
| `approval.granted` / `approval.rejected` | 承認Worker | video_job_id, 実行者ID, 日時, 媒体選択, 文面 |
| `publish.started` / `publish.succeeded` / `publish.failed` | Publisher | video_job_id, media, 投稿URL/エラー |
| `publish.outcome_unknown` | Publisher(YouTube) | video_job_id, media=youtube, attempt_no, yt_committed_offset, yt_video_id?（session URIは含めない） |
| `publish.reconciliation_required` | Publisher(YouTube) | video_job_id, media=youtube, 照合対象（yt_video_id?/offset） |
| `publish.reconciled` | 照合処理 | video_job_id, media=youtube, 結果（published/none）, yt_video_id? |
| `tiktok.handed_off` / `tiktok.confirmed` | TikTok | video_job_id, 担当者, 投稿URL |

Queueは at-least-once。イベント重複到達を前提に、消費側は冪等に処理する。

## 6. エラー形式

```
{ code, media?, retryable: bool, message, occurred_at }
```

文字列ログによる成否判定（現行の弱点）を廃し、構造化して状態と分離する。

## 7. 冪等性規約

- すべての副作用API（媒体投稿・状態遷移）は `idempotency_key`（§1）を必須とする。
- 同一キーの再実行は既存結果を返すのみで、再投稿しない。
- `attempt_no` はキーと別管理（リトライ・監視用）。
- DLQ（ADR-0008）投入分の再処理も冪等キーで二重投稿を防ぐ。
- YouTube投稿は `idempotency_key` に加え、**再セッション禁止条件（§3.3）**を副作用実行の前段ゲートとする。`OUTCOME_UNKNOWN`/`RECONCILIATION_REQUIRED` のジョブは照合完了まで新規投稿を実行しない（DLQ再処理も同ゲートを通す）。

## 8. PII / 秘密の扱い

- 講師メールアドレス等のPIIをイベント・ログ・公開面へ流さない（ADR-0006）。
- 秘密値はコード・文書・ログに書かない。キー名・保存場所のみ。
- `yt_resumable_session_uri` は保存時暗号化（at-rest）し、平文でログ・イベント・レポート・スクショに出さない。期限切れ session URI も秘密として破棄（値を残さない）。
