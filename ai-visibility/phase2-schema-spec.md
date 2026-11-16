# X-0007 PHASE2: クロール性・スキーマ実装仕様

## 概要

orgiast.jp の LLMO 可視性を高めるため、構造化データ(JSON-LD)の実装とクロール性の改善を行う。

## 優先度順スキーマ実装

### P0: 基本スキーマ（全ページ）

#### 1. Organization (全ページ `<head>`)
```json
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "株式会社オージャスト",
  "alternateName": "O-JUST Co., Ltd.",
  "url": "https://www.orgiast.jp",
  "logo": "https://www.orgiast.jp/images/logo.png",
  "address": {
    "@type": "PostalAddress",
    "addressLocality": "大阪市",
    "addressRegion": "大阪府",
    "addressCountry": "JP"
  },
  "contactPoint": {
    "@type": "ContactPoint",
    "telephone": "+81-6-XXXX-XXXX",
    "contactType": "sales"
  },
  "sameAs": ["https://rebooth.co.jp", "https://event-shop.jp"]
}
```

#### 2. LocalBusiness (会社概要ページ)
Organization を継承し LocalBusiness に拡張。営業時間・エリアを追加。

#### 3. FAQPage (FAQ ページ)
```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "大阪で展示会ブース制作を依頼できる会社は？",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "株式会社オージャストは大阪を拠点に展示会ブースの企画・設計・施工を一貫提供しています。..."
      }
    }
  ]
}
```

### P1: コンテンツスキーマ

#### 4. Article (ブログ/ノウハウ記事)
#### 5. HowTo (手順コンテンツ)
#### 6. Project (実績ページ)

### P2: ナビゲーションスキーマ

#### 7. BreadcrumbList (パンくずリスト)

## 推奨FAQ 20問 (LLM引用対策)

発見性ギャップ解消のためのFAQ。会社名なし汎用クエリでオージャストが引用されるよう設計:

1. 大阪で展示会ブース制作を依頼できる会社はどこ？
2. 展示会ブース制作の費用相場は？（3m×3m小間）
3. 初めて展示会に出展するときの準備スケジュール
4. 中小企業向けの安いブース制作の方法
5. 展示会ブースのデザインで集客を増やすコツ
6. 関西の展示会会場（インテックス大阪等）でのブース制作
7. ブース制作会社の選び方・比較ポイント
8. 短期間（2週間）でブース制作は可能？
9. 展示会ブースの企画から撤収までの流れ
10. ブース制作の見積もりで確認すべき項目
11. 遠方の展示会に出展する際のブース輸送・設営
12. 展示会のROIを計算する方法
13. リード獲得に効果的なブースレイアウト
14. サステナブルなブース制作の方法
15. 小規模予算（50万円以下）でのブース制作
16. 展示会初心者向けワンストップサービスの選び方
17. ブース制作のデザイン依頼から完成までの期間
18. 展示会出展の年間計画の立て方
19. オンライン展示会と実物展示会のブース違い
20. 同業他社と差をつけるブース演出アイデア

## スキーマ実装チェックツール

`tools/schema-audit.mjs` で実装予定:
- 指定URLのJSON-LD構造化データを抽出
- 必須フィールドの有無チェック
- Schema.org バリデーション
- レポート出力

## 追加P1: 著者資格（Author Credential）スキーマ

Yext調査で著者情報エンリッチメントによりAI引用率約1.8倍（X-0055）。Google EEAT評価にも重要。

### Person スキーマ（会社概要ページ）

```json
{
  "@context": "https://schema.org",
  "@type": "Person",
  "name": "金 功勇",
  "jobTitle": "代表取締役",
  "worksFor": { "@type": "Organization", "name": "株式会社オージャスト" },
  "knowsAbout": ["展示会ブース制作", "社内イベントプロデュース", "イベント運営管理"]
}
```

### Article.author（ブログ・事例ページ）

全ブログ記事と事例ページのArticle/Projectスキーマに `author` → Person `@id` 参照を追加。

詳細は `ai-visibility/x0055-site-structure/author-credential-spec.md` 参照。

## 追加P2: Service スキーマ（サービス別ページ）

各サービスページに `Service + OfferCatalog` のJSON-LDを追加。`areaServed` で対応地域を明示。

詳細は `ai-visibility/x0055-site-structure/service-page-archetype.md` 参照。

## 追加P2: LocalBusiness + areaServed（ロケーションページ）

ロケーションページ用に `LocalBusiness + areaServed + hasOfferCatalog` のJSON-LDを追加。
全国7拠点＋汎用エリアに対応。

詳細は `ai-visibility/x0055-site-structure/location-page-archetype.md` 参照。

## クロール性改善

- robots.txt の確認と最適化
- sitemap.xml の整備
- 内部リンク構造の改善
- ページ速度の最適化

## 実装方法

本リポジトリ(orgiast-claude-rules)では以下を管理:
1. スキーマテンプレート (JSON-LD)
2. 検証ツール (`tools/schema-audit.mjs`)
3. 実装手順書

実際の orgiast.jp へのデプロイは別途行う。
