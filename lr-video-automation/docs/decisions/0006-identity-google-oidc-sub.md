# ADR-0006: 講師本人確認はGoogle OIDCとし、teacher_id ↔ sub を正式紐付けとする

## Status

accepted

## Date

2026-07-30

## Context

現行はGoogleフォームで取得するメールアドレスを本人確認の土台としている（F-09）。しかしメールアドレスは変更可能で不変の識別子ではなく、これを本人IDとして固定すると、メール変更・誤紐付け・なりすましのリスクが残る。ADR-0002により、講師本人とクラスマスタの照合は自動判定の起点であり、確実な本人確認が前提となる。

関連未決: open-questions Q6（講師本人確認はGoogleメールでよいか）。

## Decision

- 講師の本人確認は **Google OIDC** で行う。
- **初回のみ**、検証済みメール（`email_verified=true`）とクラスマスタ タブ①のメールアドレス列を照合する。
- 以後は **`teacher_id ↔ Google sub`** を正式な本人紐付けとして登録し、`sub` で識別する。メールアドレスは不変IDに用いない。
- 毎回、IDトークンの **署名・`aud`・`iss`・`exp`・`email_verified`** をバックエンドで検証する。
- メール変更・講師退職・誤紐付けの **解除・再登録手順** を用意する。
- 講師メールアドレス等のPIIを公開ポータル・イベント・ログへ流さない。

## Consequences

- 本人確認が不変IDに基づき、なりすまし・誤判定の耐性が上がる。
- Google OIDCのクライアント設定・トークン検証・紐付け台帳の運用が必要となる（秘密値はコード・文書・ログに書かない）。
- `teacher_id` はメールと分離した内部IDとして扱う（共通契約: docs/contracts）。
- open-questions Q6 を本ADRで解決とする。

## References

- Google OpenID Connect: https://developers.google.com/identity/openid-connect/reference
