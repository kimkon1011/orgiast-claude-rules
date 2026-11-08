# X-0010: プレフィックスキャッシュと自作モデルルーター

## 概要
prefix cachingの効果測定と、コスト・レイテンシ・品質による独自モデルルーターを構築する。既存のprovider-routing.mjs/cost-routing-gate.mjs/routing-table.mjs を拡張する形で実装。

## 成果物

### 1. tools/prefix-cache-bench.mjs — Prefix Caching ベンチマーク

Anthropic/OpenAI API の prefix caching 効果をワークロード種別ごとに測定するツール。

**機能要件:**
- 3種類のワークロードをテスト:
  - `repeated_system`: 同一システムプロンプト + 異なるユーザー入力（高キャッシュヒット想定）
  - `similar_context`: 部分的に共通する長いコンテキスト（中キャッシュヒット想定）
  - `unique`: 毎回異なるコンテキスト（キャッシュミス想定・ベースライン）
- 各ワークロードで以下を計測:
  - TTFT（time-to-first-token）のキャッシュ有無の差
  - 入力トークンのうちキャッシュヒットした割合
  - 実費（キャッシュ割引適用後）
- 出力はMarkdown表形式（再現可能なベンチマークとして公開可能）
- 安全のため `--dry-run` モード（API呼ばず模擬データで動作）

**CLIインターフェース:**
```
node tools/prefix-cache-bench.mjs [--dry-run] [--provider openrouter|anthropic] [--model <model>] [--out <file.md>]
```

**dry-runモードの模擬データ:**
- `repeated_system`: TTFT 150ms (cache hit 85%), cost $0.0012
- `similar_context`: TTFT 300ms (cache hit 45%), cost $0.0035
- `unique`: TTFT 800ms (cache hit 0%), cost $0.0080

### 2. tools/model-router.mjs — コスト・レイテンシ・品質によるモデルルーター

タスクの複雑さに応じてモデルをルーティングする。provider-routing.mjs の gatewayModel/routeCandidate を活用。

**ルーティング戦略:**
- `simple`: 分類・抽出・定型応答 → DeepSeek v4 Flash（最も安い）
- `medium`: 要約・一般的な推論 → Kimi K3（中間）
- `complex`: 設計・創造的タスク → 高品質モデル（設定可能、既定は Opus にエスカレート）
- `unknown`: フォールバック → 安全側の medium に倒す

**ルーティング分類器:**
- タスク文のキーワードとパターンマッチでルートを判定
- 信頼度が低い場合は medium へ倒す（安全側フォールバック）
- 分類精度・コスト・レイテンシをログに記録

**機能:**
- `classifyTask(text)`: タスク文からルート(simple|medium|complex|unknown)を判定
- `routeTask(text)`: タスクをルーティングし、選択されたモデル情報を返す
- `estimateCost(route, tokens)`: ルート別の推定コスト計算
- `loadTest(count, options)`: 指定数だけ疑似的にルーティングし p50/p95/p99 レイテンシを報告

**CLI:**
```
node tools/model-router.mjs classify "タスク文"
node tools/model-router.mjs estimate --route simple --tokens 1000
node tools/model-router.mjs load-test --count 1000
node tools/model-router.mjs benchmark --out <file.md>
```

**ルーティングテーブル（定数）:**
| ルート | モデル | 入力単価(/1M) | 出力単価(/1M) | 推定レイテンシ |
|--------|--------|--------------|--------------|---------------|
| simple | deepseek/deepseek-v4-flash | $0.15 | $0.60 | 500ms |
| medium | moonshotai/kimi-k3 | $0.50 | $1.50 | 1200ms |
| complex | openai/gpt-4o (or configurable) | $2.50 | $10.00 | 2000ms |

### 3. tools/model-router.test.mjs — テスト

既存のテストパターン（provider-routing.test.mjs 等）に従い `node:test` + `assert/strict` で書く。

**テストケース:**
1. classifyTask が simple/medium/complex を正しく分類する
2. routeTask が unknown を medium にフォールバックする
3. estimateCost が正しい金額を返す
4. loadTest が p50/p95/p99 を返す（模擬データ）
5. エッジケース（空文字、特殊文字、極端に長い入力）

### 4. docs/x0010-prefix-cache-model-router.md — ベンチマークレポート

ベンチマーク実行結果と、Orgiastの提案生成タスクへの適用計画を記述。

## 禁止事項
- 実APIを呼ぶコードを含めない（--dry-run のみ安全に動作。実API呼び出しはコメントとして記述）
- Claude API（anthropic）は使わない。既定は OpenRouter 経由
- 外部サービスへの自動送信・デプロイを行わない
- 既存の tools/*.mjs ファイルを書き換えない（新規ファイルのみ作成）

## 検証
```
node --test tools/model-router.test.mjs
node tools/prefix-cache-bench.mjs --dry-run
node tools/model-router.mjs load-test --count 100
```
