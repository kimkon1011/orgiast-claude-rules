# X-0057 AIニュース提案 設計書

## 概要
Google Trends から自社事業に関連する急上昇キーワードを定期的に取得し、LLM（gemini-cli）で記事ネタとして分類して提案ファイルを生成する。

## フロー
1. シードキーワード（自社事業KW）を Google Trends API に投げる
2. `relatedQueries` の「急上昇」（Rising）キーワードを取得 → これが "注目" に相当
3. 各キーワードの `interestOverTime` でトレンド方向を確認
4. 全結果を LLM に渡し、以下に分類させる：
   - ✅ **新規記事向き**（検索ボリュームあり・競合少・自社の強みと一致）
   - 🔄 **既存記事への追記向き**（関連度高・リライトで対応可能）
   - ❌ **対象外**（無関係・自社事業とマッチしない）
5. 分類結果を提案ファイルとして出力

## ファイル構成
- `seo/x0057-ai-news-pipeline.mjs` — メインパイプライン
- `seo/data/x0057-seed-keywords.json` — シードキーワード定義
- `outputs/X-0057/` — 出力先（日付ごとの提案）

## API
- `google-trends-api` (npm) — `relatedQueries`, `interestOverTime`
- LLM分類: `gemini-cli` の MCP または `node -e ...` 経由の呼び出し

## CLI
```
node seo/x0057-ai-news-pipeline.mjs [options]
  --mode full|research|classify   (default: full)
  --seed <keyword>                1つのシードKW（省略時はデフォルトリスト）
  --output <path>                 出力先ファイル
  --mock                          LLM呼び出しなし（分類ランダム）
  --dry-run                       分析のみ表示、ファイル出力なし
```