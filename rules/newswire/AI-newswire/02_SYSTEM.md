# システムアーキテクチャ

## ファイル構成

```
tools/
  ai-newswire.mjs          # メインCLI（エントリポイント）
  llm-ask.mjs              # LLM呼び出し（既存）
  provider-routing.mjs      # プロバイダルーティング（既存）
```

## 処理フロー

1. **入力受付**: `--keyword` でキーワードを受け取る
2. **プロンプト構築**: 04_PROMPT.md のプロンプトを組み立てる
3. **LLM呼び出し**: `llm-ask.mjs --provider gemini --category newswire` でLLMを呼ぶ
4. **結果パース**: JSON応答をパース
5. **出力整形**: MarkdownまたはJSONで出力

## 既存依存

- `tools/llm-ask.mjs` — LLM呼び出し統合CLI
- `tools/provider-routing.mjs` — プロバイダルーティング（Gemini Flash優先）