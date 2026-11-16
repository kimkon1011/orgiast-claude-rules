#!/usr/bin/env node

/**
 * ai-location-schema-gen.mjs
 * X-0055: ロケーション・サービス・著者スキーマJSON-LD生成ツール
 *
 * Usage:
 *   node tools/ai-location-schema-gen.mjs location --slug osaka --city "大阪市" --pref "大阪府" --hall "インテックス大阪"
 *   node tools/ai-location-schema-gen.mjs service --slug booth-construction
 *   node tools/ai-location-schema-gen.mjs person --slug kim
 *   node tools/ai-location-schema-gen.mjs all --output schemas.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Location parameters: slug, city, prefecture, wikidata, hall, region
const LOCATIONS = [
  { slug: 'osaka', city: '大阪市', prefecture: '大阪府', wikidata: 'Q35765', hall: 'インテックス大阪', region: '関西' },
  { slug: 'tokyo', city: '東京都', prefecture: '東京都', wikidata: 'Q1490', hall: '東京ビッグサイト', region: '関東' },
  { slug: 'nagoya', city: '名古屋市', prefecture: '愛知県', wikidata: 'Q483766', hall: 'ポートメッセなごや', region: '中部' },
  { slug: 'sapporo', city: '札幌市', prefecture: '北海道', wikidata: 'Q48692', hall: '札幌コンベンションセンター', region: '北海道' },
  { slug: 'hiroshima', city: '広島市', prefecture: '広島県', wikidata: 'Q184607', hall: '広島産業会館', region: '中国' },
  { slug: 'fukuoka', city: '福岡市', prefecture: '福岡県', wikidata: 'Q739822', hall: 'マリンメッセ福岡', region: '九州' },
  { slug: 'okinawa', city: '那覇市', prefecture: '沖縄県', wikidata: 'Q487591', hall: '沖縄コンベンションセンター', region: '沖縄' },
];

// Service parameters
const SERVICES = [
  {
    slug: 'booth-construction',
    name: '展示会ブース設計・施工',
    description: '大阪・東京を拠点に展示会ブースの企画・デザイン・施工を一貫提供。年間100件以上の実績。',
    offers: [
      { name: 'Re:ブース スタンダードプラン', description: '3m×3m小間対応のモジュール式ブース。従来比30〜50%コスト削減。' },
      { name: 'カスタムブース', description: 'フルオーダーメイドの大規模ブース。50小間以上対応可能。' },
      { name: 'ミニマムプラン', description: '50万円以下の小規模予算でも対応可能な基本ブース。' },
    ],
  },
  {
    slug: 'event-planning',
    name: '社内イベントプロデュース',
    description: '社員総会・キックオフ・周年記念イベントの企画・運営。年間50件以上の実績。',
    offers: [
      { name: '社員総会プラン', description: '台本制作・映像演出・会場装飾・ケータリング' },
      { name: 'キックオフミーティングプラン', description: '合宿企画・チームビルディング・会議進行' },
      { name: '周年記念イベントプラン', description: '式典企画・記念品・タレント手配・演出' },
    ],
  },
  {
    slug: 'creative',
    name: 'クリエイティブ制作',
    description: 'Web制作・映像制作・グラフィックデザインを一貫提供。ブースと連動したプロモーション。',
    offers: [
      { name: 'Web制作', description: 'ブース連動ランディングページ・実績紹介サイト' },
      { name: '映像制作', description: 'プロモーション映像・会場演出映像・商品紹介' },
      { name: 'グラフィック制作', description: 'パネルデザイン・リーフレット・名刺・ロゴ制作' },
    ],
  },
];

// Person parameters
const PERSONS = [
  {
    slug: 'kim',
    name: '金 功勇',
    givenName: '功勇',
    familyName: '金',
    jobTitle: '代表取締役',
    knowsAbout: ['展示会ブース制作', '社内イベントプロデュース', 'イベント運営管理', '展示会マーケティング'],
    description: '年間100件以上の展示会ブース制作・社内イベントを手がけるイベント制作のプロフェッショナル。大阪市ベンチャー調達制度認定企業の経営者。',
  },
];

// === Generators ===

function genLocationPage(loc) {
  const baseUrl = `https://www.orgiast.jp/locations/${loc.slug}/`;
  return [
    {
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      "@id": `${baseUrl}#business`,
      "name": "株式会社オージャスト",
      "description": `${loc.prefecture}（${loc.city}）で展示会ブース制作を手がけるイベント制作会社。${loc.hall}での設営実績多数。`,
      "url": baseUrl,
      "areaServed": {
        "@type": "City",
        "name": loc.city,
        "sameAs": `https://www.wikidata.org/wiki/${loc.wikidata}`,
      },
      "hasOfferCatalog": {
        "@type": "OfferCatalog",
        "name": "展示会ブース制作",
        "itemListElement": [
          { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "展示会ブース設計・施工" } },
          { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "モジュール式ブース（Re:ブース）" } },
          { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "ブース備品レンタル" } },
        ],
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "トップ", "item": "https://www.orgiast.jp/" },
        { "@type": "ListItem", "position": 2, "name": "対応地域", "item": "https://www.orgiast.jp/locations/" },
        { "@type": "ListItem", "position": 3, "name": `${loc.prefecture}`, "item": baseUrl },
      ],
    },
  ];
}

function genServiceSchema(svc) {
  return {
    "@context": "https://schema.org",
    "@type": "Service",
    "@id": `https://www.orgiast.jp/service/${svc.slug}/#service`,
    "name": svc.name,
    "description": svc.description,
    "provider": {
      "@type": "Organization",
      "name": "株式会社オージャスト",
      "url": "https://www.orgiast.jp/",
    },
    "areaServed": LOCATIONS.map(l => ({ "@type": "City", "name": l.city })),
    "hasOfferCatalog": {
      "@type": "OfferCatalog",
      "name": `${svc.name}プラン`,
      "itemListElement": svc.offers.map(o => ({
        "@type": "Offer",
        "name": o.name,
        "description": o.description,
      })),
    },
  };
}

function genPersonSchema(person) {
  return {
    "@context": "https://schema.org",
    "@type": "Person",
    "@id": `https://www.orgiast.jp/about/#person-${person.slug}`,
    "name": person.name,
    "givenName": person.givenName,
    "familyName": person.familyName,
    "jobTitle": person.jobTitle,
    "worksFor": {
      "@type": "Organization",
      "@id": "https://www.orgiast.jp/#organization",
      "name": "株式会社オージャスト",
    },
    "knowsAbout": person.knowsAbout,
    "description": person.description,
  };
}

// === CLI ===

function showHelp() {
  console.log(`
Usage:
  node ai-location-schema-gen.mjs <command> [options]

Commands:
  location --slug <slug>          Generate LocationPage JSON-LD
  service  --slug <slug>          Generate Service schema JSON-LD
  person   --slug <slug>          Generate Person schema JSON-LD
  all      [--output <file>]      Generate all schemas (stdout or file)

Location slugs: ${LOCATIONS.map(l => l.slug).join(', ')}
Service slugs:  ${SERVICES.map(s => s.slug).join(', ')}
Person slugs:   ${PERSONS.map(p => p.slug).join(', ')}
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    process.exit(0);
  }
  const cmd = args[0];
  const slugIdx = args.indexOf('--slug');
  const slug = slugIdx >= 0 ? args[slugIdx + 1] : null;
  const outputIdx = args.indexOf('--output');
  const output = outputIdx >= 0 ? args[outputIdx + 1] : null;
  // Extra flags for location
  const cityIdx = args.indexOf('--city');
  const city = cityIdx >= 0 ? args[cityIdx + 1] : null;
  const prefIdx = args.indexOf('--pref');
  const pref = prefIdx >= 0 ? args[prefIdx + 1] : null;
  const hallIdx = args.indexOf('--hall');
  const hall = hallIdx >= 0 ? args[hallIdx + 1] : null;

  return { cmd, slug, output, city, pref, hall };
}

function writeOutput(data, output) {
  const json = JSON.stringify(data, null, 2);
  if (output) {
    writeFileSync(output, json, 'utf-8');
    console.error(`Written to ${output}`);
  } else {
    console.log(json);
  }
}

function main() {
  const { cmd, slug, output, city, pref, hall } = parseArgs();

  switch (cmd) {
    case 'location': {
      if (!slug) { console.error('Error: --slug required for location'); process.exit(1); }
      const loc = LOCATIONS.find(l => l.slug === slug);
      if (!loc) { console.error(`Error: unknown location "${slug}". Available: ${LOCATIONS.map(l => l.slug).join(', ')}`); process.exit(1); }
      const data = genLocationPage(loc);
      writeOutput(data, output);
      break;
    }
    case 'service': {
      if (!slug) { console.error('Error: --slug required for service'); process.exit(1); }
      const svc = SERVICES.find(s => s.slug === slug);
      if (!svc) { console.error(`Error: unknown service "${slug}". Available: ${SERVICES.map(s => s.slug).join(', ')}`); process.exit(1); }
      const data = genServiceSchema(svc);
      writeOutput(data, output);
      break;
    }
    case 'person': {
      if (!slug) { console.error('Error: --slug required for person'); process.exit(1); }
      const person = PERSONS.find(p => p.slug === slug);
      if (!person) { console.error(`Error: unknown person "${slug}". Available: ${PERSONS.map(p => p.slug).join(', ')}`); process.exit(1); }
      const data = genPersonSchema(person);
      writeOutput(data, output);
      break;
    }
    case 'all': {
      const data = {
        locations: LOCATIONS.map(l => genLocationPage(l)),
        services: SERVICES.map(s => genServiceSchema(s)),
        persons: PERSONS.map(p => genPersonSchema(p)),
      };
      writeOutput(data, output);
      break;
    }
    default:
      console.error(`Error: unknown command "${cmd}"`);
      showHelp();
      process.exit(1);
  }
}

main();