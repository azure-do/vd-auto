# E-1共通基盤・E-2.1ローカル本人確認とクラス受付・E-4.1模擬承認・E-5.1模擬投稿契約・E-5.2 OAuth境界

Issue #3のE-1共通基盤、Issue #7のE-2.1ローカル本人確認・クラス判定、Issue #16のE-4.1模擬承認、Issue #10のE-5.1模擬投稿契約、Issue #18のE-5.2 YouTube OAuth・対象チャンネル照合境界を扱う。Cloudflare D1を状態正本とし、Queueの重複配信を前提に、状態遷移・冪等台帳・監査ログ・DLQ・Sheetsミラー・保存期限の境界を実装する。

## ローカル確認

```bash
cd worker
npm ci
npm run check
npm run demo
```

`npm test`はCloudflare公式のWorkers Vitest連携機能を使い、D1・Queueを実環境へ接続せずMiniflare上で再現する。

## E-5.5 R2 Range/stream取得

`CloudflareR2StreamingSource` は、R2 bindingから固定長Rangeを順番に読み、全量を
メモリや一時ファイルへ保存せずSHA-256を照合する。検証完了後だけ、同じETagに
固定した下流向けstreamを返す。中断後は `open(committedOffset)` で未送信位置から
再開できる。別のWorker実行へ跨がる場合は、検証済みsnapshotを運用DBにJSONとして
保存し、承認済みobject情報と照合して `rehydrate()` する。

```bash
npm run test:e5:r2-stream
```

この層は署名URLを作らず、providerの例外文やobject keyを外部エラーへコピーしない。
投稿境界は検証で得た同じstreamを最後まで消費し、object keyをprovider adapterへ渡さない。
実YouTube送信への接続はE-5.6の範囲であり、E-5.5では行わない。

## E-2.1 ローカル目視デモ

実Google、実Sheets、実LINE、実個人情報へ接続しない受入確認用デモである。製品画面ではなく、別の起動入口であるため通常のWorker配備対象には含まれない。

```bash
cd worker
npm run demo:e2
```

起動後、ブラウザで `http://127.0.0.1:8788/` を開く。サーバは`127.0.0.1`だけで待ち受け、画面にも「DUMMY／外部接続なし」と表示する。次を確認できる。

- 登録済みの架空本人＋候補1件は自動確定し、凍結したクラス情報と後続用`intended_video_job_id`を予約する。この段階で`video_jobs`は作らない
- 初回の架空メール照合は`teacher_id`と本人のフィンガープリントを登録する
- 不正なローカルトークンは受付前に拒否する
- 複数候補は正本由来候補だけを保持して`SELECTION_REQUIRED`にする
- 0件・TTL切れ・読取障害は`UNRESOLVED`へ隔離し、模擬通知予定にする

停止はターミナルで`x`または`Ctrl+C`。`demo/`はローカル専用で、Cloudflareへ配備しない。

## E-5.1 ローカル契約デモ

実YouTube、OAuth、実R2、Cloudflare実リソース、実動画には接続せず、模擬クライアントで投稿判定と安全境界を確認する。

```bash
cd worker
npm run demo:e5
```

完了・処理中・失敗・拒否・結果不明の分岐、`private`以外と予約公開の拒否、R2範囲取得とサイズ・チェックサム不一致、重複・並行・再配信時の二重副作用防止を確認する。詳細と後続作業への引渡しは`docs/reports/E-5.1-fake-publish-contracts.md`を参照する。

## E-5.2 ローカルOAuth境界確認

自動確認では実Google、実YouTube、実OAuth同意、実投稿に接続しない。ローカルの模擬認証先を使い、読み取り専用権限、対象チャンネル照合、更新、失効、ERROR手動復旧、再試行、安全停止を確認する。

```bash
cd worker
npm run demo:e5:oauth
npm run verify:e5:oauth-config
npm run verify:e5:oauth-config:dev
npm run test:e5:oauth-config
npm run test:e5:oauth-deploy-wrapper
npm run verify:e5:oauth-migration
```

2026年8月31日に実Google OAuthの取得→対象チャンネル照合→token更新・再照合→失効を確認した旧dev versionは`39771401-b085-47f4-882a-8ff146a301e1`である。その後に追加した厳密な`Origin`判定を含むcommit `9190fa192baa`は、新dev version `5a6a8155-8721-4510-a387-9e9d2469083b`としてCloudflare開発環境へ100%配備済みである。配備tagは`issue18-9190fa192baa`である。

必要なCloudflare Access設定とWorker Secretが1つでもなければ`404`で無効になる。全経路でAccess JWTの署名・発行元・対象アプリ・期限・許可利用者を検証する。開始GETは状態を変えない日本語確認ページだけを返し、そのページの安全判定とCSRF検証を通過したPOSTだけがGoogle同意画面へ進む。動的な認証情報とPKCE検証値はWorker Secret由来の鍵で暗号化してからD1へ保存し、生の値、メールアドレス、チャンネルIDを状態表示や監査記録へ出さない。監査にはAccess JWTの主体ID（`sub`）から作った不可逆フィンガープリントだけを記録し、メールアドレスは材料にしない。

新版配備後に、未認証の開始・状態経路がCloudflare Accessの`302`を返し、rootが`404`を返すことを確認済みである。remote migrationは`No migrations to apply`である。2026年9月3日の同意とcallback後はD1 generation `9`、control `READY`、credential `CONNECTED`、attempt `COMPLETED`で、token暗号文あり、対象チャンネル一致、失敗理由・最終エラーなし、監査`oauth.connected`を確認した。戻り先だけ一時的に`ERROR`表示となったため、接続確定後の再読取を分離し、状態表示は1回再試行、連続失敗時は永続状態を変えずHTTP 503の`UNAVAILABLE`を返す修正を配備済みである。

通常`wrangler.jsonc`はObservabilityを無効のまま維持する。開発用`wrangler.e3-dev.jsonc`だけはquery削除を必須にしてWorkers Logsを有効にし、invocation logs、traces、Logpush、tail consumer、外部送信先は無効にする。OAuth HTTP境界が出すアプリpayloadは固定4キー・固定列挙値だけで、Cloudflare metadataが付く場合もqueryは設定で削除する。URL/query、認証情報、識別子、生の例外、外部応答をアプリpayloadへ渡さない。callback再送は新たな成功・同意拒否と誤記録せず、再送と現在状態を固定分類する。更新・失効はHTTP境界拒否だけがこのログ対象で、サービス処理の成功・既知失敗はHTTP状態表示とD1監査で確認する。このログ変更は2026年9月4日にdev version `fda2aa56-2456-48f8-a053-252995ff441d`として配備済みである。

開発環境へこのログ変更を配備する場合は、承認後に`npm run deploy:e5:oauth:dev`だけを使う。この入口は固定dev Worker名、会社account ID、dev D1名・ID、redirect URI、ログ制限を検査し、固定dev configでdry-run後に再検査してから配備する。`--name`や`--config`等の引数上書き、configの`env`、非空のWrangler配備先・ログ・出力先上書き環境変数は受け付けない。子processではWranglerのdisk log・error report・metricsを無効、ログのサニタイズを有効に固定する。認証用のCloudflare環境変数は保持する。このコマンドは実配備を行うため、ローカル検査用には実行しない。2026年9月4日の配備後確認では、非秘密のダミーqueryがCloudflare metadataを含む保存ログに残らないことを実確認し、停止ゲートを通過した。

状態表示修正版の配備後確認と、現行devの実token更新・対象チャンネル再照合は2026年9月4日に完了した。現行の正常接続を維持するため、現行版で実失効・暗号文削除・失効後拒否は再実施していない。この経路は2026年8月31日の旧dev版で実証済みで、現行実装も自動テストで失効と失効後拒否を回帰確認している。直近の技術レビューで追加した、callback・refreshのD1確定後に応答だけが失われる場合の永続`ERROR`停止と、後続処理が進んだ場合に古い処理がDB状態や共有Google grantを変更しない競合保護はローカル検証済みだが、現行devには未配備である。remote復旧executeと実動画投稿は行っていない。CLIはdev config以外へ切替できず、remote previewを含む全D1呼出前に、固定会社account ID・開発D1名・開発D1 IDとconfig、および単一Wrangler membershipを機械照合する。詳しい停止・再開・復旧手順は`docs/runbooks/e5-2-youtube-oauth.md`を参照する。

## E-4.1 ローカル模擬承認デモ

実LINE、実Webhook、実利用者ID、実メッセージ、実動画、Cloudflare実リソース、実SNSに接続せず、架空の内部IDとダミー参照だけで承認契約を確認する。

```bash
cd worker
npm run demo:e4
npm run verify:e4:migration-upgrade
```

許可リスト、期限付き操作トークン、対象改変の拒否、承認・却下競合、多重押下、停止・再配信、承認版と投稿対象の固定、投稿処理の副作用1件維持を確認する。詳細は`docs/reports/E-4.1-fake-approval-contracts.md`を参照する。

### source_versionのローカル仮定

`source_version`は、正本同期側が発行する**正の単調増加整数**とする。ローカルの模擬データでは1、2、3…と増やす。同一版・同一内容の再取込は冪等、同一版・別内容および現在版より小さい値は拒否する。切替競合の`SOURCE_IMPORT_CONFLICT`だけは一時エラーとして再試行し、旧版と同一版衝突は再試行しない。取得時刻は処理時刻より最大5分先まで、TTLは最大24時間とする。実Sheets同期でどの列・更新番号をこの整数へ変換するかは本Issueの対象外であり、実接続作業パッケージで確定する。

### lr-portalとの後続境界

`lr-portal`は別リポジトリのままとする。後続Issueでは、ポータルが取得したGoogle IDトークン、`submission_id`、対象日を受付Workerへ渡す。E-2.1は検証・本人紐付け・候補判定までを行い、完全なクラス情報一式が1件確定した場合も`intended_video_job_id`を予約するだけにする。E-3がR2アップロード完了をサーバ側で確認した後、この予約IDと凍結した情報一式を入力に既存のジョブ作成境界を呼ぶ。トークン、メール、生の`sub`は保存・イベント化・表示しない。

### 本Issueで未接続

- 実Google OIDC / 実Googleアカウント
- 実クラスマスタ / 実Google Sheets同期
- 実LINE通知
- `lr-portal`のログイン・提出画面
- R2、動画、承認、媒体投稿
- Cloudflare本番・課金リソース

### ローカルDB移行

E-1適用済みのローカルD1には、追加の移行処理を順番に適用する。2回目が「適用対象の移行なし」を意味する`No migrations to apply`になることまで確認する。

```bash
cd worker
npm run db:migrate:local
npm run db:migrate:local
```

新規DBへの移行検証は、既存ローカルDBを削除せず、Wranglerの`--persist-to`で新しい一時ディレクトリを指定する。実環境のD1やリソースには実行しない。

旧版の`0002`適用済みDBから`0003`へ更新し、既存通知行を保持したままデモを連続表示できることは次で再現する。

```bash
npm run verify:e2:migration-upgrade
```

この検証は一時ローカルDBへ旧`0001`・`0002`を適用し、旧デモの本人紐付け・受付・読取モデルと既存の`PENDING`・`DELIVERED`通知を投入してから、前方移行専用の`0003`を適用する。旧行を保ったまま、新しい版付き模擬データの名前空間を使うデモを連続GETで表示でき、`video_jobs`を作らないことも確認する。

## 安全境界

- `wrangler.jsonc`のD1 IDはローカルテスト用のプレースホルダ。
- Cloudflare本番環境のリソース作成・移行適用・配備は、別途の作業パッケージ承認まで行わない。開発環境も承認済み範囲を超えて変更しない。
- Queue消費失敗は受領済みにせず再試行し、`max_retries`到達後にCloudflareがDLQへ移動する。DLQはDBへ保持し、明示的な再処理だけ元Queueへ戻す。
- Queueの処理権利期限はメッセージ送信時刻ではなく消費処理時刻で管理する。イベント発生時刻は監査上の業務時刻として分離する。
- 同じ`video_job_id`の再作成は、受付・支部・スタジオ・クラス・講師・実行主体が同じ場合だけ冪等成功とする。異なる入力でのID再利用は`VIDEO_JOB_ID_COLLISION`として、ジョブ・監査・ミラーを変更せず拒否する。
- 同じ`event_id`は、イベント種類・ジョブID・ISO正規化した発生時刻・定義済みデータから作るフィンガープリントと初回到着時に紐付ける。内容が異なる再到着は`EVENT_ID_COLLISION`として隔離し、通常処理も受領済み処理も行わない。
- 同じ変更操作トークンも操作種類と入力のフィンガープリントに紐付ける。別操作または別入力に再利用された場合は状態・監査・ミラーを更新せず拒否する。
- `approved_content_version`は契約上の意味を変えず、実装の入力境界として英数字、ピリオド、アンダースコア、コロン、ハイフンの128文字以内に限る。メールアドレス、空白、改行、パス風文字列は受け付けない。
- 投稿対象は承認時に「媒体＋非秘密の`target_account_id`＋承認版」で固定する。対象の完了状態からのみ全体完了と保存起算を更新する。
- E-1では`FAILED`となった投稿対象の処理権利を再取得しない。`attempt_no`の加算、再試行可能判定、YouTubeの再セッション禁止条件をまとめて実装するE-5.4の専用再試行境界が完成するまで、手動の状態書き換えによる再試行は行わない。二重投稿を避けるため、安全側に停止する。
- 同じジョブ・承認版でもYouTubeの投稿先アカウントが異なれば別々に処理権利を取得できる。ただし、いずれかの結果が`OUTCOME_UNKNOWN`または`RECONCILIATION_REQUIRED`に確定した後は、照合が完了するまで別アカウントの新規処理権利取得を拒否する。競合時はD1トランザクションが直列化し、既に処理権利取得済みの別対象は取り消さない。
- DLQはスキーマに合うイベントだけを未知フィールド除去後の正規化JSONで保持する。スキーマ不正・`event_id`衝突は生データを保存せず、ダイジェスト値・バイト数・型・エラーコードだけを`QUARANTINED`で保持し、再送は拒否する。通常のDLQ再処理は公開HTTPでは提供せず、許可された内部IDだけがService Binding RPCを通じて実行する。
- 運用手順と本番で必要な承認境界は`docs/runbooks/e-1-dlq-replay.md`を参照する。
- Sheetsは`mirror_outbox`からの一方向出力のみ。Sheetsからジョブ状態を読み戻さない。
- Sheets側は`mirror_event_id`をキーに追加または更新（upsert）し、同一イベントの再送で行を二重作成しない実装とする。
- 実メールアドレス、会員情報、トークン、実動画はテストとログに入れない。
- E-2.1の模擬通知は`PENDING`から期限付き`SENDING`へ原子的に処理権利を取得する。通知IDは判定ごとに固定し、並行実行と処理権利期限の回収後の再送でも同じIDを使う。外部通知を実装する後続Issueでは、このIDを受信側の冪等キーとして扱う。
