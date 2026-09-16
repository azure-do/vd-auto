# RFC-0003: SNS用動画加工の実行基盤（D-PROC）

- Status: open
- 関連: baseline §8（初期加工方針）、docs/design/mvp-scope.md（MVPは加工なし）
- 決定時期: Phase 3（SNS加工）着手判断時

## 背景

初期のSNS加工は「失敗しにくい加工」に限定（9:16 / 1080×1920 / 30秒確認 / 回転補正 / 縦化 / 支部・講師・クラス名の焼込 / 会話時のみ字幕 / ウォーターマーク除去）。縦・30秒以内の元動画は振付を勝手に切らない。Cloudflare単体はffmpeg重処理が不得手。

## 候補

| 基盤 | 長所 | 短所 | 位置づけ |
|---|---|---|---|
| A. 加工なし（YouTube先行） | 最速で確実投稿 | IG/TikTok後回し | **MVP** |
| B. Cloudflare Stream | CF内完結 | 焼込・字幕の自由度・API制約 | 評価 |
| C. 外部ffmpeg（コンテナ/Cloud Run等） | 全機能・焼込自由 | 別基盤の運用・認証・コスト | Phase 3本命候補 |

## 結論

未定（open）。MVPは A（加工なし・YouTubeは元動画）。IG/TikTok展開をGo判断した時点で C を本命に評価し、ADR化する。高度編集（ハイライト・自動カット・人物追尾・複数案）はさらに後続（U-4/AI編集）。
