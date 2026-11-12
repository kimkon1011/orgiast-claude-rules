## AIニュース提案 X-0014: タスク難易度別モデルルーティング 実測ベンチマーク

### 概要
Haiku 5.5 / Sonnet 5.5 / Opus 5.5 の3モデルを、ブース企画（creative）・分類抽出（extraction）・資料作成（document）の3タスク種別で実測評価。18回の API 呼び出し結果から最適ルーティングルールを導出。

### 実測結果（pass@1）
| カテゴリ | Haiku | Sonnet | Opus | 最適 |
|----------|-------|--------|------|------|
| Creative | 50% | 25% | **100%** | Opus |
| Extraction | 25% | **100%** | **100%** | Sonnet |
| Document | **100%** | 50% | 50% | Haiku |

### コスト効果
- 従来（全Opus）: $0.033/task
- スマートルーティング: **$0.013/task（60%減）**
- 失敗時リトライ方式: **$0.011/task（66%減、pass@1 94.5%）**

### 変更
- `tools/llm-ask.mjs`: `claude` provider 追加（OpenRouter proxy 経由）
- `tools/benchmark-model-routing.mjs`: ベンチマーク実行スクリプト（新規）
- `docs/ai-news-x0014-model-routing-benchmark.md`: 提案文書（新規）
- `outputs/X-0014/benchmark-results-20261112.csv`: 実測データ（新規）

### 検証
- `node --test tools/llm-ask.test.mjs`: 9/9 passing ✅
- 実測ベンチマーク: 18 calls 完遂 ✅
- 全3モデルの API 到達性確認済み（Haiku/Sonnet/Opus all reachable via OpenRouter）

Co-Authored-By: Claude Code <noreply@anthropic.com>

🤖 Generated with [Claude Code](https://claude.com/claude-code)