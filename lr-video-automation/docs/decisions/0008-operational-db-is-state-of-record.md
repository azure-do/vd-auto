# ADR-0008: 動画ジョブの状態正本は運用DBとし、Sheetsは人間向けミラーとする

## Status

accepted

## Date

2026-07-30

## Context

オーケストレーションにCloudflare Queueを用いる方針だが、Queueは at-least-once 配信であり、同一イベントが複数回到達し得る。ジョブ状態、排他、冪等記録、承認済みコンテンツ版、外部投稿IDを、条件付き更新やトランザクションのできない Google Sheets に正本として置くと、重複配信・多重処理で状態が壊れ、二重投稿の原因となる。

## Decision

- 動画ジョブの状態・排他・冪等台帳・監査ログの **正式記録（状態正本）は運用DB** とする。状態遷移は条件付き更新／トランザクションで排他する。
- **Google Sheets は人間向け台帳・ミラー**（表示・レポート）に限定し、固定列番号に依存せずヘッダ名参照とする。
- 失敗メッセージを破棄しないため **Dead Letter Queue（DLQ）を必須** とし、監視と手動再処理手順を持つ。
- **DB製品の具体選定（Cloudflare D1 / SQLite-backed Durable Objects / その他）は技術比較後に別ADRで決定** する（RFC: docs/rfcs/0001）。規模は約14件/日であり、最大スケールより運用単純性を重視する。

## Consequences

- 重複配信・多重承認に耐える状態管理が可能になる。
- DB製品選定までは本ADRの「方針」を確定とし、具体選定はRFC/比較ADRで確定する。
- Sheetsは参照・レポート用途に用途を限定し、書き込み起点にしない。

## References

- Cloudflare Queues delivery guarantees: https://developers.cloudflare.com/queues/reference/delivery-guarantees/
- Cloudflare Queues dead letter queues: https://developers.cloudflare.com/queues/configuration/dead-letter-queues/
