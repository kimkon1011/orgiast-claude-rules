# X-0010: 競合キーワード差分をAIで優先順位付け

> 2026-11-10 初回設計・実装。自動セッションによる実装。

## 概要

Ahrefsコンテンツギャップで取得した競合上位キーワードと、GSCの自社クエリデータをAIに渡すことで、「競合は上位（1-5位）だが自社は中位（6-20位）」のキーワードを抽出し、検索意図で分類して優先順位付けするシステム。

### 元記事参照

元記事の手法: Ahrefs Content Gap → キーワード取得 + GSC → 自社クエリと順位 → AIに両方を渡して競合1-5位自社6-20位キーワード抽出・意図分類 → キーワード/ページ単位で一覧化し優先度付け。48件キーワード、49ページ候補、高優先10ページを特定した実例。

## アーキテクチャ

```
[Ahrefs Content Gap] ─→ 競合キーワードCSV
                              │
[Google Search Console] ─→ 自社クエリデータ
                              │
                              ▼
            Competitive Gap Analyzer (competitive-gap-analyzer.mjs)
                              │
                    ┌─────────┼─────────┐
                    ▼         ▼         ▼
             AI意図分類  ギャップ抽出  優先度スコア
                    │         │         │
                    └─────────┼─────────┘
                              ▼
              優先順位付きキーワードリスト
                    │
                    ▼
            コンテンツ改善提案
```

### コンポーネント

| ツール | 役割 | 依存 |
|--------|------|------|
| `competitive-gap-analyzer.mjs` | 競合ギャップ分析の中核 | GSCデータ / Ahrefs CSV / LLM |
| `tools/gsc-keyword-finder.mjs` | GSCからクエリデータ取得（X-0011） | Google APIs OAuth |
| `tools/llm-ask.mjs --kind classify` | AIによるキーワード意図分類 | 安価AIレーン（gemini/deepseek） |
| `tools/llm-ask.mjs --kind summarize` | AIによる優先度評価 | 同上 |

## 3ステップの処理フロー

### Step 1: データ収集

**入力**: 
- Ahrefs → Site Explorer → Content Gap → 競合ドメイン（最大5サイト）のランキングキーワードCSVエクスポート
- GSC → 検索パフォーマンスレポート → クエリCSVエクスポート

**フォーマット**:
```
# 競合キーワード（Ahrefs Content Gap）: CSVの列構成
Keyword, Volume, KD, CPC, Competitor1_Position, Competitor2_Position, ...

# 自社クエリ（GSC）: CSVの列構成
Query, Impressions, Clicks, CTR, Position
```

### Step 2: AI分析（LLM分類）

`tools/llm-ask.mjs --kind classify` で以下を実行:

1. **ギャップ抽出**: 競合1-5位 ∧ 自社6-20位 のキーワードをフィルタ
2. **意図分類**: 各キーワードを「情報収集」「比較検討」「商談・発注」「事例参照」の4分類
3. **自社カバレッジ判定**: 該当キーワードのページが既存か未カバーかを判定

**プロンプト構造**:

```
あなたはSEOアナリストです。以下の競合キーワードデータと自社GSCデータを分析し、
「競合が上位（1-5位）で自社が6-20位」のキーワードを抽出し、検索意図を分類してください。

## 競合キーワード（Ahrefs Content Gap）
{competitor_keywords_csv}

## 自社GSCクエリ
{own_gsc_csv}

## 出力形式
次のJSON形式で出力してください:
{
  "gaps": [
    {
      "keyword": "展示会ブース デザイン",
      "competitor_avg_position": 2.3,
      "own_position": 8,
      "search_intent": "比較検討",
      "search_volume": 1200,
      "difficulty": 45,
      "own_coverage": "partial",
      "existing_page": "/booth-design/",
      "priority_score": 85
    }
  ]
}

## 意図分類定義
- 情報収集: 「とは」「やり方」「費用」などの情報探索
- 比較検討: 「比較」「おすすめ」「ランキング」「口コミ」
- 商談・発注: 「見積」「依頼」「申込」「会社」
- 事例参照: 「事例」「実績」「施工例」

## 優先度スコア計算式
priority_score = (competitor_avg_position差 × 20) + (検索ボリューム補正) + (自社未カバー補正+30) + (ビジネス価値補正)
- 競合位置差: 自社順位 - 競合平均順位（大きいほど改善余地大）
- 検索ボリューム補正: volume > 1000 → +20, > 500 → +10, > 100 → +5
- 未カバー補正: 自社に該当ページなし → +30
- ビジネス価値補正: 商談・発注意図 → +25, 比較検討 → +15
```

### Step 3: 優先順位出力

以下の形式でCSVおよびMarkdownレポートを出力:

```
| # | キーワード | 競合平均順位 | 自社順位 | 差 | 検索意図 | ボリューム | 難易度 | 自社カバレッジ | 既存ページ | 優先度スコア | 推奨アクション |
|---|-----------|------------:|--------:|---:|---------|----------:|------:|--------------|-----------|------------:|--------------|
| 1 | 展示会ブース デザイン | 2.3 | 8 | 5.7 | 比較検討 | 1,200 | 45 | 部分的 | /booth-design/ | 85 | ページ改善＋CTA追加 |
| 2 | イベント装飾 会社 | 1.8 | 12 | 10.2 | 商談・発注 | 880 | 38 | 未カバー | なし | 82 | 新規サービスページ作成 |
```

## 実装状況

| ファイル | 内容 | 状態 |
|---------|------|------|
| `tools/competitive-gap-analyzer.mjs` | 競合ギャップ分析CLIツール | 実装済み |
| `outputs/X-0010/README.md` | 本ファイル（設計・実装レポート） | 実装済み |
| `outputs/X-0010/competitive-gap-workflow.md` | 日次ワークフロー手順書 | 未実装 |
| `outputs/X-0010/orgiast-example.md` | オージャスト実データ適用例 | 未実装 |

## 使い方

```bash
# GSCデータを取得（X-0011のツールを利用）
node tools/gsc-keyword-finder.mjs --output json --limit 100 > data/gsc-queries.json

# 競合キーワードCSVと自社GSCデータを分析
node tools/competitive-gap-analyzer.mjs \
  --competitor-csv data/competitor-keywords.csv \
  --gsc-json data/gsc-queries.json \
  --output markdown

# 全自動（データ収集→分析→レポート生成）
node tools/competitive-gap-analyzer.mjs --fetch-gsc --auto
```

## 技術スタック

- Node.js 20+ (ES Modules)
- LLM: tools/llm-ask.mjs（gemini/deepseek 等の安価AIレーン）
- データ: CSV（Ahrefsエクスポート）/ JSON（GSC API）
- 出力: Markdown / CSV / JSON

## オージャスト適用シナリオ

### 展示会ブース制作キーワード

1. **競合サイト選定**: rebooth.co.jp, その他展示会ブース制作競合5サイト
2. **Ahrefs Content Gap**: 自社サイト vs 競合5サイトのギャップキーワードをエクスポート
3. **GSCデータ**: orgiast.jp の直近90日クエリデータ
4. **AI分析**: 上記Step 2のプロンプトで分析
5. **改善実行**: 高優先キーワードから順にページ作成・改善

### 想定効果

- 48件のギャップキーワードを特定（元記事実例）
- 49ページの改善候補を発見
- 10ページの高優先改善（CV貢献度大）
- AIを使った意図分類の工数削減（手動分類の10%以下）

## 既存の制約

- Ahrefs APIの直接連携は未対応（CSVエクスポートを手動で行う必要あり）
- GSC APIの認証は OAuth 2.0 またはサービスアカウントが必要
- LLM分類の精度はプロンプト品質に依存（サンプルレビューで90%以上の適合率目標）
- 競合データの鮮度はAhrefsの更新頻度に依存
