#!/usr/bin/env node
/**
 * gsc-preflight.mjs — GSC根拠つき新規記事プリフライト（X-0101）
 *
 * 予定記事の主クエリが既存ページで1〜30位なら NEW を止め REWRITE を勧める。
 *
 * 使い方:
 *   node tools/gsc-preflight.mjs --input <gsc.json|csv> --query "展示会ブース 制作"
 *   node tools/gsc-preflight.mjs --input raw.json --query "ブース デザイン" --query "再利用 ブース" --json
 *
 * 入力:
 *   - x0099 形式 JSON: { meta, rows:[{query,page,clicks,impressions,position,...}] }
 *   - 行配列 JSON / CSV（Query,Page,Clicks,Impressions,Position）
 */

import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const USAGE = `使い方:
  node tools/gsc-preflight.mjs --input <gsc.json|csv> --query "<主クエリ>" [--query ...] [--json]

オプション:
  --input <path>   GSC エクスポート（JSON / CSV）
  --query <text>   予定記事の主クエリ（複数可）
  --json           JSON で出力（既定は人が読む表）
  --help           このヘルプを表示
`;

const RANK_REWRITE_MAX = 30;

/** @typedef {{ query: string, page: string, clicks: number, impressions: number, position: number, site?: string }} GscRow */
/** @typedef {{ query: string, reason: string }} ExcludeHit */

/**
 * URL を比較・集計用に正規化する（#・?・末尾/除去、http→https、www 統一）。
 * @param {string} raw
 * @returns {string}
 */
export function normalizeUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  let href = text;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
    href = `https://${href}`;
  }
  let url;
  try {
    url = new URL(href);
  } catch {
    const stripped = text.split('#')[0].split('?')[0].replace(/\/+$/u, '');
    return stripped;
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  url.hash = '';
  url.search = '';
  let host = url.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  url.hostname = host;
  let pathname = url.pathname || '/';
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/u, '');
  else pathname = '';
  return `${url.protocol}//${host}${pathname}`;
}

/**
 * ボット/スクレイパー由来とみなすクエリか。
 * @param {string} query
 * @returns {{ excluded: boolean, reason: string }}
 */
export function classifyBotQuery(query) {
  const q = String(query ?? '').trim();
  if (!q) return { excluded: true, reason: 'empty' };
  const lower = q.toLowerCase();
  if (/\burl\s*:/iu.test(q) || lower.includes('url:')) return { excluded: true, reason: 'url:' };
  if (/\bsite\s*:/iu.test(q) || lower.includes('site:')) return { excluded: true, reason: 'site:' };
  if (/\binurl\s*:/iu.test(q) || lower.includes('inurl:')) return { excluded: true, reason: 'inurl:' };
  if (/\bfiletype\s*:/iu.test(q) || lower.includes('filetype:')) return { excluded: true, reason: 'filetype:' };
  if (/\b(?:scraper|scraping|crawler)\b/iu.test(q)) return { excluded: true, reason: 'scraper' };
  if (/(?:^|[^a-z])bot(?:[^a-z]|$)/iu.test(lower)) return { excluded: true, reason: 'bot' };
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu.test(q)) {
    return { excluded: true, reason: 'uuid' };
  }
  // 空白を挟まない英数字連続16以上（ハッシュ風）。通常の英語フレーズは除外しない
  if (/[A-Za-z0-9]{16,}/u.test(q)) {
    return { excluded: true, reason: 'alnum-run' };
  }
  const symbols = (q.match(/[^\p{L}\p{N}\s]/gu) || []).length;
  if (q.length >= 8 && symbols / q.length >= 0.4) {
    return { excluded: true, reason: 'symbol-heavy' };
  }
  return { excluded: false, reason: '' };
}

export function isBotQuery(query) {
  return classifyBotQuery(query).excluded;
}

/**
 * @param {string} text
 * @returns {GscRow[]}
 */
export function parseCsvGsc(text) {
  const lines = String(text ?? '').replace(/^\uFEFF/u, '').split(/\r?\n/u).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim().replace(/^"|"$/gu, ''));
  const idx = {
    query: findCol(header, ['query', 'queries', 'keyword', 'keywords']),
    page: findCol(header, ['page', 'pages', 'url', 'landing page', 'landing_page']),
    clicks: findCol(header, ['clicks', 'click']),
    impressions: findCol(header, ['impressions', 'impression', 'imps']),
    position: findCol(header, ['position', 'avg position', 'avg_position', '平均掲載順位']),
  };
  if (idx.query < 0 || idx.page < 0) {
    throw new Error('CSV に Query/Page 列がありません');
  }
  /** @type {GscRow[]} */
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const query = String(cols[idx.query] ?? '').trim();
    const page = String(cols[idx.page] ?? '').trim();
    if (!query && !page) continue;
    rows.push({
      query,
      page,
      clicks: num(cols[idx.clicks]),
      impressions: num(cols[idx.impressions]),
      position: num(cols[idx.position]),
    });
  }
  return rows;
}

/**
 * @param {unknown} data
 * @returns {GscRow[]}
 */
export function rowsFromJson(data) {
  if (Array.isArray(data)) return data.map(normalizeRow).filter(Boolean);
  if (data && typeof data === 'object' && Array.isArray(/** @type {{rows?: unknown}} */ (data).rows)) {
    return /** @type {{rows: unknown[]}} */ (data).rows.map(normalizeRow).filter(Boolean);
  }
  throw new Error('JSON は rows 配列、または行配列である必要があります');
}

/**
 * @param {string} filePath
 * @returns {{ rows: GscRow[], inputRows: number }}
 */
export function loadGscExport(filePath) {
  const abs = path.resolve(filePath);
  const text = fs.readFileSync(abs, 'utf8');
  const lower = abs.toLowerCase();
  if (lower.endsWith('.csv')) {
    const rows = parseCsvGsc(text);
    return { rows, inputRows: rows.length };
  }
  const data = JSON.parse(text);
  const rows = rowsFromJson(data);
  return { rows, inputRows: rows.length };
}

/**
 * ボット除外 → URL正規化で同一キーへ統合。
 * @param {GscRow[]} rows
 */
export function prepareRows(rows) {
  /** @type {ExcludeHit[]} */
  const excluded = [];
  /** @type {GscRow[]} */
  const kept = [];
  for (const row of rows) {
    const bot = classifyBotQuery(row.query);
    if (bot.excluded) {
      excluded.push({ query: row.query, reason: bot.reason });
      continue;
    }
    const page = normalizeUrl(row.page);
    if (!page) continue;
    kept.push({
      ...row,
      page,
      clicks: num(row.clicks),
      impressions: num(row.impressions),
      position: num(row.position),
    });
  }
  const mergedMap = new Map();
  for (const row of kept) {
    const key = `${row.query}\t${row.page}`;
    const prev = mergedMap.get(key);
    if (!prev) {
      mergedMap.set(key, { ...row });
      continue;
    }
    const impressions = prev.impressions + row.impressions;
    const position = impressions > 0
      ? (prev.position * prev.impressions + row.position * row.impressions) / impressions
      : Math.min(prev.position || Infinity, row.position || Infinity);
    mergedMap.set(key, {
      ...prev,
      clicks: prev.clicks + row.clicks,
      impressions,
      position: Number.isFinite(position) ? position : 0,
    });
  }
  const merged = [...mergedMap.values()];
  return {
    excludedCount: excluded.length,
    excluded,
    keptCount: kept.length,
    mergedRows: merged,
    mergedCount: merged.length,
  };
}

/**
 * 主クエリ1件のプリフライト判定。
 * @param {GscRow[]} preparedRows normalize+merge 済み
 * @param {string} mainQuery
 */
export function evaluateQuery(preparedRows, mainQuery) {
  const needle = String(mainQuery ?? '').trim();
  if (!needle) throw new Error('--query が空です');

  const matched = preparedRows.filter((r) => String(r.query).includes(needle));
  if (matched.length === 0) {
    return {
      query: needle,
      verdict: 'NO_DATA',
      label: '該当なし',
      bestPage: null,
      position: null,
      clicks: null,
      impressions: null,
      matchedRows: 0,
      pages: [],
      internalLinkCandidates: [],
      advice: 'データに該当行がありません（捏造しない）。',
    };
  }

  /** @type {Map<string, { page: string, clicks: number, impressions: number, position: number, queryCount: number }>} */
  const byPage = new Map();
  for (const row of matched) {
    const prev = byPage.get(row.page);
    if (!prev) {
      byPage.set(row.page, {
        page: row.page,
        clicks: row.clicks,
        impressions: row.impressions,
        position: row.position,
        queryCount: 1,
      });
      continue;
    }
    const impressions = prev.impressions + row.impressions;
    const position = impressions > 0
      ? (prev.position * prev.impressions + row.position * row.impressions) / impressions
      : prev.position;
    byPage.set(row.page, {
      page: row.page,
      clicks: prev.clicks + row.clicks,
      impressions,
      position,
      queryCount: prev.queryCount + 1,
    });
  }

  const pages = [...byPage.values()].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return b.impressions - a.impressions;
  });

  const best = pages[0];
  const inTop30 = best && best.position >= 1 && best.position <= RANK_REWRITE_MAX;
  const verdict = inTop30 ? 'REWRITE' : 'NEW_OK';

  const internalLinkCandidates = pages
    .filter((p) => p.page !== best.page && p.impressions > 0)
    .sort((a, b) => b.impressions - a.impressions || a.position - b.position)
    .slice(0, 5)
    .map((p) => ({
      page: p.page,
      impressions: p.impressions,
      clicks: p.clicks,
      position: round(p.position, 1),
    }));

  return {
    query: needle,
    verdict,
    label: verdict,
    bestPage: best.page,
    position: round(best.position, 1),
    clicks: best.clicks,
    impressions: best.impressions,
    matchedRows: matched.length,
    pages: pages.map((p) => ({
      page: p.page,
      clicks: p.clicks,
      impressions: p.impressions,
      position: round(p.position, 1),
      queryCount: p.queryCount,
    })),
    internalLinkCandidates,
    advice: verdict === 'REWRITE'
      ? `既存 ${best.page}（平均順位 ${round(best.position, 1)}）を直し、即答500字以内＋内部リンク追加を勧める。`
      : '既存ページが1〜30位に無いため新規記事（NEW）可。',
  };
}

/**
 * @param {GscRow[]} rows
 * @param {string[]} queries
 */
export function runPreflight(rows, queries) {
  const prepared = prepareRows(rows);
  const results = queries.map((q) => evaluateQuery(prepared.mergedRows, q));
  return {
    stats: {
      inputRows: rows.length,
      excludedRows: prepared.excludedCount,
      keptRows: prepared.keptCount,
      mergedRows: prepared.mergedCount,
      // 入力 = 除外 + 保持（空URLで落ちた行は kept に入れないが入力からは除外扱いでない）
      // 空ページは稀なので、合計一致は inputRows = excluded + kept + droppedEmpty
      droppedEmptyPage: rows.length - prepared.excludedCount - prepared.keptCount,
    },
    results,
  };
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{ help?: boolean, json?: boolean, input?: string, queries: string[] }} */
  const args = { queries: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--input') {
      if (i + 1 >= argv.length) throw new Error('--input の値がありません');
      args.input = argv[++i];
    } else if (a === '--query') {
      if (i + 1 >= argv.length) throw new Error('--query の値がありません');
      args.queries.push(argv[++i]);
    } else {
      throw new Error(`未知の引数: ${a}`);
    }
  }
  return args;
}

/**
 * @param {ReturnType<typeof runPreflight>} report
 */
export function formatTable(report) {
  const lines = [];
  const s = report.stats;
  lines.push('# GSC Preflight');
  lines.push('');
  lines.push(`入力行数: ${s.inputRows}`);
  lines.push(`除外行数: ${s.excludedRows}`);
  lines.push(`保持行数: ${s.keptRows}`);
  lines.push(`正規化統合後行数: ${s.mergedRows}`);
  lines.push(`空ページ落とし: ${s.droppedEmptyPage}`);
  lines.push(`合計チェック: ${s.excludedRows + s.keptRows + s.droppedEmptyPage} （入力 ${s.inputRows}）`);
  lines.push('');
  lines.push('| 主クエリ | 判定 | 最良ページ | 順位 | クリック | 表示 | 内部リンク候補（上位5） |');
  lines.push('|---|---|---|---:|---:|---:|---|');
  for (const r of report.results) {
    if (r.verdict === 'NO_DATA') {
      lines.push(`| ${esc(r.query)} | 該当なし | — | — | — | — | — |`);
      continue;
    }
    const links = r.internalLinkCandidates.length
      ? r.internalLinkCandidates.map((c) => c.page).join('<br>')
      : '—';
    lines.push(
      `| ${esc(r.query)} | ${r.verdict} | ${esc(r.bestPage)} | ${r.position} | ${r.clicks} | ${r.impressions} | ${links} |`,
    );
  }
  lines.push('');
  for (const r of report.results) {
    lines.push(`## ${r.query}`);
    lines.push(r.advice);
    lines.push('');
  }
  return lines.join('\n');
}

function findCol(header, names) {
  const lower = header.map((h) => h.toLowerCase());
  for (const name of names) {
    const i = lower.indexOf(name.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function normalizeRow(row) {
  if (!row || typeof row !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (row);
  const query = String(r.query ?? r.Query ?? r.keyword ?? '').trim();
  const page = String(r.page ?? r.Page ?? r.url ?? '').trim();
  if (!query && !page) return null;
  return {
    query,
    page,
    clicks: num(r.clicks ?? r.Clicks),
    impressions: num(r.impressions ?? r.Impressions),
    position: num(r.position ?? r.Position),
    site: r.site != null ? String(r.site) : undefined,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(n, digits) {
  const p = 10 ** digits;
  return Math.round(Number(n) * p) / p;
}

function esc(s) {
  return String(s ?? '').replace(/\|/gu, '\\|');
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!args.input) {
    process.stderr.write('--input が必要です\n');
    process.stderr.write(USAGE);
    return 1;
  }
  if (!args.queries.length) {
    process.stderr.write('--query が1つ以上必要です\n');
    process.stderr.write(USAGE);
    return 1;
  }
  const { rows } = loadGscExport(args.input);
  const report = runPreflight(rows, args.queries);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatTable(report)}\n`);
  }
  return 0;
}

if (isEntry(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
