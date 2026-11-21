# X-0096: microsoft/markitdown — 展示会ファイル変換パイプライン

## 目的
Microsoft MarkItDown の導入評価と、展示会制作・イベントワークフローにおけるファイル変換統一の提案。

## 成果物
- `research/ai-news-x0096-markitdown-file-conversion.md` — 技術調査とカスタマイズ計画
- サンプルプラグイン案 (`booth-quote-to-md`): 複数ベンダー見積書の統一Markdown変換

## 検証結果
- Python 3.15 環境確認 OK
- インストール: `pip install markitdown` で導入可能（Windows Python 3.15 で動作確認）
- CLI: `markitdown input.pdf > output.md` で即時変換
- サンプルデータを用いた変換テストは次回セッションで実施

## 未実施
- [ ] 実際の PDF/Excel を使った変換品質テスト
- [ ] プラグイン実装とユニットテスト
- [ ] 展示会見積書をサンプルにした E2E パイプライン
- [ ] Grok Bot 用プロンプト変換ルールの文書化（X-0048 との連携）