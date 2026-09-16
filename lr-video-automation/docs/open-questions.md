# open-questions.md

## 運用ルール

- 未決事項は一括決着しない。
- 各フェーズ開始前に、そのフェーズに関係する項目のみ決定する。
- 無関係な項目は `proposed` のままとする。
- 正式決定は `docs/decisions/` に1決定=1 ADRとして追加し、該当項目の status を更新する。

## 一覧（Q1〜Q13）

| No | 質問 | 関連フェーズ | status | 決定・確認根拠 |
|----|------|------|--------|------|
| Q1 | TikTokはどの支部用か、全支部共通か | Phase 6 | proposed | |
| Q2 | TikTokの管理者は本部か支部担当者か | Phase 6 | proposed | |
| Q3 | Instagramは本当に8支部分のアカウントがあるか | Phase 5 | confirmed | F-08で8支部＋総合の実在を確認（事実確認のためADR不要） |
| Q4 | Instagram各アカウントがプロアカウントか | Phase 5 | proposed | E-0bの技術実証で確認 |
| Q5 | LINE承認者は本部1名か複数名か | Phase 4 | accepted | [ADR-0010](decisions/0010-line-approval-authorization-model.md)（亮さん＋指定した本部担当者。登録済みuser IDのみ承認可） |
| Q6 | 講師本人確認はGoogleメールアドレスでよいか | Phase 1 | accepted | [ADR-0006](decisions/0006-identity-google-oidc-sub.md)（Google OIDC＋sub紐付け。メールは初回照合のみ） |
| Q7 | 同日に複数クラスがある場合の選択方法 | Phase 1 | proposed | 枠組みは[ADR-0007](decisions/0007-class-unresolved-isolation-and-alerting.md)（1件自動/複数のみ選択）。選択UIは未決 |
| Q8 | SNS加工版に表示する要素 | Phase 3 | proposed | |
| Q9 | 元動画と加工動画の保存期間 | Phase 1/3 | accepted | [ADR-0011](decisions/0011-media-retention-and-deletion-policy.md)（投稿完了後30日ほか・暫定） |
| Q10 | 東京スタジオの「萩窪」が正式表記か | Phase 2 | proposed | |
| Q11 | 「愛知」を「名古屋」へ統一してよいか | Phase 2 | proposed | |
| Q12 | YouTubeの公開設定と投稿時刻 | Phase 2 | proposed | 投稿方式=B確定（[ADR-0013](decisions/0013-youtube-upload-external-resumable.md)、ADR-0009を置換予定）。完了=processed/succeeded/private。**private無条件強制**。公開は「監査通過＋Q12決定＋亮さん承認」の別実装単位（監査フラグ単独では公開しない）。公開設定・時刻はPhase 2で決定 |
| Q13 | TikTokの初期方式を手動投稿にするか受信箱転送にするか | Phase 6 | proposed | |

## 新規決定（未決事項に無かったが確定した設計判断）

open-questions に元々無かったが、亮さんの判断で確定した事項。ADRとして記録済み。

| 決定 | 内容 | ADR |
|----|------|------|
| D2 | クラス未確定・マスタ障害時はCLASS_UNRESOLVEDで隔離・投稿不可、本部運用グループLINEへ通知 | [ADR-0007](decisions/0007-class-unresolved-isolation-and-alerting.md) |
| D3 | 動画ジョブの状態正本はCloudflare D1、Sheetsは人間向けミラー、DLQ必須 | [ADR-0008](decisions/0008-operational-db-is-state-of-record.md) / [ADR-0015](decisions/0015-operational-db-cloudflare-d1.md) |
| D4 | YouTube投稿方式は技術実証後に決定（決め打ちしない）→ E-0a完了。B方式で[ADR-0013](decisions/0013-youtube-upload-external-resumable.md)（proposed）。accepted時に[ADR-0009](decisions/0009-youtube-upload-method-decided-after-poc.md)をsuperseded | [ADR-0009](decisions/0009-youtube-upload-method-decided-after-poc.md) / [ADR-0013](decisions/0013-youtube-upload-external-resumable.md) |
| D7 | 退職時の認証情報失効は新システム稼働と独立に実施 | [ADR-0012](decisions/0012-offboarding-credential-revocation.md) |
| D8 | 成果物と作業環境は最初から自社所有アカウント（共有ドライブ）配下に置き、後からの所有権移管を前提にしない | [ADR-0014](decisions/0014-assets-under-company-owned-accounts.md) |
