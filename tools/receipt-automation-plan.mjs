#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const DEFAULT_REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ASSUMPTION_KEYS = ['casesPerMonth', 'manualMinutesPerCase', 'reconcileMinutesPerCase', 'hourlyYen', 'llmYenPerCase', 'devDayYen'];
const ROUTE_NUMBERS = ['fixedYen', 'licenseYenPerMonth', 'includedCasesPerMonth', 'overageYenPerCase', 'llmYenPerCase', 'devDays', 'residualMinutesPerCase'];
const PRICE_LABELS = { primary: '一次情報で確認済み', secondary: '二次情報。公式で要再確認', assumed: '仮定値', 'quote-required': '公開価格なし。見積必須' };
const FLAGS = { '--cases': 'casesPerMonth', '--manual-minutes': 'manualMinutesPerCase', '--reconcile-minutes': 'reconcileMinutesPerCase', '--hourly-yen': 'hourlyYen', '--llm-yen-per-case': 'llmYenPerCase', '--dev-day-yen': 'devDayYen' };
const nonNegative = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const knownCalculation = (values, fn) => values.some((v) => v == null) ? null : fn(...values);
const display = (v, digits = 0) => v === null ? '見積必須' : v.toLocaleString('ja-JP', { maximumFractionDigits: digits });
const cell = (v) => String(v ?? '未確認').replace(/\|/gu, '\\|').replace(/[\r\n]+/gu, ' ');
const named = (route) => `${route.label}（${route.id}）`;

export function validateCatalog(catalog) {
  const errors = [];
  if (catalog?.version !== 1) errors.push('version は1が必要です');
  for (const key of ['priceAsOf', 'proposalId']) if (!nonEmpty(catalog?.[key])) errors.push(`${key} が空です`);
  for (const key of ASSUMPTION_KEYS) {
    if (!Object.hasOwn(catalog?.assumptions ?? {}, key)) errors.push(`assumptions.${key} が欠落しています`);
    else if (catalog.assumptions[key] !== null && !nonNegative(catalog.assumptions[key])) errors.push(`assumptions.${key} は null または有限の非負数が必要です`);
  }
  if (!Array.isArray(catalog?.routes) || !catalog.routes.length) errors.push('routes は空でない配列が必要です');
  const ids = new Set();
  for (const route of Array.isArray(catalog?.routes) ? catalog.routes : []) {
    if (!route || typeof route !== 'object') { errors.push('route が不正です'); continue; }
    for (const key of ['id', 'label']) if (!nonEmpty(route[key])) errors.push(`route.${key} が欠落しています`);
    if (ids.has(route.id)) errors.push(`id が重複しています: ${route.id}`);
    ids.add(route.id);
    if (!Object.hasOwn(PRICE_LABELS, route.priceVerify)) errors.push(`${route.id}: priceVerify が不正です`);
    if (['primary', 'secondary'].includes(route.priceVerify) && !(typeof route.priceSource === 'string' && route.priceSource.startsWith('https://'))) errors.push(`${route.id}: priceSource は https:// が必要です`);
    if (route.priceVerify === 'quote-required' && (route.fixedYen !== null || route.licenseYenPerMonth !== null)) errors.push(`${route.id}: quote-required の fixedYen / licenseYenPerMonth は null が必要です`);
    for (const key of ROUTE_NUMBERS) if (route[key] !== null && !nonNegative(route[key])) errors.push(`${route.id}.${key} は null または有限の非負数が必要です`);
  }
  return errors;
}

export function computeRouteEconomics(route, assumptions, overrides = {}) {
  const a = { ...assumptions, ...overrides };
  // カタログが assumptions.llmYenPerCase を参照する自前ルートだけに適用。
  const llmYenPerCase = route.kind === 'diy' && route.llmYenPerCase !== null ? a.llmYenPerCase : route.llmYenPerCase;
  const cases = a.casesPerMonth;
  const baselineMinutesPerCase = knownCalculation([a.manualMinutesPerCase, a.reconcileMinutesPerCase], (m, r) => m + r);
  const baselineHoursPerMonth = knownCalculation([cases, baselineMinutesPerCase], (c, m) => c * m / 60);
  const residualHoursPerMonth = knownCalculation([cases, route.residualMinutesPerCase], (c, m) => c * m / 60);
  const savedHoursPerMonth = knownCalculation([baselineHoursPerMonth, residualHoursPerMonth], (b, r) => b - r);
  const laborSavedYenPerMonth = knownCalculation([savedHoursPerMonth, a.hourlyYen], (h, y) => h * y);
  const included = route.includedCasesPerMonth;
  const overageCases = knownCalculation([cases, included], (c, i) => Math.max(0, c - i));
  const overageYen = knownCalculation([overageCases, route.overageYenPerCase], (c, y) => c * y);
  const monthlyCostYen = knownCalculation([route.licenseYenPerMonth, overageYen, cases, llmYenPerCase], (l, o, c, y) => l + o + c * y);
  const netYenPerMonth = knownCalculation([laborSavedYenPerMonth, monthlyCostYen], (l, m) => l - m);
  const initialCostYen = knownCalculation([route.fixedYen, route.devDays, a.devDayYen], (f, d, y) => f + d * y);
  const paybackMonths = knownCalculation([netYenPerMonth, initialCostYen], (n, i) => n <= 0 ? null : i / n);
  const annualNetYen = knownCalculation([netYenPerMonth], (n) => n * 12);
  return { ...route, llmYenPerCase, cases, baselineMinutesPerCase, baselineHoursPerMonth, residualHoursPerMonth, savedHoursPerMonth, laborSavedYenPerMonth, included, overageCases, overageYen, monthlyCostYen, netYenPerMonth, initialCostYen, paybackMonths, annualNetYen };
}

export function computeReport(catalog, assumptions = catalog.assumptions, overrides = {}) {
  return catalog.routes.map((route) => computeRouteEconomics(route, assumptions, overrides));
}

// 提案 P-0135 の必須要件。「レシート画像とテンプレートからPDF作成」と「カレンダー照合」の両方。
// 会計SaaS内蔵OCRはどちらも持たないため、純効果が最大でも推奨にはしない(要件を満たさない推奨は誤誘導)。
export function meetsProposalRequirements(route) {
  return route.receiptToPdf === true && route.calendarReconcile === true;
}

export function pickRecommendation(report) {
  return report.filter((r) => r.priceVerify !== 'quote-required' && r.netYenPerMonth !== null && meetsProposalRequirements(r))
    .reduce((best, r) => best === null || r.netYenPerMonth > best.netYenPerMonth ? r : best, null);
}

export function renderMarkdown(catalog, report, assumptions = catalog.assumptions) {
  const recommendation = pickRecommendation(report);
  const payback = (r) => r.paybackMonths === 0 ? '初期費用0円のため即時' : r.paybackMonths !== null ? `${display(r.paybackMonths, 2)}か月` : r.netYenPerMonth === null || r.initialCostYen === null ? '見積必須' : '回収不可（純効果0以下）';
  const lines = [
    '# レシート自動入力とカレンダー連携ツールの導入 ルート比較（P-0135）', '',
    '> このファイルは生成物。手で編集しない。再生成: node tools/receipt-automation-plan.mjs --write', '',
    '## 結論', '',
    ...(recommendation ? [
      `- 推奨: ${named(recommendation)}。算出可能な候補の純効果が最大（${display(recommendation.netYenPerMonth)}円/月、年間${display(recommendation.annualNetYen)}円）。月額${display(recommendation.monthlyCostYen)}円、削減${display(recommendation.savedHoursPerMonth, 2)}h/月、回収期間: ${payback(recommendation)}。`,
      `- この推奨は仮定値に依存する（仮定: ${[...ASSUMPTION_KEYS, `${recommendation.id}.residualMinutesPerCase`, ...(recommendation.priceVerify === 'assumed' ? ROUTE_NUMBERS.filter((k) => k !== 'residualMinutesPerCase').map((k) => `${recommendation.id}.${k}`) : [])].join(', ')}）。`,
      ...(recommendation.netYenPerMonth <= 0 ? ['- 最大候補でも純効果は0以下のため、導入による経済的改善は示されていない。'] : []),
    ] : [`- 導入判断に必要な価格が未取得（見積必須）: ${report.map(named).join('、')}`]),
    '- 推奨は「提案の必須要件（レシート→PDF作成かつカレンダー照合）を満たす」かつ「見積必須でない」かつ「算出可能」な候補のうち純効果が最大のもの。要件を満たさないルート（例: 会計SaaS内蔵OCRはカレンダー照合もPDF作成も持たない）は純効果が最大でも推奨にしない。', '',
    '## ルート比較', '',
    `価格は台帳の${catalog.priceAsOf}時点の確認区分に従う。金額・時間・回収期間は仮定に基づく試算であり、実測ではない。null は見積必須として伝播する。機能の有無も台帳記載であり、稼働検証結果ではない。`, '',
    '| ルート | 初期費用 | 月額 | 削減h/月 | 削減額円/月 | 純効果円/月 | 回収期間 | 価格の確度 | カレンダー照合 | レシート→PDF |',
    '|---|---:|---:|---:|---:|---:|---|---|---|---|',
    ...report.map((r) => `| ${cell(named(r))} | ${display(r.initialCostYen)} | ${display(r.monthlyCostYen)} | ${display(r.savedHoursPerMonth, 2)} | ${display(r.laborSavedYenPerMonth)} | ${display(r.netYenPerMonth)} | ${payback(r)} | ${PRICE_LABELS[r.priceVerify]} | ${r.calendarReconcile ? 'あり（台帳）' : 'なし（台帳）'} | ${r.receiptToPdf ? 'あり（台帳）' : 'なし（台帳）'} |`), '',
    ...report.map((r) => `- ${named(r)}: ${r.priceNote} 残作業: ${display(r.residualMinutesPerCase, 2)}分/件（仮定）。${r.residualNote}`), '',
    '## 感度分析', '',
    '| ルート | 50件/月 | 100件/月 | 200件/月 | 400件/月 |', '|---|---:|---:|---:|---:|',
    ...catalog.routes.map((r) => `| ${cell(named(r))} | ${[50, 100, 200, 400].map((casesPerMonth) => { const e = computeRouteEconomics(r, assumptions, { casesPerMonth }); return e.netYenPerMonth === null ? '-' : display(e.netYenPerMonth); }).join(' | ')} |`), '',
    '純効果円/月の試算。件数・手作業と残作業の時間差・人件費単価の仮定が削減額を支配し、無料枠超過単価とLLM単価が月額を左右する（実測ではない）。', '',
    '## カレンダー照合の実装スケッチ', '',
    '- GASで対象カレンダーと期間・タイムゾーンを指定し、CalendarAppから予定を取得する。',
    '- DriveのレシートをOCRし、日付・金額・通貨を抽出して原本への参照を保持する。',
    '- 予定の説明欄または案件台帳から案件ID・照合用金額を取得する。予定に金額がなければ要確認とする。',
    '- レシートの日付×金額で予定を突合する。一意に一致した候補を案件に紐付け、複数候補・不一致は人が確認する。',
    '- 確認結果をSheets等に保存し、レシート→PDFと案件の参照を記録する。重複登録を防ぎ、試行時に一致率・残作業時間を実測する。', '',
    '## 前提（仮定であり実測ではない）', '',
    '| 項目 | 値（仮定） | 注記 |', '|---|---:|---|',
    ...Object.entries(assumptions).map(([key, value]) => `| ${cell(key)} | ${display(value, 2)} | ${cell(catalog.assumptionNotes?.[key])} |`), '',
    '- 表の値が今回の試算入力。注記の既定値と異なる場合はCLI上書き値を使用している。--llm-yen-per-case は自前（kind=diy）の既知LLM単価に適用し、未取得のnullは補完しない。', '',
    '## 見積必須・未確認', '',
    ...report.filter((r) => r.priceVerify === 'quote-required').map((r) => `- ${named(r)}: 見積必須。${r.priceNote}`),
    ...report.filter((r) => r.priceVerify !== 'quote-required' && (r.monthlyCostYen === null || r.initialCostYen === null)).map((r) => `- ${named(r)}: 見積必須。計算入力に未取得値（null）があり、金額を算出できない。無料枠nullを無制限や0件と解釈しない。`),
    ...Object.entries(catalog.facts ?? {}).filter(([, fact]) => fact.status !== 'verified').map(([key, fact]) => `- ${key}: ${fact.value}（${fact.status}）。${fact.note ?? ''}`), '',
    '## 出典', '',
    ...Object.entries(catalog.sources ?? {}).map(([key, url]) => `- ${key}: ${url}`),
    ...catalog.routes.map((r) => `- ${named(r)}: ${r.priceSource || '出典未取得'}`),
  ];
  return `${lines.join('\n').replace(/\r\n/gu, '\n').trimEnd()}\n`;
}

export function parseCli(args) {
  const parsed = { overrides: {} };
  let modes = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--write', '--check', '--json'].includes(arg)) { parsed[arg.slice(2)] = true; modes++; }
    else if (Object.hasOwn(FLAGS, arg)) {
      const raw = args[++i];
      const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (!nonNegative(value)) throw new Error(`${arg} は有限の非負数が必要です`);
      parsed.overrides[FLAGS[arg]] = value;
    } else throw new Error(`不正な引数です: ${arg}`);
  }
  if (modes > 1) throw new Error('モードは1つだけ指定してください');
  return parsed;
}

export function runPlan(options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  try {
    const parsed = parseCli(options.args ?? []);
    const config = { ...options, ...Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== 'overrides')) };
    if (['write', 'check', 'json'].filter((k) => config[k]).length > 1) throw new Error('モードは1つだけ指定してください');
    const overrides = { ...options.overrides, ...parsed.overrides };
    for (const [key, value] of Object.entries(overrides)) if (!ASSUMPTION_KEYS.includes(key) || !nonNegative(value)) throw new Error(`不正な上書きです: ${key}`);
    const repo = options.repo || DEFAULT_REPO;
    const catalog = JSON.parse(fs.readFileSync(options.catalogPath || path.join(repo, 'tools', 'receipt-automation-catalog.json'), 'utf8'));
    const errors = validateCatalog(catalog);
    if (errors.length) throw new Error(errors.join('; '));
    const assumptions = { ...catalog.assumptions, ...overrides };
    const report = computeReport(catalog, assumptions);
    const markdown = renderMarkdown(catalog, report, assumptions);
    const docPath = options.docPath || path.join(repo, 'docs', 'receipt-automation-plan.md');
    if (config.check) {
      const current = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8').replace(/\r\n/gu, '\n') : null;
      if (current !== markdown) throw new Error('drift: docs/receipt-automation-plan.md が古い。node tools/receipt-automation-plan.mjs --write で再生成');
    } else if (config.write) {
      fs.mkdirSync(path.dirname(docPath), { recursive: true });
      fs.writeFileSync(docPath, markdown, 'utf8');
    } else if (config.json) stdout.write(`${JSON.stringify({ assumptions, routes: report, recommendation: pickRecommendation(report) }, null, 2)}\n`);
    else stdout.write(markdown);
    return 0;
  } catch (error) { stderr.write(`${error.message.replace(/[\r\n]+/gu, ' ')}\n`); return 1; }
}

if (isEntry(import.meta.url)) process.exitCode = runPlan({ args: process.argv.slice(2) });
