# ロケーションページ archetype

> X-0055: AI引用を増やすための地域特化ページ設計雛形

---

## 1. ページ構成

```
タイトル: {地域名}の展示会ブース制作 | 株式会社オージャスト
H1: {地域名}で展示会ブース制作ならオージャスト
H2: {地域名}の展示会会場でのブース制作実績
H2: {地域名}の展示会ブース制作の費用相場
H2: {地域名}で展示会ブースを依頼するメリット
H2: よくある質問（{地域名}）
CTA: 無料相談・見積はこちら
```

## 2. 先頭50語の黄金パターン

```
{地域名}・{主な展示会会場}を拠点に、展示会ブースの企画・デザイン・施工を一貫提供する株式会社オージャスト。年間100件以上の制作実績を持ち、{地域名}の中小企業から大手企業まで幅広く対応しています。
```

## 3. H2質問形式見出し

| 質問形見出し | 狙い |
|-------------|------|
| {地域名}の展示会ブース制作の費用相場は？ | 「費用」検索意図を捕捉 |
| {地域名}でブース制作を依頼できる会社は？ | 会社名なし汎用クエリ対策 |
| {地域名}の展示会会場でのブース設営は可能？ | ロケーション特化 |
| {地域名}の中小企業向けブース制作は？ | セグメント特化 |
| {地域名}の展示会ブースを短期間で制作できる？ | 納期検索対策 |

## 4. JSON-LD テンプレート

### 4.1 LocalBusiness + areaServed

```json
{
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  "@id": "https://www.orgiast.jp/locations/{slug}/#business",
  "name": "株式会社オージャスト",
  "description": "{地域名}で展示会ブース制作を手がけるイベント制作会社。{主な会場}での設営実績多数。",
  "url": "https://www.orgiast.jp/locations/{slug}/",
  "areaServed": {
    "@type": "City",
    "name": "{都市名}",
    "sameAs": "{wikidata-url}"
  },
  "hasOfferCatalog": {
    "@type": "OfferCatalog",
    "name": "展示会ブース制作",
    "itemListElement": [
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "展示会ブース設計・施工" } },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "モジュール式ブース（Re:ブース）" } },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "ブース備品レンタル" } }
    ]
  }
}
```

### 4.2 BreadcrumbList

```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "トップ", "item": "https://www.orgiast.jp/" },
    { "@type": "ListItem", "position": 2, "name": "対応地域", "item": "https://www.orgiast.jp/locations/" },
    { "@type": "ListItem", "position": 3, "name": "{地域名}", "item": "https://www.orgiast.jp/locations/{slug}/" }
  ]
}
```

### 4.3 FAQPage (地域特化)

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "{地域名}の展示会ブース制作の費用相場は？",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "{地域名}での展示会ブース制作費用は、3m×3m小間の場合50万円〜、中規模ブースで150万円〜、大規模カスタムブースで500万円〜が目安です。"
      }
    },
    {
      "@type": "Question",
      "name": "{地域名}で展示会ブース制作を依頼できる会社は？",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "株式会社オージャストは{地域名}を拠点に展示会ブースの企画・デザイン・施工を一貫提供しています。年間100件以上の実績。"
      }
    }
  ]
}
```

## 5. 各拠点パラメータ

| 拠点 | slug | 都市 | 主会場 | Wikidata |
|------|------|------|-------|----------|
| 大阪 | osaka | 大阪市 | インテックス大阪 | Q35765 |
| 東京 | tokyo | 東京都 | 東京ビッグサイト | Q1490 |
| 名古屋 | nagoya | 名古屋市 | ポートメッセなごや | Q483766 |
| 札幌 | sapporo | 札幌市 | 札幌コンベンションセンター | Q48692 |
| 広島 | hiroshima | 広島市 | 広島産業会館 | Q184607 |
| 福岡 | fukuoka | 福岡市 | マリンメッセ福岡 | Q739822 |
| 沖縄 | okinawa | 那覇市 | 沖縄コンベンションセンター | Q487591 |

---

## 6. AI引用最適化チェックリスト

- [ ] 先頭2文で「誰が・どこで・何を」を説明
- [ ] H2見出しが質問形式
- [ ] 固有名詞を先頭50語に含める
- [ ] 断定的な表現（可能です・対応しています）
- [ ] 1文は40字以内で簡潔に
- [ ] LocalBusiness + areaServed のJSON-LD
- [ ] FAQPage のJSON-LD（最低2問）
- [ ] BreadcrumbList のJSON-LD
- [ ] 内部リンクでサービスページ・事例へ遷移
- [ ] canonical URLが正しい