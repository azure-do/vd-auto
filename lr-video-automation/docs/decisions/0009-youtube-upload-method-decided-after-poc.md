# ADR-0009: YouTube投稿の実行方式は技術実証後に決定し、現時点で決め打ちしない

## Status

accepted（E-0a実証完了。方式は[ADR-0013](0013-youtube-upload-external-resumable.md)（proposed・B方式採用）で具体化。ADR-0013 accepted時に本ADRを superseded とする）

## Date

2026-07-30

## Context

現行はGASと外部`VideoUploaderLib`でYouTube投稿を実現し高い実績を持つ（成功率約99.5%）。しかし新システムでR2に置いた元動画をYouTubeへ投稿する経路は未検証である。Apps ScriptでR2から動画をURL Fetchする方式には応答サイズ1回50MBの制限があり、Advanced Serviceの媒体アップロードはBlobを受け取るため、一般的な動画サイズを安全に扱えるか実測が必要である。YouTubeは大容量向けに再開可能（resumable）アップロードを提供する。また、新規の未監査APIプロジェクトからアップロードした動画は非公開に制限され、公開には監査が必要。支部別OAuth（8支部＋総合）の保管・更新・失効も論点である。

## Decision

- YouTube投稿の実行方式を **現時点で決め打ちしない**（GAS+Drive経由 と 外部コンピュートによるR2→YouTube再開可能アップロードのいずれにも固定しない）。
- 次を **技術実証（E-0a）** で確認してから、全体バランスを見て別ADRで確定する。
  - GAS+Drive経由を維持できるか（R2からの取得方法、Blob化、動画サイズ制約）
  - 外部コンピュートがR2からYouTubeへ再開可能アップロードできるか
  - 支部別OAuthを8支部＋総合でどう保管・更新・失効するか
- 外部接続を伴う実証は **亮さんの明示承認後** に行う。
- 新規の未監査APIプロジェクトでは **非公開に限定** し、公開自動化は監査通過後（暫定方式の終了条件）。
- ADR-0001に従い、現行外部ライブラリの関数（`processFormSubmit` / `processAllExistingRows` / `uploadVideoByBranch`）の再現は目的にしない。並行移行に便益がある一時アダプタの入口に限定する。

## Consequences

- 方式決定を実測に基づけるため、行き止まり実装を避けられる。
- 実証完了までYouTube投稿の詳細設計は保留され、MVPは非公開・少数支部パイロットで先行する。
- 方式確定時に別ADRを追加する。

## References

- Apps Script quotas: https://developers.google.com/apps-script/guides/services/quotas
- YouTube resumable uploads: https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
- YouTube videos.insert restrictions: https://developers.google.com/youtube/v3/docs/videos/insert
