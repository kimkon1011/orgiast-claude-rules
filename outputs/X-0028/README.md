# X-0028: 手順画像自動生成 — 出力ディレクトリ

このディレクトリには `tools/procedure-image-generator.mjs` が生成するファイルを出力します。

## 出力ファイル

| ファイル | 説明 |
|---------|------|
| `<案件名>-<日時>/procedure.html` | 手順書HTML（全ステップ＋画像埋め込み） |
| `<案件名>-<日時>/procedure.css` | 手順書スタイル定義 |
| `<案件名>-<日時>/step-01.png` | 各ステップのスクリーンショット＋枠線＋番号（Codex生成） |
| `<案件名>-<日時>/step-01.svg` | プレースホルダ画像（Codex未実行時） |

## 生成コマンド

```bash
node tools/procedure-image-generator.mjs --steps procedure-def.json --output outputs/X-0028/<案件名>-<日時>
```