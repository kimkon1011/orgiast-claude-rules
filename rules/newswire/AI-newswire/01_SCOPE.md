# スコープ

## MVP（今回の実装対象）

- CLIツール: `node tools/ai-newswire.mjs --keyword "キーワード"`
- LLM（Gemini/cheap-model）で以下の5つを生成
  1. 関連サジェストキーワード（5-10件）
  2. 再検索ワード（3-5件）
  3. 読者ペルソナ（2-3人）
  4. 記事構成案（1-3案）
  5. 記事品質チェックリスト
- JSON出力（`--json`）とMarkdownテキスト出力（`--format md` デフォルト）
- 既存 `tools/llm-ask.mjs` を呼び出し（provider: gemini 優先, fallback groq）
- `tools/provider-routing.mjs` に従う

## 今回やらないこと

- Web UI（React画面等）
- バッチ処理・定期実行
- 生成結果の永続化・DB保存
- 記事本文の自動生成
- 複数キーワードの一括処理
- 出力のカスタマイズ（トーン変更等）