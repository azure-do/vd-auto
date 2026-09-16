# E-3.2 開発用R2アップロードの運用手順

対象は `lr-video-automation-dev-20260824` の開発専用資産だけです。本番、既存Worker、既存bucket、実動画には接続しません。

## 事前設定

1. 会社のIssue専用アカウントを `CLOUDFLARE_ACCOUNT_ID` などの環境変数で明示する。識別子の実値は設定ファイル、チャット、Issue、PR、ログへ書かない。
2. `npx wrangler whoami` を実行し、表示されたアカウントが会社のIssue専用アカウントと一致することを確認する。一致しない、または判別できない場合は停止する。
3. `worker/wrangler.e3-dev.jsonc` のD1、R2 bucket、Queue/DLQだけを作成・紐付ける。
4. `worker/config/r2-e3-dev-cors.json` を `wrangler r2 bucket cors set lr-video-automation-dev-20260824 --file worker/config/r2-e3-dev-cors.json` でR2 bucketへ適用する。許可元は `http://localhost:8788` だけで、`*` は設定しない。
5. Worker secretとして `DEV_TEST_SECRET`、`R2_ACCOUNT_ID`、`R2_UPLOAD_ACCESS_KEY_ID`、`R2_UPLOAD_SECRET_ACCESS_KEY` を扱う。値をチャット、Issue、PR、ログ、ファイルへ書かない。公開WorkerはCloudflare Access未設定のため、Issue #14の検証ではこれらのsecretを公開側へ設定せず、開発用routeを404のままにする。
6. R2のS3互換資格情報は、この開発bucketへのオブジェクト書込みに限定する。不要になったら失効する。
7. `R2_ACCOUNT_ID` を含む実環境の値は設定ファイルに書かず、実行時のsecretとしてのみ渡す。値の共有は不要。

## 開発用D1 migrationの適用

Issue #14専用の会社開発用D1だけを対象にします。実行前に `worker/wrangler.e3-dev.jsonc` の `database_name` が `lr-video-automation-dev-20260824` であることを目視確認し、他のD1名では実行しません。

1. `worker` ディレクトリで `npx wrangler d1 migrations apply lr-video-automation-dev-20260824 --remote --config wrangler.e3-dev.jsonc` を実行する。
2. 出力で対象DB名と適用されたmigrationを確認し、エラーがあればWorkerの配備へ進まない。
3. 同じコマンドをもう一度実行し、未適用のmigrationがない旨の表示になることを確認する。再適用でテーブル変更やエラーが発生した場合は停止する。
4. この確認ではダミーデータ以外を投入しない。本番D1や既存プロジェクトのD1には接続しない。

## 開発確認

- 開始は `POST /__dev/e3/uploads/begin`、完了は `POST /__dev/e3/uploads/complete` を使う。どちらも `DEV_TEST_SECRET` が必要で、production設定ではroute自体が404になる。
- `begin` が返すURLは短時間だけ有効で、Content-Type、SHA-256、実payload長のContent-Lengthを署名対象にする。ブラウザのJavaScriptはContent-Lengthを設定せず、File bodyからブラウザが自動送信する。`required_headers`にもContent-Lengthは返さない。
- Chromeの実FetchからR2へ直接PUTできることは、2026-08-25に4,584バイト、20MiB、60MiB、300MiBの生成ダミーMP4で確認済みである。各サイズで開始 `201`、R2直接PUT `200`、完了 `202`、完了再送 `202` を確認した。
- 完了時はR2のHEADだけで判断せず、必要なコンテナ範囲と分散した代表動画サンプルを読み、開発E2Eで受け付けるMP4の構造を確認する。MP4以外、切断・破損データ、サイズ・SHA-256・MIME不一致はジョブ化しない。
- `ftyp`は4KiB、代表動画サンプルのRange読取りは1サンプル64KiBを上限とする。`mp4box`で`stsc`・`stco/co64`・`stsz`を展開し、各動画trackの先頭・中間・末尾を含む最低3、動画時間に応じ最大7サンプルを分散して読む。H.264はtype 1〜5、H.265はtype 0〜31のVCL NALを必須とし、NAL header、非ゼロ実体、H.265の`temporal_id_plus1`を確認する。SEI・SPS・PPSだけのsample、未対応codecはfail-closedで拒否する。
- durationは有限かつ正値、縦横は各1〜32,768、比率は1:100〜100:1の安全境界を確認する。この値は通常の縦動画・横動画を選別する運用ルールではない。durationは後続のメモリ確保に使わないため、未合意の最長時間を独自に追加しない。
- 完了callbackの再送は同じreceiptを返す。Queue送信中の停止後も、callback再送で既存receiptを再取得してQueueへ再送できる。
- 別submissionの同じチェックサムは、専用claim表のownerだけをD1で新規完了させ、後続を `UPLOAD_DUPLICATE_CHECKSUM` で拒否する。移行前から存在する重複session・receipt・jobは変更せず、submission ID順で決定した1件だけを今後のownerとしてbackfillする。receipt確定後のQueue送信失敗は再試行可能な`503`とし、同じcallbackを再送する。

この検証はコンテナと最大7代表sampleの構造確認であり、全frameの完全復号ではない。未選択sampleだけの破損を検出できない既知の限界はあるが、代表sampleによる破損拒否でIssue #14の要件を満たすため、追加承認の停止条件とはしない。

### 2026-08-25の強化版最終E2E

- 強化版WorkerをIssue専用の開発環境へ配備し、migration `0007`の適用後、再実行で未適用migrationがないことを確認した。
- 小容量と20MiB、60MiB、300MiBの生成ダミーMP4で、開始`201`、R2直接PUT`200`、完了`202`、同一完了callback再送`202`を確認した。
- 破損MP4は完了`400`かつ`UPLOAD_OBJECT_CORRUPT`となり、receiptとjobを作成しないことを確認した。
- 別submissionの同一チェックサムは完了`400`となり、claim 1件、拒否session 1件、receipt 0件、job 0件であることを確認した。
- 公開側へ開発用secretは配備せず、通常routeとlocalhost Origin付きリクエストがともに`404`となることを確認した。
- 最終E2Eの既知ダミーobject 6件だけを削除し、6件の不存在を確認した。D1の状態と監査証跡は削除しない。
- アカウント識別子は実行時の環境変数だけで指定し、設定ファイルや履歴へ記録しない。

### 2026-08-25に確認した異常系

- 破損MP4: R2へのPUT後、完了callbackと再送をともに `400` とし、D1を `REJECTED`、理由を `UPLOAD_OBJECT_CORRUPT` にする。receiptとjobは作成しない。
- 途中切断相当: bodyを半分だけ送るPUTはブラウザ側で拒否される。同じ受付から全量を再送した場合は正常完了でき、Queueの重複投入後もreceipt、job、`job.created`監査記録を各1件に保つ。
- 不正MIME: `video/webm` は開始時点で `400` とし、session、receipt、jobを作成しない。
- チェックサム不一致: 開始後のR2直接PUTを `400` とし、sessionは `PENDING`、receiptとjobは未作成とする。

実際のネットワーク接続を途中で切る試験は未実施であり、上記の途中切断相当試験と区別する。音声のみ、空ファイル、`moov`読取り上限超過、R2のRange読取り失敗も、実Cloudflareで確認する場合は別途記録する。

## ローカルbrowser E2E時のQueue接続

Wrangler local devでD1、R2、Queue producerをすべてremoteにすると、D1がcode 1105で失敗する場合がある。この組合せで無理に続行しない。

1. D1とR2はIssue専用のremote資産へ接続し、Queue producerはlocalのまま起動する。
2. Chromeからダミー動画だけで開始、R2直接PUT、完了callback、再送を確認する。
3. D1を確認し、receiptが確定済みであることと、送るeventがそのreceiptに対応していることを確認する。
4. 確定済みreceiptに対応するeventだけを、Cloudflare HTTP Push APIでIssue専用のremote Queueへ送る。未確定event、任意payload、実データは送らない。
5. 同じeventを再送し、D1上のjobと監査記録が1件のままであることを確認する。

アカウントの照合前にPush APIを呼ばない。署名URL、object参照値、トークン、アカウント識別子の実値をコマンド履歴や記録へ残さない。

## 停止・後片付け

### Workerとconsumerの停止・再開

1. `wrangler whoami`で会社のIssue専用アカウントを再確認し、対象Worker、main Queue、DLQの名前がIssue専用名であることを画面と設定の両方で確認する。
2. Queue画面でmain Queueのconsumer配信を一時停止し、状態が「一時停止」になったことを確認する。Worker自体を止める必要がある場合は、先に公開側にbindingとsecretがないこと、通常Originとlocalhost Originの両方が`404`であることを記録する。
3. 再開時はIssue専用main Queueのconsumer配信だけを再開し、状態が「稼働中」になったことを確認する。他のQueueやWorkerは操作しない。
4. main QueueとDLQの保留件数が0になるまで待ち、D1のDLQ記録と監査記録を確認する。不正eventは `INVALID_EVENT_SCHEMA` / `QUARANTINED` とし、再送しない。

### 対象を限定した削除と資格情報の失効

1. 今回のE2E中にメモリ上で把握したダミーobjectの既知キーだけを削除対象一覧にする。prefix全体、wildcard、bucket削除は使用しない。
2. 既知キーを1件ずつ削除し、同じキーへのHEADまたは一覧照合で不存在を確認する。件数が一致しない場合は、追加削除せず停止する。
3. D1の状態・監査・冪等記録は削除しない。Queue/DLQはダミーeventだけが処理済みで保留0であることを確認する。
4. E2E用に一時生成したUI、ローカルfixture、secretファイルを削除し、作業treeに残っていないことを確認する。
5. 新規URL発行と追加操作が不要になった最後の段階で、Issue専用のR2資格情報と短期API tokenを失効する。失効後に対象資格情報が一覧から消え、再利用が拒否されることを、値をログへ出さずに確認する。

手順5は2026-08-25に実施済みである。Cloudflare上にAccount API tokenとUser API tokenが残っていないこと、旧CLI資格情報の再利用が拒否されることを確認した。端末の環境変数を解除してシェルを終了し、クリップボードも消去した。

bucket、D1、Worker、アカウント自体を削除する操作はこの手順に含みません。
