#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const CATALOG_URL = new URL('./ai-unit-price-renewal-catalog.json', import.meta.url);
const CASES_URL = new URL('./ai-unit-price-renewal-cases.json', import.meta.url);
const DOC_URL = new URL('../docs/ai-unit-price-renewal.md', import.meta.url);
const DOC_LABEL = 'docs/ai-unit-price-renewal.md';
const USAGE = '使い方: node tools/ai-unit-price-renewal.mjs [--write | --check | --analyze <file> | --template] [--asof YYYY-MM-DD]';
const BASES = ['case', 'person-day', 'month'];
const BOOL_FIELDS = ['aiUsed', 'renewalTarget', 'renewalRenewed'];

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function requireDate(value, label) {
  if (!validDate(value)) throw new Error(`${label}: 実在する YYYY-MM-DD の日付が必要です`);
}

export function parseCases(ledger) {
  if (!ledger || !Array.isArray(ledger.cases)) throw new Error('案件 (台帳): cases は配列で指定してください');
  if (ledger.asOf != null) requireDate(ledger.asOf, '案件 (台帳): asOf');
  const ids = new Set();
  const cases = ledger.cases.map((input) => {
    const row = { ...input };
    const fail = (reason) => { throw new Error(`案件 ${row.id ?? '(不明)'}: ${reason}`); };
    if (typeof row.id !== 'string' || !row.id.trim()) fail('id は非空文字列が必要です');
    if (ids.has(row.id)) fail('id が重複しています');
    ids.add(row.id);
    if (!validDate(row.contractDate)) fail('contractDate は実在する YYYY-MM-DD の日付が必要です');
    for (const key of ['amountYen', 'quantity']) {
      if (!Number.isFinite(row[key]) || row[key] <= 0) fail(`${key} は 0 より大きい有限数が必要です`);
    }
    if (!BASES.includes(row.unitPriceBasis)) fail('unitPriceBasis は case / person-day / month が必要です');
    for (const key of BOOL_FIELDS) {
      row[key] = row[key] ?? null;
      if (row[key] !== null && typeof row[key] !== 'boolean') fail(`${key} は true / false / null が必要です`);
    }
    row.renewalDueDate = row.renewalDueDate ?? null;
    if (row.renewalDueDate !== null && !validDate(row.renewalDueDate)) fail('renewalDueDate は実在する YYYY-MM-DD または null が必要です');
    return row;
  });
  return { dataStatus: ledger.dataStatus, source: ledger.source ?? '', asOf: ledger.asOf ?? null, cases };
}

export function parseCasesCsv(text) {
  // State machine preserves commas, newlines and escaped quotes inside quoted cells.
  const records = [];
  let cells = [], cell = '', state = 'start';
  text = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const endCell = () => { cells.push(cell); cell = ''; state = 'start'; };
  const endRow = () => { endCell(); records.push(cells); cells = []; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (state === 'quoted') {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else state = 'closed';
      } else cell += char;
    } else if (char === ',') endCell();
    else if (char === '\n' || char === '\r') endRow();
    else if (char === '"' && state === 'start') state = 'quoted';
    else {
      if (state === 'closed' || char === '"') throw new Error('案件 (CSV): 引用符の形式が不正です');
      cell += char;
      state = 'plain';
    }
  }
  if (state === 'quoted') throw new Error('案件 (CSV): 引用符が閉じていません');
  if (cells.length || cell || state !== 'start') endRow();
  const header = (records.shift() ?? []).map((value) => value.trim());
  for (const key of ['id', 'contractDate', 'amountYen', 'quantity', 'unitPriceBasis']) {
    if (!header.includes(key)) throw new Error(`案件 (CSV): 必須列 ${key} がありません`);
  }
  if (new Set(header).size !== header.length) throw new Error('案件 (CSV): ヘッダが重複しています');
  const cases = records.filter((record) => !(record.length === 1 && record[0] === '')).map((record) => {
    if (record.length !== header.length) throw new Error(`案件 ${record[header.indexOf('id')] || '(CSV)'}: 列数がヘッダと一致しません`);
    const row = Object.fromEntries(header.map((key, i) => [key, record[i]]));
    for (const key of ['amountYen', 'quantity']) row[key] = row[key].trim() === '' ? null : Number(row[key]);
    for (const key of BOOL_FIELDS) {
      const value = (row[key] ?? '').trim().toLowerCase();
      if (value === '') row[key] = null;
      else if (['true', '1', 'yes'].includes(value)) row[key] = true;
      else if (['false', '0', 'no'].includes(value)) row[key] = false;
      else throw new Error(`案件 ${row.id}: ${key} の真偽値が不正です`);
    }
    row.renewalDueDate = row.renewalDueDate?.trim() || null;
    return row;
  });
  return parseCases({ dataStatus: 'connected', source: 'CSV', cases });
}

export function unitPriceOf(row) { return row.amountYen / row.quantity; }

export function selectWindow(cases, asOf, months) {
  requireDate(asOf, 'asOf');
  if (!Number.isInteger(months) || months < 0) throw new Error('windowMonths は非負整数が必要です');
  const start = new Date(`${asOf}T00:00:00.000Z`);
  const day = start.getUTCDate();
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - months);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  start.setUTCDate(Math.min(day, end.getUTCDate()));
  const lower = start.toISOString().slice(0, 10);
  const inWindow = cases.filter((row) => row.contractDate >= lower && row.contractDate <= asOf);
  return { inWindow, excludedOutOfWindow: cases.length - inWindow.length };
}

export function splitByAi(cases, mode, aiAdoptedAt) {
  if (!['case-flag', 'cutoff-date'].includes(mode)) throw new Error(`未知の splitMode: ${mode}`);
  if (mode === 'cutoff-date') requireDate(aiAdoptedAt, 'aiAdoptedAt');
  const result = { before: [], after: [], unknown: [] };
  for (const row of cases) {
    const group = mode === 'cutoff-date' ? (row.contractDate < aiAdoptedAt ? 'before' : 'after')
      : row.aiUsed === true ? 'after' : row.aiUsed === false ? 'before' : 'unknown';
    result[group].push(row);
  }
  return result;
}

export function summarizeUnitPrice(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.unitPriceBasis)) groups.set(row.unitPriceBasis, []);
    groups.get(row.unitPriceBasis).push(unitPriceOf(row));
  }
  return [...groups.keys()].sort().map((basis) => {
    const prices = groups.get(basis).sort((a, b) => a - b);
    const n = prices.length;
    // totalYen is the sum of per-case unit prices, not the sum of contract amounts.
    const totalYen = prices.reduce((sum, price) => sum + price, 0);
    return { basis, n, mean: totalYen / n, median: n % 2 ? prices[(n - 1) / 2] : (prices[n / 2 - 1] + prices[n / 2]) / 2,
      min: prices[0], max: prices[n - 1], totalYen };
  });
}

export function renewalRate(rows, asOf) {
  requireDate(asOf, 'asOf');
  let n = 0, renewed = 0, excludedNotDue = 0, excludedNoDueDate = 0;
  for (const row of rows) {
    if (row.renewalTarget !== true) continue;
    if (row.renewalDueDate == null) { excludedNoDueDate++; continue; }
    if (row.renewalDueDate > asOf) { excludedNotDue++; continue; }
    n++;
    if (row.renewalRenewed === true) renewed++;
  }
  return { n, renewed, rate: n ? renewed / n : null, excludedNotDue, excludedNoDueDate };
}

export function analyze(ledger, catalog, asOfOverride) {
  const parsed = parseCases(ledger);
  const asOf = asOfOverride ?? parsed.asOf ?? catalog.asOfDefault;
  const { windowMonths, splitMode, minSampleForClaim } = catalog;
  const window = selectWindow(parsed.cases, asOf, windowMonths);
  const groups = splitByAi(window.inWindow, splitMode, catalog.aiAdoptedAt);
  const byBasis = { before: summarizeUnitPrice(groups.before), after: summarizeUnitPrice(groups.after) };
  const bases = [...new Set([...byBasis.before, ...byBasis.after].map((row) => row.basis))].sort();
  const comparison = bases.map((basis) => {
    const before = byBasis.before.find((row) => row.basis === basis);
    const after = byBasis.after.find((row) => row.basis === basis);
    const beforeN = before?.n ?? 0, afterN = after?.n ?? 0;
    const beforeMean = before?.mean ?? null, afterMean = after?.mean ?? null;
    const diffYen = beforeMean !== null && afterMean !== null ? afterMean - beforeMean : null;
    return { basis, beforeN, afterN, beforeMean, afterMean, diffYen,
      ratioPct: beforeMean === null || beforeMean === 0 || diffYen === null ? null : diffYen / beforeMean * 100,
      reliable: beforeN >= minSampleForClaim && afterN >= minSampleForClaim };
  });
  const before = renewalRate(groups.before, asOf), after = renewalRate(groups.after, asOf);
  const connected = parsed.dataStatus === 'connected' && parsed.cases.length > 0;
  const warnings = [];
  if (!connected) warnings.push('実データが未接続です。単価・契約更新率は算出結果として表示しません。');
  if (groups.unknown.length) warnings.push(`aiUsed 不明の ${groups.unknown.length} 件を前後比較から除外しました。`);
  return { asOf, windowMonths, splitMode, minSampleForClaim, connected, source: parsed.source,
    totalCases: parsed.cases.length, inWindow: window.inWindow.length, excludedOutOfWindow: window.excludedOutOfWindow,
    unknownCount: groups.unknown.length, unitPrice: { byBasis, comparison },
    renewal: { before, after, comparison: { beforeN: before.n, afterN: after.n, beforeRate: before.rate, afterRate: after.rate,
      diffPctPoint: before.rate === null || after.rate === null ? null : (after.rate - before.rate) * 100,
      reliable: before.n >= minSampleForClaim && after.n >= minSampleForClaim } }, warnings };
}

function formatYen(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
const yen = (n) => n === null ? '—' : `${formatYen(n)} 円`;
const pct = (n) => n === null ? '—' : `${(n * 100).toFixed(1)}%`;
const diff = (n, unit) => n === null ? '—' : `${n >= 0 ? '+' : ''}${unit === ' 円' ? formatYen(n) : n.toFixed(1)}${unit}`;
const cellText = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

export function render(catalog, analysis) {
  const a = analysis;
  const judgment = (reliable) => reliable ? '—' : `参考値（n<${a.minSampleForClaim}）`;
  const lines = [
    '<!-- このファイルは tools/ai-unit-price-renewal.mjs --write が生成する。手で編集しない。 -->',
    '# AI導入後の単価変化と契約更新率（P-0149）', '',
  ];
  if (!a.connected) lines.push(`> ⚠️ ${catalog.dataStatusNote}`, '');
  lines.push(`- 基準日: ${a.asOf} / 分析窓: 直近 ${a.windowMonths} ヶ月 / 分割モード: ${a.splitMode}`,
    `- 台帳: ${cellText(a.source || '未接続')} / 総案件数: ${a.totalCases} / 分析対象: ${a.inWindow}（窓外 ${a.excludedOutOfWindow} / aiUsed不明 ${a.unknownCount}）`,
    '', '## 分析設計', '', ...catalog.metrics.map((metric) => `- ${metric.name}: ${metric.definition}`),
    `- ${catalog.censoringRule}`, `- ${catalog.minSampleNote}`, '', '## 結果', '');
  if (!a.connected) {
    lines.push('実データが未接続のため、単価・契約更新率は算出していない（数値は 0 ではなく「なし」）。',
      '', '## 必要な入力', '', '| フィールド | 型 | 説明 |', '|---|---|---|',
      ...catalog.requiredFields.map((field) => `| ${cellText(field.name)} | ${cellText(field.type)} | ${cellText(field.note)} |`));
  } else {
    lines.push('### 単価（基準別）', '', '| basis | 群 | n | 平均 | 中央値 | 最小 | 最大 |', '|---|---|---|---|---|---|---|');
    for (const [group, label] of [['before', '前'], ['after', '後']]) {
      for (const row of a.unitPrice.byBasis[group]) lines.push(`| ${row.basis} | ${label} | ${row.n} | ${yen(row.mean)} | ${yen(row.median)} | ${yen(row.min)} | ${yen(row.max)} |`);
    }
    lines.push('', '### 単価の比較', '', '| basis | 前 平均(n) | 後 平均(n) | 差 | 変化率 | 判定 |', '|---|---|---|---|---|---|');
    for (const row of a.unitPrice.comparison) lines.push(`| ${row.basis} | ${yen(row.beforeMean)} (${row.beforeN}) | ${yen(row.afterMean)} (${row.afterN}) | ${diff(row.diffYen, ' 円')} | ${diff(row.ratioPct, '%')} | ${judgment(row.reliable)} |`);
    lines.push('', '### 契約更新率', '', '| 群 | 分母 | 更新 | 更新率 | 除外(時期未到来) | 除外(期日なし) |', '|---|---|---|---|---|---|');
    for (const [group, label] of [['before', '前'], ['after', '後']]) {
      const row = a.renewal[group];
      lines.push(`| ${label} | ${row.n} | ${row.renewed} | ${pct(row.rate)} | ${row.excludedNotDue} | ${row.excludedNoDueDate} |`);
    }
    const row = a.renewal.comparison;
    lines.push('', '### 契約更新率の比較', '', '| 前 | 後 | 差(pt) | 判定 |', '|---|---|---|---|',
      `| ${pct(row.beforeRate)} | ${pct(row.afterRate)} | ${diff(row.diffPctPoint, 'pt')} | ${judgment(row.reliable)} |`);
  }
  if (a.warnings.length) lines.push('', ...a.warnings.map((warning) => `- ${warning}`));
  lines.push('', '## 限界', '', ...catalog.limits.map((limit) => `- ${limit}`), '', '## データの接続方法', '',
    '- 台帳 JSON: tools/ai-unit-price-renewal-cases.json の cases に追記し、dataStatus を "connected" にする',
    '- CSV: `node tools/ai-unit-price-renewal.mjs --analyze <file>.csv`',
    '- 雛形: `node tools/ai-unit-price-renewal.mjs --template`');
  return `${lines.join('\n')}\n`;
}

export function main(argv) {
  let mode = null, file, asOf;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--asof' && asOf === undefined && validDate(argv[i + 1])) asOf = argv[++i];
    else if (['--write', '--check', '--template', '--analyze'].includes(arg) && mode === null) {
      mode = arg;
      if (arg === '--analyze') {
        file = argv[++i];
        if (!file?.trim() || file.startsWith('--')) { console.error(USAGE); return 2; }
      }
    } else { console.error(USAGE); return 2; }
  }
  try {
    const catalog = JSON.parse(fs.readFileSync(CATALOG_URL, 'utf8'));
    if (mode === '--template') {
      console.log(JSON.stringify({ dataStatus: 'connected', source: 'サンプル（実案件に置き換えてください）', asOf: asOf ?? catalog.asOfDefault,
        cases: [{ id: 'sample-001', name: 'サンプル案件', contractDate: asOf ?? catalog.asOfDefault, amountYen: 120000,
          quantity: 1, unitPriceBasis: 'case', aiUsed: false, renewalTarget: true, renewalDueDate: null, renewalRenewed: null }] }, null, 2));
      return 0;
    }
    let ledger;
    if (mode === '--analyze') {
      const content = fs.readFileSync(file, 'utf8');
      const extension = path.extname(file).toLowerCase();
      if (extension === '.csv') { ledger = parseCasesCsv(content); ledger.source = file; }
      else if (extension === '.json') ledger = JSON.parse(content);
      else throw new Error('入力ファイルは .json または .csv を指定してください');
    } else ledger = JSON.parse(fs.readFileSync(CASES_URL, 'utf8'));
    const analysis = analyze(ledger, catalog, asOf ?? (['--write', '--check'].includes(mode) ? catalog.asOfDefault : undefined));
    if (mode === null) {
      console.log(`接続状態: ${analysis.connected ? '接続済み' : '未接続'} / 総件数: ${analysis.totalCases} / 分析窓の対象件数: ${analysis.inWindow} / unknown 件数: ${analysis.unknownCount}\n基準日: ${analysis.asOf}`);
      return 0;
    }
    const output = render(catalog, analysis);
    if (mode === '--analyze') { console.log(output.trimEnd()); return 0; }
    if (mode === '--write') {
      fs.mkdirSync(path.dirname(fileURLToPath(DOC_URL)), { recursive: true });
      fs.writeFileSync(DOC_URL, output, 'utf8');
      console.log(`生成: ${DOC_LABEL}`);
      return 0;
    }
    let existing;
    try { existing = fs.readFileSync(DOC_URL, 'utf8').replace(/\r\n/g, '\n'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing === output) { console.log(`OK: ${DOC_LABEL} は最新`); return 0; }
    console.error(`drift: ${DOC_LABEL} が生成物と一致しません。--write で再生成してください。`);
    return 1;
  } catch (error) { console.error(error.message); return 2; }
}

if (isEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2));
