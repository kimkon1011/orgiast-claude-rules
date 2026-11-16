# 実装指示: GSC バブルチャート可視化ツール

## 概要
Google Search Console のクエリデータCSVから3ゾーンバブルチャートを生成するHTML可視化ツールを作成する。

## ファイル
1. `research/ai-news-x0069-gsc-bubble-chart.md` — AIニュース提案文書
2. `tools/gsc-bubble-chart.mjs` — バブルチャート生成ツール

## tools/gsc-bubble-chart.mjs の仕様

### 入力
- CSVファイル（Search Console エクスポート形式）
  - 必須カラム: Query, Impressions, Clicks, Position, CTR
  - または Pages.csv: Page, Impressions, Clicks, Position, CTR
- コマンドライン引数: --input <csv-path> [--output <html-path>] [--site "orgiast.jp"]

### 出力
- 自己完結型HTMLファイル（JS/CSS内蔵）
- インタラクティブなバブルチャート

### チャート仕様
- **X軸**: 掲載順位（1〜50、右に行くほど順位が高い＝1が右端）
- **Y軸**: インプレッション数（対数スケール推奨）
- **バブルサイズ**: クリック数
- **色分けゾーン**:
  - 赤ゾーン（ミスマッチ）: 掲載順位1〜10 かつ CTR < 5%（タイトル・説明文の改善が必要）
  - 黄ゾーン（可能性）: 掲載順位11〜20 または CTR 5-15%（コンテンツ追加で改善可能）
  - 灰ゾーン（見極め）: 掲載順位21以下（記事の要否を判断）
- 各バブルをホバーでクエリ・インプレッション・クリック・CTR・掲載順位を表示
- ゾーン凡例
- フィルタ: 最低インプレッション数で絞り込み可能

### 技術スタック
- Chart.js または 素のCanvas/SVG（Chart.js推奨・CDN参照）
- 単一HTMLで完結
- 日本語UI

### テストデータ生成
--demo フラグでサンプルデータ（展示会・ブース関連クエリ50件）の埋め込みHTMLを生成できること

## research/ai-news-x0069-gsc-bubble-chart.md の構成
- 既存の research/ai-news-x*.md と同じフロントマター形式
- 提案の核: Search Consoleデータを3ゾーンバブルチャートで可視化し、SEO改善優先順位を視覚的に判断する
- オージャストの展示会・ブース関連クエリへの適用を具体的に記載
