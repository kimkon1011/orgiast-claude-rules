# 著者資格（Author Credential）マークアップ仕様

> X-0055: EEATシグナル強化のための著者情報構造化データ

**根拠**: Yext調査で著者情報エンリッチメントによりAI引用率が約1.8倍に向上。GoogleのEEAT評価においても著者情報の明示が重要。

---

## 1. マークアップ対象

| ページ種別 | 対象者 | 用途 |
|-----------|-------|------|
| ブログ記事 | 記事著者 | Article.author として紐付け |
| 事例ページ (/case/) | 担当者 | 実績の信頼性担保 |
| 会社概要 (/company/) | 代表者・役員 | Organization の紐付け |
| サービスページ | ディレクター | 専門性の証明 |
| トップページ | 代表者 | サイト全体の信頼性 |

---

## 2. Person スキーマテンプレート

```json
{
  "@context": "https://schema.org",
  "@type": "Person",
  "@id": "https://www.orgiast.jp/about/#person-{slug}",
  "name": "{氏名}",
  "givenName": "{名}",
  "familyName": "{姓}",
  "jobTitle": "{役職}",
  "worksFor": {
    "@type": "Organization",
    "@id": "https://www.orgiast.jp/#organization",
    "name": "株式会社オージャスト"
  },
  "knowsAbout": ["{専門分野1}", "{専門分野2}", "{専門分野3}"],
  "description": "{プロフィール（140字以内）}",
  "url": "https://www.orgiast.jp/company/#member-{slug}",
  "image": "https://www.orgiast.jp/images/team/{slug}.jpg"
}
```

## 3. 具体例

### 3.1 代表者

```json
{
  "@type": "Person",
  "name": "金 功勇",
  "givenName": "功勇",
  "familyName": "金",
  "jobTitle": "代表取締役",
  "worksFor": { "@type": "Organization", "name": "株式会社オージャスト" },
  "knowsAbout": [
    "展示会ブース制作", "社内イベントプロデュース", "イベント運営管理"
  ],
  "description": "年間100件以上の展示会ブース制作・社内イベントを手がけるイベント制作のプロフェッショナル。大阪市ベンチャー調達制度認定企業の経営者。",
  "birthDate": "",
  "nationality": { "@type": "Country", "name": "Japan" }
}
```

### 3.2 デザインディレクター（事例ページ用）

```json
{
  "@type": "Person",
  "name": "山田 太郎",
  "jobTitle": "展示会ブース デザインディレクター",
  "worksFor": { "@type": "Organization", "name": "株式会社オージャスト" },
  "knowsAbout": ["ブースデザイン", "空間設計", "照明デザイン", "3D CAD"],
  "description": "展示会ブースデザイン歴15年。自動車・IT・製造業など100件以上のブースデザインを担当。"
}
```

## 4. Article + author 紐付け

ブログ記事・事例ページの Article スキーマに author を追加:

```json
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "{記事タイトル}",
  "author": {
    "@type": "Person",
    "@id": "https://www.orgiast.jp/about/#person-{slug}"
  },
  "publisher": {
    "@type": "Organization",
    "@id": "https://www.orgiast.jp/#organization"
  },
  "datePublished": "2026-01-15",
  "dateModified": "2026-11-01"
}
```

## 5. ブログ記事への適用手順

1. 各記事作成時に `author` フィールドに該当Personの `@id` を指定
2. 複数著者の場合は `author: [Person1, Person2]` の配列形式
3. ゲスト著者の場合は個別のPersonスキーマを作成
4. Personスキーマは `about/#person-{slug}` でID管理

## 6. 事例ページへの適用手順

1. 事例ページの Article/Project スキーマに author 追加
2. 担当デザイナー・ディレクターのPersonスキーマをID参照
3. チーム制作の場合は主要担当者1名を author、他を contributor に

## 7. 優先度

| 優先度 | 対象 | 理由 |
|--------|------|------|
| P1 | 会社概要の代表者Person | サイト全体のEEAT基底 |
| P1 | ブログ記事のauthor紐付け | AI引用率1.8倍が期待できる |
| P2 | 事例ページの担当者 | 実績の信頼性向上 |
| P2 | サービスページのディレクター | 専門性の証明 |