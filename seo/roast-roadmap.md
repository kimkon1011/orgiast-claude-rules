# SEO Roast Roadmap: expo-apply (Japan Trade Show Intake)

**Verdict:** Crawlable and AI-friendly, but missing structured SEO fundamentals.

## 改善一覧

| # | 優先度 | 課題 | Revenue/SEO影響 | 対応 | 状態 |
|---|--------|------|-----------------|------|------|
| 1 | FATAL | **sitemap.xml 未存在** — Google/Bing/Yandex が全ページを探索できない | 全ページのインデクシングが不完全 | `sitemap.xml` 作成、全4ページ登録、hreflang付き | ✅ 作成済み |
| 2 | FATAL | **robots.txt に Sitemap 指示なし** — sitemapがあっても検索エンジンが発見できない | sitemap作成の効果が半減 | `Sitemap:` ディレクティブ追加 | ✅ 修正済み |
| 3 | REVENUE | **hreflang 未定義** — en/ja二カ国語対応だがGoogleに言語間関係が伝わらない | 日本語検索での誤インデクシング | index/FAQに hreflang + x-default 追加 | ✅ 修正済み |
| 4 | REVENUE | **canonical が相対パス** — `href="./"` はデプロイ環境によって解決が不定 | 重複コンテンツ判定のリスク | 絶対URL `https://orgiast.jp/apps/expo-apply/` に変更 | ✅ 修正済み |
| 5 | REVENUE | **タイトルがキーワード弱い** — "Japan Exhibition Application | Trade Show Intake Portal" は検索意図に合致しない | CTR低下・順位低迷 | "Japan Trade Show Exhibition Application | Overseas Exhibitor Intake Portal" に変更 | ✅ 修正済み |
| 6 | REVENUE | **meta description が短い** — 「browser-based intake tool」だけでは検索者がクリックしない理由 | CTR低下 | 価値提案・ユースケースを含む記述に拡張 | ✅ 修正済み |
| 7 | COMPOUNDING | **JSON-LD FAQPage が3問のみ** — リッチリザルト表示機会を逃している | FAQリッチリザルト非表示 | 6問に拡張（保存場所・エクスポート形式・無料であること等） | ✅ 修正済み |
| 8 | COMPOUNDING | **llms.txt が内容薄い** — AIアシスタントへの情報提供不足 | AI citation取得機会損失 | キーワード・主要展示会名・差別化要因を追加 | ✅ 修正済み |
| 9 | COMPOUNDING | **キーワード調査未実施** — どの検索クエリで流入を得るか未定義 | 全体の方向性欠如 | FOODEX/JAPAN PACK/Gift Show 等の展示会名をキーワード候補として特定 | ⚠️ 調査済み・反映は別途 |
| 10 | FLUFF | **research.html canonical が相対パス** | 軽微 | 絶対URLに統一 | ✅ 修正済み |
| 11 | FLUFF | **freebies/ がクロール対象** — 公開サンプルだがSEO価値なし | クロールバジェット浪費 | robots.txt で Disallow /freebies/ | ✅ 修正済み |

## 対応しなかった事項（理由付き）

- **Google Search Console 設定**: このPCにSA鍵が存在しない。kim@orgiast.jp のGSC権限が必要（既知の制約）
- **内部リンク構造の大幅改善**: サイトが4ページと小規模であり、現在のナビゲーションで十分カバーされている
- **ブログ投稿最適化**: 当サイトにブログ機能はない。展示会参加ガイド記事などを作成する場合は別途対応

## 次の推奨アクション

1. `kim@orgiast.jp` でSearch Consoleにログインし、サイトをプロパティ登録
2. sitemap.xml 提出 → インデクシング状況確認
3. BigQuery連携設定 → `gsc-bq-weekly-analysis.sql` による週次分析開始
4. 日本語版専用ページ（`/?lang=ja`）に個別のJSON-LDを追加し、hreflangを完全対応

## 参考スキル

- `seo-roast`: 本監査の手法
- `seo-title-optimization`: タイトル最適化
- `internal-linking`: 内部リンク構造改善（サイト拡大後に適用）
- `blog-refresher`: コンテンツ更新（ブログ追加後に適用）