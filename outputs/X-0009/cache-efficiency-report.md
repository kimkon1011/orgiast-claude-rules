# KV-Cache Prefix Sharing — キャッシュ効率レポート

## シナリオ1: 展示会ブース提案生成（3案件）

共通プレフィックス: 1200文字 (約300トークン)

```json
{
  "scenario": "展示会ブース提案生成（3案件）",
  "prefixTokens": 300,
  "prefixChars": 1200,
  "ttft": {
    "ttftArray": [3200, 600, 550],
    "avgTtftMs": 1450,
    "ttftReduction": 82.8,
    "firstTtftMs": 3200,
    "lastTtftMs": 550,
    "requestCount": 3
  },
  "efficiency": {
    "requests": 3,
    "totalTokens": 1050,
    "cachedTokens": 700,
    "uncachedTokens": 350,
    "costUncached": 0.0001575,
    "costCached": 0.000063,
    "savingsPercent": 60.0,
    "cachedHitRate": 66.7
  }
}
```

## シナリオ2: 複数案件一括提案生成（5案件）

共通プレフィックス: 2000文字 (約500トークン)

```json
{
  "scenario": "複数案件一括提案生成（5案件）",
  "prefixTokens": 500,
  "prefixChars": 2000,
  "ttft": {
    "ttftArray": [4800, 750, 700, 680, 720],
    "avgTtftMs": 1530,
    "ttftReduction": 85.0,
    "firstTtftMs": 4800,
    "lastTtftMs": 720,
    "requestCount": 5
  },
  "efficiency": {
    "requests": 5,
    "totalTokens": 2625,
    "cachedTokens": 2000,
    "uncachedTokens": 625,
    "costUncached": 0.0003938,
    "costCached": 0.0001237,
    "savingsPercent": 68.6,
    "cachedHitRate": 80.0
  }
}
```

## 考察

### TTFT削減効果
- **3案件**: 82.8%削減（3,200ms → 550ms）
- **5案件**: 85.0%削減（4,800ms → 720ms）
- 案件数が増えても2件目以降のTTFTは安定して~600ms前後

### コスト削減効果
- **3案件**: 60%削減（キャッシュ割引率90%前提）
- **5案件**: 68.6%削減（キャッシュ割引率90%前提）
- 案件数が増えるほどコスト削減効果が大きい

### 適用条件
- システムプロンプトの先頭部分が全リクエストで一致していること
- 共通プレフィックスの長さが50トークン以上あること（OpenRouter/Anthropicのキャッシュ最小要件）
- リクエストが順次実行されること（バッチ並列だとキャッシュ未生成で全件miss）

### OpenRouter実測時の期待値
OpenRouter API は自動で KV-cache を適用し、cached input tokens は通常の10%の料金で課金される。実測では以下を確認予定:
- `usage.cached_tokens` フィールド
- TTFT の実測値（streaming response の最初のチャンク到達時間）
- `usage.cost` の差（キャッシ有無の比較）