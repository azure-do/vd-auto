# E-3.2 R2開発環境接続の実装記録

## 実装内容

- R2へ直接PUTするS3 SigV4署名URLを追加した。Workerは動画全体を中継しない。
- URLは15分以下、保存keyはサーバー生成の推測困難な値で、既存の提出予約と結び付く。
- Content-Type、SHA-256、実payload長のContent-Lengthを署名対象にした。ブラウザJavaScriptはContent-Lengthを設定せず、File bodyからブラウザが自動送信する想定で、返却ヘッダには含めない。Chromeの実FetchからR2へ直接PUTできることを確認した。
- 完了callbackではR2のHEADに加え、必要なコンテナ範囲と分散した代表動画サンプルを読取り、MP4の実動画trackを確認する。空・音声のみ・切断データは拒否し、R2 metadataだけを信頼しない。MP4の`moov`読取りは4MiBまでに制限し、超過・Range読取失敗は拒否する。
- `ftyp`は4KiB、動画サンプルの代表Range読取りは1サンプル64KiBまでに制限した。`mp4box`で`stsc`・`stco/co64`・`stsz`を展開し、各動画trackの先頭・中間・末尾を含む最低3、動画時間に応じ最大7サンプルを分散して確認する。H.264/H.265はサンプル内のNALを順に走査し、VCL NAL、正しいheader、非ゼロ実体を確認する。未対応codecはfail-closedで拒否する。
- 動画trackのdurationは有限かつ正値、縦横は各1〜32,768、比率は1:100〜100:1だけを許可する。通常の縦動画・横動画を制限する運用閾値ではなく、後続処理で安全に扱えない値だけを拒否する境界である。
- receiptを先にD1へ確定してからQueueへ送る。Queue送信または応答途中の停止は、同一callbackの再送で回復する。
- D1に完了チェックサムの専用claim表を追加し、別submissionから同じ動画が同時完了しても新規完了は1件だけを確定する。過去の重複履歴は削除・変更せず、移行時にチェックサムごとの決定的な1 submissionだけを今後のownerとして登録する。同一submissionの同一callback再送は従来どおり同じreceiptを返す。
- receipt確定後のQueue送信失敗は、アップロード拒否の`400`ではなく再試行可能な`503`として返す。
- 開発専用のHTTP routeは `DEV_TEST_SECRET` が設定された構成だけで有効にし、CORSは `http://localhost:8788` のみとした。
- 開発E2Eで受理する形式は `video/mp4` のみに限定する。ISO BMFF解析は手製のbox解析だけに依存せず、`mp4box`で実動画track情報を確認する。

## 実Cloudflare確認結果（2026-08-25）

- 会社アカウント内に、Issue #14専用のWorker、R2、D1、Queue、DLQを作成した。既存プロジェクトの資産には接続していない。
- 強化版Worker（version `4bea126b-6914-4b4e-8309-227176b8a8e6`）を開発環境へ配備した。
- 開発専用D1へmigration `0007`を適用し、再実行では`No migrations to apply`となることを確認した。
- 公開側には開発用secretを配備していない。通常routeとlocalhost Origin付きリクエストはいずれも`404`となることを確認した。
- R2のCORSは `http://localhost:8788` だけを許可し、`*` は設定していない。
- 小容量の生成ダミーMP4で、`begin=201`、R2直接PUT `=200`、`complete=202`、同一完了callbackの再送 `=202` を確認した。
- 20MiB、60MiB、300MiBの生成ダミーMP4でも、それぞれ`begin=201`、R2直接PUT `=200`、`complete=202`、同一完了callbackの再送 `=202` を確認した。3件合計でcompleted session、receipt、job、`job.created`監査記録が各3件となることを確認した。
- 破損MP4は完了callbackが`400`となり、`UPLOAD_OBJECT_CORRUPT`の監査記録が1件、receiptとjobが0件であることを確認した。
- 別submissionから同じチェックサムを完了させた場合は`400`となり、チェックサムclaimが1件、拒否sessionが1件、receiptとjobが0件であることを確認した。
- 20MiBの途中切断相当として半分のbodyだけを送ると、ブラウザのPUTは `TypeError` で拒否された。同じ受付から全量を再送すると `begin=201`、R2直接PUT `=200`、`complete=202`、再送 `=202` となり、Queue重複投入後もreceipt、job、`job.created`監査記録はそれぞれ1件だった。
- 不正MIMEの `video/webm` は開始時点で `400` となり、session、receipt、jobは作成されなかった。
- チェックサム不一致は `begin=201` の後、R2直接PUTが `400` となった。sessionは `PENDING` のままで、receiptとjobは作成されなかった。
- 最終E2Eで把握したダミーR2 objectの既知キー6件だけに削除操作を行い、6件すべてが不存在になったことを確認した。D1の状態・監査・冪等記録は、運用手順に従い残した。
- Issue専用Queueのconsumerを一時停止してスキーマ不正のダミーevent 2件を投入し、再開後にDLQ consumerがD1へ `INVALID_EVENT_SCHEMA` / `QUARANTINED` として2件を隔離したことを確認した。確認後、main QueueとDLQはいずれも空だった。
- Cloudflareのアカウント識別子は実行時の環境変数だけで指定し、設定ファイルや履歴へ含めていない。資格情報、署名URL、object参照値の実値も記録していない。
- 2026-08-25にIssue専用のR2資格情報と短期API tokenを失効した。Cloudflare上にAccount API tokenとUser API tokenが残っていないこと、旧CLI資格情報の再利用が拒否されることを確認し、端末の環境変数とクリップボードも消去した。

## 未検証事項・既知の限界

- MP4の破損拒否は、コンテナと動画全体へ分散した最大7代表サンプルの検査でIssue #14の要件を満たす。全frameの完全復号ではないため、未選択sampleだけの破損を検出できない既知の限界は残るが、Issue #14の追加承認を必要とする停止条件ではない。
- 実際にネットワーク接続を途中で切る試験は未実施である。今回の切断確認は、20MiBのbodyを半分だけ送る方法で再現した。
- 音声のみ、空ファイル、`moov`が読取り上限を超えるMP4、R2のRange読取り失敗は、今回の実Cloudflare E2Eでは未実施である。
- 正常な `video.uploaded` eventのDLQ格納・再送・重複再送は自動テストで1 job / 1 auditを確認したが、実Cloudflareでは未実施である。
- 追加の実環境確認が必要になった場合も、ダミー動画だけを使い、URL・資格情報・個人情報を記録しない。

## ローカル確認結果

- `npm run check`: 分散sample破損、VCL NAL、上限、duration・縦横比、別submission同一checksum競合、receipt挿入衝突時の一括ロールバック、Queue送信失敗回復、`video.uploaded`のDLQ再送を含む184テスト成功、型検査成功
- `npm run verify:e3:migration-upgrade`: fresh、旧0005からの更新、既存重複履歴を保持したclaim backfill、履歴不変、再適用を確認
- R2 adapter契約: Content-Lengthを署名対象にしつつ呼出側ヘッダへ返さないこと、R2 callback、Queue重複配信時のジョブ1件化、ffmpeg生成ダミーMP4の受理、切断・音声のみ・偽装MP4の拒否、CORS設定形式を自動テストで確認
- `wrangler deploy --dry-run --config wrangler.e3-dev.jsonc`: Worker、D1、R2、Queue/DLQの開発構成を配備せず確認

## 実環境接続で判明した注意点

- Wrangler local devでD1、R2、Queue producerをすべてremote接続すると、D1がcode 1105で失敗する組合せがあった。
- Wranglerが意図しないアカウントを推定する可能性があるため、会社アカウントを環境変数で明示し、`whoami`の結果と照合してから操作する必要がある。
- ローカルのbrowser E2EではQueueをlocalのままにし、D1で確定済みのreceiptに対応するeventだけをCloudflare HTTP Push APIでIssue専用のremote Queueへ送る回避策で確認した。未確定のeventや任意のpayloadは送らない。
