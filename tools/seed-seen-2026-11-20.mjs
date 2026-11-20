#!/usr/bin/env node
/**
 * One-shot seed for data/state/seen.json from 2026-11-20 manual run artifacts.
 * Usage: node tools/seed-seen-2026-11-20.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATE = '2026-11-20';
const seen = {};

function upsert(url, patch) {
  if (!url || !url.startsWith('http')) return;
  const cur = seen[url] || {
    firstSeen: DATE,
    nameFilter: 'unknown',
    keyword: '',
    tier: '除外',
    title: '',
    org: '',
    applyDeadline: '',
    submitDeadline: '',
    askedKim: false,
    askedOn: '',
    draftPath: '',
  };
  seen[url] = { ...cur, ...patch, firstSeen: cur.firstSeen || DATE };
}

// namefilter
const nfPath = path.join(root, `reports/namefilter-${DATE}.txt`);
for (const line of fs.readFileSync(nfPath, 'utf8').split(/\r?\n/)) {
  if (!line.includes('http')) continue;
  const parts = line.split('|');
  if (parts.length < 6) continue;
  upsert(parts[4], {
    nameFilter: 'keyword',
    keyword: parts[5] || '',
    title: parts[3] || '',
    org: parts[2] || '',
    firstSeen: parts[0] || DATE,
  });
}

// extract.json
const extract = JSON.parse(fs.readFileSync(path.join(root, `data/notices/${DATE}/extract.json`), 'utf8'));
for (const row of extract) {
  upsert(row.url, {
    nameFilter: seen[row.url]?.nameFilter || 'keyword',
    title: row.title || '',
    org: row.org || '',
    applyDeadline: row.apply_deadline || '',
    submitDeadline: row.submit_deadline || '',
    tier: row.deadline_passed ? 'C' : (seen[row.url]?.tier || 'B'),
    extractNo: row.no,
  });
}

// nov-classify hits (positive)
const novOut = path.join(root, `data/notices/${DATE}/nov-classify-out.txt`);
if (fs.existsSync(novOut)) {
  for (const line of fs.readFileSync(novOut, 'utf8').split(/\r?\n/)) {
    if (!line.includes('http') || line.startsWith('[')) continue;
    const parts = line.split('|');
    if (parts.length < 5) continue;
    upsert(parts[3], {
      nameFilter: 'llm',
      keyword: parts[4] || '',
      title: parts[2] || '',
      org: parts[1] || '',
      firstSeen: parts[0] || DATE,
    });
  }
}

// nov-others (all presented to classifier — mark seen so we don't re-ask)
const novOthers = path.join(root, `data/notices/${DATE}/nov-others.txt`);
if (fs.existsSync(novOthers)) {
  for (const line of fs.readFileSync(novOthers, 'utf8').split(/\r?\n/)) {
    const m = line.match(/https?:\/\/\S+/);
    if (!m) continue;
    upsert(m[0], {
      nameFilter: seen[m[0]]?.nameFilter === 'llm' ? 'llm' : 'llm-scan',
      title: seen[m[0]]?.title || '',
      tier: seen[m[0]]?.tier || '除外',
    });
  }
}

// shortlist A/B/C
const short = fs.readFileSync(path.join(root, `reports/shortlist-${DATE}.md`), 'utf8');
const sections = { A: [], B: [], C: [] };
let cur = null;
for (const line of short.split(/\r?\n/)) {
  if (/^## A\./.test(line)) { cur = 'A'; continue; }
  if (/^## B\./.test(line)) { cur = 'B'; continue; }
  if (/^## C\./.test(line)) { cur = 'C'; continue; }
  if (!cur || !line.startsWith('|')) continue;
  const cells = line.split('|').map((c) => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
  if (!cells.length || cells[0] === '#' || cells[0] === '案件名' || /^-+$/.test(cells[0])) continue;
  const url = cells.find((c) => c.startsWith('http')) || '';
  if (!url) continue;
  sections[cur].push(url);
  const draftCell = cells.find((c) => c.includes('reports/drafts/')) || '';
  upsert(url, {
    tier: cur,
    askedKim: cur === 'A',
    askedOn: cur === 'A' ? DATE : '',
    draftPath: draftCell.startsWith('reports/') ? draftCell : (seen[url]?.draftPath || ''),
  });
}

// known drafts
for (const slug of ['kagawa-dentoukougei', 'wakayama-police-kunren', 'shimonoseki-kankyo-douga']) {
  const dir = `reports/drafts/${DATE}/${slug}/`;
  for (const [url, rec] of Object.entries(seen)) {
    if (rec.draftPath === dir) continue;
  }
}


// all candidates CSV URLs (verification: dry-run new=0 for this date)
const csvPath = path.join(root, `data/candidates-${DATE}.csv`);
if (fs.existsSync(csvPath)) {
  const rows = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/).slice(1);
  for (const line of rows) {
    const m = line.match(/https?:\/\/[^,"]+/);
    if (!m) continue;
    upsert(m[0], {
      nameFilter: seen[m[0]]?.nameFilter || 'csv',
      tier: seen[m[0]]?.tier || '除外',
      title: seen[m[0]]?.title || '',
    });
  }
}

const out = path.join(root, 'data/state/seen.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(seen, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({
  urls: Object.keys(seen).length,
  tiers: Object.values(seen).reduce((a, r) => { a[r.tier] = (a[r.tier] || 0) + 1; return a; }, {}),
  askedKim: Object.values(seen).filter((r) => r.askedKim).length,
  shortlist: { A: sections.A.length, B: sections.B.length, C: sections.C.length },
}, null, 2));
