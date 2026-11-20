#!/usr/bin/env node
/**
 * tools/look-cases.mjs
 * 官公庁入札 比較ビュー（比較ビズの仕組み化）
 *
 * 日次パイプラインで集めた案件を横断的に比較・分析する。
 * 類似案件の検出、発注機関ごとの案件一覧、重複発見、統計を提供する。
 *
 * 使い方:
 *   node tools/look-cases.mjs                         # デフォルト概要（tier別件数・最新動向）
 *   node tools/look-cases.mjs --repeated              # 複数日に出現した同一/類似案件
 *   node tools/look-cases.mjs --compare               # A/B 案件の一覧比較（金額・期限）
 *   node tools/look-cases.mjs --search <語>           # キーワード検索
 *   node tools/look-cases.mjs --org <発注機関>        # 発注機関で絞り込み
 *   node tools/look-cases.mjs --stats                 # 統計情報（発注機関・キーワード・月次）
 *   node tools/look-cases.mjs --recent [N]            # 直近N件の新規（既定10）
 *   node tools/look-cases.mjs --similar <URL>         # 指定URLに類似の案件
 *   node tools/look-cases.mjs --export               # TSV形式で全件出力（スプレッドシート用）
 *   node tools/look-cases.mjs --json                 # JSON形式で全件出力
 *
 * 共通オプション:
 *   --seen-file <path>      seen.json のパス（既定: data/state/seen.json）
 *   --data-dir <dir>        candidates CSV のディレクトリ（既定: data/）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

// ─── CLI パース ────────────────────────────────────────────
function has(name) { return args.includes(name); }
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const MODE_REPEATED  = has('--repeated');
const MODE_COMPARE   = has('--compare');
const MODE_SEARCH    = has('--search');
const MODE_ORG       = has('--org');
const MODE_STATS     = has('--stats');
const MODE_RECENT    = has('--recent');
const MODE_SIMILAR   = has('--similar');
const MODE_EXPORT    = has('--export');
const MODE_JSON      = has('--json');

const searchTerm    = MODE_SEARCH  ? args[args.indexOf('--search') + 1] : null;
const orgFilter     = MODE_ORG     ? args[args.indexOf('--org') + 1] : null;
const similarUrl    = MODE_SIMILAR ? args[args.indexOf('--similar') + 1] : null;
const recentN       = MODE_RECENT  ? parseInt(args[args.indexOf('--recent') + 1] || '10', 10) : 10;

const seenFile = flag('--seen-file') || path.join(root, 'data/state/seen.json');
const dataDir  = flag('--data-dir')  || path.join(root, 'data');

// ─── データ読み込み ──────────────────────────────────────────

/** seen.json を読み込む */
function loadSeen() {
  if (!fs.existsSync(seenFile)) return {};
  return JSON.parse(fs.readFileSync(seenFile, 'utf8'));
}

/** candidates CSV から案件名・発注機関・キーワードを読む */
function loadCandidatesIndex() {
  const index = []; // { url, title, org, keyword, date, format }
  if (!fs.existsSync(dataDir)) return index;
  for (const f of fs.readdirSync(dataDir).sort()) {
    const m = f.match(/^candidates-(\d{4}-\d{2}-\d{2})\.csv$/);
    if (!m) continue;
    const date = m[1];
    const text = fs.readFileSync(path.join(dataDir, f), 'utf8').replace(/^﻿/, '');
    const lines = text.trim().split(/\r?\n/);
    const header = lines[0].split(',');
    const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
    if (idx['公告URL'] == null) continue;
    for (const row of lines.slice(1)) {
      const cells = row.match(/("(?:[^"]|"")*"|[^,]+)/g);
      if (!cells) continue;
      const c = (i) => (cells[idx[i]] || '').replace(/^"|"$/g, '').replace(/""/g, '"').trim();
      const url = c('公告URL');
      if (!url.startsWith('http')) continue;
      index.push({
        url,
        title: c('案件名'),
        org: c('発注機関'),
        keyword: c('合致キーワード'),
        format: c('入札形式'),
        date,
        fromCsv: true,
      });
    }
  }
  return index;
}

/** extract.json を読み込む（全日付分） */
function loadAllExtracts() {
  const extracts = [];
  const noticesDir = path.join(dataDir, 'notices');
  if (!fs.existsSync(noticesDir)) return extracts;
  for (const d of fs.readdirSync(noticesDir).sort()) {
    const ep = path.join(noticesDir, d, 'extract.json');
    if (!fs.existsSync(ep)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(ep, 'utf8'));
      for (const row of (Array.isArray(data) ? data : [data])) {
        if (row.url) {
          row.extractDate = d;
          extracts.push(row);
        }
      }
    } catch { /* skip corrupt */ }
  }
  return extracts;
}

// ─── 類似度判定 ──────────────────────────────────────────────

/**
 * タイトルベースの簡易類似度（単語共通率）
 * 同じ発注機関＋類似タイトルで反復案件を検出する。
 */
function titleSimilarity(a, b) {
  const norm = (s) => (s || '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const na = norm(a).split(/\s+/).filter(Boolean);
  const nb = norm(b).split(/\s+/).filter(Boolean);
  if (!na.length || !nb.length) return 0;
  const setA = new Set(na);
  const setB = new Set(nb);
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

/** 発注機関の正規化（"国立研究開発法人", "独立行政法人" などを除去） */
function normalizeOrg(org) {
  if (!org) return '';
  return org
    .replace(/^独立行政法人/, '')
    .replace(/^国立研究開発法人/, '')
    .replace(/^国立大学法人/, '')
    .replace(/\s+/g, '')
    .trim();
}

// ─── 表示ユーティリティ ──────────────────────────────────────

function mdEscape(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function fmtTier(tier) {
  const m = { A: '✅ A', B: '🔶 B', C: '⏹ C', 除外: '─ 除外' };
  return m[tier] || tier;
}

// ─── 各モード ────────────────────────────────────────────────

function cmdSummary(seen, csvIndex, extracts) {
  const byTier = { A: [], B: [], C: [], 除外: [] };
  const byDate = {};
  const asked = [];
  for (const [url, rec] of Object.entries(seen)) {
    const t = rec.tier || '除外';
    (byTier[t] || byTier['除外']).push({ url, ...rec });
    const d = rec.firstSeen || 'unknown';
    if (!byDate[d]) byDate[d] = { total: 0, A: 0, B: 0, C: 0, 除外: 0 };
    byDate[d][t] = (byDate[d][t] || 0) + 1;
    byDate[d].total++;
    if (rec.askedKim) asked.push({ url, ...rec });
  }

  // CSV 日付一覧
  const csvDates = new Set();
  for (const c of csvIndex) csvDates.add(c.date);

  console.log('# 官公庁入札 比較ビュー\n');
  console.log(`- seen.json: ${Object.keys(seen).length} 件`);
  console.log(`- candidates CSV: ${csvDates.size} 日分（${csvIndex.length} 行）`);
  console.log(`- extract.json: ${extracts.length} 件`);
  console.log(`- kim確認済み: ${asked.length} 件`);
  console.log();

  // Tier 別
  console.log('## Tier 別件数\n');
  console.log('| Tier | 件数 | 割合 |');
  console.log('|---|---|');
  const total = Object.keys(seen).length || 1;
  for (const t of ['A', 'B', 'C', '除外']) {
    const n = (byTier[t] || []).length;
    if (n === 0) continue;
    console.log(`| ${fmtTier(t)} | ${n} | ${(n / total * 100).toFixed(1)}% |`);
  }
  console.log();

  // 日次推移
  console.log('## 日次発見数推移\n');
  console.log('| 日付 | 合計 | A | B | C | 除外 |');
  console.log('|---|---|---|---|---|---|');
  const sortedDates = Object.keys(byDate).sort();
  for (const d of sortedDates) {
    const r = byDate[d];
    console.log(`| ${d} | ${r.total} | ${r.A || 0} | ${r.B || 0} | ${r.C || 0} | ${r['除外'] || 0} |`);
  }
  console.log();

  // 今すぐ検討できるA
  if (byTier.A.length) {
    console.log('## A（今から検討可）\n');
    console.log('| 案件名 | 発注者 | 金額 | 期限 | 発見日 |');
    console.log('|---|---|---|---|---|');
    for (const r of byTier.A.sort((a, b) => (a.firstSeen || '').localeCompare(b.firstSeen || ''))) {
      const deadline = [r.applyDeadline, r.submitDeadline].filter(Boolean).join(' / ') || '不明';
      console.log(`| ${mdEscape(r.title)} | ${mdEscape(r.org)} | ${mdEscape('')} | ${mdEscape(deadline)} | ${r.firstSeen || ''} |`);
    }
    console.log();
  }
}

function cmdRepeated(seen, csvIndex) {
  // seen.json + CSV のクロス参照で、同じ発注機関＋類似タイトルが複数日付に出現したものを検出
  const entries = [];
  for (const [url, rec] of Object.entries(seen)) {
    entries.push({ url, ...rec, source: 'seen' });
  }
  // CSV の情報で補完
  const csvByUrl = {};
  for (const c of csvIndex) {
    if (!csvByUrl[c.url]) csvByUrl[c.url] = [];
    csvByUrl[c.url].push(c);
  }
  for (const e of entries) {
    if (csvByUrl[e.url]) {
      e.csvDates = [...new Set(csvByUrl[e.url].map((c) => c.date))].sort();
    }
  }

  // 発注機関＋タイトル類似度でクラスタリング
  const clusters = [];
  const used = new Set();
  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    const cluster = [i];
    used.add(i);
    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j)) continue;
      const a = entries[i];
      const b = entries[j];
      if (!a.org || !b.org) continue;
      if (normalizeOrg(a.org) !== normalizeOrg(b.org)) continue;
      if (titleSimilarity(a.title, b.title) < 0.5) continue;
      cluster.push(j);
      used.add(j);
    }
    if (cluster.length > 1) {
      clusters.push(cluster.map((idx) => entries[idx]));
    }
  }

  if (!clusters.length) {
    console.log('# 比較ビュー: 反復案件\n');
    console.log('反復案件は見つかりませんでした。');
    return;
  }

  console.log('# 比較ビュー: 反復案件\n');
  console.log(`同じ発注機関から類似案件が複数回出現: ${Object.keys(clusters).length} グループ\n`);

  for (const group of clusters) {
    const org = group[0].org || '不明';
    const sorted = group.sort((a, b) => (a.firstSeen || '').localeCompare(b.firstSeen || ''));
    const lastDate = sorted[sorted.length - 1].firstSeen || '';
    console.log(`### ${mdEscape(org)}\n`);
    console.log('| 発見日 | 案件名 | Tier | 金額 | 期限 | 下書き |');
    console.log('|---|---|---|---|---|---|');
    for (const r of sorted) {
      const deadline = [r.applyDeadline, r.submitDeadline].filter(Boolean).join(' / ') || '不明';
      const tier = r.tier || '除外';
      const csvDates = r.csvDates ? r.csvDates.join(', ') : '';
      const dates = csvDates || (r.firstSeen || '');
      console.log(`| ${dates} | ${mdEscape(r.title)} | ${fmtTier(tier)} | ${mdEscape('')} | ${mdEscape(deadline)} | ${r.draftPath || ''} |`);
    }
    console.log();
  }
}

function cmdCompare(seen, extracts) {
  const aOrB = [];
  for (const [url, rec] of Object.entries(seen)) {
    if (rec.tier === 'A' || rec.tier === 'B') {
      aOrB.push({ url, ...rec });
    }
  }
  // extract の金額で補完
  const extByUrl = {};
  for (const ex of extracts) extByUrl[ex.url] = ex;
  for (const r of aOrB) {
    const ex = extByUrl[r.url];
    if (ex) {
      r.amount_text = ex.amount_text || r.amount_text || '';
      r.qualification = ex.qualification || r.qualification || '';
      r.submit_method = ex.submit_method || r.submit_method || '';
    }
  }

  if (!aOrB.length) {
    console.log('# 比較ビュー: A/B 比較\n');
    console.log('A/B 案件はありません。');
    return;
  }

  const sorted = aOrB.sort((a, b) => {
    const ta = a.tier === 'A' ? 0 : 1;
    const tb = b.tier === 'A' ? 0 : 1;
    return ta === tb ? (a.firstSeen || '').localeCompare(b.firstSeen || '') : ta - tb;
  });

  console.log('# 比較ビュー: A/B 比較表\n');
  console.log(`A: ${sorted.filter((r) => r.tier === 'A').length} 件 / B: ${sorted.filter((r) => r.tier === 'B').length} 件\n`);
  console.log('| # | Tier | 発見日 | 発注者 | 案件名 | 金額 | 期限 | 必要資格 | 提出方法 |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  sorted.forEach((r, i) => {
    const deadline = [r.applyDeadline, r.submitDeadline].filter(Boolean).join(' / ') || '不明';
    console.log(`| ${i + 1} | ${fmtTier(r.tier)} | ${r.firstSeen || ''} | ${mdEscape(r.org)} | ${mdEscape(r.title)} | ${mdEscape(r.amount_text || '')} | ${mdEscape(deadline)} | ${mdEscape((r.qualification || '').slice(0, 100))} | ${mdEscape((r.submit_method || '').slice(0, 80))} |`);
  });
  console.log();
}

function cmdSearch(term, seen, csvIndex, extracts) {
  const q = term.toLowerCase();
  const seenHits = [];
  for (const [url, rec] of Object.entries(seen)) {
    const blob = [rec.title, rec.org, rec.keyword, rec.applyDeadline, rec.submitDeadline, rec.qualification, url]
      .filter(Boolean).join(' ').toLowerCase();
    if (blob.includes(q)) seenHits.push({ url, ...rec, matchField: 'seen' });
  }

  const csvHits = [];
  for (const c of csvIndex) {
    const blob = [c.title, c.org, c.keyword, c.url].filter(Boolean).join(' ').toLowerCase();
    if (blob.includes(q) && !seenHits.some((h) => h.url === c.url)) {
      csvHits.push(c);
    }
  }

  if (!seenHits.length && !csvHits.length) {
    console.log(`# 比較ビュー: 検索「${term}」\n`);
    console.log('該当なし');
    return;
  }

  console.log(`# 比較ビュー: 検索「${term}」\n`);
  console.log(`seen.json: ${seenHits.length} 件 / CSV のみ: ${csvHits.length} 件\n`);

  if (seenHits.length) {
    const sorted = seenHits.sort((a, b) => {
      if ((a.tier || '除外') !== (b.tier || '除外')) {
        const order = { A: 0, B: 1, C: 2, 除外: 3 };
        return (order[a.tier || '除外'] || 9) - (order[b.tier || '除外'] || 9);
      }
      return (a.firstSeen || '').localeCompare(b.firstSeen || '');
    });
    console.log('| Tier | 発見日 | 発注者 | 案件名 | URL |');
    console.log('|---|---|---|---|---|');
    for (const r of sorted) {
      console.log(`| ${fmtTier(r.tier || '除外')} | ${r.firstSeen || ''} | ${mdEscape(r.org)} | ${mdEscape(r.title)} | ${r.url} |`);
    }
    console.log();
  }

  if (csvHits.length) {
    console.log('### CSV のみの案件（seen未取込）\n');
    console.log('| 日付 | 発注者 | 案件名 | キーワード | URL |');
    console.log('|---|---|---|---|---|');
    for (const c of csvHits.sort((a, b) => a.date.localeCompare(b.date))) {
      console.log(`| ${c.date} | ${mdEscape(c.org)} | ${mdEscape(c.title)} | ${c.keyword || ''} | ${c.url} |`);
    }
    console.log();
  }
}

function cmdOrg(orgName, seen, csvIndex, extracts) {
  const q = orgName.toLowerCase();
  const seenHits = [];
  for (const [url, rec] of Object.entries(seen)) {
    if ((rec.org || '').toLowerCase().includes(q)) {
      seenHits.push({ url, ...rec });
    }
  }

  // CSV のみの拡張
  const csvHits = [];
  const seenUrls = new Set(Object.keys(seen));
  for (const c of csvIndex) {
    if (!seenUrls.has(c.url) && (c.org || '').toLowerCase().includes(q)) {
      csvHits.push(c);
    }
  }

  console.log(`# 比較ビュー: 発注機関「${orgName}」\n`);
  console.log(`seen.json: ${seenHits.length} 件 / CSV のみ: ${csvHits.length} 件\n`);

  if (seenHits.length) {
    const byTier = { A: [], B: [], C: [], 除外: [] };
    for (const r of seenHits) {
      const t = r.tier || '除外';
      (byTier[t] || byTier['除外']).push(r);
    }
    for (const t of ['A', 'B', 'C', '除外']) {
      const list = byTier[t];
      if (!list.length) continue;
      const label = t === 'A' ? '✅ 検討可' : t === 'B' ? '🔶 条件付き' : t === 'C' ? '⏹ 不可' : '─ 除外';
      console.log(`### ${label} (${list.length})\n`);
      console.log('| 発見日 | 案件名 | 期限 | URL |');
      console.log('|---|---|---|---|');
      for (const r of list.sort((a, b) => (a.firstSeen || '').localeCompare(b.firstSeen || ''))) {
        const deadline = [r.applyDeadline, r.submitDeadline].filter(Boolean).join(' / ') || '不明';
        console.log(`| ${r.firstSeen || ''} | ${mdEscape(r.title)} | ${mdEscape(deadline)} | ${r.url} |`);
      }
      console.log();
    }
  }

  if (csvHits.length) {
    console.log('### CSV のみ（未処理）\n');
    console.log('| 日付 | 案件名 | キーワード | URL |');
    console.log('|---|---|---|---|');
    for (const c of csvHits.sort((a, b) => a.date.localeCompare(b.date))) {
      console.log(`| ${c.date} | ${mdEscape(c.title)} | ${c.keyword || ''} | ${c.url} |`);
    }
    console.log();
  }
}

function cmdStats(seen, csvIndex, extracts) {
  const byOrg = {};
  const byKeyword = {};
  const byFormat = {};
  const byMonth = {};

  for (const [url, rec] of Object.entries(seen)) {
    // 発注機関
    const org = normalizeOrg(rec.org) || '不明';
    if (!byOrg[org]) byOrg[org] = { total: 0, A: 0 };
    byOrg[org].total++;
    if (rec.tier === 'A') byOrg[org].A++;

    // キーワード
    const kw = rec.keyword || '不明';
    if (!byKeyword[kw]) byKeyword[kw] = 0;
    byKeyword[kw]++;

    // 月次
    const m = (rec.firstSeen || 'unknown').slice(0, 7);
    if (!byMonth[m]) byMonth[m] = { total: 0, A: 0 };
    byMonth[m].total++;
    if (rec.tier === 'A') byMonth[m].A++;
  }

  for (const c of csvIndex) {
    const fmt = c.format || '要確認';
    if (!byFormat[fmt]) byFormat[fmt] = new Set();
    byFormat[fmt].add(c.url);
  }

  const total = Object.keys(seen).length || 1;

  console.log('# 比較ビュー: 統計\n');

  // 月次推移
  console.log('## 月次発見数\n');
  console.log('| 月 | 合計 | A | A率 |');
  console.log('|---|---|---|---|');
  for (const m of Object.keys(byMonth).sort()) {
    const r = byMonth[m];
    const aRate = r.total > 0 ? (r.A / r.total * 100).toFixed(1) : '0.0';
    console.log(`| ${m} | ${r.total} | ${r.A} | ${aRate}% |`);
  }
  console.log();

  // 発注機関トップ
  console.log('## 発注機関トップ15\n');
  const topOrgs = Object.entries(byOrg).sort((a, b) => b[1].total - a[1].total).slice(0, 15);
  console.log('| 発注機関 | 件数 | A | A率 |');
  console.log('|---|---|---|---|');
  for (const [org, r] of topOrgs) {
    const aRate = r.total > 0 ? (r.A / r.total * 100).toFixed(1) : '0.0';
    console.log(`| ${mdEscape(org)} | ${r.total} | ${r.A} | ${aRate}% |`);
  }
  console.log();

  // 合致キーワード
  console.log('## 合致キーワード\n');
  const topKw = Object.entries(byKeyword).sort((a, b) => b[1] - a[1]);
  console.log('| キーワード | 件数 | 割合 |');
  console.log('|---|---|---|');
  for (const [kw, n] of topKw) {
    console.log(`| ${kw} | ${n} | ${(n / total * 100).toFixed(1)}% |`);
  }
  console.log();

  // 入札形式
  console.log('## 入札形式\n');
  console.log('| 形式 | 件数 |');
  console.log('|---|---|');
  for (const [fmt, urls] of Object.entries(byFormat).sort((a, b) => b[1].size - a[1].size)) {
    console.log(`| ${fmt} | ${urls.size} |`);
  }
  console.log();

  // Tier 分布
  const byTier = { A: 0, B: 0, C: 0, 除外: 0 };
  for (const rec of Object.values(seen)) {
    const t = rec.tier || '除外';
    if (byTier[t] !== undefined) byTier[t]++;
    else byTier['除外']++;
  }
  console.log('## Tier 分布\n');
  for (const [t, n] of Object.entries(byTier)) {
    console.log(`- ${fmtTier(t)}: ${n} 件 (${(n / total * 100).toFixed(1)}%)`);
  }
  console.log();

  // 重複
  const dupOrgs = Object.entries(byOrg).filter(([_, r]) => r.total >= 3).sort((a, b) => b[1].total - a[1].total);
  if (dupOrgs.length) {
    console.log('## 複数回出現した発注機関（3回以上）\n');
    console.log('継続的に案件が出る可能性が高い発注機関。');
    console.log('');
    console.log('| 発注機関 | 件数 |');
    console.log('|---|---|');
    for (const [org, r] of dupOrgs) {
      console.log(`| ${mdEscape(org)} | ${r.total} |`);
    }
    console.log();
  }
}

function cmdRecent(seen, csvIndex, n) {
  // seen を firstSeen で降順ソート
  const withDate = [];
  for (const [url, rec] of Object.entries(seen)) {
    if (rec.firstSeen) withDate.push({ url, ...rec });
  }
  const sorted = withDate.sort((a, b) => b.firstSeen.localeCompare(a.firstSeen));
  const recent = sorted.slice(0, n);

  console.log(`# 比較ビュー: 直近${n}件の新規案件\n`);
  if (!recent.length) {
    console.log('データなし');
    return;
  }

  console.log('| 発見日 | Tier | 発注者 | 案件名 | kim確認 |');
  console.log('|---|---|---|---|---|');
  for (const r of recent) {
    const askStatus = r.askedKim ? '✅' : '⏳';
    console.log(`| ${r.firstSeen || ''} | ${fmtTier(r.tier || '除外')} | ${mdEscape(r.org)} | ${mdEscape(r.title)} | ${askStatus} |`);
  }
  console.log();
}

function cmdSimilar(url, seen, csvIndex, extracts) {
  const target = seen[url];
  if (!target) {
    console.log(`# 比較ビュー: 類似案件検索\n`);
    console.log(`指定されたURLは seen.json に見つかりません: ${url}`);
    // CSV から探す
    const csvMatch = csvIndex.find((c) => c.url === url);
    if (csvMatch) {
      console.log(`CSV にはあります: ${csvMatch.title}（${csvMatch.org}、${csvMatch.date}）`);
    }
    return;
  }

  const orgNorm = normalizeOrg(target.org || '');
  const candidates = [];
  for (const [u, rec] of Object.entries(seen)) {
    if (u === url) continue;
    if (!rec.org || !rec.title) continue;
    const sim = titleSimilarity(target.title, rec.title);
    const sameOrg = normalizeOrg(rec.org) === orgNorm;
    if (sameOrg && sim >= 0.3) {
      candidates.push({ url: u, ...rec, similarity: sim });
    }
  }

  // CSV でも検索
  const csvCandidates = [];
  const seenUrls = new Set(Object.keys(seen));
  for (const c of csvIndex) {
    if (seenUrls.has(c.url)) continue;
    if (normalizeOrg(c.org) === orgNorm && titleSimilarity(target.title, c.title) >= 0.3) {
      csvCandidates.push(c);
    }
  }

  console.log(`# 比較ビュー: 類似案件検索\n`);
  console.log(`対象: ${mdEscape(target.title)}（${mdEscape(target.org)}）\n`);

  if (!candidates.length && !csvCandidates.length) {
    console.log('類似案件は見つかりませんでした。');
    return;
  }

  const all = [...candidates, ...csvCandidates].sort((a, b) => {
    const sa = a.similarity || titleSimilarity(target.title, a.title);
    const sb = b.similarity || titleSimilarity(target.title, b.title);
    return sb - sa;
  });

  console.log('| 類似度 | 発見日 | Tier | 発注者 | 案件名 | 金額 | URL |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of all.slice(0, 20)) {
    const sim = r.similarity || titleSimilarity(target.title, r.title);
    console.log(`| ${(sim * 100).toFixed(0)}% | ${r.firstSeen || r.date || ''} | ${fmtTier(r.tier || 'CSV')} | ${mdEscape(r.org || r.title)} | ${mdEscape(r.title || r.url)} | ${mdEscape(r.amount_text || '')} | ${r.url} |`);
  }
  console.log();
}

function cmdExport(seen, extracts) {
  const extByUrl = {};
  for (const ex of extracts) extByUrl[ex.url] = ex;

  console.log('URL\t発見日\tTier\t発注者\t案件名\t金額\t申込期限\t提出期限\tキーワード\tkim確認\t下書き\t必要資格');
  for (const [url, rec] of Object.entries(seen)) {
    const ex = extByUrl[url];
    const row = [
      url,
      rec.firstSeen || '',
      rec.tier || '除外',
      (rec.org || '').replace(/\t/g, ' '),
      (rec.title || '').replace(/\t/g, ' '),
      (ex?.amount_text || rec.amount_text || ''),
      rec.applyDeadline || '',
      rec.submitDeadline || '',
      rec.keyword || '',
      rec.askedKim ? '済' : '未',
      (rec.draftPath || '').replace(/\t/g, ' '),
      (ex?.qualification || '').replace(/\t/g, ' '),
    ];
    console.log(row.join('\t'));
  }
}

function cmdJson(seen, extracts) {
  const extByUrl = {};
  for (const ex of extracts) extByUrl[ex.url] = ex;

  const output = {};
  for (const [url, rec] of Object.entries(seen)) {
    const ex = extByUrl[url];
    output[url] = {
      firstSeen: rec.firstSeen,
      tier: rec.tier || '除外',
      org: rec.org,
      title: rec.title,
      keyword: rec.keyword,
      amount: ex?.amount_text || '',
      applyDeadline: rec.applyDeadline || '',
      submitDeadline: rec.submitDeadline || '',
      qualification: ex?.qualification || '',
      submitMethod: ex?.submit_method || '',
      askedKim: rec.askedKim || false,
      draftPath: rec.draftPath || '',
    };
  }
  console.log(JSON.stringify(output, null, 2));
}

// ─── main ────────────────────────────────────────────────────

function main() {
  const seen = loadSeen();
  const csvIndex = loadCandidatesIndex();
  const extracts = loadAllExtracts();

  if (MODE_SEARCH && searchTerm) {
    cmdSearch(searchTerm, seen, csvIndex, extracts);
  } else if (MODE_ORG && orgFilter) {
    cmdOrg(orgFilter, seen, csvIndex, extracts);
  } else if (MODE_SIMILAR && similarUrl) {
    cmdSimilar(similarUrl, seen, csvIndex, extracts);
  } else if (MODE_REPEATED) {
    cmdRepeated(seen, csvIndex);
  } else if (MODE_COMPARE) {
    cmdCompare(seen, extracts);
  } else if (MODE_STATS) {
    cmdStats(seen, csvIndex, extracts);
  } else if (MODE_RECENT) {
    cmdRecent(seen, csvIndex, recentN);
  } else if (MODE_EXPORT) {
    cmdExport(seen, extracts);
  } else if (MODE_JSON) {
    cmdJson(seen, extracts);
  } else {
    cmdSummary(seen, csvIndex, extracts);
  }
}

main();