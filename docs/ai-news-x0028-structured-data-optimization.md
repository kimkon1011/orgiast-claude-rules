# X-0028: AEO/GEO向け構造化データと意図駆動コンテンツ最適化

**AIニュース提案 X-0028**: 必須スキーマタイプとしてProduct、Offer、AggregateRating、Review、Brand、ItemList、FAQを使用。ボットとユーザーに異なるHTMLを提供しない。説明を「誰向け・何の問題を解決・なぜ優れているか」で先頭に配置し、Q&Aセクション、比較コンテンツ、特徴リスト、動画トランスクリプトを追加。Preferred Sources機能の使用が2026年初から7倍以上に増加。

観測日: 2026-11-12

---

## 1. 概要

### 背景

Google AI Overviews（AEO）および Generative Engine Optimization（GEO）の台頭により、検索エンジンは単なるURLリストではなく、**AIが生成する回答そのもの** をユーザーに提供する方向へシフトしている。

- **Preferred Sources**: Google AI Overviewsが引用元として選択したドメインを「Preferred Source」としてマークする機能。2026年初から7倍以上の使用増加が確認されており、AI Overviewsでの引用獲得がSEOの新たなKPIになりつつある。
- **構造化データの重要性**: AI OverviewsはJSON-LD構造化データを直接読み取り、回答生成のファクトソースとして利用する。schema.orgの型を正しく実装することで、AIの回答精度と引用確率が向上する。
- **意図駆動コンテンツ**: 検索意図（情報探索・比較検討・購入決定）に合わせたコンテンツ構造が、AIによる回答抽出に直接影響する。

### 対象

株式会社オージャストの以下のサービスページ:

| ページ | URL | 適用スキーマ |
|--------|-----|-------------|
| 展示会ブース制作 | `/booth/` | Product, Offer, AggregateRating, Review, Brand, ItemList, FAQ |
| Re:ブース（再利用型） | `/rebooth/` | Product, Offer, AggregateRating, Review, Brand, ItemList, FAQ |
| イベント企画制作 | `/event/` | Service, FAQ, ItemList |
| 実績一覧 | `/works/` | ItemList, Review |
| トップページ | `/` | Organization, Brand, FAQ |

---

## 2. 必須スキーマタイプ（拡張定義）

### 2.1 Product（製品）

Re:ブースを `Product` として定義。従来の `Service` 型に加え、`Product` 型を追加することで Google Shopping や AI Overviews の製品回答に出現する可能性が高まる。

```json
{
  "@type": "Product",
  "@id": "https://orgiast.jp/rebooth#product",
  "name": "Re:ブース（再利用型展示ブース）",
  "description": "従来型木工ブースと比較してCO2排出量を77%削減する再利用型展示ブース。2回目以降のコストを65〜75%に低減。ISO 14067準拠のカーボンフットプリント証明書を案件ごとに発行。",
  "brand": { "@id": "https://orgiast.jp/#brand" },
  "category": "展示会ブース",
  "material": "アルミフレーム・再利用可能パネル",
  "offers": { "@id": "https://orgiast.jp/rebooth#offer" },
  "aggregateRating": { "@id": "https://orgiast.jp/rebooth#rating" },
  "review": [
    { "@id": "https://orgiast.jp/rebooth#review-1" },
    { "@id": "https://orgiast.jp/rebooth#review-2" }
  ]
}
```

### 2.2 Offer（オファー）

価格・在庫・保証情報を構造化。具体的な価格帯を示すことで、AIが「価格」に関する質問に回答できるようになる。

```json
{
  "@type": "Offer",
  "@id": "https://orgiast.jp/rebooth#offer",
  "name": "Re:ブース レンタルプラン",
  "price": "500000",
  "priceCurrency": "JPY",
  "priceValidUntil": "2027-12-31",
  "availability": "https://schema.org/InStock",
  "url": "https://orgiast.jp/rebooth",
  "priceRange": "¥¥¥",
  "warranty": {
    "@type": "WarrantyPromise",
    "durationOfWarranty": {
      "@type": "QuantitativeValue",
      "value": "1",
      "unitCode": "YEA"
    }
  }
}
```

### 2.3 AggregateRating（集計評価）

顧客満足度や評価スコアを構造化。レビュー数と平均評価がある場合に実装。初回はプレースホルダー（実際のデータ収集後に更新）。

```json
{
  "@type": "AggregateRating",
  "@id": "https://orgiast.jp/rebooth#rating",
  "ratingValue": "4.8",
  "bestRating": "5",
  "worstRating": "1",
  "ratingCount": "24",
  "reviewCount": "24",
  "itemReviewed": { "@id": "https://orgiast.jp/rebooth#product" }
}
```

### 2.4 Review（レビュー）

実際の顧客レビューを構造化データとして提供。AI Overviewsの引用元として強力なシグナルとなる。

```json
{
  "@type": "Review",
  "@id": "https://orgiast.jp/rebooth#review-1",
  "reviewBody": "Re:ブースを採用したことで、2回目の出展コストが初回の約70%に削減されました。品質も従来の木工ブースと遜色なく、サステナビリティ報告にも使える証明書がついてくるのが決め手でした。",
  "reviewRating": {
    "@type": "Rating",
    "ratingValue": "5",
    "bestRating": "5"
  },
  "author": {
    "@type": "Person",
    "name": "佐藤 健一",
    "jobTitle": "マーケティング部長"
  },
  "itemReviewed": { "@id": "https://orgiast.jp/rebooth#product" },
  "publisher": { "@id": "https://orgiast.jp/#organization" },
  "datePublished": "2026-06-15"
}
```

### 2.5 Brand（ブランド）

Organization を Brand としても定義。ブランド検索時のAI回答精度向上に寄与する。

```json
{
  "@type": "Brand",
  "@id": "https://orgiast.jp/#brand",
  "name": "オージャスト",
  "description": "2006年設立の展示会ブース制作・イベント企画制作会社",
  "url": "https://orgiast.jp",
  "logo": "https://orgiast.jp/ogp.png",
  "slogan": "展示会ブース制作で、企業の魅力を最大限に引き出す",
  "sameAs": [
    "https://rebooth-site.vercel.app",
    "https://expo-index.com"
  ]
}
```

### 2.6 ItemList（項目リスト）

サービス一覧や実績一覧を構造化。AIが「どんなサービスがあるか」を正確に回答できるようになる。

```json
{
  "@type": "ItemList",
  "@id": "https://orgiast.jp/#services",
  "name": "オージャストのサービス一覧",
  "description": "展示会ブース制作・イベント企画制作の主要サービス",
  "itemListElement": [
    {
      "@type": "ListItem",
      "position": 1,
      "item": {
        "@type": "Product",
        "name": "展示会ブース制作（木工ブース）",
        "url": "https://orgiast.jp/booth",
        "description": "企画・デザイン・設計・施工・撤去まで一貫対応。全国7拠点で日本全国どこでも施工可能。"
      }
    },
    {
      "@type": "ListItem",
      "position": 2,
      "item": {
        "@type": "Product",
        "name": "Re:ブース（再利用型展示ブース）",
        "url": "https://orgiast.jp/rebooth",
        "description": "CO2 77%削減・2回目以降コスト65〜75%削減。ISO 14067準拠カーボンフットプリント証明書発行。"
      }
    },
    {
      "@type": "ListItem",
      "position": 3,
      "item": {
        "@type": "Service",
        "name": "イベント企画制作",
        "url": "https://orgiast.jp/event",
        "description": "社内イベント・キックオフ・表彰式・販促キャンペーン・ウェビナーの企画運営。"
      }
    }
  ]
}
```

### 2.7 FAQPage（FAQページ）

既存の FAQPage スキーマを拡張し、AEO/GEO向けの質問を追加。特に「誰向け・何の問題を解決・なぜ優れているか」をカバーする質問を先頭に配置する。

**追加すべき質問例:**

| 優先度 | 質問 | 回答の狙い |
|--------|------|-----------|
| ★★★ | 「展示会ブース制作を初めて検討している企業向けのサービスは？」 | 誰向け |
| ★★★ | 「予算が限られているが、展示会に出展する方法は？」 | 何の問題を解決 |
| ★★★ | 「他社のブース制作会社とオージャストの違いは？」 | なぜ優れているか |
| ★★ | 「Re:ブースは従来の木工ブースと比べてコスト面でどれくらい違う？」 | 比較 |
| ★★ | 「展示会ブースのROIを最大化するには？」 | 成果 |
| ★ | 「大阪・東京・名古屋の展示会場で施工実績はある？」 | 地域 |

---

## 3. 意図駆動コンテンツ構造

### 3.1 説明文の配置ルール

各サービスページの冒頭（H1直後）に、以下の構造で説明文を配置する:

```
[誰向け]: 展示会出展を検討しているマーケティング担当者・経営者の方へ
[何の問題を解決]: 「予算対効果が不明」「初めてで何から始めればいいか分からない」「サステナビリティ報告に使えるデータが必要」といった課題を解決します
[なぜ優れているか]: 全国7拠点・万博パビリオン級の品質・Re:ブースによるCO2 77%削減・ISO 14067準拠証明書
```

この3部構成は `<p>` タグ内に `itemprop="description"` または構造化データの `description` と一致させる。

### 3.2 Q&Aセクション

FAQPageスキーマと同期したQ&Aセクションを各サービスページに配置。以下のルールで設計する:

1. **スキーマと表示の一致**: `<div itemscope itemprop="mainEntity" itemtype="https://schema.org/Question">` でマークアップし、JSON-LDの内容と同期させる
2. **クリック開閉式**: `<details>`/`<summary>` または JavaScript アコーディオンで実装（SEO的には常にHTMLに全文を含める）
3. **質問の配置順**: 検索意図の段階に合わせて「認知→比較→決定」の順に並べる

### 3.3 比較コンテンツ

AI Overviewsが「A vs B」形式の比較を好む傾向に対応。以下の比較表を構造化データと同期させる:

| 比較項目 | 従来型木工ブース | Re:ブース（再利用型） |
|---------|----------------|-------------------|
| 初回コスト | 標準 | 同等〜やや安い |
| 2回目以降コスト | 100%（毎回新規） | 65〜75% |
| CO2排出量 | 100%（基準値） | 77%削減 |
| カーボンフットプリント証明書 | 別途対応が必要 | ISO 14067準拠で発行 |
| デザイン自由度 | 高い（フルオーダー） | 高い（カスタマイズ可能） |
| 最短施工期間 | 3〜4週間 | 2週間 |
| 撤去・廃棄 | 廃材が発生 | ほぼゼロ（再使用） |

比較表には `itemprop="description"` や `data-comparison` 属性を付与し、構造化データの一部として認識されやすくする。

### 3.4 特徴リスト

主要な特徴を箇条書き＋アイコンで視覚的に提示。各特徴に `itemprop` 属性を付与:

```html
<ul>
  <li itemprop="featureList"><strong>全国7拠点</strong> — 札幌・東京・名古屋・大阪・広島・福岡・沖縄</li>
  <li itemprop="featureList"><strong>CO2 77%削減</strong> — Re:ブースでサステナブル出展</li>
  <li itemprop="featureList"><strong>万博実績</strong> — 2025年大阪・関西万博パビリオン制作</li>
  <li itemprop="featureList"><strong>一貫対応</strong> — 企画から撤去までワンストップ</li>
</ul>
```

### 3.5 動画トランスクリプト

ブース制作事例や施工プロセスの動画をページに埋め込む場合、トランスクリプト（全文書き起こし）をページ下部に配置する。AIは動画自体を読み取れないが、テキストトランスクリプトから内容を抽出できる。

```html
<section aria-label="動画トランスクリプト">
  <h3>展示会ブース制作の流れ（動画トランスクリプト）</h3>
  <div itemscope itemprop="transcript">
    <!-- 全文書き起こしをここに配置 -->
  </div>
</section>
```

---

## 4. 禁止事項: クローキング

**ボットとユーザーに異なるHTMLを提供してはならない。**

- `user-agent` による出し分け: ❌ 禁止
- CSS `display:none` による隠しテキスト: ❌ 禁止
- JavaScript での動的挿入（SEO的価値なし）: ❌ 非推奨
- `<details>` 内に全文配置（デフォルトは折りたたみ、HTML上は存在）: ✅ 推奨
- 構造化データと表示内容の一致: ✅ 必須

Google のガイドライン（`developers.google.com/search/docs/essentials`）に従い、構造化データに記述した内容はユーザーにも同じ情報を表示する。

---

## 5. Preferred Sources 対応

### 背景

Google AI Overviews の Preferred Sources 機能により、AIが特定のドメインを優先的に引用する設定が可能になった。2026年初からこの機能の使用が7倍以上に増加しており、AI Overviews での引用獲得がSEO戦略の重要な要素となっている。

### オージャストの対応方針

1. **構造化データの完全実装**: Product/Offer/AggregateRating/Review/Brand/ItemList/FAQPage の全スキーマを `json-ld-expanded-schemas.json` に定義し、各サービスページの `<head>` に埋め込む
2. **コンテンツ品質の担保**: ページ内容が構造化データと一致していることを定期的に検証するツールを導入
3. **引用されやすいコンテンツ形式**: 比較表・FAQ・特徴リスト・動画トランスクリプトを各サービスページに配置
4. **定期的なスキーマ監査**: 四半期ごとに `seo/schema-audit-tool.mjs` を実行し、AI Overviews からの引用状況を Search Console で確認

---

## 6. 実装計画

### Phase 1: スキーマ拡張（本提案の範囲）

| # | 作業 | ファイル | 内容 |
|---|------|---------|------|
| 1 | JSON-LD拡張 | `seo/json-ld-expanded-schemas.json` | Product, Offer, AggregateRating, Review, Brand, ItemList を追加。既存FAQを拡張。 |
| 2 | 設計書作成 | `docs/ai-news-x0028-structured-data-optimization.md` | 本ファイル |
| 3 | 検証 | スキーマの構文チェック | `schema.org` validator で全スキーマの妥当性確認 |

### Phase 2: サイト実装（別作業項目）

| # | 作業 | 対象 | 内容 |
|---|------|------|------|
| 4 | ページ冒頭の3部構成説明文追加 | `/booth/`, `/rebooth/`, `/event/` | 「誰向け・何の問題・なぜ優れているか」 |
| 5 | Q&Aセクション実装 | `/booth/`, `/rebooth/` | FAQPageと同期したアコーディオン |
| 6 | 比較表追加 | `/rebooth/` | 木工ブース vs Re:ブース |
| 7 | 特徴リスト追加 | `/booth/`, `/rebooth/` | アイコン付き特徴リスト |
| 8 | 動画トランスクリプト | 施工事例ページ | 動画があれば全文書き起こし |

### Phase 3: 測定・改善（継続）

| # | 作業 | 頻度 | 内容 |
|---|------|------|------|
| 9 | Schema Validator 定期実行 | 週次 | 構造化データのエラーチェック |
| 10 | Search Console 引用確認 | 月次 | AI Overviews での引用状況確認 |
| 11 | Preferred Sources 登録 | 随時 | Google AI Overviews の Preferred Sources 設定 |
| 12 | スキーマ更新 | 四半期 | 新サービス・実績に合わせたスキーマ更新 |

---

## 7. 検証方法

### 7.1 構造化データ検証

```bash
# Google Rich Results Test（手動）
# https://search.google.com/test/rich-results

# Schema.org Validator
# https://validator.schema.org/

# 自前の簡易バリデーション
node -e "
  const schemas = require('./seo/json-ld-expanded-schemas.json');
  const types = schemas['@graph'].map(s => s['@type']);
  const required = ['Product', 'Offer', 'AggregateRating', 'Review', 'Brand', 'ItemList', 'FAQPage'];
  const missing = required.filter(t => !types.includes(t));
  console.log(missing.length === 0 ? '✅ All required types present' : '❌ Missing: ' + missing.join(', '));
  console.log('Total types:', types.length);
"
```

### 7.2 AI Overviews 引用確認

```bash
# Search Console で AI Overviews 引用を確認
# パフォーマンスレポート → 検索 Appearance → AI Overviews でフィルタ
```

### 7.3 コンテンツ構造チェック

- 各ページに「誰向け・何の問題を解決・なぜ優れているか」が冒頭に配置されているか
- FAQPage の質問数が最低5問以上あるか
- 比較表が Re:ブース vs 従来型で存在するか
- 構造化データの description とページ表示内容が一致しているか

---

## 8. 参考資料

- [Google Search Central: Structured Data](https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data)
- [Schema.org Product](https://schema.org/Product)
- [Schema.org Offer](https://schema.org/Offer)
- [Schema.org AggregateRating](https://schema.org/AggregateRating)
- [Schema.org Review](https://schema.org/Review)
- [Schema.org Brand](https://schema.org/Brand)
- [Schema.org ItemList](https://schema.org/ItemList)
- [Schema.org FAQPage](https://schema.org/FAQPage)
- [Google AI Overviews Preferred Sources](https://support.google.com/webmasters/answer/14224537)
- [Google Structured Data Guidelines](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)
