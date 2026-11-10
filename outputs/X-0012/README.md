# X-0012: 既存ページ解除とマルチソースでAI検索$506K — PHASE 1 診断レポート

> 2026-11-09 実測調査。自動セッションによる初回分析。

## 調査結果サマリ

### サイト構造（orgiast.jp）

| カテゴリ | ページ数（sitemap） | CMS種別 | URLパターン |
|----------|-------------------|---------|------------|
| イベント・展示会事例 | 85 | WordPress（カスタム投稿） | /event/{ID} |
| 制作実績（動画・デザイン） | 26 | WordPress（カスタム投稿） | /creative/{ID} |
| トピックス（ブログ） | 213 | WordPress（標準投稿） | /topics/{ID} |
| ニュースリリース | 25 | WordPress（カスタム投稿） | /newsrelease/{ID} |
| サービスページ | 6 | WordPress（固定ページ） | /event, /creative, /clients, /recruiting, /, /newsrelease |
| クライアント一覧 | 47 | WordPress（カスタム投稿） | /clients/{ID} |
| 採用情報 | 11 | WordPress（カスタム投稿） | /recruiting/{ID} |
| インタビュー | 14 | WordPress（カスタム投稿） | /interview/{ID} |
| イベントフォト | 12 | WordPress（カスタム投稿） | /eventphoto/{ID} |
| スライド資料 | 4 | WordPress（カスタム投稿） | /slide/{ID} |
| **合計（sitemap掲載）** | **~461** | | |

**関連ドメイン**: rebooth.co.jp（Vercel ホスティング、別途調査要）

### 重大発見

#### ✅ 問題なし
- **noindex は全ページに無し**（すべて indexable）。「数千ページのnoindex解除」は誤認。
- **robots.txt は健全**（/wp/wp-admin/ のみブロック、sitemap 2件掲載）
- **sitemap 構造は適切**（17 sub-sitemap に分類、全461URLをカバー）

#### 🚨 改善必須

1. **Canonical タグが全ページで未実装**
   - 調査した全ページ（トップ・event/7623・event/7317・creative/5429・topics/7890・newsrelease・rebooth.co.jp）に `<link rel="canonical">` なし
   - **リスク**: WordPress のカテゴリアーカイブ・タグページ・`?page=N` ページとの重複コンテンツで、Google が間違ったページを正規URLと認識する可能性
   - **対処**: 全ページに自己参照 canonical を実装（Yoast SEO / All in One SEO の設定で対応可能）

2. **構造化データ（Schema.org）が全ページで未実装**
   - JSON-LD / Microdata / RDFa の形跡なし
   - **リスク**: Google のリッチリザルト非対応、Bing の deep link 非対応、ChatGPT/Perplexity 等 AI 検索の信頼度評価に不利
   - **対処**: 
     - 事例ページ → `Article` + `Event` スキーマ
     - 組織トップ → `Organization` + `WebSite` + `BreadcrumbList`
     - ブログ → `Article` + `BlogPosting`
     - rebooth → `Product` + `Review` スキーマ

3. **meta description が事例ページ・ブログに無い**
   - WordPress SEO プラグインが適切に出力していない可能性
   - ChatGPT/Claude 等 AI がスニペット生成時に meta description を重視する

4. **All in One SEO Pack 2.11（2012年頃の最終版）は旧式**
   - 現行の SEO 要件（スキーマ、ソーシャル、sitemap自動更新）に非対応
   - **推奨**: Rank Math SEO または Yoast SEO への移行

5. **rebooth.co.jp も同様の問題**
   - Vercel ホスティング、WordPress ではないが同様に canonical 無し・構造化データ無し・meta description 無し
   - rebooth の sitemap は確認できず

### Bing 対応状況

Bing Webmaster Tools 未確認（今回はアクセス不可）。以下は推測：
- sitemap が全URLをカバーしているため、Bing への sitemap 送信のみで大部分は index 可能
- Bing の index には canonical タグと schema.org が重要 → 実装後、Bing Webmaster Tools 経由で index リクエスト

## フェーズ推奨

### PHASE 1（今回）✅ 完了
- [x] 現状の index/canonical 分析
- [x] sitemap 構造調査
- [x] robots.txt 確認
- [x] 主要ギャップ特定

### PHASE 2（次回）
- [ ] WordPress SEO プラグインを Rank Math にアップデート（または All in One SEO の設定で canonical + meta description + sitemap 自動更新を確認）
- [ ] 全事例ページにスキーマ実装（Article + Event + 写真の ImageObject）
- [ ] rebooth.co.jp に canonical + 構造化データ実装
- [ ] Bing Webmaster Tools 登録・sitemap 送信
- [ ] 主要ページの meta description 一括生成（AI で各事例から抽出）

### PHASE 3
- [ ] ChatGPT/Perplexity が引用する第三者ドメインのスクレイプ→アウトリーチ
- [ ] デザイナーインタビューのAI構造化コンテンツ化
- [ ] 引用される Reddit スレの関与
- [ ] クリーン帰属 vs 影響帰属の分離計測

## 実測URL一覧

### イベント事例（85件）
- https://www.orgiast.jp/event/7623（アパレル全社オフサイト）
- https://www.orgiast.jp/event/7317（メディアネットワーク様 展示会Reブース）
- https://www.orgiast.jp/event/7320 〜 /6281（全85件）

### 制作事例（26件）
- https://www.orgiast.jp/creative/5429（C3様 蒼山コラボ動画）
- https://www.orgiast.jp/creative/3491 〜 /201（全26件）

### トピックス（213件）
- https://www.orgiast.jp/topics/7890 〜 /7833（最新〜過去）

### サービスページ
- https://www.orgiast.jp/
- https://www.orgiast.jp/event/
- https://www.orgiast.jp/creative/
- https://www.orgiast.jp/clients/
- https://www.orgiast.jp/company/
- https://www.orgiast.jp/contactus/
- https://www.orgiast.jp/services/flow/
- https://www.orgiast.jp/newsrelease/
- https://www.orgiast.jp/recruiting/
- https://www.orgiast.jp/policy/

### rebooth.co.jp
- https://rebooth.co.jp/
- https://rebooth.co.jp/about/
- https://rebooth.co.jp/why-choose-us/
- https://rebooth.co.jp/works-top/
- https://rebooth.co.jp/works/1538/ 〜 /1242/
- https://rebooth.co.jp/column/
- https://rebooth.co.jp/reviews/
- https://rebooth.co.jp/company/
- https://rebooth.co.jp/contact/

## 実装優先度

| # | 項目 | 優先度 | 影響（AI検索） | 影響（Google） | 実装難易度 |
|---|------|--------|----------------|---------------|-----------|
| 1 | canonical 全ページ実装 | P0 | ⭐⭐⭐ | ⭐⭐⭐ | 低（プラグイン設定変更） |
| 2 | 構造化データ（スキーマ） | P0 | ⭐⭐⭐ | ⭐⭐⭐ | 中（テーマ関数追記） |
| 3 | meta description 生成 | P1 | ⭐⭐ | ⭐⭐⭐ | 低（AIで一括生成可） |
| 4 | SEO プラグイン更新 | P1 | ⭐⭐ | ⭐⭐⭐ | 中（プラグイン切替手順要確認） |
| 5 | Bing 登録 + sitemap 送信 | P2 | ⭐⭐⭐ | - | 低 |
| 6 | rebooth 構造化データ | P2 | ⭐⭐ | ⭐⭐ | 中（Next.js 実装） |
| 7 | トピックス増産（AI生成SEOガイド） | P3 | ⭐⭐ | ⭐⭐ | 中 |
| 8 | 第三者ドメイン引用アウトリーチ | P3 | ⭐⭐⭐ | ⭐ | 高 |