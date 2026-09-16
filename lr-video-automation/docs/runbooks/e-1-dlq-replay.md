# Runbook: E-1 DLQ replay

## Purpose

DLQへ退避されたイベントを、二重処理を防ぎながら元Queueへ戻すための境界を定める。

## Safety rules

- 公開HTTP endpointは作らない。
- `OPERATOR_IDS`に登録された内部operator IDだけを許可する。メールアドレスは使用しない。
- 呼出しはCloudflare Service Binding RPC `replayDlqMessage(dlqMessageId, actorId)`に限定する。
- 本番の呼出し元はCloudflare Accessで管理者だけに制限する。管理Worker・Service Binding・D1・Queueの実resource作成は別作業パッケージの承認後に行う。
- 再送イベントは元の`event_id`を維持する。Consumerは同一`event_id`を冪等処理する。
- schemaに合うイベントは、定義済みfieldだけに正規化してからDLQへ保存する。未知fieldは保存も再送もしない。
- schema不正のメッセージは生payloadを保存しない。digest、byte数、トップレベルの型、`INVALID_EVENT_SCHEMA`だけを`QUARANTINED`で残し、再送不可とする。
- 初回と内容が異なる同一`event_id`は`EVENT_ID_COLLISION`として隔離・監査し、ackせずCloudflareのDLQ経路へ送る。DLQ側では再送不可にする。

## Recovery behavior

0. `QUARANTINED`は内容にかかわらず再送対象に選ばない。
1. 対象行を`PENDING`から`REPLAYING`へ条件付き更新し、60秒のleaseを設定する。
2. 元Queueへの送信に成功したら`REPLAYED`にする。
3. 送信に失敗したら`PENDING`へ戻し、構造化エラーコードを残す。
4. 送信の前後で処理が停止した場合はlease失効後に再取得できる。再送が重複しても、Queueの`event_id`台帳とジョブのmutation tokenにより状態変更を重複させない。

ローカルでは`worker/test/queue.spec.ts`が、未許可operatorの拒否、lease失効後の回収、重複イベントの再配信、未知field除去、不正payloadの非保存・再送拒否を検証する。
