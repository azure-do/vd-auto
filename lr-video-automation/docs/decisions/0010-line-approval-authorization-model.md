# ADR-0010: 本部LINE承認は登録済みuser IDのみに許可し、実行者・日時を記録する

## Status

accepted

## Date

2026-07-30

## Context

投稿前の本部確認はLINEで行う（baseline §9）。LINE Messaging APIは1チャネルにつきWebhook URLが1つであり、既存`lr-line-relay`と同一チャネルを使う場合、別Workerを直接Webhook受信口にはできない。また、グループLINEに参加しているだけの利用者に承認権限を与えると、意図しない承認・公開が起こり得る。

関連未決: open-questions Q5（LINE承認者は本部1名か複数名か）。

## Decision

- 承認要求・障害通知は **本部担当者が参加するグループLINE** へ送る。
- **承認操作は事前登録した LINE user ID の allowlist のみに許可** する。**グループ参加のみでは承認権限を与えない**（通知の閲覧のみ）。
- 承認・差戻の **実行者ID・日時を監査ログに記録** する。
- 承認時に **承認済みコンテンツ版を固定** し、多重押下・postback再送でも二重投稿しない（冪等キー要素、docs/contracts）。
- Webhook入口は **既存`lr-line-relay`を単一入口として利用できるかをE-0で確認** し、可なら承認イベントを別Queue/Consumerへ振り分け、不可なら専用チャネルを新設する。
- 承認者の追加・退職失効は運用手順（docs/runbooks）に含める。

## Consequences

- 承認権限が登録IDに限定され、誤承認・不正公開の耐性が上がる。
- 承認者allowlistの管理・失効運用が必要となる。
- Q5は「亮さん＋指定した本部担当者」の複数承認者として解決する。実際の氏名・人数はallowlistの運用設定として管理する。

## References

- LINE Messaging API webhook configuration: https://developers.line.biz/en/docs/messaging-api/building-bot/
