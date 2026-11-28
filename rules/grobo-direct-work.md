# グロボ直接作業ルール

グロボ（指示側AI）が担当PCで直接実行してよい作業は次の2種類だけ。

## 許可される作業

1. **claude -p 起動の1コマンド**（run-cc.ps1 経由を含む）
   - 既定モデルは `sonnet`。
   - `opus` を使用する場合は `-ModelReason` に10文字以上の理由を必須とする。
   - モデルポリシー違反は起動前に STATUS-LAUNCH.txt に記録され exit 2 で終了する。

2. **REPORT.md / DONE.txt / PROGRESS.md を読む1コマンド**
   - `Get-Content`（PowerShell）、`cat` / `type`（Unix/CMD）のみ許可。
   - 対象ファイル名の末尾が `REPORT.md` / `DONE.txt` / `PROGRESS.md` であること。

## 禁止される作業

- 複合コマンド（`;` `&&` `|` で複数コマンドを連結）全て違反。
- 進捗確認でログ・記録・履歴を直接読む行為（以下参照）。
- 上記2種以外のあらゆるコマンド実行。

## ログと検査

- `cc-launcher-audit.mjs --root <path>`: 既存 run-cc*.ps1 の opus 固定を検出する。
- `cc-model-usage-daily.mjs --file <jsonl> --date <date>`: モデル使用の日次集計。
- `grobo-direct-check.mjs --file <path> | --date <date>`: グロボ直接コマンドの違反検査。違反0で PASS。

## 再発事例

| 日付 | 事象 | 対策 |
|------|------|------|
| 2026-11-28 | 999 の claude -p が --model opus だった（理由なし） | cc-launcher-audit で opus 固定を検出、テンプレートで理由なし opus を拒否 |
| 2026-11-28 | 999 の FAX テストで複合機履歴・ログを直接読んだ | grobo-direct-check の違反検出でブロック |
| 2026-11-28 | 神原さん件で 000 の記録を直接読んだ | grobo-direct-check の違反検出対象 |