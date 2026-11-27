# X-0055: GSC28日比較で流入減の原因を切り分ける実践ガイド

## 概要

AIニュース提案 [X-0055]: Google Search Consoleの28日間比較機能を使い、オージャストのブース関連ページで発生しているクリック減少の原因を特定する実践ガイド。表示回数・CTR・掲載順位の3指標の組み合わせから「需要減」「SERP変化」「競合負け」の3パターンに分類する手法を、既存GSCデータの分析事例とともに提供。

## 変更内容

- **docs/ai-news-x0055-gsc-28day-comparison.md**: 新規作成
  - GSC28日比較の3パターン診断フレームワーク（需要減/SERP変化/競合負け）
  - orgiast.jpブース関連ページの既存サンプルデータ分析（／service/booth-construction が195クリック/月・タイトル欠落P1-HIGH）
  - BigQueryクエリ自動化の拡張（URLフィルタ追加）
  - 5ステップの実践手順書
  - 既存課題の優先度マッピング（X-0024連携）

## 分析で判明したこと

| ページ | クリック/月 | CTR | 順位 | 課題 |
|--------|------------|-----|------|------|
| /service/booth-construction | 195 | 3.20% | 6.8位 | タイトル欠落（P1-HIGH） |
| /service/event-planning | 78 | 2.29% | 9.1位 | メタ記述欠落（P2-MEDIUM） |
| /blog/booth-design-tips-2025 | 6 | 2.14% | 14.5位 | noindex矛盾 |
| /case/ | 340 | 2.72% | 8.5位 | 低速ページ（P1-HIGH） |

🤖 Generated with [Claude Code](https://claude.com/claude-code)