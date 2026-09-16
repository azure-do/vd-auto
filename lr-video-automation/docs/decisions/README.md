# ADR運用ルール

このディレクトリには正式決定した事項のみを、1決定=1 ADRとして追加する。
未決事項の台帳は `docs/open-questions.md` を参照（ここには未決事項一覧は置かない）。

## 番号付け

- `NNNN-短いタイトル.md` の形式（例: `0001-tiktok-account-scope.md`）
- 番号は連番、欠番なし

## ステータス

- `proposed`: 提案中
- `accepted`: 決定済み
- `superseded`: 後続のADRにより上書き

## 追加手順

1. `0000-adr-template.md` をコピーして新規ファイルを作成
2. Status を `proposed` または `accepted` に設定
3. `docs/open-questions.md` の該当項目の status とADRリンクを更新
