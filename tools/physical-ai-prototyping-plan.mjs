#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const DEFAULT_REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ASSUMPTION_KEYS = ['prototypesPerMonth', 'currentLeadDays', 'currentManualMinutesPerPrototype', 'hourlyYen', 'devDayYen', 'marginYenPerPrototype', 'demandCaptureRate', 'amortizeMonths'];
const ROUTE_NUMBERS = ['gadgetYen', 'buildDays', 'consumablesYenPerMonth', 'cloudYenPerMonth', 'leadDays', 'residualMinutesPerPrototype'];
const PRICE_LABELS = { primary: '一次情報で確認済み', secondary: '二次情報。公式で要再確認', assumed: '仮定値', 'quote-required': '公開価格なし。見積必須' };
const FLAGS = { '--prototypes': 'prototypesPerMonth', '--current-lead-days': 'currentLeadDays', '--manual-minutes': 'currentManualMinutesPerPrototype', '--hourly-yen': 'hourlyYen', '--dev-day-yen': 'devDayYen', '--margin-yen': 'marginYenPerPrototype', '--demand-capture-rate': 'demandCaptureRate', '--amortize-months': 'amortizeMonths' };
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
  if (catalog?.assumptions?.demandCaptureRate != null && catalog.assumptions.demandCaptureRate > 1) errors.push('assumptions.demandCaptureRate は0以上1以下が必要です');
  if (!Array.isArray(catalog?.routes) || !catalog.routes.length) errors.push('routes は空でない配列が必要です');
  const ids = new Set();
  for (const route of Array.isArray(catalog?.routes) ? catalog.routes : []) {
    if (!route || typeof route !== 'object') { errors.push('route が不正です'); continue; }
    for (const key of ['id', 'label']) if (!nonEmpty(route[key])) errors.push(`route.${key} が欠落しています`);
    if (ids.has(route.id)) errors.push(`id が重複しています: ${route.id}`);
    ids.add(route.id);
    if (!Object.hasOwn(PRICE_LABELS, route.priceVerify)) errors.push(`${route.id}: priceVerify が不正です`);
    if (['primary', 'secondary'].includes(route.priceVerify) && !(typeof route.priceSource === 'string' && route.priceSource.startsWith('https://'))) errors.push(`${route.id}: priceSource は https:// が必要です`);
    if (route.priceVerify === 'quote-required' && (route.gadgetYen !== null || route.buildDays !== null)) errors.push(`${route.id}: quote-required の gadgetYen / buildDays は null が必要です`);
    if (route.leadDays !== null && !(route.leadDays >= 1)) errors.push(`${route.id}.leadDays は null または1以上が必要です`);
    for (const key of ROUTE_NUMBERS) if (route[key] !== null && !nonNegative(route[key])) errors.push(`${route.id}.${key} は null または有限の非負数が必要です`);
  }
  return errors;
}

export function computeRouteEconomics(route, assumptions, overrides = {}) {
  const a = { ...assumptions, ...overrides };
  const monthlyGadgetYen = knownCalculation([route.gadgetYen, a.amortizeMonths], (g, m) => g / m);
  const monthlyCostYen = knownCalculation([monthlyGadgetYen, route.consumablesYenPerMonth, route.cloudYenPerMonth], (g, c, l) => g + c + l);
  const savedMinutesPerPrototype = knownCalculation([a.currentManualMinutesPerPrototype, route.residualMinutesPerPrototype], (c, r) => Math.max(0, c - r));
  const laborSavedYenPerMonth = knownCalculation([savedMinutesPerPrototype, a.prototypesPerMonth, a.hourlyYen], (m, p, y) => m * p / 60 * y);
  const speedupRatio = knownCalculation([a.currentLeadDays, route.leadDays], (c, l) => c / l);
  const extraPrototypesPerMonth = knownCalculation([a.prototypesPerMonth, speedupRatio], (p, r) => Math.max(0, p * r - p));
  const extraMarginYenPerMonth = knownCalculation([extraPrototypesPerMonth, a.marginYenPerPrototype, a.demandCaptureRate], (e, m, d) => e * m * d);
  const grossBenefitYenPerMonth = knownCalculation([laborSavedYenPerMonth, extraMarginYenPerMonth], (l, e) => l + e);
  const netYenPerMonth = knownCalculation([grossBenefitYenPerMonth, monthlyCostYen], (b, c) => b - c);
  const initialCostYen = knownCalculation([route.gadgetYen, route.buildDays, a.devDayYen], (g, d, y) => g + d * y);
  const paybackMonths = knownCalculation([netYenPerMonth, initialCostYen], (n, i) => n <= 0 ? null : i / n);
  const annualNetYen = knownCalculation([netYenPerMonth], (n) => n * 12);
  return { ...route, monthlyGadgetYen, monthlyCostYen, savedMinutesPerPrototype, laborSavedYenPerMonth, speedupRatio, extraPrototypesPerMonth, extraMarginYenPerMonth, grossBenefitYenPerMonth, netYenPerMonth, initialCostYen, paybackMonths, annualNetYen };
}

export function computeReport(catalog, assumptions = catalog.assumptions, overrides = {}) {
  return catalog.routes.map((route) => computeRouteEconomics(route, assumptions, overrides));
}

// 提案 P-0137 の必須要件。「実世界センサで閉ループする学習モデル（物理AI）」と「試作サイクル短縮に効く」の両方。
// 3Dプリンタ＋AIスライサは物理AIではないため、純効果が最大でも推奨にはしない(要件を満たさない推奨は誤誘導)。
export function meetsProposalRequirements(route) {
  return route.physicalAI === true && route.prototypeCycleShortening === true;
}

export function pickRecommendation(report) {
  return report.filter((r) => r.priceVerify !== 'quote-required' && r.netYenPerMonth !== null && meetsProposalRequirements(r))
    .reduce((best, r) => best === null || r.netYenPerMonth > best.netYenPerMonth ? r : best, null);
}

export function renderMarkdown(catalog, report, assumptions = catalog.assumptions) {
  const recommendation = pickRecommendation(report);
  const payback = (r) => r.paybackMonths === 0 ? '初期費用0円のため即時' : r.paybackMonths !== null ? `${display(r.paybackMonths, 2)}か月` : r.netYenPerMonth === null || r.initialCostYen === null ? '見積必須' : '回収不可（純効果0以下）';
  const lines = [
    '# フィジカルAIを活用したプロトタイプ高速化 ルート比較（P-0137）', '',
    '> このファイルは生成物。手で編集しない。再生成: node tools/physical-ai-prototyping-plan.mjs --write', '',
    '## 結論', '',
    ...(recommendation ? [
      `- 推奨: ${named(recommendation)}。算出可能な候補の純効果が最大（${display(recommendation.netYenPerMonth)}円/月、年間${display(recommendation.annualNetYen)}円）。月額${display(recommendation.monthlyCostYen)}円、短縮${display(recommendation.savedMinutesPerPrototype, 2)}分/件、回収期間: ${payback(recommendation)}。`,
      `- この推奨は仮定値に依存する（仮定: ${[...ASSUMPTION_KEYS, `${recommendation.id}.residualMinutesPerPrototype`, ...(recommendation.priceVerify === 'assumed' ? ROUTE_NUMBERS.filter((k) => k !== 'residualMinutesPerPrototype').map((k) => `${recommendation.id}.${k}`) : [])].join(', ')}）。`,
      ...(recommendation.netYenPerMonth <= 0 ? ['- 最大候補でも純効果は0以下のため、導入による経済的改善は示されていない。'] : []),
    ] : [`- 導入判断に必要な価格が未取得（見積必須）: ${report.map(named).join('、')}`]),
    '- 推奨は「提案の必須要件（物理AIかつ試作サイクル短縮）を満たす」かつ「見積必須でない」かつ「算出可能」な候補のうち純効果が最大のもの。要件を満たさないルート（例: 3Dプリンタ＋AIスライサは物理AIではない）は純効果が最大でも推奨にしない。', '',
    '- demandCaptureRate による追加受注への転換が売上効果の唯一の原資。追加試作能力 × marginYenPerPrototype × demandCaptureRate で粗利換算し、0なら売上効果は0、効果は工数削減のみ（純効果はそこから月額費用を差し引く）。nullなら売上効果・純効果は算出しない。', '',
    '## ルート比較', '',
    `価格は台帳の${catalog.priceAsOf}時点の確認区分に従う。金額・時間・回収期間は仮定に基づく試算であり、実測ではない。null は見積必須として伝播する。機能の有無も台帳記載であり、稼働検証結果ではない。`, '',
    '| ルート | 初期費用 | 月額 | 短縮分/件 | 工数削減円/月 | 売上効果円/月 | 純効果円/月 | 回収期間 | 価格の確度 | 物理AI | 試作短縮 |',
    '|---|---:|---:|---:|---:|---:|---:|---|---|---|---|',
    ...report.map((r) => `| ${cell(named(r))} | ${display(r.initialCostYen)} | ${display(r.monthlyCostYen)} | ${display(r.savedMinutesPerPrototype, 2)} | ${display(r.laborSavedYenPerMonth)} | ${display(r.extraMarginYenPerMonth)} | ${display(r.netYenPerMonth)} | ${payback(r)} | ${PRICE_LABELS[r.priceVerify]} | ${r.physicalAI === true ? 'あり（台帳）' : 'なし（台帳）'} | ${r.prototypeCycleShortening === true ? 'あり（台帳）' : 'なし（台帳）'} |`), '',
    ...report.map((r) => `- ${named(r)}: ${r.priceNote} 残作業: ${display(r.residualMinutesPerPrototype, 2)}分/件（仮定）。${r.residualNote}`), '',
    '## 感度分析', '',
    '| ルート | 1件/月 | 2件/月 | 4件/月 | 8件/月 | 12件/月 |', '|---|---:|---:|---:|---:|---:|',
    ...catalog.routes.map((r) => `| ${cell(named(r))} | ${[1, 2, 4, 8, 12].map((prototypesPerMonth) => { const e = computeRouteEconomics(r, assumptions, { prototypesPerMonth }); return e.netYenPerMonth === null ? '-' : display(e.netYenPerMonth); }).join(' | ')} |`), '',
    '純効果円/月の試算。件数・手作業と残作業の時間差・人件費単価が工数削減額を、リードタイム・追加試作1件の粗利・需要転換率が売上効果を左右する（実測ではない）。', '',
    '## 模倣学習の実装スケッチ', '',
    '- リーダーアームでテレオペ教示し、LeRobot のデータセット形式でエピソードを記録する。',
    '- カメラはワークスペースを俯瞰する固定位置に置き、照明条件を固定する。',
    '- ACT 等の模倣学習ポリシーを学習し、成功判定は試作タスクの完了条件（はめ合い・位置決め等）で自動判定する。',
    '- 失敗エピソードを追加収集して再学習するループを回し、成功率と1件あたり所要時間を記録する。',
    '- 教示・学習・推論のログを Sheets に残し、`residualMinutesPerPrototype` の実測値で仮定を置き換える。', '',
    '## 前提（仮定であり実測ではない）', '',
    '| 項目 | 値（仮定） | 注記 |', '|---|---:|---|',
    ...Object.entries(assumptions).map(([key, value]) => `| ${cell(key)} | ${display(value, 2)} | ${cell(catalog.assumptionNotes?.[key])} |`), '',
    '- 表の値が今回の試算入力。注記の既定値と異なる場合はCLI上書き値を使用している。未取得のnullは0で補完しない。', '',
    '## 見積必須・未確認', '',
    ...report.filter((r) => r.priceVerify === 'quote-required').map((r) => `- ${named(r)}: 見積必須。${r.priceNote}`),
    ...report.filter((r) => r.priceVerify !== 'quote-required' && (r.monthlyCostYen === null || r.initialCostYen === null || r.netYenPerMonth === null)).map((r) => `- ${named(r)}: 見積必須。計算入力に未取得値（null）があり、金額を算出できない。nullを0円と解釈しない。`),
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
    const catalog = JSON.parse(fs.readFileSync(options.catalogPath || path.join(repo, 'tools', 'physical-ai-prototyping-catalog.json'), 'utf8'));
    const errors = validateCatalog(catalog);
    if (errors.length) throw new Error(errors.join('; '));
    const assumptions = { ...catalog.assumptions, ...overrides };
    const assumptionErrors = validateCatalog({ ...catalog, assumptions });
    if (assumptionErrors.length) throw new Error(assumptionErrors.join('; '));
    const report = computeReport(catalog, assumptions);
    const markdown = renderMarkdown(catalog, report, assumptions);
    const docPath = options.docPath || path.join(repo, 'docs', 'physical-ai-prototyping-plan.md');
    if (config.check) {
      const current = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8').replace(/\r\n/gu, '\n') : null;
      if (current !== markdown) throw new Error('drift: docs/physical-ai-prototyping-plan.md が古い。node tools/physical-ai-prototyping-plan.mjs --write で再生成');
    } else if (config.write) {
      fs.mkdirSync(path.dirname(docPath), { recursive: true });
      fs.writeFileSync(docPath, markdown, 'utf8');
    } else if (config.json) stdout.write(`${JSON.stringify({ assumptions, routes: report, recommendation: pickRecommendation(report) }, null, 2)}\n`);
    else stdout.write(markdown);
    return 0;
  } catch (error) { stderr.write(`${error.message.replace(/[\r\n]+/gu, ' ')}\n`); return 1; }
}

if (isEntry(import.meta.url)) process.exitCode = runPlan({ args: process.argv.slice(2) });
