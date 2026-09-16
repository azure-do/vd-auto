# E-5.2 YouTube OAuth・対象チャンネル照合の運用手順

この手順はIssue #18の実装に対応します。2026年8月31日に実OAuthの1サイクルを確認した旧dev versionは`39771401-b085-47f4-882a-8ff146a301e1`です。その後に追加した厳密な`Origin`修正を含むcommit `9190fa192baa`は、新dev version `5a6a8155-8721-4510-a387-9e9d2469083b`としてCloudflare開発環境へ100%配備済みです。配備tagは`issue18-9190fa192baa`です。

2026年8月31日には、旧dev versionで実Google OAuthの取得、対象チャンネル照合、実更新後の再照合、実失効、暗号文削除、失効後の投稿準備拒否まで成功しました。その後、厳密な`Origin`修正を含む新dev versionで、2026年9月3日01:27:57 JSTにチャンネル所有者の同意とcallbackのD1保存まで完了しました。2026年9月4日14:16:53 JSTに現行devで実token更新と対象チャンネルの再照合に成功し、`CONNECTED`、アクセストークン・更新トークンの暗号文あり、対象チャンネル一致、監査`oauth.refreshed`あり、`last_error_code`なしを秘密値を表示せず確認しました。クライアントは接続成功と更新後の再照合を確認し、再認証不要、修正はIssue #18の受入範囲内、rollback不要と承認しました。

一方、D1保存後の画面では一時的に`{"status":"ERROR"}`が表示されました。当時はWorkerの生ログ保存を無効にしていたため、例外箇所は遡って特定できません。修正後は、callbackとrefreshが認証情報・照合結果・監査を原子的に保存した後に、表示用statusを再読取せず、確定済みの`CONNECTED`を返します。redirect後の状態表示GETは別経路として1回だけ読取を再試行し、2回連続で失敗した場合は永続状態と監査を変えず、HTTP 503と一時表示`UNAVAILABLE`を返します。callback内で認証情報の確定を確認できない場合は、取得したtokenを失効して暗号文を消去し、監査付きの永続`ERROR`へ安全停止します。これらの修正はdev version `c74748f5-95a9-4b38-994f-effc44f273ab`として100%配備しました。さらに今後の切り分け用として、秘密値を含まない固定分類ログを開発用設定だけで保存する変更を、2026年9月4日にcommit `50ac026`から固定dev配備入口でdev Workerへ配備しました。配備versionは`fda2aa56-2456-48f8-a053-252995ff441d`です。非秘密のダミーqueryによる新しい停止ゲートは通過し、現行devの更新・再照合成功により接続の有効性も確定しました。投稿API呼出、動画アップロード、resumable upload sessionはいずれも0件です。

追加の技術レビューで、更新保存のD1 batchがサーバーで確定した直後に応答だけが失われると、旧実装は`CONNECTED`のまま残ることが判明しました。修正後は、同一世代・同一更新番号のままである場合に限り、先に暗号文消去・監査付き永続`ERROR`への停止をD1で確定し、その処理が確定した場合だけ取得済みtokenを失効します。後続の更新・失効・照合が状態や更新番号を進めた場合、古い処理はD1を上書きせず、後続更新と共有するGoogle grantも失効しません。模擬認証先もtoken単体ではなくgrant全体への失効影響を再現し、応答喪失後に後続refreshが成功する競合と、後続実失効が勝つ競合を回帰確認します。この追加修正はローカル検証済み、現行devには未配備です。

根本原因は、D1の世代・更新番号による保護と、Google側のgrantを失効する補償処理を別々に確認できていなかったことです。以前の模擬認証先もtoken単体の有無だけを扱い、同じgrantを共有する新旧tokenへの連鎖影響を再現していませんでした。今後はDB状態と外部grantの状態を別々に確認し、「古い処理の失敗→新しい処理の成功→古いcleanupの再開」を外部連携の必須競合テストとします。

同じ問題はcallbackの確定後にもありました。旧処理はcallbackのD1確定結果が不明なとき、先にtokenを失効し、処理権利が`READY`へ解放済みなら更新番号を確認せず`ERROR`へ変更できました。修正後は、callback自身の世代、完了attempt、callback確定直後のcredential更新番号がすべて一致する場合だけ、先にD1の`ERROR`停止を確定してからtokenを失効します。callbackの確定前に失敗したことが判明している場合は、従来どおり未保存tokenを失効して安全停止します。確定後に後続refresh、実失効、再照合、新しいcallbackが進んだ場合、古いcallback cleanupはDBも共有grantも変更しません。

## 安全境界

- 認証に要求する権限はYouTubeの読み取り専用権限1つだけです。追加権限が返った場合も安全側に停止します。
- OAuthで返ったチャンネルを初回の正解として登録しません。会社が事前に確認した公開チャンネルIDを非秘密設定 `YOUTUBE_EXPECTED_CHANNEL_ID` として固定し、`channels.list` の本人対象結果が1件かつ完全一致した場合だけ接続済みにします。
- 認証先との通信境界は、認証URL生成、認可コード交換、本人対象チャンネル照合、更新、失効だけです。投稿、動画登録、分割アップロード、公開設定の操作はありません。
- 外へ返す永続状態は未接続、処理中、接続済み、更新必要、失効済み、エラーです。状態表示の読取だけが一時失敗した場合は1回再試行し、2回とも失敗した場合はOAuth状態を変更せず、HTTP 503と一時表示状態`UNAVAILABLE`を返します。`UNAVAILABLE`ではERRORの手動復旧を行わず、状態表示を再確認します。トークン、認可コード、state、メールアドレス、チャンネルIDは返しません。
- OAuthのstateはハッシュだけをD1へ保存します。PKCE検証値、アクセストークン、更新トークンはWorker Secret由来の暗号鍵でAES-GCM暗号化し、D1には暗号文だけを保存します。
- OAuthの全運用経路はCloudflare Accessが必須です。JWTのRS256署名をAccessのJWKSで確認し、発行元、対象アプリ、有効期限、許可利用者が一致しない場合は`404`で拒否します。設定またはSecretが不足する場合も経路自体を`404`にします。
- アプリ内の監査には、Accessが発行する安定した主体ID（JWTの`sub`）をSHA-256で不可逆化したフィンガープリントだけを記録します。`sub`は署名検証後に必須・非空・正しい型であることを確認します。メールアドレスはAccessの許可判定だけに使い、フィンガープリントの材料、D1、アプリログ、HTTP応答には使いません。メール変更後も同じ`sub`なら同一実行者として追跡し、同じメールでも`sub`が異なれば別実行者として記録します。
- 開始経路のGETは、Access認証済みブラウザへ日本語の確認ページを返すだけで、state、世代、attempt、監査を変更しません。確認ページは32バイトの乱数から作ったCSRFトークンをhidden inputに入れ、同値を`Secure`・`HttpOnly`・`SameSite=Strict`・`Path=/`・Domain指定なしの`__Host-`専用Cookieに入れます。Cookieの有効期間は`Max-Age=600`（10分）で、操作成功時にCookieを削除します。CSRFトークン自体にサーバー側の使用済み台帳はなく、「1回」は成功後のCookie削除で実現するブラウザ上の制御です。開始・更新・失効のPOSTは、Access検証済みであり、フォーム値とCookie値の定数時間比較を通過した場合だけ許可します。`Origin`がある場合は期待originとの完全一致が必須です。`Origin`が欠落する場合は`Sec-Fetch-Site: same-origin`があるときだけ代替根拠として許可します。両ヘッダー欠落、`Origin: null`、HTTP・別host・別port・別origin、`Sec-Fetch-Site: same-site`・`cross-site`・`none`、トークンまたはCookieの欠落・不一致・重複・不正、非form形式、過大本文は`404`で拒否します。callback後はcode、state、Googleのerror値を除いた安全な状態経路へ移動します。
- 開始確認ページだけは`Referrer-Policy: same-origin`を返し、同一originのフォームPOSTにブラウザが正しい`Origin`を付けられるようにします。同意先へのリダイレクトとその他のOAuth応答は`no-referrer`のままで、別originへ参照元を送りません。
- OAuth経路のすべての`404`・`409`・`503`エラー応答は`Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`を返します。callback URLに一時的なcodeとstateがある状態で設定・Access・JWKS・サービス初期化が失敗しても、エラー文書から参照元を送りません。診断OFF時の本文とHTTP statusは、従来の汎用`404`のままです。
- 開始確認ページは外部フレーム表示を禁止し、CSPの`form-action`は同一originとGoogle OAuthの正規origin `https://accounts.google.com`だけを許可します。ワイルドカードやGoogleの他originは許可しません。認証情報、認可コード、state、チャンネルID、秘密値をページへ表示しません。
- OAuth callbackのqueryには一時的にcodeとstateが含まれるため、通常用`wrangler.jsonc`ではObservability、Workers Logs、invocation logs、traces、Logpushを無効のままにします。開発用`wrangler.e3-dev.jsonc`だけはWorkers Logsを有効にしますが、`redact_query_string: true`でqueryを削除し、invocation logsとtracesを無効、Logpushを無効、logs/tracesの外部送信先を空にします。通常・ストリーミングのtail consumerを設定せず、OAuth操作中に`wrangler tail`も起動しません。

## 開発環境の固定分類ログ

開発環境でアプリが出す構造化ログpayloadは、`event`、`stage`、`outcome`、`reason`の4項目だけです。値はコード内の固定列挙から選び、開始前のHTTP境界拒否、callbackの受信・接続確定・拒否・再送、状態表示の再試行・一時不能だけを記録します。callback再送は新たな成功や同意拒否として記録せず、`REPLAYED`と現在の固定状態分類を記録します。URL、path/query、認可code、state、PKCE、token、Cookie、JWT、メール、チャンネルID、生の例外、Google・Cloudflareの応答本文やstatusはpayloadへ渡しません。実際のWorkers LogsにはCloudflare管理のmetadataも付きますが、設定の`redact_query_string: true`でmetadataのqueryを削除します。ログをIssueやチャットへ共有するときは、確認済みの4項目のアプリpayloadだけを転記します。

状態表示で`stage=STATUS`、`outcome=RETRYING`、`reason=READ_FAILED`が1回出た後に正常表示へ戻れば、状態表示の一時的な内部読取失敗（通常はD1等）です。同じ要求で続けて`outcome=UNAVAILABLE`が出た場合はHTTP 503の一時不能であり、永続OAuth `ERROR`ではありません。状態を再読取し、ERROR手動復旧へは進みません。callbackで`outcome=SUCCEEDED`、`reason=CONNECTED`が出た後の状態表示一時不能も、接続済みD1状態を変更・失効させる根拠にはしません。

このアプリログはcallbackと状態表示の切り分けを目的とする最小範囲です。通常の状態値や永続的な既知エラーは`STATUS`ログに追加しません。更新・失効はAccess・Origin・CSRF等のHTTP境界拒否だけが`REQUEST_GATE`の対象で、サービス処理の成功や既知失敗はこのログの対象外です。それらは秘密値を含まないHTTP状態表示とD1監査で確認します。

## 設定名

非秘密設定:

- `YOUTUBE_OAUTH_CLIENT_ID`
- `YOUTUBE_EXPECTED_CHANNEL_ID`
- `YOUTUBE_OAUTH_REDIRECT_URI`
- `CLOUDFLARE_ACCESS_TEAM_DOMAIN`
- `CLOUDFLARE_ACCESS_AUD`

Cloudflare Worker Secret:

- `YOUTUBE_OAUTH_CLIENT_SECRET`
- `YOUTUBE_OAUTH_ENCRYPTION_KEY`
- `YOUTUBE_OAUTH_ALLOWED_EMAILS`

秘密値はWrangler設定、コード、D1の平文列、Issue、PR、チャット、コマンド履歴、ログへ書きません。実メールアドレスも設定例やテストデータへ転記しません。

## 一時的な404診断

通常は`YOUTUBE_OAUTH_DIAGNOSTICS_ENABLED`を設定せず、設定不足、redirect不一致、Access拒否、サービス初期化失敗、POST検証拒否のすべてで従来どおり同じ平文の汎用404を返します。会社の開発環境で原因を切り分けている期間だけ、非秘密設定を正確に`true`として有効化できます。有効時も返すのは次の粗い段階名だけで、設定値、Secret、メール、JWT、Cookie内容、フォーム送信値、例外本文は返しません。

- `CONFIG_INVALID`
- `REDIRECT_INVALID`
- `ACCESS_REJECTED`
- `SERVICE_INIT_FAILED`
- `MUTATION_REJECTED`

`ACCESS_REJECTED`の場合だけ、さらに次の固定分類を返します。生の例外、JWT、メール、鍵ID、URL、Secret、認可code/stateは返しません。分類表にない拒否は詳細分類を付けません。

- `TOKEN_MISSING`
- `JWT_INVALID`
- `CLAIMS_INVALID`
- `SIGNATURE_INVALID`
- `JWKS_TIMEOUT`
- `JWKS_FETCH_FAILED`
- `JWKS_HTTP_REJECTED`
- `JWKS_INVALID`
- `JWK_NOT_FOUND`
- `JWK_IMPORT_FAILED`
- `ALLOWLIST_DENIED`
- `ACCESS_CONFIG_INVALID`

`MUTATION_REJECTED`の場合は、開始・更新・失効の全POSTで共通の検証を使い、次の固定分類だけを返します。トークン、Cookieの値、送信本文、originの値は返しません。

- `ORIGIN_REJECTED`
- `CSRF_COOKIE_MISSING_OR_INVALID`
- `FORM_CONTENT_TYPE_REJECTED`
- `FORM_BODY_REJECTED`
- `CSRF_TOKEN_MISSING_OR_INVALID`
- `CSRF_TOKEN_MISMATCH`

診断は会社の開発環境・Access対象経路で原因確認中の短時間だけ使い、原因を特定した直後にフラグを削除または無効化して汎用404へ戻します。通常用のWrangler設定と本番環境にはこのフラグを設定しません。診断応答をログ、Issue、チャットへ貼る場合も、URLのqueryやAccess情報を添付しません。

公開cert endpointは鍵素材を表示せず項目構成だけを確認し、現在はRSA署名鍵2件、各鍵に`alg`、`e`、`kid`、`kty`、`n`、`use`があり、想定スキーマと一致しました。同じ公開JWKを標準WebCryptoで読み込む確認も2件とも成功しました。JWKS取得は`AbortController`でHTTP応答本文の読取完了までを5秒以内に制限し、時間超過、通信例外、HTTP拒否を別々の固定分類で返します。HTTP status、URL、応答本文、例外は診断応答へ出しません。Worker入口ではグローバル`fetch`を値として切り離さず、処理中のrequest context内で呼び出すラッパーを注入します。

Cloudflare公式仕様では、WorkerからCloudflareのfront door経由で公開endpointを取得する場合、Service Bindingまたは`global_fetch_strictly_public`が必要です。Access cert endpointはService Bindingの対象にできないため、通常・開発用の両Wrangler設定で同flagを明示し、公開経路として取得します。現在の外向き`fetch`はAccess cert endpointとGoogle公式APIに限定されています。自WorkerのURLを`fetch`しないことを維持し、ループを避けます。

## ローカル確認

```bash
cd worker
npm run typecheck
npm run verify:e5:oauth-config
npm run verify:e5:oauth-config:dev
npm run test:e5:oauth-config
npm run test:e5:oauth-deploy-wrapper
npm run demo:e5:oauth
npm run verify:e5:oauth-migration
```

ローカル確認では、模擬認証先がその場で生成する架空の認証情報とチャンネルIDだけを使います。次を確認します。

1. Cloudflare Access未確認なら開始とcallbackを拒否する。
2. stateの有効期限は10分で、一度しか使えない。同時開始・開始とcallback・同時callbackは、処理権利を取得した片方だけがDB状態を変更する。
3. PKCEはS256、認証要求は読み取り専用権限、オフライン更新、`prompt=consent`を指定する。
4. 本人対象チャンネルが0件、複数、不一致なら接続情報を確定せず、取得済み認証情報を失効させる。
5. 更新後も同じチャンネルを再照合する。不一致なら暗号文を削除してエラー状態にする。
6. 更新・失効で外部結果を確認できない場合は永続エラーにし、自動再試行や新しい同意を許可しない。更新のD1確定後に応答だけが失われた場合も同じで、同一世代・同一更新番号のままなら暗号文を消去し、`ERROR`へ停止する。Google側の手動失効と運用解除後に再同意する。
7. 失効成功後は暗号文を削除し、投稿準備済み判定へ戻れない。
8. D1、外向け状態、監査記録、ログへ生の認証情報やチャンネルIDが出ない。
9. 模擬認証先に投稿・動画登録・分割アップロード操作が存在しない。
10. 世代番号と処理ごとの所有番号を持つ共通処理権利で開始・callback・更新・失効・投稿準備確認を直列化し、旧callbackや競合した敗者が後から状態や監査記録を変更できない。
11. 外部応答後にDB確定が不明になった場合は接続済みへ戻さず、認証情報を削除してエラー停止をD1で先に確定し、確定できた処理だけが取得済みtokenを失効する。D1確定後の応答喪失で、その間に別処理が先へ進んだ場合は、世代・処理権利・更新番号の条件で後続結果の上書きと共有grantの失効を防ぐ。
12. 後続処理の直前に現在の期待チャンネル設定、暗号文の復号認証、本人対象チャンネルの実照合をやり直す。
13. 投稿準備確認も共通の処理権利と世代番号を取得し、live照合中に失効・更新が始まった場合は準備済みを返さない。
14. callbackの処理期限切れは一時的な未接続へ戻さず、PKCE暗号文を消去して永続的な結果不明エラーにする。運用解除まで新しい同意を開始しない。
15. 期限切れ回復は、読み取った世代・処理種別・所有番号・期限が変わっていない場合だけ実施し、新しく始まった処理を変更しない。
16. 認証情報が未確定のcallback処理中に失効要求が来た場合は、失効済みとは扱わず永続エラーにして、Google側の手動失効を求める。
17. 同意拒否と期限切れは、同じ世代のattemptが未処理で、controlが待機中の場合だけ確定する。認可コード交換が処理中なら上書きせず、処理中として拒否する。
18. 失効済み、期限切れ、同意拒否の状態変更と対応監査は同じD1 batchで確定する。監査記録が失敗した場合は状態変更も取り消し、状態だけを再試行不能にしない。
19. 同じattemptへの期限切れ・同意拒否が重なった場合は、直前の状態変更が成功した要求だけが監査を記録する。敗者は勝者の最終状態を根拠に重複監査を追加しない。
20. 状態のエラー化、認証情報の消去、attemptの失敗化、処理権利の安全停止、対応監査を同じD1 batchで確定する。監査INSERTが失敗した場合は全変更を取り消す。
21. すべての監査に、Access JWTの`sub`から作った実行者の不可逆フィンガープリントを記録する。実メールアドレスは保存・表示・フィンガープリント化しない。
22. ERROR手動復旧は、Google側失効確認、ERROR・owner/期限なし、active attemptなし、安全なcredential、期待世代一致のすべてを要求する。通常READY、CONNECTED、暗号文残存、世代不一致を拒否する。
23. 手動復旧のcontrol・credential・attempt・`oauth.recovered`監査は1つのD1 batchで確定し、途中失敗・監査失敗を全rollbackする。二重実行・同時実行・応答不明後の再実行は監査や世代を重複させない。
24. 復旧CLIはpreviewが標準で、remoteのpreview・書き込みは、コードに固定した会社account ID・開発D1名・開発D1 IDと同梱dev configの完全一致、および単一Wrangler membershipの機械一致後にだけD1を呼ぶ。接続先configの切替機能は持たない。remote書き込みにはさらに明示実行、Google側失効確認、確認句が必要である。設定不一致・未認証・account不一致・複数membership・異常出力ではD1 read/writeとも0件で停止する。メール形式・不正なoperator IDを拒否し、秘密値・メール・外部応答を表示しない。
25. 通常設定ではログ全体が無効であり、開発設定だけquery削除済みの固定分類ログを保存する。invocation logs、traces、Logpush、tail consumer、外部送信先を有効にすると設定検査が失敗する。アプリログのキーと値は固定列挙だけで、URL、認証情報、識別子、生の例外、外部応答を含まない。

DB移行の自動確認は一時ローカルDBだけを使います。新規適用、再適用が変更なしになること、旧移行適用済みDBの既存行を保持すること、`0009`・`0010`それぞれの競合で途中テーブルや移行記録を残さず失敗することを確認します。開発環境のD1には移行`0009`・`0010`を適用済みで、再適用確認は`No migrations to apply`でした。本番環境へは適用しません。

## 実経路確認前の停止点（実施済み記録）

Google同意画面ではチャンネル所有者の操作が必要です。2026年8月31日の旧dev versionに続き、2026年9月3日にも新dev versionで以下を確認したうえで、この停止点を通過しました。同年9月4日14:16:53 JSTに現行devの更新・再照合も成功したため、再同意と再認証は不要です。

1. 会社所有のGoogle Cloud設定とOAuthクライアントである。
2. callbackのHTTPS経路がCloudflare Accessで保護され、許可対象が会社指定の利用者だけである。
3. Worker Secretが値を表示せず登録され、設定ファイルや履歴に秘密値がない。
4. 事前確認済みの対象チャンネルIDが非秘密設定に固定され、OAuth結果から自動登録する処理がない。
5. 読み取り専用権限以外を要求せず、投稿APIを呼ぶ経路がない。
6. 対象がIssue #18専用の会社環境であり、ownerが同意内容と対象アカウントを画面で確認できる。
7. 当時の型確認、自動テスト、設定検査、Wrangler dry-runが成功し、Workers Logsとtracesは無効である。OAuth操作中はDashboardのリアルタイムログや`wrangler tail`を開かない。
8. `YOUTUBE_OAUTH_REDIRECT_URI`が、実際のWorker要求と同じHTTPS originかつ固定の`/__ops/e5/youtube-oauth/callback`である。ユーザー情報、末尾slash、query、fragmentを含めない。originやpathが異なる設定は経路全体が`404`になることを配備前に確認する。
9. Cloudflare Accessのアクセスログ、HTTP単位の要求ログ、Workers Logs、Logpush、Tail、OpenTelemetryについて、callbackのquery（認可コードとstate）が保存ログ、保存データセット、外部の永続保管先に残らないことをDashboardと公式仕様で確認する。一時処理や一時転送の有無だけでは停止条件にせず、処理後に残らないことをIssueの判断基準とする。
10. Googleから戻る際にCloudflare AccessのCookieが利用できることを、実認可コードを使わない事前確認で確かめる。CookieのSameSite設定やAccessの再認証によりcallback queryが別画面・ログへ残る可能性がある場合は止める。
11. Access、D1 migration、非秘密設定、Worker Secretの登録状態を、値を表示・コピーせず確認する。

## 固定分類ログ配備後の新しい停止点（通過済み）

この停止点は上記の過去の実OAuth前確認とは別物です。2026年9月4日に次の順で確認し、新しいダミーquery停止ゲートを通過しました。

1. `npm run check`、`npm run demo:e5:oauth`、通常・開発設定検査、`npm run test:e5:oauth-deploy-wrapper`、通常・開発設定のWrangler dry-runを成功させる。
2. 開発環境への配備は`npm run deploy:e5:oauth:dev`だけを使う。この入口は利用者からの引数を一切受け付けず、固定dev Worker名、会社account ID、dev D1名・ID、redirect URI、query削除とログ制限を検査し、固定dev configでdry-runした後に同じ設定を再検査してから配備する。`--name`、`--config`等の上書きは拒否され、config内の`env`セクションも拒否される。
3. Wrangler 4.128で配備先を変え得る`WRANGLER_CI_OVERRIDE_NAME`、`CLOUDFLARE_ENV`、`WRANGLER_API_ENVIRONMENT`、`CLOUDFLARE_API_BASE_URL`、`CF_API_BASE_URL`、`CLOUDFLARE_COMPLIANCE_REGION`は、親processで非空ならWranglerを1回も起動せず停止する。空文字でも子processから除去する。`CLOUDFLARE_API_TOKEN`等の認証に必要な環境変数は削除しない。
4. Wrangler自身の出力は`WRANGLER_LOG_SANITIZE=true`、`WRANGLER_WRITE_LOGS=false`、`WRANGLER_SEND_ERROR_REPORTS=false`、`WRANGLER_SEND_METRICS=false`、`DO_NOT_TRACK=1`に固定する。`WRANGLER_LOG_SANITIZE=false`、disk log有効化、debug等の`WRANGLER_LOG`、`WRANGLER_LOG_PATH`、`WRANGLER_OUTPUT_FILE_DIRECTORY`、`WRANGLER_OUTPUT_FILE_PATH`、`WRANGLER_TRACE_ID`の非空指定はWrangler起動前に拒否する。API request/response詳細、認証情報、配備結果の追加disk/stdout出力や外部telemetryを親processの設定で増やさない。
5. 配備後、実認可code/stateではなく非秘密の一時的なダミー印だけをqueryに入れ、Access認証済みの固定callbackへ1回アクセスする。確認時の完全URLはIssue、チャット、証跡へ転記しない。
6. 保存されたWorkers Logsで、アプリpayloadが固定4項目だけであり、Cloudflare metadataを含めてもqueryとダミー印が残っていないことを確認する。queryまたはダミー印が見えた場合はログを無効化して停止し、実OAuthを行わない。

実施証跡は、commit `50ac026`から固定dev配備入口でdev Workerへ配備したversion `fda2aa56-2456-48f8-a053-252995ff441d`です。DashboardでWorkers Logsが有効、Workers Tracesが無効であることを確認しました。実認可code/stateではない非秘密probeを固定callbackへ行い、JST 10:06:54.627に`info` / `event=YOUTUBE_OAUTH_HTTP` / `stage=CALLBACK` / `outcome=STARTED` / `reason=CODE_RECEIVED`、JST 10:06:55.052に`warn` / `event=YOUTUBE_OAUTH_HTTP` / `stage=CALLBACK` / `outcome=REJECTED` / `reason=STATE_REJECTED`が保存されたことを確認しました。Cloudflare metadataの`request.url`・`trigger`・`path`はcallback pathまでで、queryとprobe印は残っていません。完全なprobe URLとprobe値は記録しません。この確認で実Google OAuth、更新、失効、動画投稿は行っていません。

`npm run deploy:e5:oauth:dev`は実配備を行うコマンドです。配備の承認と実行者の確定後だけ実行し、ローカル検査の代わりには使いません。

## 過去に通過した停止点の証跡

2026年8月29日の星のしたのDashboard確認では、次を確認済みです。

- 固定OAuth pathがAccess対象で、許可対象は会社指定の1アドレスだけ
- Accessの認証先はCloudflareアカウントメンバーだけで、会社CloudflareログインはGoogle認証、セッションは30分
- Access認証ログにはアプリ名、判定、会社メール、国、ドメイン、Ray ID等が残るが、pathとqueryは表示・記録されていない。メール実値は本書へ転記しない
- Gateway HTTPログは過去24時間0件
- Workers Logs・Tracesは無効、OpenTelemetryの送信先なし。Logpushは無料プランでは利用できず、ジョブもなし

2026年8月29日に、当時の配備版とAccess認証済みセッションで開始GETの日本語確認ページを表示でき、rootは`404`、未認証の開始経路はAccess認証への`302`になることを確認しました。認可コードとstateを含まない空callbackも、Cloudflare Access認証後に安全な状態経路へ復帰しました。その後、2026年8月31日00:01:45 JST（UTC 2026-08-30T15:01:45.118Z）に同じ以前の配備版で実Google callbackと接続が成功しました。

Fetch Metadataヘッダーだけによる許可は行いません。`Origin`欠落時は`Sec-Fetch-Site: same-origin`に加え、Access検証とCSRFトークン・専用Cookieの一致をすべて必須にします。両ヘッダー欠落や`same-site`・`cross-site`・`none`は拒否します。この厳密化はローカル検証後、commit `9190fa192baa`に対応する新dev version `5a6a8155-8721-4510-a387-9e9d2469083b`として100%配備済みです。開始POST、Google OAuth正規originだけを許可するCSP、実OAuthの1サイクルは、2026年8月31日までに旧dev versionで確認した事実です。同サイクル完了時のD1はgeneration `6`、control `READY`、credential `REVOKED`、last errorなし、active attempt `0`でした。暗号化されたアクセストークン・更新トークンは存在せず、投稿準備に進めない安全停止状態でした。監査は`oauth.connected` 1件、`oauth.refreshed` 1件、`oauth.revoked` 1件でした。現在の状態は本書末尾の「過去の実1サイクル結果と現在の接続状態」を参照してください。

また、Access未認証時の`302`応答にはNEL・`report-to`ヘッダーがあります。W3C仕様上、application phaseの失敗報告では、認可code/state付きURLのpath/queryがCloudflareのNEL endpointへ一時送信され得ます。一方、Cloudflare公式説明では処理後に個人情報や利用者固有情報を保持せず、NELの保存データセットにもURL項目がありません。このためNEL単独では実同意の停止条件としません。保存期間は断定せず、`workers.dev`側のNELをこのアカウントから無効化できることも公式確認できていない点を残存リスクとして扱います。

1つでも確認できない場合は止め、認証経路を有効にしません。

### 管理面とアプリ監査の境界

Cloudflare Accessの管理監査には、アクセス許可対象を管理するため会社メールが残る場合があります。これはCloudflare管理面の記録です。アプリ側はメールアドレスを保存せず、Access JWTの`sub`から作る不可逆フィンガープリントだけを監査へ記録します。

## 配備後のAccess保護下での実経路確認記録

厳密な`Origin`修正の配備と、チャンネル所有者による開始・同意・callbackのD1保存は2026年9月3日に成功しました。現行devでの状態確認、実token更新、更新後の再照合は2026年9月4日14:16:53 JSTに成功しました。チャンネル所有者への再同意は不要です。現行の正常接続を解除しないため、現行版の実失効は再実施していません。失効手順は将来の運用と回帰確認用に残します。新しい操作画面は追加せず、CookieやAccess JWT、パスワード、認証コード、tokenの共有を求めません。

| 操作 | 経路・方法 | 操作前の状態 | 期待結果 |
|---|---|---|---|
| 状態確認 | `GET /__ops/e5/youtube-oauth/status` | 任意 | 秘密値を含まない状態だけを返す |
| 開始確認 | ブラウザで `GET /__ops/e5/youtube-oauth/start` | 任意。GETでは状態を変更しない | 日本語確認ページを表示 |
| 開始確定 | 確認ページの「Googleの同意画面へ進む」を押す。同一originの`POST /__ops/e5/youtube-oauth/start` | 未接続または失効済み。エラー・処理中ではない | Google同意画面へ移動 |
| callback | Googleから固定経路へ自動で戻る | 開始済み | queryのない状態経路へ移動し、接続済み |
| 更新 | 同一originから `POST /__ops/e5/youtube-oauth/refresh` | 接続済み。2026年9月4日14:16:53 JSTに現行devで実行確認済み | 再照合後も接続済み |
| 失効 | 同一originから `POST /__ops/e5/youtube-oauth/revoke` | 2026年8月31日の旧dev版で実行確認済み。現行の正常接続を保つため現行版では再実施しない | 失効済み、暗号文なし |

開始確定、更新、失効は必ず同一originの通常フォームPOSTとし、アドレスバーや外部サイトから実行しません。操作前に古い確認ページのタブをすべて閉じ、最新の1タブだけを使います。開始確定はその確認ページのフォームだけを使います。更新・失効の直前にも同じ開始確認ページを新しく開き、hidden inputと専用Cookieの組を発行します。Cookieは`Max-Age=600`（10分）で失効し、操作成功時に削除されるため、次の操作前に再度ページを開き直します。CSRFトークンの使用済みをサーバー側の台帳で管理する方式ではありません。

確認ページのCSPは`default-src 'none'`のため、開発者ツールからの`fetch`は`Failed to fetch`になります。安全設定を緩めず、更新・失効では確認ページにある既存フォームの送信先だけを同一originの固定経路へ変更し、ブラウザの通常フォーム送信を使います。hidden CSRF値やCookieは読み出し、表示、コピーしません。`<操作>`に入力できるのは`refresh`または`revoke`だけです。

```js
const operation = '<操作>';
if (operation !== 'refresh' && operation !== 'revoke') {
  throw new Error('許可されていない操作です');
}
const form = document.querySelector('form');
if (!(form instanceof HTMLFormElement)) {
  throw new Error('確認ページのフォームを確認できません');
}
form.method = 'post';
form.action = `/__ops/e5/youtube-oauth/${operation}`;
form.requestSubmit();
```

開始前、callback後、更新後、失効後に状態経路を確認し、D1では対応監査の操作名、理由コード、実行者フィンガープリントが1件だけ増えたことをSEが確認します。認証情報、チャンネルID、実メールアドレスは画面・SQL結果・記録へ表示しません。エラーまたは処理中の状態ではフォーム送信を行わず、下記の復旧手順へ進みます。参考として、今回の`Origin`修正より前の配備版では、実更新がこの通常フォームPOSTで2026年8月31日19:14:37 JST（UTC 2026-08-31T10:14:37.331Z）に成功し、D1監査と再照合結果で確認しました。実失効も同じ以前の配備版の通常フォームPOSTで2026年8月31日21:17:34 JST（UTC 2026-08-31T12:17:34.421Z）に成功し、D1監査、暗号文削除、投稿準備不可を確認しました。これらは最新修正の配備後証跡ではありません。

## 停止・再開・復旧

### 停止

1. OAuth開始とcallbackを受ける経路を無効化し、Cloudflare Accessの保護状態を確認します。
2. D1の状態・監査記録は削除しません。手動で接続済みに書き換えません。
3. 認証情報の漏洩が疑われる場合は、認証先で更新トークンを失効させ、Worker Secretの暗号鍵もローテーション対象にします。
4. 暗号鍵は32バイトの暗号学的乱数をbase64url化した値を使います。鍵の世代は運用記録で管理し、鍵だけを先に変更しません。停止、Google側の手動失効、D1暗号文削除、新鍵登録、owner再同意の順で復旧します。

### 再開

1. Cloudflare Access、設定名、読み取り専用権限、期待チャンネル設定を再確認します。
2. 失効済みまたはエラー状態は自動で接続済みに戻しません。新しいstateとPKCEで最初から同意し直します。
3. 接続済み状態でも期限切れなら更新し、本人対象チャンネルを再照合してから後続準備を許可します。
4. 更新、照合、失効の失敗理由は定義済みコードだけで記録し、外部応答本文や秘密値を保存しません。
5. 1分の処理期限を過ぎたcallback・更新・失効は結果不明としてエラー停止します。Google側で手動失効し、新しい世代でowner再同意するまで後続へ進めません。
6. 結果不明エラーの解除は、Google側で対象アプリの権限を手動失効し、D1の該当attemptが失敗・PKCE空であることを確認した後に行います。確認前にcontrolを`READY`へ戻しません。解除操作は公開HTTPに設けず、会社の運用担当が対象DBを照合して実施します。
7. 認可コード交換のtimeout・5xx・不正応答は、Google側でgrantが発行された可能性を否定できないため永続エラーにします。token取得後のチャンネル拒否でGoogle側失効を確認できない場合も同じです。自動で新しい同意を開始しません。

### ERRORの手動復旧（会社運用担当CLIのみ）

公開HTTP経路や復旧画面は追加しません。会社のCloudflareアカウントで認証済みの運用担当だけが、Google側で対象アプリの権限を手動失効した後にCLIを使います。開発環境へ移行`0010_e5_youtube_oauth_manual_recovery.sql`が適用済みであることを先に確認し、通常の`READY`状態では実行しません。

復旧が許可されるのは、controlが`ERROR`で所有者・期限が空、`PENDING`・`CONSUMING` attemptが0件、credentialが0件または同じ世代の`ERROR`・`REVOKED`で全暗号文が空、かつ指定した世代が一致する場合だけです。成功時は世代を1つ進めて旧callbackを無効化し、control、credential、終了済みattemptのPKCE消去、`oauth.recovered`監査を1つのD1 batchで確定します。監査にはメールではないoperator IDのSHA-256フィンガープリント、固定理由`GOOGLE_REVOCATION_CONFIRMED`、時刻だけを保存します。

まず書き込みなしのpreviewを実行します。`<現在世代>`と`<非メールの担当ID>`だけを置換し、メール、token、code、state、暗号文を入力しません。

```bash
cd worker
npm run e5:oauth-recovery -- --expected-generation <現在世代> --operator-id <非メールの担当ID> --remote
```

Google側の手動失効を会社ownerと確認後、同じpreviewへ`--confirm-google-revoked`を付け、`READY_TO_RECOVER`であることを確認します。実行時はさらに`--execute`と会社アカウント確認句が必須です。CLIの接続先はスクリプト相対の`wrangler.e3-dev.jsonc`だけで、`--config`による切替は許可しません。remoteではpreviewを含む全D1呼出前に、コードへ固定した非秘密の会社account ID・開発D1名・開発D1 IDとconfigの完全一致を確認し、その後にWranglerの単一membershipを機械照合します。設定不一致、未認証、account不一致、複数membership、出力異常ならD1 read/writeとも0件で停止します。Wranglerは`node_modules`内の固定依存を直接使い、`npx`による暗黙downloadは行いません。実メールは設定、ソース、CLI出力へ記録しません。

```bash
npm run e5:oauth-recovery -- --expected-generation <現在世代> --operator-id <非メールの担当ID> --confirm-google-revoked --execute --remote --confirm-company-account hoshinoshita-company-cloudflare
```

`BLOCKED`ならDBを直接書き換えず原因を解消します。応答が不明な場合は同じ世代・担当ID・確認フラグで再実行します。既に成功済みなら`ALREADY_RECOVERED`となり、世代変更や監査追加は行いません。CLIは状態区分と件数だけを表示し、秘密値、メール、Google応答を表示しません。

### 失効

1. OAuth処理と将来の投稿処理を停止します。
2. 認証先へ失効要求を行い、成功後だけD1のアクセストークン暗号文と更新トークン暗号文を削除します。
3. 外部結果が不明な失敗では失効済みと誤表示せず、永続エラーで停止します。Google側で手動失効し、運用担当が状態を照合して解除するまで再試行しません。
4. 失効後は状態が失効済みであること、D1の暗号文が空であること、後続準備判定が拒否されることを確認します。

## 過去の実1サイクル結果と現在の接続状態

取得→チャンネル照合→更新・再照合→失効の実1サイクルは、2026年8月31日に旧dev version `39771401-b085-47f4-882a-8ff146a301e1`で完了しました。厳密な`Origin`修正は、commit `9190fa192baa`に対応する新dev version `5a6a8155-8721-4510-a387-9e9d2469083b`として100%配備済みです。この新dev versionでも、2026年9月3日01:27:57 JSTにチャンネル所有者の同意とcallbackが完了し、D1はgeneration `9`、control `READY`、credential `CONNECTED`、attempt `COMPLETED`です。アクセストークン・更新トークンはいずれも暗号文として保存され、対象チャンネル一致、`failure_code`・`last_error_code`ともになし、監査`oauth.connected`を確認しました。

現在は`CONNECTED`で、アクセストークン・更新トークンは暗号文として保存、対象チャンネル一致、監査`oauth.refreshed`あり、`last_error_code`なしです。チャンネル所有者への追加同意と再認証は不要です。クライアントは修正がIssue #18の受入範囲内であり、rollback不要と承認しました。現行版での実失効・暗号文削除・失効後拒否は、正常接続を解除しないため再実施していません。この経路の実証跡は2026年8月31日の旧dev版にあります。実YouTube動画、投稿API呼出、動画アップロード、resumable upload sessionはいずれも0件です。
