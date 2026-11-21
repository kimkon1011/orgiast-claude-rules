# X-0096: microsoft/markitdown 導入

展示会制作・イベント業務のファイル変換を統一するため、Microsoft MarkItDown（Python製ファイル→Markdown変換ライブラリ）を導入する。

## 内容
- MarkItDown の技術調査（`research/ai-news-x0096-markitdown-file-conversion.md`）
- 展示会見積・配布資料・報告書の Markdown 統一パイプライン設計
- サンプルプラグイン案（`booth-quote-to-md`）

## ファイル構成
- `research/ai-news-x0096-markitdown-file-conversion.md` — 技術調査・カスタマイズ計画
- `outputs/X-0096/README.md` — 導入評価

## 検証
- Python 3.15 環境でのインストール確認
- CLI / Python API の基本動作確認（ドキュメントベース）
- 改造不要の既存コードのみ（新規ファイル追加のみ）

🤖 Generated with [Claude Code](https://claude.com/claude-code)