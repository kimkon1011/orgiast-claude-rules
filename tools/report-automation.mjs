#!/usr/bin/env node
// P-0147: CSV集計・描画は決定的。時計を使うのは明示的な実測時のみ。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

export const DEFAULT_REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CANONICAL_STAGES = ['won', 'lost', 'open'];
const AD_KEYS = ['impressions', 'clicks', 'costJpy', 'conversions'];
const MOM_KEYS = ['costJpy', 'conversions', 'wonAmountJpy', 'roas'];
const USAGE = '使用法: node tools/report-automation.mjs [--run [--out <dir>]|--write|--check]';

export function parseCsv(text) {
  const source = String(text).replace(/^\uFEFF/u, '');
  if (!source) return { header: [], rows: [] };
  const records = [];
  let row = [], field = '', quoted = false, closed = false, touched = false;
  const endField = () => { row.push(field); field = ''; closed = false; };
  const endRow = () => { endField(); records.push({ row, blank: !touched }); row = []; touched = false; };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += c;
      continue;
    }
    if (c === ',') { touched = true; endField(); }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && source[i + 1] === '\n') i++;
      endRow();
    } else if (c === '"' && field === '' && !closed) { quoted = true; touched = true; }
    else {
      if (closed || c === '"') throw new Error('CSVの引用符が不正です');
      field += c; touched = true;
    }
  }
  if (quoted) throw new Error('CSVの引用符が閉じられていません');
  if (touched) endRow();
  while (records.at(-1)?.blank) records.pop();
  return { header: records[0]?.row ?? [], rows: records.slice(1).map((record) => record.row) };
}

export function rowsToObjects(parsed) {
  return parsed.rows.map((row) => Object.fromEntries(parsed.header.map((key, i) => [key, row[i] ?? ''])));
}

const stageKey = (raw) => String(raw ?? '').toLowerCase().replaceAll('_', ' ').replace(/\s+/gu, ' ').trim();
export function normalizeStage(raw, catalog) {
  const key = stageKey(raw);
  return CANONICAL_STAGES.find((stage) => (catalog.stageAliases[stage] || []).some((alias) => stageKey(alias) === key)) ?? null;
}

function numeric(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function normalizeAdRows(text, { month } = {}) {
  return rowsToObjects(parseCsv(text)).map((row) => ({
    month: row.month.trim(), campaign: row.campaign.trim(),
    impressions: numeric(row.impressions), clicks: numeric(row.clicks),
    costJpy: numeric(row.cost_jpy), conversions: numeric(row.conversions),
  })).filter((row) => month === undefined || row.month === month);
}

export function normalizeDealRows(text, catalog) {
  const seen = new Set(), rows = [];
  let duplicatesRemoved = 0;
  for (const row of rowsToObjects(parseCsv(text))) {
    const dealId = row.deal_id.trim();
    if (seen.has(dealId)) { duplicatesRemoved++; continue; }
    seen.add(dealId);
    rows.push({ dealId, dealName: row.deal_name, stage: normalizeStage(row.stage, catalog),
      amountJpy: numeric(row.amount_jpy), campaign: row.source_campaign.trim(), month: row.close_month.trim() });
  }
  return { rows, duplicatesRemoved };
}

const ratio = (a, b) => a === null || b === null || b === 0 ? null : a / b;
export function metricsFor(ad, deals) {
  const { impressions, clicks, costJpy, conversions } = Object.fromEntries(AD_KEYS.map((key) => [key, numeric(ad[key])]));
  const won = deals.filter((deal) => deal.stage === 'won');
  const wonAmountJpy = won.reduce((sum, deal) => sum + (deal.amountJpy ?? 0), 0);
  return { impressions, clicks, costJpy, conversions, leads: deals.length, wonDeals: won.length, wonAmountJpy,
    ctr: ratio(clicks, impressions), cpc: ratio(costJpy, clicks), cpa: ratio(costJpy, conversions),
    cvr: ratio(conversions, clicks), roas: ratio(wonAmountJpy, costJpy) };
}

export function monthOverMonth(current, previous) {
  return Object.fromEntries(MOM_KEYS.map((key) => {
    const now = current?.[key] ?? null, before = previous?.[key] ?? null;
    const delta = now === null || before === null ? null : now - before;
    return [key, { current: now, previous: before, delta, deltaPct: ratio(delta, before) }];
  }));
}

// 広告の不正数値は集約でもnullを伝播し、不明な費用を0円にしない。
function sumAds(rows) {
  return Object.fromEntries(AD_KEYS.map((key) => [key,
    rows.some((row) => row[key] === null) ? null : rows.reduce((sum, row) => sum + row[key], 0),
  ]));
}

export function buildReport(adText, dealsText, catalog, options = {}) {
  // optionsは拡張用。期間は常に広告CSVに存在する月から決める。
  const ads = normalizeAdRows(adText), normalized = normalizeDealRows(dealsText, catalog);
  const months = [...new Set(ads.map((row) => row.month))].sort();
  const period = months.at(-1) ?? null, previousPeriod = months.at(-2) ?? null;
  const currentAds = ads.filter((row) => row.month === period);
  const names = [...new Set(currentAds.map((row) => row.campaign))].sort();
  const allAdNames = new Set(ads.map((row) => row.campaign));
  const forCampaign = (campaign, month) => metricsFor(
    sumAds(ads.filter((row) => row.campaign === campaign && row.month === month)),
    normalized.rows.filter((row) => row.campaign === campaign && row.month === month),
  );
  const campaigns = names.map((campaign) => {
    const current = forCampaign(campaign, period);
    const previous = previousPeriod === null ? null : forCampaign(campaign, previousPeriod);
    return { campaign, ...current, mom: monthOverMonth(current, previous) };
  });
  const currentNames = new Set(names);
  return { period, previousPeriod, campaigns,
    totals: metricsFor(sumAds(currentAds), normalized.rows.filter((row) => row.month === period && currentNames.has(row.campaign))),
    adRows: ads.length, dealRows: parseCsv(dealsText).rows.length, duplicatesRemoved: normalized.duplicatesRemoved,
    unmappedCampaigns: [...new Set(normalized.rows.filter((row) => !allAdNames.has(row.campaign)).map((row) => row.campaign))].sort() };
}

export function verdictFor(agg, catalog) {
  if (!agg.measured) return { verdict: '未実測', reason: '自動化パイプラインの実測runなし' };
  if (agg.savedMinutes === null || agg.savedMinutes <= 0) return { verdict: '削減効果なし', reason: '自動化後の人手が手作業以上' };
  if (agg.savedPct < catalog.thresholds.minReductionPct) return { verdict: '削減は限定的', reason: '削減率が閾値50%未満' };
  if (agg.unverified.length > 0) return { verdict: '条件付きで有効', reason: '削減率は閾値以上だが前提または未自動化ステップが未検証' };
  return { verdict: '削減有効', reason: '削減率が閾値以上で全ステップの前提が検証済み' };
}

export function summarize(results, catalog) {
  const latest = results?.runs?.at(-1);
  const measured = Boolean(latest);
  const manualMinutes = catalog.manualSteps.reduce((sum, step) => sum + step.minutes, 0);
  const residualMinutes = catalog.manualSteps.reduce((sum, step) => sum + step.residualMinutes, 0);
  const pipelineMs = measured ? numeric(latest.pipelineMs) : null;
  if (measured && (pipelineMs === null || pipelineMs < 0)) throw new Error('最新runのpipelineMsは0以上の数が必要です');
  const machineMinutes = measured ? pipelineMs / 60000 : null;
  const humanMinutesAfter = measured ? residualMinutes + machineMinutes : null;
  const savedMinutes = measured ? manualMinutes - humanMinutesAfter : null;
  const savedPct = measured ? ratio(savedMinutes, manualMinutes) : null;
  const monthlySavedMinutes = measured ? savedMinutes * catalog.assumptions.reportsPerMonth : null;
  const monthlySavedJpy = measured ? monthlySavedMinutes / 60 * catalog.assumptions.hourlyRateJpy : null;
  const paybackRuns = measured && savedMinutes > 0 ? Math.ceil(catalog.assumptions.implementationMinutes / savedMinutes) : null;
  const unverified = catalog.manualSteps.filter((step) => step.basis !== 'observed' || step.autoStatus !== 'automated').map((step) => step.id);
  const agg = { measured, manualMinutes, residualMinutes, machineMinutes, humanMinutesAfter, savedMinutes, savedPct,
    monthlySavedMinutes, monthlySavedJpy, paybackRuns, unverified, period: latest?.period ?? null,
    previousPeriod: latest?.previousPeriod ?? null, pipelineMs };
  return { ...agg, ...verdictFor(agg, catalog) };
}

const cell = (value) => value === null || value === undefined ? '-' : String(value)
  .replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\r\n|\r|\n/gu, '<br>');
const num = (value, digits = 0) => value === null || value === undefined ? '-' : value.toLocaleString('en-US', {
  minimumFractionDigits: digits, maximumFractionDigits: digits,
});
const yen = (value) => value === null || value === undefined ? '-' : `¥${num(value)}`;
const pct = (value) => value === null || value === undefined ? '-' : `${(value * 100).toFixed(1)}%`;
const tableRow = (values) => `| ${values.map(cell).join(' | ')} |`;

export function renderReportMarkdown(built, catalog) {
  const lines = ['## 集計', '',
    `対象期間: ${cell(built.period)} / 前月: ${cell(built.previousPeriod)}。`,
    `取り込み: 広告 ${built.adRows} 行 / ディール ${built.dealRows} 行（重複除去前）、重複除去 ${built.duplicatesRemoved} 件。`, '',
    '| campaign | impressions | clicks | cost | leads | wonDeals | wonAmount | CPA | ROAS |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const row of [...built.campaigns, { campaign: '合計', ...built.totals }]) {
    lines.push(tableRow([row.campaign, num(row.impressions), num(row.clicks), yen(row.costJpy), num(row.leads),
      num(row.wonDeals), yen(row.wonAmountJpy), yen(row.cpa), pct(row.roas)]));
  }
  lines.push('', '### 前月比', '',
    '| campaign | cost 前月比 | conversions 前月比 | wonAmount 前月比 | ROAS 前月比 |',
    '|---|---:|---:|---:|---:|');
  for (const row of built.campaigns) lines.push(tableRow([row.campaign, ...MOM_KEYS.map((key) => pct(row.mom[key].deltaPct))]));
  lines.push('', '前月比は (当月 − 前月) / 前月。前月が0または不明なら -。ROASは受注額 / 広告費を百分率で表示。',
    `広告側にないキャンペーン: ${built.unmappedCampaigns.length ? built.unmappedCampaigns.map(cell).join('、') : 'なし'}。`,
    `入力: ${cell(catalog.sources.adMetrics)} / ${cell(catalog.sources.hubspot)}。`);
  return `${lines.join('\n')}\n`;
}

function readFixtures(repo) {
  const dir = path.join(repo, 'tools', 'report-automation', 'fixtures');
  return { adText: fs.readFileSync(path.join(dir, 'ad-metrics.csv'), 'utf8'),
    dealsText: fs.readFileSync(path.join(dir, 'hubspot-deals.csv'), 'utf8') };
}

export function renderMarkdown(results, catalog) {
  const a = summarize(results, catalog), latest = results?.runs?.at(-1);
  // runsは実測メタデータのみ。表は同梱CSVから再集計し、保存済みrunのスナップショットとは区別する。
  const { adText, dealsText } = readFixtures(DEFAULT_REPO);
  const built = buildReport(adText, dealsText, catalog);
  const lines = ['> このファイルは生成物。手で編集しない。再生成: `node tools/report-automation.mjs --write`', '',
    `# ${cell(catalog.title)}`, '', '## 結論', '', `**${a.verdict}** — ${a.reason}。`,
    `手作業 ${num(a.manualMinutes)}分 / 自動化後 ${num(a.humanMinutesAfter, 3)}分 / 削減 ${pct(a.savedPct)}。`];
  if (!a.measured) lines.push('`node tools/report-automation.mjs --run` で計測後、`node tools/report-automation.mjs --write` で再生成する。');
  lines.push('', '## 自動化パイプラインの実測', '',
    `対象期間: ${cell(a.period)} / 前月: ${cell(a.previousPeriod)} / 広告 ${num(latest?.adRows)} 行 / ディール ${num(latest?.dealRows)} 行 / 重複除去 ${num(latest?.duplicatesRemoved)} 件 / パイプライン ${num(a.pipelineMs, 1)} ms。`, '',
    '以下は同梱CSVの参考集計。実測runの有無にかかわらず再集計し、過去runの出力を復元するものではない。', '',
    renderReportMarkdown(built, catalog).trimEnd().replace(/^## 集計/u, '### 集計').replace('\n### 前月比\n', '\n#### 前月比\n'), '',
    '## 削減効果', '', '| 項目 | 値 |', '|---|---:|',
    tableRow(['手作業', `${num(a.manualMinutes)}分`]),
    tableRow(['自動化後の人手（想定）', `${num(a.residualMinutes)}分`]),
    tableRow(['機械', `${num(a.machineMinutes, 3)}分`]),
    tableRow(['人手 + 機械', `${num(a.humanMinutesAfter, 3)}分`]),
    tableRow(['削減', `${num(a.savedMinutes, 3)}分（${pct(a.savedPct)}）`]),
    tableRow(['月間換算', `${num(a.monthlySavedMinutes, 3)}分 / ${yen(a.monthlySavedJpy)}`]),
    tableRow(['回収', `${num(a.paybackRuns)}回`]), '',
    '未実測の項目は -。人手 + 機械を自動化後の時間として削減効果を計算する。', '',
    '## 手作業ステップの内訳', '',
    '| id | ステップ | 手作業(分) | 自動化後の人手(分) | 前提 | 自動化の方法 |',
    '|---|---|---:|---:|---|---|');
  for (const step of catalog.manualSteps) lines.push(tableRow([step.id, step.label, step.minutes, step.residualMinutes, step.basis, step.automatedBy]));
  lines.push('', '## 前提値（assumed）', '',
    ...Object.entries(catalog.assumptions).map(([key, value]) => `- ${cell(key)}: ${cell(value)}（assumed）`), '',
    '## 未検証', '', '- 手作業分の前提は実測ではなく想定値。',
    '- 所感の文章生成（ChatGPTレーン）は未自動化・未実測。',
    '- HubSpot・広告管理ツールは実APIではなくCSVエクスポートの再現。',
    '- 配布工程は未検証。', '- 金額換算は時給の想定値。',
    `- 前提または自動化が未検証のステップ: ${a.unverified.length ? a.unverified.map(cell).join(', ') : 'なし'}。`, '',
    '## 出典', '', '- カタログ: `tools/report-automation-catalog.json`。',
    '- 広告フィクスチャ: `tools/report-automation/fixtures/ad-metrics.csv`。',
    '- HubSpotフィクスチャ: `tools/report-automation/fixtures/hubspot-deals.csv`。',
    '- 実測結果: `tools/report-automation.results.json`。',
    `- 計測日時: ${latest ? cell(latest.t) : '未実測'}（\`tools/report-automation.results.json\` の \`runs[].t\`、最新run）。`);
  return `${lines.join('\n')}\n`;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    throw new Error(`${error instanceof SyntaxError ? 'JSONが壊れています' : 'ファイルを読めません'}: ${path.basename(file)}`);
  }
}

export function runPipeline(options = {}) {
  const repo = options.repo || DEFAULT_REPO;
  const outDir = path.resolve(options.outDir || path.join(os.tmpdir(), 'report-automation'));
  const started = Date.now();
  const catalog = options.catalog || readJson(options.catalogPath || path.join(repo, 'tools', 'report-automation-catalog.json'));
  const { adText, dealsText } = readFixtures(repo);
  const built = buildReport(adText, dealsText, catalog);
  if (!built.period || !/^\d{4}-(0[1-9]|1[0-2])$/u.test(built.period)) throw new Error('広告CSVに有効な対象月（YYYY-MM）がありません');
  fs.mkdirSync(outDir, { recursive: true });
  const markdownPath = path.join(outDir, `report-${built.period}.md`);
  const jsonPath = path.join(outDir, `report-${built.period}.json`);
  fs.writeFileSync(markdownPath, renderReportMarkdown(built, catalog), 'utf8');
  fs.writeFileSync(jsonPath, `${JSON.stringify(built, null, 2)}\n`, 'utf8');
  const pipelineMs = Number((Date.now() - started).toFixed(1));
  return { ...built, pipelineMs, outDir, markdownPath, jsonPath };
}

export async function runCli(options = {}) {
  const repo = options.repo || DEFAULT_REPO, stdout = options.stdout || process.stdout, stderr = options.stderr || process.stderr;
  try {
    const modes = ['run', 'write', 'check'].filter((key) => options[key]);
    if (modes.length > 1) throw new Error('モードは1つだけ指定してください');
    if (options.outDir && !options.run) throw new Error('--outには--runが必要です');
    if (!modes.length) { stdout.write(`${USAGE}\n`); return 0; }
    const catalogPath = options.catalogPath || path.join(repo, 'tools', 'report-automation-catalog.json');
    const resultsPath = options.resultsPath || path.join(repo, 'tools', 'report-automation.results.json');
    const docPath = options.docPath || path.join(repo, 'docs', 'report-automation.md');
    const catalog = readJson(catalogPath), results = readJson(resultsPath);
    if (!Array.isArray(catalog?.manualSteps) || !catalog?.stageAliases || !catalog?.assumptions || !catalog?.thresholds) throw new Error('カタログの形式が不正です');
    if (!Array.isArray(results?.runs)) throw new Error('resultsのrunsは配列が必要です');
    if (options.run) {
      const built = runPipeline({ ...options, repo, catalog });
      const t = new Date().toISOString();
      const run = { t, period: built.period, previousPeriod: built.previousPeriod, adRows: built.adRows,
        dealRows: built.dealRows, duplicatesRemoved: built.duplicatesRemoved, pipelineMs: built.pipelineMs,
        outDir: path.basename(built.outDir) };
      fs.writeFileSync(resultsPath, `${JSON.stringify({ ...results, updatedAt: t, runs: [...results.runs, run] }, null, 2)}\n`, 'utf8');
      stdout.write(`period: ${built.period}\npipelineMs: ${built.pipelineMs.toFixed(1)}\nレポート出力先: ${built.outDir}\n`);
    } else {
      const markdown = renderMarkdown(results, catalog);
      if (options.check) {
        if (!fs.existsSync(docPath)) throw new Error('drift: docs/report-automation.md がありません。--writeで生成してください');
        const current = fs.readFileSync(docPath, 'utf8').replace(/\r\n/gu, '\n');
        if (current !== markdown) {
          const before = current.split('\n'), after = markdown.split('\n');
          let index = 0;
          while (index < Math.max(before.length, after.length) && before[index] === after[index]) index++;
          throw new Error(`drift: docs/report-automation.md の${index + 1}行目が不一致。--writeで再生成してください\n現在: ${before[index] ?? '(行なし)'}\n期待: ${after[index] ?? '(行なし)'}`);
        }
      } else {
        fs.mkdirSync(path.dirname(docPath), { recursive: true });
        fs.writeFileSync(docPath, markdown, 'utf8');
      }
    }
    return 0;
  } catch (error) { stderr.write(`${error.message}\n`); return 1; }
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--run', '--write', '--check'].includes(arg)) {
      if (options.run || options.write || options.check) throw new Error('モードは1つだけ指定してください');
      options[arg.slice(2)] = true;
    } else if (arg === '--out' && !options.outDir && args[i + 1] && !args[i + 1].startsWith('--')) options.outDir = args[++i];
    else throw new Error(`不正な引数です: ${arg}`);
  }
  if (options.outDir && !options.run) throw new Error('--outには--runが必要です');
  return options;
}

if (isEntry(import.meta.url)) {
  try { process.exitCode = await runCli(parseArgs(process.argv.slice(2))); }
  catch (error) { process.stderr.write(`${USAGE}\n${error.message}\n`); process.exitCode = 1; }
}
