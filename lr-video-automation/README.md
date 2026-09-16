# lr-video-automation

## プロジェクト名と目的

講師がWebアプリから動画を1回提出すると、**YouTubeへは元動画をそのまま投稿し、InstagramへはAIを含む加工処理をした動画を投稿する**自動化システムを構築する。TikTokはこの主経路の完成後に追加する。

このプロジェクトは現行GASを完全再現するためのものではない。現行の実績・業務ルール・有用な技術知見を参考にしながら、動画検証、自動編集、本部承認、媒体別投稿・再試行までを自社管理する、現行より安全で拡張可能な動画運用基盤を構築する。

## 役割

| 役割 | 担当 |
|---|---|
| オーナー / 最終決定 | 亮さん |
| PMO / 進行・一次レビュー | Codex |
| SE | 外部委託者（GitHub: `sheet-maker`）。実装方式・技術選定・作業分割を担当 |
| 監査 | PMO・SEとは別のAI |

日常の進め方は `docs/runbooks/external-contributor-delivery.md` を正とする。亮さんは業務判断、課金、本番・公開、権限拡大の停止点だけを判断し、パッケージ内の技術作業とレビューはPMO・SEが進める。

### 委託の前提

- **固定するもの**: 製品ゴール、講師UX、クラスマスタ正本、状態・冪等・承認・private等の安全条件、受入条件
- **先方へ委任するもの**: DB製品、ライブラリ、内部構造、テーブル・index、テスト方法、PR分割、実装順などのエンジニアリング判断
- 委任範囲内の技術判断は、理由をPRまたはADRへ記録すれば亮さんの個別承認を待たずに進める

## 製品・設計原則

- 自社のクラスマスタを、講師・クラス・支部・スタジオ判定の正式な情報源とする。動画投稿側に重複マスタを作らない。
- 通常時の講師操作は「動画を選択して提出する」だけを目標とする。
- 現行システムとの互換性は製品目標ではない。必要な場合だけ、段階移行のための一時アダプタとして扱う。
- SEO自動化、講師ポータル、LINE・DM関連等の他プロジェクトとはRepositoryを統合せず、共通ID・スキーマ・イベント・技術知見を共有する。
- Gitを正式情報源とし、将来のGitHubではコードに加えてADR、RFC、共通契約、横展開候補、新しい技術アイデアも管理する。
- このプロジェクトにおけるPMO・SE・監査の役割、委任範囲、停止点は本READMEと `docs/runbooks/external-contributor-delivery.md` を正本とする。外部委託者は別の非公開リポジトリを参照しなくてよい。

正式決定の詳細:

- `docs/decisions/0001-legacy-is-reference-not-target.md`
- `docs/decisions/0002-class-master-is-source-of-truth.md`
- `docs/decisions/0003-cross-project-contracts-and-reuse.md`
- `docs/decisions/0004-github-as-knowledge-platform.md`
- `docs/decisions/0005-technical-pmo-authority.md`
- `docs/decisions/0006-identity-google-oidc-sub.md`（本人確認＝Google OIDC＋sub）
- `docs/decisions/0007-class-unresolved-isolation-and-alerting.md`（マスタ障害時は隔離・通知）
- `docs/decisions/0008-operational-db-is-state-of-record.md`（状態正本＝運用DB）
- `docs/decisions/0009-youtube-upload-method-decided-after-poc.md`（YouTube方式は実証後）
- `docs/decisions/0010-line-approval-authorization-model.md`（LINE承認権限）
- `docs/decisions/0011-media-retention-and-deletion-policy.md`（保存・削除）
- `docs/decisions/0012-offboarding-credential-revocation.md`（退職失効）
- `docs/decisions/0013-youtube-upload-external-resumable.md`（YouTube=B方式・外部resumable・private無条件・製品未決・公開は別単位。proposed／ADR-0009置換予定）
- `docs/decisions/0015-operational-db-cloudflare-d1.md`（運用DB＝Cloudflare D1）

設計の全体像は `docs/design/architecture-overview.md`、共通契約は `docs/contracts/`、確定前の技術選定は `docs/rfcs/`、実証成果物は `docs/reports/`（例: `E-0a-youtube-upload-poc.md`）を参照。

## 管理対象 / 非対象

- **管理する**: 新・動画受付Worker、自社版GAS、共通スキーマ、調査資料、テスト
- **管理しない**: `lr-portal`・`lr-line-relay`（各既存リポジトリに残す。コピー/移動/統合はしない。ポータルの変更は既存リポジトリへのPRで実施する）

## ディレクトリ構成

```
docs/
  baseline/        既存（原本・変更禁止）
  decisions/       ADR（正式決定事項）
  contracts/       共通ID・イベント・状態スキーマ（バージョン管理）
  rfcs/            確定前の技術提案・方式比較・横展開候補
  design/          承認済みアーキ概要・MVPスコープ・実装単位
  reports/         実証成果物（秘密除去。例: E-0a-youtube-upload-poc.md）
  runbooks/        運用手順（外部委託の入口・継続開発・出口を含む。秘密値は含めない）
  findings.md      baseline後の新事実・差分の記録
  phase0-inventory.md
  open-questions.md
worker/            E-1共通基盤（D1・Queue/DLQ・冪等・監査・Sheetsミラー境界）
docs/reports/E-1-local-demo.md  本番非接続のダミー実演手順
gas/               将来追加予定（Phase 0時点では未作成）
```

## フェーズ状況

Phase 0（完了） → E-0（技術実証） → MVP-Core → MVP-Publish → 段階展開

現在は **Phase 0完了・E-0a実証完了・設計承認済み・E-1共通基盤完了**。Issue #7でE-2.1の本人確認・クラス判定をlocal/fakeに限定して実装中。外部接続は、開発環境・副作用・課金上限・停止方法をまとめて承認してから行う。

## セキュリティ方針

- 秘密情報（トークン/キー/シークレット/実メールアドレス/.envの値）はコード・文書・コミット・ログに一切書かない。
- 記載可能なのは「キー名」「設定済みかどうか」「保存場所」のみ。

## baseline 概要

- 現行実績: 約2,582件、成功率約99.5%
- 新システムの主目的: 外部ライブラリ依存・列番号依存・入力検証不足の解消、確実な投稿の実現
- 詳細は `docs/baseline/` を参照

**`docs/baseline/` は原本・変更禁止（読み取り専用）。**
