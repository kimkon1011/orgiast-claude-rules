You are implementing X-0057 AIニュース提案フロー as a Node.js script.

## Design Document
The design is at .steering/20261116-x0057-ai-news-pipeline/design.md

## Requirements

Create `seo/x0057-ai-news-pipeline.mjs` (executable, shebang `#!/usr/bin/env node`):

### Flow
1. Accept seed keywords (default list focused on exhibition booth business: 展示会, ブース 制作, 展示会 出展, イベント ブース 設営, 展示会 小間, Reブース etc.)
2. For each seed keyword, call `google-trends-api` `relatedQueries({keyword, geo:'JP'})` to get:
   - Top queries (rankedList[0])
   - Rising queries (rankedList[1]) ← this is the "注目" equivalent
3. Deduplicate all collected queries (merge top+rising, case-insensitive)
4. For each query, get `interestOverTime({keyword, geo:'JP', granularity:'DAY', startTime: 30 days ago})` to check recent trend
5. Feed all results to gemini-cli for classification with this prompt:
   ```
   あなたは展示会ブース制作会社のマーケティング担当者です。以下のキーワードを3つに分類してください。
   ✅ 新規記事向き: 検索需要があり、自社で書ける専門性があり、まだ記事にしていない
   🔄 既存記事追記向き: 既存記事に関連追記できる（タイトル変更不要）
   ❌ 対象外: 自社事業と無関係、または需要が低い

   各キーワードについて: カテゴリ / 理由（1行） / 想定記事タイトル（新規・追記のみ） をJSON配列で出力
   ```
6. Output to stdout AND optionally to a file

### Implementation Details
- Use `import googleTrendsApi from 'google-trends-api'` (it's already installed in the repo cwd)
- The google-trends-api functions return JSON strings, parse them
- Use `child_process` to call `gemini-cli` for classification: `node -e "..." | gemini prompt`
- Actually, for gemini-cli, use the MCP approach: call `gemini-cli` via execSync with a prompt file
- Handle errors gracefully (API rate limits, network errors)

### CLI Interface
```
node seo/x0057-ai-news-pipeline.mjs [options]
  --seed <kw>       Single seed keyword (default: use list)
  --output <path>   Output file path (default: stdout only)
  --mock            Skip LLM, use random classification
  --json            Only output JSON (no markdown formatting)
  --help            Show usage

Without --seed, uses the default keyword list.
```

### Output Format (default, plain mode)
```
# X-0057 AIニュース提案 🗓️ 2026-11-16

## 急上昇キーワード
| キーワード | 関連元 | トレンド値 | 前週比 |
|------------|--------|-----------|--------|

## 📋 分類結果
### ✅ 新規記事向き
...

### 🔄 既存記事への追記向き
...

### ❌ 対象外
...

---
Pipeline: Google Trends → Gemini CLI classification
```

### Error Handling
- If google-trends-api returns HTML (blocked), log the error and skip that keyword
- If gemini-cli is unavailable or returns error, fall back to --mock mode
- Always collect partial results even if some APIs fail

## Seed Keywords File (also create)
Create `seo/data/x0057-seed-keywords.json`:
```json
[
  "展示会",
  "ブース 制作",
  "展示会 出展",
  "イベント ブース",
  "展示会 小間",
  "ブース デザイン",
  "展示会 施工",
  "リブース",
  "展示会 レンタル",
  "ブース 設営",
  "ノベルティ 制作",
  "展示会 備品"
]
```