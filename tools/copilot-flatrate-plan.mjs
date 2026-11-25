#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const DEFAULT_REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// 組織の意思決定用既定値。市場レートや GitHub の価格ではなく、CLI で必ず上書き可能な明示的前提。
export const DEFAULT_USD_JPY = 150;
export const DEFAULT_BUDGET_JPY = 150000;
export const DEFAULT_PLAN_ID = 'business';

const finiteNonNegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const money = (value) => value === null ? '未計測' : `$${value.toFixed(2)}`;
const yen = (value) => value === null ? '未計測' : `¥${Math.round(value).toLocaleString('ja-JP')}`;

export function computeCosts({ seats, planId, creditsPerSeat, paidOverageAllowed, usdJpy, copilotBudgetUsd, catalog }) {
  if (!Number.isInteger(seats) || seats <= 0) throw new Error('seats は正の整数が必要です');
  if (!(usdJpy > 0) || !Number.isFinite(usdJpy)) throw new Error('usdJpy は正の数が必要です');
  if (!finiteNonNegative(copilotBudgetUsd)) throw new Error('copilotBudgetUsd は0以上の数が必要です');
  if (!(creditsPerSeat === null || creditsPerSeat === undefined || finiteNonNegative(creditsPerSeat))) throw new Error('creditsPerSeat は null または0以上の数が必要です');
  const plan = catalog?.plans?.find((item) => item.id === planId);
  if (!plan) throw new Error(`未知の planId です: ${planId}`);

  const unmeasured = creditsPerSeat == null;
  const flatMonthlyUsd = seats * plan.usdPerSeatMonth;
  const pooledCredits = plan.creditsPerSeat == null ? null : seats * plan.creditsPerSeat;
  const usedCredits = unmeasured ? null : seats * creditsPerSeat;
  const overageCredits = usedCredits === null || pooledCredits === null ? null : Math.max(0, usedCredits - pooledCredits);
  const overageUsd = paidOverageAllowed && overageCredits !== null ? overageCredits * catalog.creditUsd : 0;
  const totalUsd = flatMonthlyUsd + overageUsd;
  const ceilingUsd = paidOverageAllowed === false ? totalUsd : null;
  // 未計測で従量 ON の場合、現在額も予算超過額も断定しない。
  const budgetExceededUsd = unmeasured && paidOverageAllowed ? null : Math.max(0, totalUsd - copilotBudgetUsd);
  const breakEvenCreditsPerSeat = plan.creditsPerSeat === null ? null : plan.creditsPerSeat + plan.usdPerSeatMonth / catalog.creditUsd;
  const budgetBreakCreditsPerSeat = plan.creditsPerSeat === null
    ? null
    : plan.creditsPerSeat + Math.max(0, copilotBudgetUsd - flatMonthlyUsd) / (seats * catalog.creditUsd);

  return {
    planId,
    flatMonthlyUsd,
    pooledCredits,
    usedCredits,
    overageCredits,
    overageUsd,
    totalUsd,
    totalJpy: totalUsd * usdJpy,
    ceilingUsd,
    ceilingJpy: ceilingUsd === null ? null : ceilingUsd * usdJpy,
    copilotBudgetUsd,
    copilotBudgetJpy: copilotBudgetUsd * usdJpy,
    budgetExceededUsd,
    budgetExceededJpy: budgetExceededUsd === null ? null : budgetExceededUsd * usdJpy,
    budgetExceeded: budgetExceededUsd === null ? null : budgetExceededUsd > 0,
    breakEvenCreditsPerSeat,
    budgetBreakCreditsPerSeat,
    unmeasured,
    unmeasuredCount: unmeasured ? 1 : 0,
    planCreditsUnverified: plan.creditsPerSeat === null,
  };
}

export function formatReport(result, options) {
  const { catalog, seats, planId, creditsPerSeat, paidOverageAllowed, usdJpy } = options;
  const plan = catalog.plans.find((item) => item.id === planId);
  const orgSource = catalog.sources.organizationBilling;
  const verdict = paidOverageAllowed === false
    ? '上限確定 ○ / 従量 OFF'
    : result.unmeasured ? '上限未確定 / 未計測' : '上限未確定 / 従量 ON';
  const usage = result.unmeasured ? '未計測' : `${creditsPerSeat.toLocaleString('ja-JP')} credits/seat/月（CLI入力値）`;
  const budgetLine = result.budgetBreakCreditsPerSeat === null
    ? '未確認（プランの内包クレジットが非公表）'
    : `${result.budgetBreakCreditsPerSeat.toFixed(2)} credits/seat/月超（算出値）`;
  const lines = [
    `# GitHub Copilot 定額/従量 判定（${catalog.priceAsOf}）`, '',
    '> このファイルは生成物。手で編集しない。再生成: `node tools/copilot-flatrate-plan.mjs --seats 30 --plan business --write`', '',
    `## 判定: ${verdict}`, '',
    '**Copilot は完全な定額制ではない。** コード補完・next edit suggestions は無制限（AIクレジット非消費）だが、AIクレジット超過分は従量課金。', '',
    '## 前提', '',
    `- seats: ${seats}（CLI入力値）`,
    `- plan: ${plan.label} / $${plan.usdPerSeatMonth}/seat/月 / ${plan.creditsPerSeat === null ? '含有クレジット未確認' : `${plan.creditsPerSeat} credits/seat/月`}（${plan.verified ? '一次情報で確認' : '未確認'}: ${plan.source}）`,
    `- 使用量: ${usage}`,
    `- 為替: ${usdJpy} JPY/USD（組織の試算用既定値、未確認。CLIで上書き可）`,
    `- 予算: ${yen(result.copilotBudgetJpy)}/月 = ${money(result.copilotBudgetUsd)}（組織の月次ハード上限）`,
    `- 追加クレジット: $${catalog.creditUsd}/credit（一次情報で確認: ${orgSource}）`, '',
    '## 金額', '',
    `- 固定シート: ${money(result.flatMonthlyUsd)} / ${yen(result.flatMonthlyUsd * usdJpy)}（一次価格から算出）`,
    `- 共有プール: ${result.pooledCredits === null ? '未確認' : `${result.pooledCredits.toLocaleString('ja-JP')} credits/月（一次値から算出）`}`,
    `- 使用クレジット: ${result.usedCredits === null ? '未計測' : `${result.usedCredits.toLocaleString('ja-JP')} credits/月（入力値から算出）`}`,
    `- 超過クレジット: ${result.overageCredits === null ? '未計測' : `${result.overageCredits.toLocaleString('ja-JP')} credits/月（算出値）`}`,
    `- 従量分: ${money(result.overageUsd)} / 合計: ${money(result.totalUsd)}（${yen(result.totalJpy)}）${result.unmeasured && paidOverageAllowed ? ' — 未計測（実費はこれと異なり、より大きい可能性）' : ''}`,
    `- 確定上限: ${result.ceilingUsd === null ? 'なし（上限未確定）' : `${money(result.ceilingUsd)} / ${yen(result.ceilingJpy)}`}`,
    `- 予算超過: ${result.budgetExceededUsd === null ? '未計測のため断定しない' : `${money(result.budgetExceededUsd)} / ${yen(result.budgetExceededJpy)}`}`, '',
    '## 予算が破れる境界', '',
    `- 従量を許可した場合: seat平均 ${budgetLine}`,
    `- 損益分岐指標: ${result.breakEvenCreditsPerSeat === null ? '未確認' : `${result.breakEvenCreditsPerSeat.toFixed(2)} credits/seat/月（含有credits + seat価格 ÷ $${catalog.creditUsd}）`}`,
    `- 未計測: ${result.unmeasuredCount} 件${result.unmeasuredCount ? '。実費はこれより大きい可能性があり、削減額・損益分岐の達成を断定しない。' : ''}`, '',
    '## 管理上の注意', '',
    `- チームプランは seat 数 × credits/seat の共有プール（一次情報で確認: ${orgSource}）。`,
    `- user / cost center / enterprise 単位の budget controls がある（一次情報で確認: ${orgSource}）。`,
    `- 予算到達時の停止は「${catalog.facts.pauseAtBudget.value}」と記載されるが、hard stop の保証は **未確認 (unverified)**（${catalog.facts.pauseAtBudget.source}）。`, '',
    '## 出典', '',
    ...Object.values(catalog.sources).map((source) => `- ${source}`), ''
  ];
  return lines.join('\n');
}

export function runPlan(options = {}) {
  const repo = options.repo || DEFAULT_REPO;
  const catalogPath = options.catalogPath || path.join(repo, 'tools', 'copilot-flatrate-catalog.json');
  const docPath = options.docPath || path.join(repo, 'docs', 'copilot-flatrate-plan.md');
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const result = computeCosts({ ...options, catalog });
    const markdown = `${formatReport(result, { ...options, catalog })}\n`;
    if (options.check) {
      const current = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8').replace(/\r\n/gu, '\n') : null;
      if (current !== markdown) throw new Error('drift: docs/copilot-flatrate-plan.md が古い。node tools/copilot-flatrate-plan.mjs --seats 30 --plan business --write で再生成');
    } else if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (options.write) fs.writeFileSync(docPath, markdown.replace(/\r\n/gu, '\n'), 'utf8');
    else stdout.write(markdown);
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

function parseCli(args) {
  const flags = new Set(['--allow-overage', '--json', '--check', '--write']);
  const values = new Set(['--seats', '--plan', '--credits-per-seat', '--usd-jpy', '--budget-jpy']);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const item = args[i];
    if (flags.has(item)) { parsed[item.slice(2)] = true; continue; }
    if (values.has(item) && args[i + 1] !== undefined) { parsed[item.slice(2)] = args[++i]; continue; }
    throw new Error(`不正な引数です: ${item}`);
  }
  const usdJpy = Number(parsed['usd-jpy'] ?? DEFAULT_USD_JPY);
  const budgetJpy = Number(parsed['budget-jpy'] ?? DEFAULT_BUDGET_JPY);
  return {
    seats: Number(parsed.seats ?? 30),
    planId: parsed.plan ?? DEFAULT_PLAN_ID,
    creditsPerSeat: parsed['credits-per-seat'] === undefined ? null : Number(parsed['credits-per-seat']),
    paidOverageAllowed: Boolean(parsed['allow-overage']),
    usdJpy,
    copilotBudgetUsd: budgetJpy / usdJpy,
    json: Boolean(parsed.json), check: Boolean(parsed.check), write: Boolean(parsed.write),
  };
}

if (isEntry(import.meta.url)) {
  try {
    const options = parseCli(process.argv.slice(2));
    process.exitCode = runPlan(options);
  } catch (error) {
    process.stderr.write(`使用法: node tools/copilot-flatrate-plan.mjs --seats 30 --plan business [--credits-per-seat 2500] [--allow-overage] [--usd-jpy 150] [--budget-jpy 150000] [--json|--check|--write]\n${error.message}\n`);
    process.exitCode = 1;
  }
}
