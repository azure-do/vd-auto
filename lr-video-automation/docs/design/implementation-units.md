# 実装単位（E-0〜E-7）

- Status: accepted（**実行承認済み 2026-08-14**）
- 注記: 本書は承認済みのSE向け実装単位。調査・設計・コード・テストは、GitHub Issueの作業パッケージに切り出して継続実行する。
- 各単位のPR分割、実装順、ライブラリ、DB等の具体技術はSEへ委任する。accepted ADR・contracts・受入条件を変えない限り、亮さんの個別承認を待たずに決定・実装する。
- **外部接続は作業パッケージ単位で承認**: E-0b（Instagram）・E-0c（LINE入口）は、接続先・開発用アカウント・副作用・課金上限・停止方法をIssueにまとめて一括承認する。承認後は範囲内のAPI操作ごとに再承認を求めない。現時点では両パッケージとも未承認。
- 外部委託者の受け入れ手順は `docs/runbooks/external-contributor-onboarding.md`（ADR-0014）。
- 着手後の承認・レビュー・作業キューは `docs/runbooks/external-contributor-delivery.md`。
- 準拠: ADR-0006〜0012、docs/contracts、docs/rfcs

## 依存関係

```
E-0 →(E-1, E-2)→ E-3 → E-4 → E-5 → E-6 → E-7
E-1（共通基盤）は全Publisherの前提。保存/削除ジョブはE-1に付随。
```

## E-0 技術実証（外部接続は要承認）

- E-0a YouTubeアップロード方式（RFC-0002）: GAS+Drive限界(Blob/50MB) / 外部再開可能アップロード / 8＋総合OAuthの保管・更新・失効 / 未監査API非公開制約。
- E-0b Instagram単一テストアカウント: Professional要件 / OAuth / Meta取得可能な video_url / コンテナ状態ポーリング。
- E-0c LINE入口構成（ADR-0010）: `lr-line-relay`を単一Webhook入口にできるか。
- 受入: 各媒体で投稿可否・制約・所要の実測レポート。方式ADRの根拠を提示。

## E-1 共通基盤（契約・状態DB・冪等・監査）

- 共通契約スキーマ（docs/contracts）、運用DB=状態正本（ADR-0008・D1選定はADR-0015）、冪等台帳（job+投稿先+承認済み版）、監査ログ（実行者・日時）、Queue+DLQ、Sheetsミラー同期。
- 付随: 保存/削除ジョブ（ADR-0011）— retention_state機械・+30日削除・権限者限定・設定化。
- 受入: 重複イベント/多重処理で状態が壊れない。DLQ再処理手順が動作。

## E-2 本人確認＋read model（ADR-0006/0007）

- Google OIDC検証（署名/aud/iss/exp/email_verified）、teacher_id↔sub登録・解除、read model（source_version/fetched_at/TTL/差分検知）、候補0/1/多、CLASS_UNRESOLVED隔離＋本部グループLINE通知。
- 受入: なりすまし耐性。マスタ障害時は隔離（自由選択させない）。

## E-3 R2署名アップロード＋入口検証

- 短TTL/推測不能key/Content-Type制約/限定CORS/完了後サーバ再検証、MIME/実形式/サイズ/読取/チェックサム/尺/縦横比/重複。
- 受入: 非動画/破損/重複を投稿前に拒否。署名URL誤用防止。

## E-4 LINE承認＋承認済みコンテンツ版管理（ADR-0010）

- 単一入口（E-0c結果）、allowlist承認・実行者/日時記録、postback再送・多重押下冪等、承認済み版固定。
- 受入: 登録user IDのみ承認。多重押下で二重投稿なし。

## E-5 YouTube投稿（B方式）単一テストチャネル・private＋照合＋再試行（ADR-0013）

> E-0a実証（ChatGPT受入）と亮さん判断により **B方式（外部実行環境＋YouTube resumable upload）** を採用（ADR-0013 proposed／ADR-0009を置換予定）。
>
> 共通の禁止事項（全単位）: `privacyStatus=private` を無条件強制／`public`・`unlisted`・`publishAt` を拒否／実支部チャンネル・実SNS・本番relayに触れない／秘密値（OAuth・client secret・R2資格・session URI）を表示・記録しない（ログマスキング・session URIは暗号化保存）／破壊的削除（アカウント/チャンネル/プロジェクト）は別承認／現行本番は無停止。
>
> 共通依存: E-1（運用DB状態正本・冪等台帳・DLQ）、共通契約（結果不明状態・完了判定・再セッション禁止）、RFC-0002の**製品確定**（実投稿を伴う E-5.6 以降）。
>
> rollback方針（全単位）: **runner停止＋台帳（状態・冪等・追跡フィールド）保持の fail-closed**。旧スタブ・単純PUT等のフォールバック経路は設けない（迂回で二重投稿・公開事故を招くため）。
>
> 順序原則: 契約/偽クライアント → OAuthと対象channel照合 → privateガード → 冪等フェンス → R2 Range/stream取得 → resumable → 処理照合 → E2E。**最初の実投稿は前提（E-5.1〜E-5.5）完成後**（E-5.6以降）。

### E-5.1 契約整備＋偽クライアント（外部接続なし）
- 目的: YouTube/R2の**偽（fake）クライアント**と契約テストで、状態遷移・完了判定・エラー形式・結果不明分岐を外部接続なしに固める。
- 変更対象: `worker/` の契約層・テストダブル。
- 依存: E-1、共通契約。
- 受入条件: 完了（processed/succeeded/private）・失敗・拒否・処理中・結果不明の各分岐が偽クライアントで再現・検証できる。実投稿は発生しない。
- テスト: 契約テスト（全分岐）。
- rollback: 機能未接続のため影響なし（fail-closed）。

### E-5.2 OAuth取得と対象channel照合
- 目的: テストチャンネルOAuthを会社所有で保管・更新・失効し、**トークンが意図した対象channel_idに一致することを照合**（誤チャンネル投稿の防止）。
- 変更対象: 認証層、秘密保管（キー名のみ）。
- 依存: E-5.1、ADR-0012 runbook。
- 受入条件: トークンの対象channelが期待値と一致しなければ**投稿経路に進めない**。更新・失効が手順どおり。値は非表示・非記録・会社所有・復旧可能。
- テスト: channel一致/不一致、取得→更新→失効の1サイクル。
- rollback: 認証層無効化で投稿停止（fail-closed）。

### E-5.3 privateガード（無条件強制）
- 目的: 送信リクエストの `privacyStatus=private` を**無条件強制**し、`public`/`unlisted`/`publishAt` を**実装で拒否**。監査フラグ有無に依存しない。
- 変更対象: 投稿リクエスト構築・検証。
- 依存: E-5.1。
- 受入条件: private以外の指定は構築段階で拒否（例外送出・記録）。公開・予約公開に到達する経路が存在しない。
- テスト: public/unlisted/publishAt 指定が全て拒否される。private のみ通過。
- rollback: ガードは常時有効（無効化経路を持たない）。

### E-5.4 冪等フェンス＋結果不明設計
- 目的: 冪等キー（job+投稿先+承認済み版）・attempt_no・運用DB状態に加え、`OUTCOME_UNKNOWN`/`RECONCILIATION_REQUIRED` と**再セッション禁止条件**を副作用前段ゲートとして実装。
- 変更対象: 冪等台帳・状態遷移・照合（`videos.list`）連携。
- 依存: E-1、共通契約、E-5.2。
- 受入条件: 同一冪等キー再実行・DLQ再処理・結果不明復帰で二重投稿ゼロ。再セッション禁止条件（offset>0／video_id判明／照合未了）該当時は新規セッションを開かない。
- テスト: 多重実行、at-least-once重複、結果不明→照合→確定、DLQ再処理。
- rollback: runner停止＋台帳保持（fail-closed）。

### E-5.5 R2 Range/stream取得＋整合性照合
- 目的: R2からオブジェクトを **Range GET でストリーム取得**（300MBの全量ローカル保存を避ける）、サイズ・チェックサム照合。
- 変更対象: runnerのR2取得層。
- 依存: E-5.1。
- 受入条件: サイズ/チェックサム一致。不一致は `VALIDATION_FAILED` 相当で停止。ストリーム取得で ephemeral disk 消費を抑制。
- テスト: 正常・破損・サイズ不一致の3ケース、Range再取得。
- 禁止事項: 署名URL全文・R2資格情報をログに残さない。
- rollback: 取得層停止（fail-closed。旧スタブへ戻さない）。

### E-5.6 resumable送信・確定位置再開・session URI暗号化保存（最初の実投稿）
- 目的: session発行・**暗号化保存**（秘密）・チャンク送信・committed offsetからの再開。前提（E-5.1〜E-5.5）完成後の最初の実 private 投稿を含む。
- 変更対象: runnerのアップロード層。
- 依存: E-5.1〜E-5.5、RFC-0002 製品確定。
- 受入条件: テストチャンネルへ private 投稿成立。中断後 committed offset から再送して完了、全量再送しない。session URI は暗号化保存・非表示・非記録。期限切れ時は照合後にのみ再セッション。
- テスト: 60MB/300MBで中断→再開、session期限切れ→照合→再セッション可否。
- 禁止事項: session URI・token を表示・記録しない。private以外を送らない。
- rollback: runner停止＋session/offset台帳保持（fail-closed）。

### E-5.7 処理照合（完了判定）
- 目的: `uploadStatus`/`processingStatus`/`privacyStatus` をポーリングし、**processed かつ succeeded かつ private** の成立時のみ `PUBLISHED`。
- 変更対象: 完了確認・状態更新。
- 依存: E-5.6、E-1。
- 受入条件: 3条件成立前は PUBLISHED にしない。失敗/拒否/処理中/期限切れを共通契約 3.1 どおり分岐。文字列ログで成否判定しない。
- テスト: processed+succeeded+private／processing／failed／rejected／期限切れ の分岐。
- rollback: 判定未成立はPUBLISHINGで保留（fail-closed。判定スキップ不可）。

### E-5.8 private投稿E2E＋現行突合
- 目的: 20/60/300MB（E-0aフィクスチャ再利用）を単一テストチャネルへ private 投稿し、現行と突合。
- 変更対象: E2Eテスト・突合スクリプト（秘密なし）。
- 依存: E-5.1〜E-5.7。
- 受入条件: 全サイズ private 投稿成功・private維持・現行突合一致（是正差分のみ）。
- テスト: 3サイズE2E＋中断再開＋結果不明復帰。
- rollback: runner停止（fail-closed）、現行経路は無停止のまま。

### 公開対応（E-5範囲外・将来別単位）
- **監査完了フラグだけでは公開しない**。公開は「YouTube API監査通過 ＋ Q12（公開設定・投稿時刻）決定 ＋ 亮さん承認」の3条件成立後の**別実装単位（例: P-1 公開対応）**として起票する。E-5では扱わない。

### 依存図
```
E-1 ─ E-5.1(契約/偽client) ─ E-5.2(OAuth+channel照合) ─ E-5.3(privateガード) ─ E-5.4(冪等+結果不明)
        ─ E-5.5(R2 Range/stream) ─ E-5.6(resumable・最初の実投稿) ─ E-5.7(処理照合) ─ E-5.8(E2E+突合)
[公開対応] は E-5 範囲外（監査通過＋Q12決定＋亮さん承認で別単位）
```

## E-6 展開・切替・ロールバック

- 8＋総合展開、機能フラグ切替、収束手順（処理中ジョブ・公開済み・二重経路）、外部Lib停止・削除。
- 受入: 現行へ戻せる（ロールバック実証）後に外部Lib削除。

## E-7 加工・Instagram・TikTok（後続）

- SNS加工（変換・RFC-0003）、IG支部別自動投稿、TikTok手動パッケージ→受信箱。
- 受入: 正しい支部アカウント投稿・媒体別再試行・TikTok手動フロー準拠。
