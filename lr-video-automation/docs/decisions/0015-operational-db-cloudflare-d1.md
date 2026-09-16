# ADR-0015: E-1の運用DBにCloudflare D1を採用する

## Status

accepted

## Date

2026-08-16

## Context

ADR-0008で、動画ジョブの状態正本をトランザクション可能な運用DBとし、Google Sheetsは人間向けミラーに限定した。E-1でCloudflare D1とSQLite-backed Durable Objectsを比較し、具体製品を固定する。

想定規模は約14ジョブ/日で、ジョブ横断の検索、監査、保存期限検索、Sheetsミラー用outboxを単一の関係DBで管理する。

## Decision

- E-1の運用DBに **Cloudflare D1（SQLite）** を採用する。
- 条件付き`UPDATE`と`row_version`で楽観的排他を行う。
- 状態遷移、冪等台帳、監査ログ、ミラーoutboxをD1の`batch()`による単一トランザクションで更新する。後続INSERTは、更新後の状態と`row_version`に一致する行からのみ生成する。
- `idempotency_key`に一意制約を設け、同一キーの多重実行は既存の取得結果として扱う。
- Cloudflare Queueは専用DLQを必須設定し、DLQ到達メッセージはD1に保持して明示的に再処理する。
- Durable Objectsは、将来、特定の単一ジョブに対する高頻度な同時操作や、ジョブ単位のアラームが必要になった場合のみ再検討する。

## Rationale

- D1はWorkerから直接SQLで参照でき、中央台帳、監査、期限検索に適する。
- D1の`batch()`は複数ステートメントを順次実行するSQLトランザクションで、途中失敗時はシーケンス全体がロールバックされる。
- SQLite-backed Durable Objectsは強整合と専有ストレージに優れる一方、Workerとオブジェクトへのルーティング、分割キー、ジョブ横断クエリ用の別集約を設計する必要がある。本規模では運用複雑性に見合わない。

## Consequences

- D1は単一プライマリ書き込みを前提とする。多重配信はDBの一意制約と条件付き更新で吸収する。
- 実環境へのD1作成・migration適用・Queue/DLQ作成は、別途承認された作業パッケージで行う。
- Sheets同期はD1 outboxからの一方向とし、Sheetsの状態をD1へ取り込まない。

## References

- Cloudflare D1 `batch()`: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
- SQLite-backed Durable Objects: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- Cloudflare Queues DLQ: https://developers.cloudflare.com/queues/configuration/dead-letter-queues/
