# ADR-0013: YouTube投稿は外部実行環境＋resumable upload（B方式）とする

## Status

proposed（B方式の採用そのものは亮さんの正式決定。ChatGPT監査差戻しに対しv2で対応。実測値・インシデント原文の転記が完了し監査指摘を満たした時点で accepted 化を諮る）

## Supersedes

ADR-0009（YouTube投稿方式は技術実証後に決定）。本ADRが accepted になった時点で ADR-0009 を `superseded` とする（それまで ADR-0009 は accepted のまま）。

## Date

2026-07-30（v2改訂: 2026-08-01）

## Context

- E-0a技術実証（ChatGPT受入）で、R2の元動画をYouTubeへ投稿する3経路を比較した。A1: R2→GAS(URL Fetch)→Blob→YT / A2: R2→Drive→GAS→YT / B: R2→外部実行環境→YT resumable。
- 実測比較・不採用理由・一時R2トークンの発行/失効・セキュリティインシデントは、秘密除去した正式レポート `docs/reports/E-0a-youtube-upload-poc.md` を一次証跡とする。
- **原文未入手項目**（比較表の実測数値、インシデントの事象・原因）は当該レポートで `【原文転記待ち／未入手】` とし、本ADRでも**推測しない**。数値確定は原本転記が前提。
- 規模は約14件/日（最大スケールより運用単純性を優先）。

## Decision

1. **方式=B を採用**（外部実行環境がR2から取得し、YouTube resumable upload で送信）。証跡は E-0a 正式レポート。
   - **A1不採用**: Apps Script URL Fetch 応答上限（約50MB/回）・実行時間/メモリ制約で中〜大サイズを安全に扱えない。
   - **A2不採用**: Driveステージングの往復・二重保管・容量/権限・掃除運用のコスト増。GAS制約も残る。
2. **外部実行環境の製品は本ADRで確定しない**。候補比較（数値ベース）と（必要時）最小実証は RFC-0002 で扱い、**根拠が揃った時点で別ADRで確定**する。本ADRは製品を推奨しない。
3. **結果不明状態の設計**（共通契約 3.1〜3.3 に準拠）:
   - resumable session を用い、中断時は YouTube が返した確定位置（committed offset）から再送。全量再送しない。
   - 最終結果を確認できない場合は `OUTCOME_UNKNOWN → RECONCILIATION_REQUIRED`。**再セッション禁止条件**（committed offset>0／video_id判明／照合未了）に該当する間は新規セッションを開かず、既存session再開または `videos.list` 照合で二重投稿を防ぐ。
   - `yt_resumable_session_uri` は**保存時暗号化**し非表示・非記録。`yt_committed_offset`・`yt_video_id` を追跡。
4. **冪等・状態管理**（ADR-0008・共通契約準拠）:
   - 冪等キー = `video_job_id + 投稿先(YouTube+チャンネル) + approved_content_version`（`attempt_no` は別管理）。
   - 状態正本は運用DB。`publish.started/succeeded/failed/outcome_unknown/reconciliation_required` を記録、遷移は条件付き更新で排他。DLQ再処理も冪等フェンス＋再セッション禁止条件を通す。
5. **完了・失敗判定**:
   - **完了** = `uploadStatus=processed` かつ `processingStatus=succeeded` かつ `privacyStatus=private`。この3条件成立時のみ `PUBLISHED`。
   - 処理中=`processingStatus=processing` は保留・ポーリング。失敗=`uploadStatus=failed` または `processingStatus=failed/terminated`。拒否=`uploadStatus=rejected`（端末的・自動再投稿しない）。期限切れ/確認不能=`OUTCOME_UNKNOWN`。
6. **private の無条件強制**:
   - E-5 の全投稿は `privacyStatus=private` を**無条件強制**し、`public`/`unlisted`/`publishAt`（予約公開）を**実装で拒否**する。
   - **監査完了フラグだけでは公開可能にしない**。公開対応は「YouTube API監査通過 ＋ Q12（公開設定・投稿時刻）決定 ＋ 亮さん承認」の3条件が揃った後の**別実装単位**とし、本ADRの範囲外とする。
7. **OAuth（8支部＋総合）**: OAuthクライアント/トークンは会社所有。承認済み秘密保管場所に用途別分離で保管（ADR-0012）。更新はリフレッシュ、失効は退職/交代時に offboarding runbook と連動。session URI・access token・client secret・R2資格情報は秘密として非表示・非記録。
8. **一時R2トークンの後片付け**: 実証で用いた一時R2資格情報は**失効済み**（再利用しない）。トークン失効は**環境保持判断（テストGCP/チャンネルの保持・削除）とは分離**した後片付けであり、独立に実施する。詳細（日時・キー名）はレポート原文転記待ち。
9. **セキュリティインシデントと再発防止**: 事象・原因・恒久対策は原文転記待ち（`【未入手】`）。転記後、恒久対策を本 Consequences・runbook・E-5受入条件へ反映する。**推測で記載しない**。
10. **テスト環境の保持／削除**: テスト動画・R2オブジェクトは削除、token/鍵は失効（後片付け）。テストGCPプロジェクト・テストチャンネル自体の削除は**破壊的操作**につき別承認。監査申請・製品最小実証（RFC-0002）に使う場合はそれまで保持、不要確定後に削除。

## Consequences

- 本ADRが accepted になれば ADR-0009 を supersede。E-5 を B方式前提で実装単位化できる（`docs/design/implementation-units.md` E-5.1〜5.8）。
- 外部実行環境という運用基盤が1つ増える。14件/日規模での費用・運用負荷・障害復旧は RFC-0002 の数値比較で評価（根拠が揃うまで製品未確定）。
- 製品未決のため、E-5 の実投稿単位は製品確定を依存に持つ。
- **公開は本ADRの範囲外**。監査完了フラグ単独では公開しない（private無条件強制）。
- 未入手の実測値・インシデント詳細が確定するまで、本ADRは proposed のまま（accepted 化しない）。

## References

- YouTube resumable upload: https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
- YouTube videos.insert restrictions（未監査は非公開）: https://developers.google.com/youtube/v3/docs/videos/insert
- 一次証跡: `docs/reports/E-0a-youtube-upload-poc.md`（秘密除去版）
- 共通契約（結果不明状態・完了判定・再セッション禁止）: `docs/contracts/common-ids-events-states.v1.md`
