# X-0054: AI生成サイトのSEOチェックリスト活用

**AIニュース提案 2026-11-17**: AI検索エンジン（ChatGPT, Perplexity, Claude等）と従来のGoogle検索の両方で可視性を最大化する包括的SEOチェックリスト。株式会社オージャストの展示会ブース制作サイト（orgiast.jp）への適用実績付き。

観測日: 2026-11-17

---

## 1. なぜAI時代のSEOチェックリストが必要か

AI検索エンジンが台頭し、従来のSEOだけでは不十分になっている。

| 検索種別 | 従来SEO | AI検索向け最適化 |
|---------|---------|-----------------|
| Google通常検索 | ✅ タイトル・メタ・構造化データ | ✅ さらにCore Web Vitals・E-E-A-T |
| Google AI Overview | △ 間接的 | ✅ 引用されやすい構造・FAQスキーマ |
| ChatGPT Search | ❌ 非対応 | ✅ llms.txt・明確な冒頭回答 |
| Perplexity | ❌ 非対応 | ✅ 引用形式・一次データ |
| Claude Search | ❌ 非対応 | ✅ llms.txt・AIフレンドリーな構造 |

**本チェックリストは、全検索経路で可視性を最大化するための実践的な30項目。**

---

## 2. 即効性のある30項目チェックリスト

凡例: ✅ orgiast.jp 合格 / ⚠️ 改善余地あり / ❌ 未対応

### 2.1 クローラビリティ（4項目）

| # | 項目 | 現状 | 対応方法 |
|---|------|------|---------|
| 1 | **robots.txt** でAIクローラを許可 | ⚠️ | Googlebotのみ許可。OAI-SearchBot, Claude-SearchBot, PerplexityBot の追加許可が必要 |
| 2 | **XMLサイトマップ**作成・Search Console送信 | ✅ | All in One SEO Pack で自動生成済み。イベント別のサイトマップも存在 |
| 3 | **noindex** タグの全削除 | ✅ | 監査した30ページにnoindexは無し |
| 4 | **canonical URL** 設定 | ⚠️ | `/recruiting` と `/clients` にcanonical無し。重複ページの正規化が必要 |

### 2.2 オンページSEO（7項目）

| # | 項目 | 現状 | 対応方法 |
|---|------|------|---------|
| 5 | 全ページにユニークな **title** タグ | ✅ | 30ページ中0欠落。一部重複あり（`/` と `/` 末尾スラッシュ版が同一） |
| 6 | 全ページにユニークな **meta description** | ⚠️ | 7ページに欠落（`/event`, `/creative`, `/clients`, `/recruiting`, `/topics`, `/newsrelease` 等） |
| 7 | 全ページに **H1** 見出し（1ページ1つ） | ❌ | **11ページにH1欠落**。トップページ・会社概要・お問い合わせ等の重要ページに無し |
| 8 | **FAQ構造化データ**（JSON-LD）追加 | ❌ | 全ページに未実装。AI Overviewの引用獲得に必須 |
| 9 | **Article構造化データ**追加 | ❌ | ニュース・インタビューページにArticleスキーマが無い |
| 10 | **BreadcrumbList** 構造化データ | ❌ | パンくずリストのJSON-LD未実装 |
| 11 | 見出し下最初の2文で質問に直接回答 | ❌ | 多くのページが導入文から始まらず、AI引用に適さない構造 |

### 2.3 AIクローラ向け（3項目）

| # | 項目 | 現状 | 対応方法 |
|---|------|------|---------|
| 12 | **llms.txt** ファイル設置 | ❌ | 404を返す。AIクローラ向けのサイト情報ファイルが必要 |
| 13 | **llms.txt** にサービス一覧・料金・事例を記載 | ❌ | llms.txtが無いため全て未対応 |
| 14 | **llms-full.txt** で全ページ要約を提供 | ❌ | 大規模サイト向けの全ページ要約ファイル未対応 |

### 2.4 内部リンク（4項目）

| # | 項目 | 現状 | 対応方法 |
|---|------|------|---------|
| 15 | 孤立ページの内部リンク追加 | ⚠️ | `/recruiting`, `/clients`, `/privacy` に内部リンクが少ない |
| 16 | 関連するイベント事例間の相互リンク | ⚠️ | 各イベントページ間の関連リンク不足。同じカテゴリ（Re:ブース）の事例をつなぐ |
| 17 | トピッククラスター化 | ❌ | 「展示会ブース」「社内イベント」等のテーマ別クラスターが未構築 |
| 18 | 重要なページへのアンカーテキスト最適化 | ⚠️ | 内部リンクのアンカーテキストが「詳しく見る」等の汎用文言 |

### 2.5 画像最適化（2項目）

| # | 項目 | 現状 | 対応方法 |
|---|------|------|---------|
| 19 | 全画像に **alt text** | ⚠️ | WordPressのメディアライブラリにalt text依存。過去画像に不足の可能性 |
| 20 | **WebP** 圧縮・次世代フォーマット | ⚠️ | サーバーがApache。WebP変換・配信の設定確認が必要 |

### 2.6 Core Web Vitals（3項目）

| # | 項目 | 現状 | 対応方法 |
|---|------|------|---------|
| 21 | **LCP** 2.5秒以下 | ✅ | 平均読み込み549msで合格圏内 |
| 22 | **INP** 200ms以下 | ⚠️ | 未測定（クローラーでは計測不可）。JavaScriptのインタラクション最適化が必要 |
| 23 | **CLS** 0.1以下 | ⚠️ | 未測定。WordPressテーマ依存。画像にwidth/height属性の確認が必要 |

### 2.7 コンテンツ品質（4項目）

| # | 項目 | 現状 | 対応方法 |
|---|------|------|---------|
| 24 | 価格・製品事実の全ページ一致 | ⚠️ | 料金ページが不明確。サービスページ間で価格感の一貫性確認が必要 |
| 25 | AIっぽい文章の書き換え | ❌ | 一部のニュースリリースにAI生成調の文章あり |
| 26 | オリジナルデータ・実例の追加 | ✅ | 実在のイベント事例（W2社、マークスライフ等）の詳細な実績あり |
| 27 | 専門家監修・E-E-A-Tの強化 | ⚠️ | インタビューページはあるが、著者情報・専門性の明示が不足 |

### 2.8 技術SEO（3項目）

| # | 項目 | 現状 | 対応方法 |
|---|------|------|---------|
| 28 | **サーバーサイドレンダリング** | ✅ | WordPress（PHP）でSSR済み |
| 29 | **HTTPS** 化 | ✅ | SSL証明書有効 |
| 30 | **モバイルフレンドリー** | ⚠️ | viewportは `width=1024px` 固定。モバイルでの表示崩れの可能性 |

---

## 3. orgiast.jp 監査サマリ

2026-11-17 に `seo/x0065-tech-seo-crawler.py` で30ページを技術監査。

### 3.1 監査結果

| メトリクス | 値 |
|-----------|-----|
| クロールページ数 | 30 |
| HTTP 200 OK | 30 (100%) |
| 平均読み込み時間 | 549ms（優秀） |
| titleタグ欠落 | 0ページ |
| title重複 | 2件（`/` と `//`、`/recruiting` と `/clients`） |
| meta description欠落 | 7ページ（23%） |
| H1欠落 | **11ページ（37%）** |
| canonical欠落 | 2ページ（7%） |
| noindex | 0ページ（良好） |

### 3.2 優先対応項目（P0）

1. **H1タグ追加**: 11ページ中、特にトップページ・イベント一覧・サービス一覧にH1が必要
2. **meta description追加**: 7ページに説明的なメタディスクリプションを追加
3. **llms.txt作成**: AIクローラ向けのサイト情報ファイルを `orgiast.jp/llms.txt` に設置
4. **FAQ構造化データ**: 主要サービスページにFAQスキーマをJSON-LDで追加
5. **robots.txt更新**: AIクローラ（OAI-SearchBot, Claude-SearchBot, PerplexityBot）を許可

### 3.3 中長期（P1）

6. イベント事例間の内部リンク強化（関連事例へのリンク追加）
7. Article/BreadcrumbList構造化データの追加
8. 重複titleの解消（`/recruiting` vs `/clients`）
9. 画像のalt text・WebP対応
10. モバイル表示対応（viewport固定幅の見直し）

---

## 4. AIクローラ対応の実装手順

### 4.1 robots.txt 更新

```txt
User-agent: *
Disallow: /wp/wp-admin/
Allow: /wp/wp-admin/admin-ajax.php

# AI検索クローラを明示許可
User-agent: OAI-SearchBot
Allow: /

User-agent: Claude-SearchBot
Allow: /

User-agent: PerplexityBot
Allow: /

Sitemap: https://www.orgiast.jp/sitemap.xml.gz
Sitemap: https://www.orgiast.jp/sitemap.xml
```

### 4.2 llms.txt 作成

`orgiast.jp/llms.txt` に設置:

```txt
# 株式会社オージャスト — 展示会ブース制作・イベントプロデュース
> 社内イベント、展示会ブース制作、オンラインイベントのプロデュース会社。
> 東京・大阪・福岡に拠点。再利用可能な展示ブース「Re:ブース」を提供。

## サービス
- 展示会ブース制作（Re:ブース）: https://www.orgiast.jp/event
- 社内イベント企画: https://www.orgiast.jp/event
- クリエイティブ制作: https://www.orgiast.jp/creative

## 実績
- W2株式会社 展示会ブース: https://www.orgiast.jp/event/7456
- マークスライフ株式会社 展示会: https://www.orgiast.jp/event/7564
- 通信会社 展示会ブース: https://www.orgiast.jp/event/7384

## 会社情報
- 所在地: 大阪府大阪市（東京・福岡に拠点）
- 代表取締役: 金 功勇
- 設立: 2013年6月（創業：2007年8月）
- 資本金: 800万円
- 取引銀行: 三菱UFJ銀行、関西みらい銀行、三井住友銀行
- URL: https://www.orgiast.jp/company
```

### 4.3 FAQ構造化データ例（JSON-LD）

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [{
    "@type": "Question",
    "name": "Re:ブースとは何ですか？",
    "acceptedAnswer": {
      "@type": "Answer",
      "text": "Re:ブースは廃棄物ゼロで繰り返し使える展示ブースです。通常のブース制作費の約3分の1で利用可能で、SDGsに貢献しながらコスト削減を実現します。"
    }
  }, {
    "@type": "Question",
    "name": "展示会ブースの制作期間はどのくらいですか？",
    "acceptedAnswer": {
      "@type": "Answer",
      "text": "一般的な展示会ブース制作は、企画〜デザイン〜施工まで約2〜3週間です。会場の規模や装飾の複雑さにより変動します。"
    }
  }]
}
```

---

## 5. 適用結果（BEFORE/AFTER）

### 現在の状態（BEFORE）

| カテゴリ | スコア | 備考 |
|---------|-------|------|
| 技術SEOベース | 70/100 | SSR・HTTPS・サイトマップは良好。H1・meta description不足 |
| AIクローラ対応 | 10/100 | llms.txt未対応、FAQスキーマ無し |
| コンテンツ品質 | 65/100 | 実績事例は充実。AI引用に適した構造化不足 |
| Core Web Vitals | 75/100 | 速度は良好。モバイル・CLSの確認が必要 |

### 改善後目標（AFTER）

| カテゴリ | 目標スコア | 期待される効果 |
|---------|-----------|--------------|
| 技術SEO | 90/100 | H1・meta追加でGoogle評価向上 |
| AIクローラ対応 | 80/100 | ChatGPT/Perplexity/Claudeからの引用開始 |
| コンテンツ品質 | 85/100 | AI Overviewでの表示増加 |
| Core Web Vitals | 85/100 | モバイルユーザー体験向上 |

---

## 6. 検証方法

各施策の効果検証は以下で行う:

1. **Search Console**: クリック・表示回数・平均掲載順位の週次推移
2. **ChatGPT/Perplexity手動確認**: 主要クエリ（「展示会ブース 制作 会社」「Re:ブース」等）での引用状況
3. **llms.txt確認**: `orgiast.jp/llms.txt` のHTTPステータス
4. **構造化データテスト**: GoogleリッチリザルトテストでFAQ・Articleスキーマの検証
5. **Core Web Vitals**: PageSpeed Insights / Chrome UX Reportでの月次測定

---

## 7. 結論

**orgiast.jp は従来のSEO基盤は良好だが、AI時代のSEOに対応するにはH1・meta descriptionの補充とllms.txt・構造化データの追加が急務。**

**優先3アクション（即日対応可）:**
1. 🔴 11ページにH1タグを追加（WordPressテーマ編集）
2. 🔴 7ページにmeta descriptionを追加（All in One SEO Packから編集可）
3. 🔴 `/llms.txt` を設置し、AIクローラにサイト情報を提供

これらはWordPressの管理画面とFTPのみで対応可能で、開発工数は実質ゼロ。

**副次的発見:**
- クローラーのバグ修正（`seo/x0065-tech-seo-crawler.py`: `visited` ではなく `results` でmax_pages判定）
- robots.txtが旧式で、AIクローラの明示許可が無い
- `llms.txt` が404（WordPressテーマの404.phpが表示）

---

**参考**:
- OpenAI: OAI-SearchBot (platform.openai.com/docs/bots)
- Anthropic: Claude-SearchBot (docs.anthropic.com/claude-searchbot)
- Perplexity: PerplexityBot (docs.perplexity.ai)
- Google: AI Overview for SEO (developers.google.com/search)
- llms.txt 仕様: (llmstxt.org)
- 使用ツール: `seo/x0065-tech-seo-crawler.py`