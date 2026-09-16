# アーキテクチャ概要

- Status: accepted（設計ベースライン。未選定技術はRFCで管理）
- 準拠: ADR-0001〜0012、docs/contracts、docs/rfcs
- 注記: 本書は設計の全体像。確定事項はADR、確定前の技術選定はRFC、実装範囲はmvp-scopeを参照。

## 1. 設計原則

1. 決定的コードとLLMの責務分離。LLMに投稿権限・トークンを渡さない（baseline §12）。
2. 動画本体をアプリ層でプロキシしない。講師端末→R2へ直接アップロード（署名付きURL）。
3. クラスマスタが正（ADR-0002）。動画側は参照専用。
4. 媒体別に独立した状態と冪等性。1媒体失敗はその媒体だけ再実行。二重投稿しない。
5. 状態正本はトランザクション可能な運用DB（ADR-0008）。イベントは at-least-once 前提。
6. 検証は入口で完結（前倒し）。未検証は承認・投稿へ進めない。
7. 秘密は用途別に分離（人間用 / アプリ実行 / OAuth）。退職失効は稼働と独立（ADR-0012）。
8. まず確実に投稿。高度AI編集は投稿経路安定後。

## 2. データ経路

```
[講師] lr-portal ─Google OIDC(sub)→ [受付Worker lr-video-upload]
   IDトークン検証(署名/aud/iss/exp/email_verified) → teacher_id↔sub 照合(ADR-0006)
   read model照合 → 候補(0/1/多) → R2署名URL(短TTL/推測不能key/Content-Type制約/限定CORS)
        │
   R2直PUT → 完了通知(サーバ再検証) → ジョブ生成
        ▼
[運用DB=状態正本(ADR-0008)] 条件付き更新で排他 / 監査ログ / 冪等台帳
   Sheets = 人間向けミラー(表示・レポートのみ)
        ▼
[Queue(at-least-once)] ──失敗上限→ [DLQ必須]
        ▼
[Consumer]
   ├ 入口検証: MIME/実形式/読取/尺/縦横比/サイズ/チェックサム/重複 →(VALIDATION_FAILED)
   ├ クラス未確定 → CLASS_UNRESOLVED 隔離 ＋ 本部運用グループLINE通知(ADR-0007)
   ├ 加工(変換のみ・後続) → PROCESSING
   ├ 承認要求 → WAITING_APPROVAL
        ▼
[LINE承認(ADR-0010)] 単一Webhook入口(E-0確認) / 登録user IDのみ承認 / 実行者・日時記録
        ▼ APPROVED（承認済みコンテンツ版を固定）
[媒体別Publisher] 冪等= job+投稿先+承認済み版 / 試行番号別
   ├ YouTube  : B方式=外部runner+resumable(ADR-0013)・private無条件・完了=processed/succeeded/private・結果不明はRECONCILIATION_REQUIRED照合・1〜2支部パイロット
   ├ Instagram: 手動代替（将来Graph API：Professional/コンテナポーリング）
   └ TikTok   : 手動（READY_FOR_MANUAL_POST→HANDED_OFF→CONFIRMED_PUBLISHED）
        ▼
[台帳] 運用DB(正本) / Sheets(ミラー) / 元動画R2 / 生成物R2  ※保存はADR-0011
```

## 3. コンポーネントと所有

| コンポーネント | 役割 | 配置 |
|---|---|---|
| lr-portal | アップロードUI＋OIDCサインイン | 既存repo（PR方式・統合しない） |
| worker/lr-video-upload | OIDC検証 / 署名URL / 入口検証 / ジョブ生成 | 本repo `worker/` |
| R2 | 元動画・生成物 | Cloudflare |
| 運用DB | 状態正本・冪等台帳・監査ログ | Cloudflare D1（ADR-0015） |
| Queue+DLQ+Consumer | オーケストレーション | 本repo `worker/` |
| 検証/加工 | 入口検証(前倒し)＋変換(後続) | RFC-0003 |
| worker/lr-line-approval | LINE承認・冪等（入口はADR-0010） | 本repo `worker/` |
| gas/ | クラスマスタ read model（YouTube投稿はB方式=外部runnerへ移行・gasは投稿しない） | 本repo `gas/` |
| Publisher(IG/TikTok) | 媒体投稿 / 手動パッケージ | 本repo |

## 4. 連携境界（ADR-0003）

- **lr-portal**: 変更は既存repoへPR。統合しない。
- **lr-line-relay**: Cloudflare資産・Queue設計思想を流用。動画機能をLINE受信Workerに混ぜない。単一Webhook入口の可否はE-0で確認（ADR-0010）。
- **DM関連**: MVP非対象。トークン・会話データ・送信責務を共有しない。将来はイベント契約のみ。
- **SEO自動化**: 連携形態（動画公開後イベントを渡す / 生成テンプレートを受け取る）と契約所有者・変更通知を定義。早すぎる共通ライブラリ化は避ける。

## 5. スキーマ

共通ID・状態・イベント・エラー・冪等・保存は docs/contracts/common-ids-events-states.v1.md を正とする。

## 6. 開発フェーズ

`E-0 技術実証(外部接続は要承認) → MVP-Core（基盤） → MVP-Publish（YouTube最小） → U-1 展開 → U-2 SNS自動化 → U-3 運用高度化 → U-4 AI編集`。
実装範囲の切り分けは docs/design/mvp-scope.md、SE実装単位は docs/design/implementation-units.md を参照。

## 7. 並行稼働・ロールバック

- 現行本番は検証・ロールバック確認完了まで無停止（ADR-0001 / CLAUDE.md）。
- 新系は非公開で並行し現行と突合。切替は機能フラグで経路切替（処理中ジョブ・公開済み・二重経路の収束手順を持つ）。外部`VideoUploaderLib`はロールバック不要確認後に停止・削除。
