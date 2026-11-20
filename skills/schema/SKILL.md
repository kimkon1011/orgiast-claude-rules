---
name: schema
description: Schema.org の構造化データ（JSON-LD）を実装・検証する。展示会（Event）・組織（Organization）・製品（Product）・FAQ・パンくずリスト・レビューのマークアップを生成し、Google リッチリザルト対応を確認する。「構造化データ」「Schema.org」「JSON-LD」「リッチリザルト」「スキーママークアップ」「リッチスニペット」「schema」と言われたらこのスキルを使う。
---

# Schema.org 構造化データ実装（schema）

展示会ブース制作サイトに構造化データ（JSON-LD）を実装し、Google リッチリザルト表示を獲得する。

## 1. 対応スキーマ

| ページ種別 | Schema.org タイプ | 主なプロパティ |
|---|---|---|
| 会社概要 | `Organization` | `name`・`logo`・`url`・`address`・`contactPoint`・`sameAs` |
| 展示会実績 | `Event` + `ExhibitionEvent`（拡張） | `name`・`startDate`・`location`・`image`・`description` |
| 制作事例 | `CreativeWork` + `Product` | `name`・`image`・`description`・`about`（イベント） |
| サービス一覧 | `Service` | `name`・`provider`・`areaServed`・`category` |
| よくある質問 | `FAQPage` + `Question`/`Answer` | `mainEntity[].name`・`mainEntity[].acceptedAnswer.text` |
| パンくず | `BreadcrumbList` | `itemListElement[].name`・`itemListElement[].item` |
| お客様の声 | `Review` + `ReviewAction` | `itemReviewed`・`reviewBody`・`reviewRating`・`author` |

## 2. 実装手順

1. 該当ページの種類を特定し、適切な Schema.org タイプを選ぶ
2. JSON-LD ブロックを生成（`<script type="application/ld+json">`）
3. Google リッチリザルトテスト（`https://search.google.com/test/rich-results`）または `curl` + Schema.org バリデーターで検証
4. 全ページに適用後、サイトマップと併せて Google Search Console からインデックスをリクエスト

## 3. 禁止・注意

- 存在しないレビュー・イベント・口コミを生成しない
- `Event` の `startDate`・`location` は確定情報のみを使い、予定は `offers.pending` 等で表現する
- `Review` の `rating` は実際の顧客評価のみ。推測・平均値の混同を避ける
- `sameAs` は運用中の SNS アカウントのみ記載
- 実装後は必ず Google リッチリザルトテストと `curl` + Google Structured Data API でエラー0を確認する