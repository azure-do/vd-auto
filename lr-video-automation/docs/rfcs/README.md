# rfcs — 技術提案・方式比較・横展開候補

ADR-0004（GitHubをコードと横断知識の共有基盤とする）に基づき、**確定前**の技術提案・方式比較・横展開候補を記録する。

## ADRとの違い

- **ADR** = 確定した決定（1決定=1 ADR、`docs/decisions/`）。
- **RFC** = 確定前の検討。方式比較・適用先・導入条件・採用/保留/却下理由を残す。技術実証（E-0）の結果で結論づけ、確定分をADR化する。

## 命名

- `NNNN-短いタイトル.md`（連番）
- Status: `open`（検討中） / `resolved`（ADR化済み） / `rejected`

## 一覧

- `0001-operational-db-selection.md` — 運用DB製品の選定（ADR-0008の具体化）
- `0002-youtube-upload-execution.md` — YouTube投稿の実行方式。方式=B確定（ADR-0013）／製品未決（open）
- `0003-video-processing-platform.md` — SNS用動画加工の実行基盤（D-PROC）
