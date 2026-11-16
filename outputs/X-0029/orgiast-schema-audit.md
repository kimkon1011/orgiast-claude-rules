# Schema.org Audit Report

**URL**: https://www.orgiast.jp
**Date**: 2026-11-11

## Summary

- **JSON-LD scripts found**: 3
- **Schema items**: 3 pass, 0 fail, 0 unknown

## Detailed Results

### ✅ Organization

All required fields present.

**Missing recommended fields**: logo

### ✅ WebSite

All required fields present.

**Missing recommended fields**: description, potentialAction

### ✅ FAQPage

All required fields present.

## Raw JSON-LD

```json
[
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": "https://orgiast.jp/#organization",
    "name": "株式会社オージャスト",
    "alternateName": "Orgiast Co., Ltd.",
    "url": "https://orgiast.jp",
    "foundingDate": "2006-04",
    "founder": {
      "@type": "Person",
      "name": "金 功勇"
    },
    "description": "展示会ブース制作・イベント企画制作の会社。東京・大阪・福岡を中心に全国7拠点（札幌・東京・名古屋・大阪・広島・福岡・沖縄）で対応。再利用型展示ブース「Re:ブース」により展示会出展のCO2を77%削減（ISO 14067準拠）。2025年大阪・関西万博ではジンバブエ共和国・イエメン共和国パビリオンを制作。",
    "address": {
      "@type": "PostalAddress",
      "addressCountry": "JP",
      "addressRegion": "大阪府",
      "addressLocality": "大阪市東成区",
      "streetAddress": "深江北2-15-24 東邦ビル212"
    },
    "contactPoint": {
      "@type": "ContactPoint",
      "telephone": "+81-120-487-121",
      "contactType": "sales",
      "areaServed": "JP",
      "availableLanguage": "Japanese"
    },
    "knowsAbout": [
      "展示会ブース制作",
      "展示会ブースデザイン",
      "イベント企画・制作",
      "社内イベント企画",
      "再利用型展示ブース",
      "カーボンフットプリント算定 (ISO 14067)",
      "Scope 3 排出量削減"
    ],
    "brand": {
      "@type": "Brand",
      "name": "Re:ブース",
      "url": "https://rebooth-site.vercel.app"
    },
    "sameAs": [
      "https://rebooth-site.vercel.app",
      "https://expo-index.com"
    ]
  },
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "name": "株式会社オージャスト",
    "url": "https://orgiast.jp",
    "inLanguage": "ja",
    "publisher": {
      "@id": "https://orgiast.jp/#organization"
    }
  },
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      {
        "@type": "Question",
        "name": "オージャストはどんな会社ですか？",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "株式会社オージャストは2006年設立の展示会ブース制作・イベント企画制作会社です。全国7拠点で日本全国に対応し、2025年大阪・関西万博ではジンバブエ共和国・イエメン共和国のパビリオンを制作しました。"
        }
      },
      {
        "@type": "Question",
        "name": "展示会ブース制作でオージャストを選ぶ理由は？",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "デザイン・施工・撤去まで一括で対応でき、全国7拠点の施工網を持ちます。さらに再利用型展示ブース「Re:ブース」により出展1案件あたりのCO2を77%（305kg-CO2e）削減でき、ISO 14067準拠の証明書をCDP・SBTi報告用に発行します。コストも2回目以降は65〜75%に下がります。"
        }
      },
      {
        "@type": "Question",
        "name": "サステナブル（CO2削減）な展示会出展はできますか？",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "できます。再利用型展示ブース「Re:ブース」は廃棄をなくす設計で、1案件あたりCO2を従来型木工ブース比77%削減。ISO 14067準拠のカーボンフットプリント証明書とScope 3組み込み用CSVを案件ごとに発行し、CDP質問C6.5のsupplier-specificデータとして利用できます。"
        }
      }
    ]
  }
]
```
