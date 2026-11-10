#!/usr/bin/env node
/**
 * 官公庁入札 候補リスト収集ツール v2.1
 * メイン源: kkj.go.jp 公開API（認証不要）
 *
 * 使い方: node tools/collect.mjs
 * 出力: data/candidates-YYYY-MM-DD.csv
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const REPORT_DIR = path.resolve(__dirname, '..', 'reports');

// 絞り込んだキーワード（広すぎないものだけ）
const KEYWORDS = [
  '展示会', 'ブース', '設営', '式典',
  '映像制作', '動画制作', 'オンライン配信',
  'イベント運営', '会議運営', '運営業務',
  'プロポーザル イベント'
];

const CSV_HEADER = '﻿案件名,発注機関,区分,入札形式,公告日,提出期限,残日数,履行場所,必要資格(原文),資格適合,予定価格,公告URL,仕様書URL,データ源,合致キーワード\n';

async function fetchXml(url) {
  const resp = await globalThis.fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OrgiastBidBot/1.0)' },
    signal: AbortSignal.timeout(15000)
  });
  if (!resp.ok) return null;
  return resp.text();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** XML 簡易パース：1つの <SearchResult> ブロックを解析 */
function parseSearchResult(block) {
  const g = (tag) => {
    const m = block.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`));
    if (m) return m[1];
    const m2 = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return m2 ? m2[1] : '';
  };
  return {
    name: g('ProjectName'),
    org: g('OrganizationName') || g('CityName'),
    url: g('ExternalDocumentURI'),
    pref: g('PrefectureName'),
    city: g('CityName'),
    cftDate: g('CftIssueDate'),
    pubDate: g('Date'),
    desc: g('ProjectDescription'),
    fileType: g('FileType')
  };
}

function classifyRegion(pref, city) {
  if (!pref) return '未区分';
  if (pref === '東京都') return '東京都';
  if (pref === '大阪府') return '大阪府';
  if (pref.endsWith('府') || pref.endsWith('県')) return pref;
  return pref;
}

function classifyBidType(desc) {
  if (!desc) return '要確認';
  if (desc.includes('プロポーザル')) return 'プロポーザル';
  if (desc.includes('公募')) return '公募';
  if (desc.includes('企画競争')) return '企画競争';
  if (desc.includes('見積合わせ') || desc.includes('オープンカウンター')) return '見積合わせ';
  if (desc.includes('一般競争')) return '一般競争入札';
  return '要確認';
}

function esc(s) {
  if (!s) return '';
  if (s.includes(',') || s.includes('"') || s.includes('\n'))
    return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

async function main() {
  console.log('=== 官公庁入札 候補リスト収集 v2.1 ===\n');
  const startMs = Date.now();

  const allItems = [];
  const seen = new Set();

  for (const kw of KEYWORDS) {
    const url = `https://www.kkj.go.jp/api/?Query=${encodeURIComponent(kw)}&Count=50&Format=json&Start=1`;
    try {
      const xml = await fetchXml(url);
      if (!xml) { console.log(`  ${kw}: HTTP失敗`); continue; }

      const hitM = xml.match(/<SearchHits>(\d+)<\/SearchHits>/);
      const hits = hitM ? parseInt(hitM[1]) : 0;
      const blocks = xml.match(/<SearchResult>[\s\S]*?<\/SearchResult>/g) || [];
      console.log(`  ${kw}: ${hits}件 (取得${blocks.length})`);

      for (const block of blocks) {
        const item = parseSearchResult(block);
        const key = item.url || item.name + item.org;
        if (seen.has(key)) continue;
        seen.add(key);

        allItems.push({
          name: item.name,
          org: item.org,
          url: item.url,
          pref: item.pref,
          city: item.city,
          cftDate: item.cftDate,
          pubDate: item.pubDate,
          desc: item.desc,
          fileType: item.fileType,
          kw: kw
        });
      }
    } catch (e) {
      console.log(`  ${kw}: ${e.message}`);
    }
    await sleep(1000);
  }

  // CSV 出力
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const dateStr = jst.toISOString().slice(0, 10);
  const csvPath = path.join(DATA_DIR, `candidates-${dateStr}.csv`);

  const rows = allItems.map(item => [
    esc(item.name),
    esc(item.org),
    esc(classifyRegion(item.pref, item.city)),
    esc(classifyBidType(item.desc)),
    esc((item.cftDate || '').slice(0, 10)),
    '',
    '',
    '',
    '',
    '要確認',
    '',
    esc(item.url),
    '',
    'kkj.go.jp',
    esc(item.kw)
  ].join(','));

  fs.writeFileSync(csvPath, CSV_HEADER + rows.join('\n'), 'utf8');

  const elapsed = (Date.now() - startMs) / 1000;
  console.log(`\n=== 完了 (${elapsed.toFixed(1)}秒) ===`);
  console.log(`候補: ${allItems.length}件 / CSV: ${csvPath}`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });