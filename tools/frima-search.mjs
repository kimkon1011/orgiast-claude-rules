#!/usr/bin/env node
// フリプラ(frima-prize.com)の横断検索を JSON API 経由で取得する。
// ページ本体は JS で結果を描画するため WebFetch では空になる。内部の
// GET /price-compare/search-shop?keyword=..&shop=.. を直接叩けば取れる（2026-10-10 実測）。
//
// 使い方:
//   node ~/.claude/tools/frima-search.mjs "PowerEdge R640" [--shops yahoo,mercari] [--min 10000] [--max 300000]
//        [--limit 15] [--exclude ジャンク,部品] [--qty 4] [--json]
//   言い換え語は「|」区切り: "32GB RDIMM|PC4-2666V-R 32GB|32GB Registered DDR4"
//   --shops は原則付けない（全サイト横断が既定。絞ると PayPayフリマ等の最安を取りこぼす: 2026-10-10 実害）
// shop: amazon rakuten yahoo_shop kakaku yahoo(ヤフオク) jmty mercari rakuma paypayfrima

import { isEntry } from './is-entry.mjs';

const ALL_SHOPS = ['amazon', 'rakuten', 'yahoo_shop', 'kakaku', 'yahoo', 'jmty', 'mercari', 'rakuma', 'paypayfrima'];
const DEFAULT_SHOPS = ['yahoo', 'mercari', 'rakuma', 'paypayfrima', 'yahoo_shop', 'rakuten', 'amazon', 'jmty'];

export function parseArgs(argv) {
  const o = { keyword: '', shops: DEFAULT_SHOPS, min: null, max: null, limit: 15, exclude: [], json: false, qty: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shops') o.shops = argv[++i].split(',').filter(s => ALL_SHOPS.includes(s));
    else if (a === '--min') o.min = Number(argv[++i]);
    else if (a === '--max') o.max = Number(argv[++i]);
    else if (a === '--limit') o.limit = Number(argv[++i]);
    else if (a === '--exclude') o.exclude = argv[++i].split(',').filter(Boolean);
    else if (a === '--json') o.json = true;
    else if (a === '--qty') o.qty = Number(argv[++i]);
    else if (a === '--include-sold') o.includeSold = true;
    else o.keyword += (o.keyword ? ' ' : '') + a;
  }
  return o;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchShop(keyword, shop, extra) {
  const p = new URLSearchParams({ keyword, shop, ...extra });
  const url = `https://frima-prize.com/price-compare/search-shop?${p}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    Accept: 'application/json',
    Referer: `https://frima-prize.com/price-compare?keyword=${encodeURIComponent(keyword)}`,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status === 429) { await sleep(20000 * (attempt + 1)); continue; }
    if (!res.ok) return { shop, items: [], error: `HTTP ${res.status}` };
    const j = await res.json();
    return { shop, items: j.items || [], error: j.error || null };
  }
  return { shop, items: [], error: 'rate limited (429 x3)' };
}

// 純関数: 結果の統合・重複除去・絞り込み・価格昇順（ネットワークなし）
export function collectItems(results, o) {
  const seen = new Set();
  let items = results.flatMap(r => r.items.map(it => ({ ...it, platform: it.platform || r.shop })))
    .filter(it => (seen.has(it.url) ? false : seen.add(it.url)));
  items = items.filter(it => typeof it.price === 'number' && it.price > 0);
  if (!o.includeSold) items = items.filter(it => !it.status || it.status === 'on_sale');
  if (o.min != null) items = items.filter(it => it.price >= o.min);
  if (o.max != null) items = items.filter(it => it.price <= o.max);
  if (o.exclude.length) items = items.filter(it => !o.exclude.some(w => (it.title || '').includes(w)));
  items.sort((a, b) => a.price - b.price);
  return items;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.keyword) { console.error('usage: frima-search.mjs <keyword> [--shops a,b] [--min N] [--max N] [--limit N] [--exclude w1,w2] [--json]'); process.exit(2); }
  // 売切・終了品も返ってくる（ラクマ・ジモティーで実害 2026-10-10）ので販売中に絞る。--include-sold で解除
  const extra = o.includeSold ? {} : { status_filter: 'on_sale' };
  if (o.min != null) extra.min_price = String(o.min);
  if (o.max != null) extra.max_price = String(o.max);

  // 「|」区切りで言い換え語を複数指定できる（例: "I350-T2|I350 T2|I350 LANカード"）。
  // 1語あたり各サイト約20件しか返らないため、言い換えで取りこぼしを減らす。
  const keywords = o.keyword.split('|').map(s => s.trim()).filter(Boolean);
  const results = [];
  for (const kw of keywords) {
    for (const shop of o.shops) {
      const r = await fetchShop(kw, shop, extra);
      results.push({ ...r, shop: keywords.length > 1 ? `${shop}[${kw}]` : shop });
      await sleep(1500); // サイトのレート制限(429)対策で逐次＋間隔
    }
  }

  const items = collectItems(results, o);

  if (o.json) { console.log(JSON.stringify({ keyword: o.keyword, results: results.map(r => ({ shop: r.shop, count: r.items.length, error: r.error })), items }, null, 2)); return; }

  console.log(`# フリプラ横断検索: ${o.keyword}`);
  console.log(results.map(r => `${r.shop}:${r.items.length}${r.error ? `(err:${r.error})` : ''}`).join(' / '));
  console.log(`該当 ${items.length} 件（重複除去後）`);
  if (o.qty > 1) {
    // 必要数量ぶんの候補を並べる。1出品が複数枚セットの場合は人が数量を確認する前提で、上位 qty×3 件を出す
    o.limit = Math.max(o.limit, o.qty * 3);
    const cheapest = items.slice(0, o.qty).reduce((s, it) => s + it.price, 0);
    console.log(`必要数 ${o.qty}: 最安 ${o.qty} 件の合計 ¥${cheapest.toLocaleString()}（セット品は枚数を要確認）`);
  }
  for (const it of items.slice(0, o.limit)) {
    const extraInfo = [it.shop || it.platform, it.buynow_price ? `即決¥${it.buynow_price.toLocaleString()}` : '', it.bid_count ? `入札${it.bid_count}` : '', it.time_left ? `残${it.time_left}` : ''].filter(Boolean).join(' ');
    console.log(`- ¥${it.price.toLocaleString()} | ${extraInfo} | ${it.title}\n  ${it.url}`);
  }
}

if (isEntry(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
