# X-0086: orgiast.jp AIO 実測監査と改善計画

> **要約 1/3:** 2026-11-19 04:05〜04:10 JST に `curl` で8ページとサイトマップを実測し、全対象ページおよび GPTBot / ClaudeBot / PerplexityBot でトップが HTTP 200 になることを確認した。
>
> **要約 2/3:** orgiast.jp は同一の Organization / FAQPage JSON-LD を全ページへ出す一方、Reブースの主要ページは JSON-LD が0件であり、ページ固有 H1・alt・料金/事例の機械可読化に改善余地がある。
>
> **要約 3/3:** P0 は Reブースの Service/FAQ/事例構造化、orgiast.jp のページ固有見出しと既存スキーマ精査、具体値の出典・更新日付与。`llms.txt` は補助施策として下書きを用意するが、本番反映は kim 承認後とし、このPRでは反映しない。

## 1. 範囲・方法・既存文書との役割分担

- 実測日時: **2026-11-19 04:05〜04:10 JST**
- 方法: ログインなしの `curl -L`。HTML、HTTPヘッダー、robots.txt、XMLサイトマップを一時領域へ保存して抽出した。
- 対象: `www.orgiast.jp` の企業・イベントサイトと、同サイトからリンクされる展示会ブースサービス `rebooth.co.jp`。
- 非実施: WordPress、サーバー、DNS、GAへのログイン・書き込み、フォーム送信、公開情報以外による補完。
- 判定原則: 観測できない値は推定せず「未取得」または `TODO:` とした。HTML内の数値も、選択ページ本文で裏付けられないものは下書きへ転載していない。

一般的なLLMOの解説は重複させず、以下を参照する。

- コンテンツ設計: [X-0004](ai-news-x0004-llmo-content-4points.md)
- 月次質問・引用率測定: [X-0007](ai-news-x0007-llmo-measurement.md)
- 誤情報訂正: [X-0030](ai-news-x0030-llmo-info-correction.md)
- 画像内数値のテキスト化: [X-0036](ai-news-x0036-image-number-text-llmo.md)、[X-0039](ai-news-x0039-image-text-llmo.md)
- 調査証拠の蓄積: [X-0089](ai-news-x0089-ai-research-knowledge-accumulation.md)

## 2. HTTP・クロール実測

### 2.1 URL別 HTTPコード

| URL | HTTP | 実測メモ |
|---|---:|---|
| `https://orgiast.jp/robots.txt` | 200 | 166 bytes。`User-agent: *`、`Disallow: /wp/wp-admin/`、`Allow: /wp/wp-admin/admin-ajax.php`、サイトマップ2本 |
| `https://www.orgiast.jp/llms.txt` | 404 | 404 HTML、18,522 bytes |
| `https://www.orgiast.jp/` | 200 | 190,153 bytes、WordPress |
| `https://www.orgiast.jp/sitemap.xml` | 200 | サイトマップインデックス、子サイトマップ9本 |
| `https://orgiast.jp/sitemap.xml.gz` | 200 | 359 bytes |
| `https://www.orgiast.jp/company` | 200 | 会社概要 |
| `https://www.orgiast.jp/event` | 200 | イベントプロデュース／Reブースへの導線あり |
| `https://www.orgiast.jp/contactus` | 200 | 問い合わせページ。送信はしていない |
| `https://rebooth.co.jp/` | 200 | Reブーストップ |
| `https://rebooth.co.jp/about/` | 200 | Reブースについて |
| `https://rebooth.co.jp/why-choose-us/reduces-costs/` | 200 | 料金の具体値を本文で確認 |
| `https://rebooth.co.jp/works/1538/` | 200 | 事例の価格帯・会場・展示会名を確認 |

robots.txt の生の該当箇所:

```text
User-agent: *
Disallow: /wp/wp-admin/
Allow: /wp/wp-admin/admin-ajax.php

Sitemap: https://www.orgiast.jp/sitemap.xml.gz
Sitemap: https://www.orgiast.jp/sitemap.xml
```

GPTBot、ClaudeBot、PerplexityBot の個別指定はないため `User-agent: *` の規則が適用される。さらに各 User-Agent を付けてトップを取得した実測は以下のとおり。

| User-Agent | HTTP | 取得サイズ | 判定 |
|---|---:|---:|---|
| GPTBot | 200 | 190,153 bytes | WAFブロックなし |
| ClaudeBot | 200 | 190,153 bytes | WAFブロックなし |
| PerplexityBot | 200 | 190,153 bytes | WAFブロックなし |

### 2.2 sitemap.xml

ルートXMLのコメントは `Wed, 18 Nov 2026 19:07:59 UTC` の動的生成を示す。子サイトマップは全9本が HTTP 200。URL数はXML内の `<url>` を数えた値で、合計 **377 URL**。

| 子サイトマップ | URL数 | 最古 lastmod | 最新 lastmod |
|---|---:|---|---|
| `sitemap_addl.xml.gz` | 6 | 2015-05-05 | 2015-05-05 |
| `sitemap_post.xml.gz` | 0 | なし | なし |
| `sitemap_page.xml.gz` | 5 | 2022-09-14 | 2026-09-17 |
| `sitemap_event.xml.gz` | 85 | 2022-06-17 | 2026-07-31 |
| `sitemap_creative.xml.gz` | 25 | 2022-06-18 | 2022-10-17 |
| `sitemap_interview.xml.gz` | 14 | 2022-06-18 | 2026-09-07 |
| `sitemap_newsrelease.xml.gz` | 25 | 2022-06-17 | 2026-11-11 |
| `sitemap_topics.xml.gz` | 217 | 2014-12-25 | 2026-11-13 |
| `sitemap_archive.xml.gz` | 0 | なし | なし |

生の該当箇所例:

```xml
<loc>https://www.orgiast.jp/sitemap_event.xml.gz</loc>
<loc>https://www.orgiast.jp/sitemap_topics.xml.gz</loc>
```

注意点は、追加サイトマップに `http://www.orgiast.jp/creative` 等のHTTP URLが残ること、0件の子サイトマップが2本あること、FAQを含むURLが orgiast.jp / Reブース双方のサイトマップで見つからないこと。Reブースは独立した `https://rebooth.co.jp/sitemap.xml`（200）を持つ。

## 3. 主要8ページ実測監査表

表中の画像は `全img / alt属性あり / 非空alt`。JSON-LDの型は各 `application/ld+json` 内の `@type` を列挙した。

| URL / 役割 | title / meta description / H1 | JSON-LD | OGP / canonical | 具体値・引用しやすさ | 画像alt |
|---|---|---|---|---|---|
| `https://www.orgiast.jp/` トップ | title: 「社内イベント企画プロデュース…［東京・大阪・福岡］」／descriptionあり／H1: 「社内イベント・クリエイティブ…」 | 3件: Organization, Person, PostalAddress, ContactPoint, Brand, WebSite, FAQPage, Question, Answer | OGP 9件／canonical自己参照 | 電話 `0120-487-121`、実績日付・社名あり。展示会制作より社内イベントが主題 | 40 / 31 / 23 |
| `https://www.orgiast.jp/company` 会社概要 | title・descriptionあり／H1はトップと同じロゴ文言 | トップと同じ3件・同じ型 | 9件／自己参照 | 設立 `2006年4月`、資本金 `500万円`、代表者、東京・大阪ほか所在地、事業内容を本文で確認 | 1 / 0 / 0 |
| `https://www.orgiast.jp/event` サービス | titleあり／**description空**／H1はトップと同じ | トップと同じ3件・同じ型 | 9件／自己参照 | 「5000人まで参加可能」等はあるが複数サービス混在。Reブースへの説明は短い | 21 / 20 / 2 |
| `https://www.orgiast.jp/contactus` 問い合わせ | title・descriptionあり／H1はトップと同じ | トップと同じ3件・同じ型 | 9件／自己参照 | 電話、営業時間 `平日10:00〜18:00`。フォーム送信は未実施 | 21 / 20 / 20 |
| `https://rebooth.co.jp/` Reブーストップ | title・descriptionあり／**H1なし** | **0件** | 8件／自己参照 | 所在地、事例日付、「目標の120%」という顧客コメントあり。価格はトップ本文では確認できず | 37 / 37 / 23 |
| `https://rebooth.co.jp/about/` サービス概要 | title・descriptionあり／H1「リブースについて」 | **0件** | 8件／自己参照 | 所在地と顧客名はあるが、本文中の価格・対応エリア・実績件数は未取得 | 47 / 47 / 40 |
| `https://rebooth.co.jp/why-choose-us/reduces-costs/` 料金相当 | title・descriptionあり／H1「出展コストと環境負荷の両立」 | **0件** | 10件／自己参照 | 本文: **「初回は100万円から、2回目以降は50万円から」**、展示会「年間約700件」 | 5 / 5 / 0 |
| `https://rebooth.co.jp/works/1538/` 実績事例 | titleあり／descriptionは「ブース写真 デザインパース 動画キャプチャ」のみ／H1は社名・年月・展示会名 | **0件** | 10件／自己参照 | 本文: **価格300万〜500万円**、幕張メッセ、サステナブル経営WEEK。小間数は「その他」で具体寸法なし | 13 / 13 / 0 |

### 生の証拠抜粋

```text
company:
社名 株式会社オージャスト
設立 2006年4月
資本金 500万円
代表取締役 金功勇（野村功勇）
東京本社 〒130-0015 東京都墨田区横網2-10-3 1F
大阪本社 〒537-0001 大阪府大阪市東成区深江北2-15-24 東邦ビル212

reduces-costs:
初回は100万円から、2回目以降は50万円からご相談いただけるため、継続的な出展コストの削減にもつなげられます。

works/1538:
価格 300万〜500万円
業種タイプ 環境・エコ
展示会場 幕張メッセ
展示会名 サステナブル経営WEEK
```

### 構造化データ上の要注意点

orgiast.jp の全対象ページには、ページ内容にかかわらず同じFAQPageが出ている。そこには `CO2を77%（305kg-CO2e）削減`、`ISO 14067準拠`、`2回目以降は65〜75%` 等が含まれるが、今回選んだページ本文では同じ根拠を確認できなかった。また Organization の Brand URL / sameAs は `https://rebooth-site.vercel.app` で、現行ナビの `https://rebooth.co.jp/` と一致しない。削除を即断せず、公開根拠を担当者が照合した上でページ本文とスキーマを一致させる。

## 4. 優先度付き改善計画

優先度は効果×手間（高・中・低）で決めた。AI検索だけでなく、検索エンジンと利用者が同じ根拠を読めることを受け入れ条件にする。

| 優先度 | 対象URL | 現状（実測） | 変更内容 | WordPress上の作業場所 | 見込み効果 | 測定方法 |
|---|---|---|---|---|---|---|
| **P0 高×低** | Reブース全主要ページ | JSON-LD 0件 | 共通 Organization/LocalBusiness と、ページ固有 Service/BreadcrumbList を追加。`rebooth.co.jp` を正規URLにする | テーマの共通head、SEOプラグインのSchema設定、必要なら子テーマ | ブランド・サービス・URLの対応を機械可読化 | Schema Validatorでエラー0、HTML再取得、AI回答の引用URL記録 |
| **P0 高×低** | orgiast.jp全ページ | 同じH1・同じFAQPageを全ページ出力。`/event` description空 | ロゴをH1にせずページ固有H1を1件設定。FAQPageはFAQが可視表示されるURLだけに限定。`/event` descriptionを追加 | テーマheader、All in One SEO、各固定/アーカイブテンプレート | 主題の誤認低減、ページ別の抽出精度向上 | H1件数、description、構造化データを月次クロール |
| **P0 高×中** | `/why-choose-us/reduces-costs/`、`/works/*` | 料金は本文にあるが構造化なし。事例画像13件の非空alt 0 | Service/Offerの `priceSpecification`、事例のCreativeWork（またはArticle）を追加。価格の適用条件・税込/税別・更新日を可視本文へ。事例画像へ内容を表すalt | 固定ページ、実績CPTフィールド、実績テンプレート、メディアライブラリ | 「展示会 ブース 費用」「再利用 ブース」で根拠付き引用されやすくする | 対象クエリの引用率、価格ページ着地、Search Console表示を前後比較 |
| **P0 高×中** | 新規 `/faq/`（Reブース） | サイトマップ・ナビにFAQページなし。orgiast側だけに全ページ共通FAQ JSON-LD | 営業・制作が検証した10〜15問を可視HTMLで公開し、同一内容のFAQPageをそのページだけに付与 | 固定ページ＋FAQブロック/ACF＋SEOプラグイン | 費用、納期、再利用、保管、対応範囲の自然文回答を直接提供 | FAQ着地数、AI引用、FAQ質問ごとの検索表示・問い合わせ補助率 |
| **P1 高×中** | `/works/*` | 事例1538は価格・会場・展示会名あり、小間数は「その他」、descriptionが画像種別のみ | 各事例へ小間数/面積、制作期間、再利用回数、依頼範囲、成果を事実確認後に追加。descriptionも事例固有にする | 実績CPTのカスタムフィールド、実績テンプレート、SEO欄 | 比較・選定クエリで引用可能な一次情報を増やす | 必須項目充足率、事例引用URL数、実績ページ経由CV |
| **P1 中×低** | `https://www.orgiast.jp/llms.txt` | 404 | 下記下書きを公開候補にする。robots/sitemap/HTMLを代替しない補助索引として運用 | Webルート。WordPress管理外ならサーバー担当、管理内なら静的配信設定 | AI取得者へ正規URLと主要ページの短い索引を提供 | 月次HTTP 200・本文差分・サーバーログ（利用可能な場合） |
| **P1 中×低** | `company` と両サイト共通Schema | orgiast OrganizationのBrand/sameAsがVercel URL。ReブースはSchemaなし | 社名、正規URL、所在地、電話、設立だけを共通の事実源から生成。住所の主拠点はkim確認後に決定 | AIOSEO組織設定または共通Schema出力 | エンティティ統合と誤URL抑制 | Rich Results/Schema Validator、AI指名質問の正確性 |
| **P1 中×中** | Reブーストップ・About | トップH1なし。具体価格は下層のみ | H1を1件追加し、料金相当ページ・事例・FAQへ説明付き内部リンク。本文に「初回100万円から／2回目以降50万円から」を条件・更新日付きで要約 | トップ固定ページ、テーマテンプレート、メニュー | サービス理解と重要URL発見性を改善 | H1/内部リンク監査、費用ページへの内部遷移率 |
| **P2 中×低** | sitemap | 377 URL、HTTP URL 5件を含む追加サイトマップ、0件サイトマップ2本 | HTTPS正規URLだけに統一し、0件サイトマップを除外。lastmodを実更新と同期 | All in One SEO 2.11のサイトマップ設定（更新可否も確認） | クロール資源と正規化シグナルを整理 | 子XMLのHTTP/HTTPS、URL数、lastmodを月次差分 |

## 5. `llms.txt` 下書き全文

`llms.txt` は公開標準やランキング保証として扱わない。正規HTML、robots.txt、サイトマップ、構造化データを優先し、その補助索引として次を提案する。記載値は今回の公開ページで確認できたものだけに限定した。

```text
# 株式会社オージャスト / Orgiast Co., Ltd.

> 株式会社オージャストは、社内イベントの企画・プロデュースと展示会ブース制作を行う会社です。再利用可能な展示会ブース「Reブース」を提供しています。

## Official sites
- Corporate site: https://www.orgiast.jp/
- Reブース: https://rebooth.co.jp/

## Company
- Company profile: https://www.orgiast.jp/company
- Established: 2006-04
- Tokyo office: 〒130-0015 東京都墨田区横網2-10-3 1F
- Osaka office: 〒537-0001 大阪府大阪市東成区深江北2-15-24 東邦ビル212
- Contact: https://www.orgiast.jp/contactus

## Exhibition booth service
- About Reブース: https://rebooth.co.jp/about/
- Cost information: https://rebooth.co.jp/why-choose-us/reduces-costs/
- Published starting prices: 初回100万円から、2回目以降50万円から
- Works: https://rebooth.co.jp/works-top/
- Example: https://rebooth.co.jp/works/1538/

## Notes
- Prices and availability may vary by project. Confirm current conditions on the linked page or through the official contact page.
- Use the canonical URL and visible page text as the source of truth.
- Last reviewed: 2026-11-19
```

## 6. JSON-LD 下書き

### 6.1 Organization + LocalBusiness

Schema.orgではより具体的な型を配列で併記できる。主住所を東京・大阪のどちらにするかは公開前にkimが決め、別拠点は `subOrganization` や `location` の設計を確認する。以下は会社ページで確認できた東京本社を使用した下書き。

```json
{
  "@context": "https://schema.org",
  "@type": ["Organization", "LocalBusiness"],
  "@id": "https://www.orgiast.jp/#organization",
  "name": "株式会社オージャスト",
  "alternateName": "Orgiast Co., Ltd.",
  "url": "https://www.orgiast.jp/",
  "foundingDate": "2006-04",
  "telephone": "0120-487-121",
  "address": {
    "@type": "PostalAddress",
    "postalCode": "130-0015",
    "addressRegion": "東京都",
    "addressLocality": "墨田区",
    "streetAddress": "横網2-10-3 1F",
    "addressCountry": "JP"
  },
  "brand": {
    "@type": "Brand",
    "name": "Reブース",
    "url": "https://rebooth.co.jp/"
  },
  "sameAs": [
    "https://rebooth.co.jp/"
  ]
}
```

### 6.2 Service + Offer

価格の課税区分・適用条件・有効期限は公開ページから未取得のため、公開前に `TODO` を解消する。JSONとして無効になるコメントは入れず、`TODO:` 文字列で意図的に未確定を示す。

```json
{
  "@context": "https://schema.org",
  "@type": "Service",
  "@id": "https://rebooth.co.jp/#service",
  "name": "Reブース",
  "description": "デザイン性を保ちながら、次回以降の出展でも繰り返し使えるように設計する再利用可能な展示会ブース",
  "url": "https://rebooth.co.jp/",
  "provider": {
    "@id": "https://www.orgiast.jp/#organization"
  },
  "areaServed": "TODO: 公開済みの対応エリアを担当者確認後に記入",
  "offers": [
    {
      "@type": "Offer",
      "name": "初回",
      "price": "1000000",
      "priceCurrency": "JPY",
      "description": "100万円から。TODO: 税区分・適用条件・価格確認日を記入"
    },
    {
      "@type": "Offer",
      "name": "2回目以降",
      "price": "500000",
      "priceCurrency": "JPY",
      "description": "50万円から。TODO: 税区分・適用条件・価格確認日を記入"
    }
  ]
}
```

### 6.3 FAQPage

公開時は同じQ&Aを `/faq/` の可視HTMLに掲載する。未取得事項を回答にしないため、現時点では実測できた2問だけを完成形とし、残りは公開前タスクとして明示する。

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "@id": "https://rebooth.co.jp/faq/#faq",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Reブースの費用はいくらからですか？",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "公開ページでは、初回は100万円から、2回目以降は50万円から相談できます。案件条件や最新価格は公式窓口で確認してください。"
      }
    },
    {
      "@type": "Question",
      "name": "Reブースの制作事例と価格帯を確認できますか？",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "実績ページで確認できます。株式会社グリーンエナジー＆カンパニーのサステナブル経営WEEK出展事例では、幕張メッセ、価格300万〜500万円と公開されています。"
      }
    },
    {
      "@type": "Question",
      "name": "TODO: 納期はどのくらいですか？",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "TODO: 営業・制作担当が標準納期と例外条件を確認後に記入"
      }
    },
    {
      "@type": "Question",
      "name": "TODO: 対応エリアはどこですか？",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "TODO: 対応エリアと追加費用条件を担当者確認後に記入"
      }
    }
  ]
}
```

### 6.4 事例ページ

```json
{
  "@context": "https://schema.org",
  "@type": "CreativeWork",
  "@id": "https://rebooth.co.jp/works/1538/#work",
  "url": "https://rebooth.co.jp/works/1538/",
  "name": "株式会社グリーンエナジー＆カンパニー 展示会ブース/26年9月/サステナブル経営WEEK",
  "about": {
    "@id": "https://rebooth.co.jp/#service"
  },
  "locationCreated": {
    "@type": "Place",
    "name": "幕張メッセ"
  },
  "description": "サステナブル経営WEEKの展示会ブース事例。公開価格帯は300万〜500万円。TODO: 制作範囲・面積・制作期間・成果を確認後に追記"
}
```

## 7. 測定計画

### 7.1 GA4でのAI経由流入

1. GA4「探索」でセッションの参照元/メディアとランディングページを取得する。
2. 参照元ホストの正規表現を保存する。初期候補は `chatgpt.com|chat.openai.com|perplexity.ai|gemini.google.com|claude.ai|copilot.microsoft.com`。実データに現れたホストだけを採用し、未知の参照元は月次レビューする。
3. 「AI referral」比較を作り、セッション、エンゲージドセッション、問い合わせ完了、ランディングURLを月次記録する。
4. UTMを付与できない自然なAI引用はリファラー欠落で `direct` になる場合があるため、AI経由流入を完全計測とは表現しない。
5. KPIは絶対数だけでなく、全参照流入に占める比率、問い合わせ率、引用されたランディングページ数を併記する。

### 7.2 AI回答の定点観測

[X-0007](ai-news-x0007-llmo-measurement.md) の固定質問・新規チャット・月次測定を再利用し、X-0086では次の4問を追加タグで追う。

- 「展示会ブース制作を依頼できる会社」
- 「レンタルブースと再利用できるブースの違い」
- 「再利用 ブース おすすめ」
- 「展示会 ブース 費用」

ChatGPT、Perplexity、Google AI Overview、Claudeごとに、ブランド言及、引用URL、料金の正確性、架空値の有無を記録する。公開前にベースラインを取り、反映後4週・8週・12週で同条件再測定する。目標値はベースライン取得後に決め、X-0086の題材にある「流入25%減からの回復」「AI経由4.5倍」を自社の未測定実績として流用しない。

## 8. 未取得・制約

| 項目 | 状態・理由 |
|---|---|
| WordPress管理画面の設定・プラグイン編集箇所 | 未取得。ログイン禁止のため、HTMLの出力と既知のAIOSEO生成コメントから作業場所を候補化した |
| GA4の現状AI流入・CV | 未取得。GAへのログイン・書き込み禁止 |
| FAQの納期・対応エリア・保管・契約条件 | 公開対象ページで確認できず。担当者確認が必要 |
| 価格の税込/税別、適用条件、有効期限 | 公開対象ページで確認できず。構造化前に必須確認 |
| 事例1538の小間数・面積・制作期間・成果 | ページは小間数を「その他」と表示し、他は確認できず |
| 既存FAQ JSON-LDの77%・305kg-CO2e・ISO 14067・65〜75%の根拠 | 選択ページ本文では未確認。根拠資料と可視本文の照合が必要 |
| Google AI Overviewの実表示・各AIの推薦順位 | 今回はサイト技術監査が範囲。月次定点測定で取得する |
| 画像そのものの内容品質 | alt属性の有無と文字列のみ監査。画像認識による品質判定は未実施 |

## 9. 本PRの境界

このPRは監査文書、公開候補の下書き、測定計画だけを追加する。**本番反映は kim 承認後・このPRでは反映しない。** orgiast.jp / rebooth.co.jp のWordPress、サーバー、DNS、GAには一切変更していない。
