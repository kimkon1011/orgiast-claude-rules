#!/usr/bin/env node
/**
 * event-material-generate.mjs — イベント資料生成ワークフローのサブエージェント委譲テンプレート
 *
 * X-0023: サブエージェント小型モデル委譲とeffort調整
 * 展示会ブース提案のイベント資料生成において、情報抽出・分類・ログ解析を
 * Haiku サブエージェントに委譲し、監督は全体企画と最終確認に集中する。
 *
 * 本ツールは以下のワークフローをシミュレーションし、各ステップのコスト試算を出力する：
 *   1. 過去事例の情報抽出 → Extractor (haiku)
 *   2. 顧客要望の分類 → Classifier (haiku)
 *   3. CIログの確認 → LogReader (haiku)
 *   4. デザイン実装（範囲明確な修正） → Implementer (sonnet)
 *   5. 全体企画・提案書構成 → 監督自身 (opus/deepseek)
 *
 * 使い方:
 *   node tools/event-material-generate.mjs
 *   node tools/event-material-generate.mjs --verbose  (詳細出力)
 *   node tools/event-material-generate.mjs --pass-rate 0.95 --count 50
 *
 * 依存: なし（stdlib のみ）
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// サブエージェント別のコストモデル（USD/タスク）
const SUBAGENT_COSTS = {
  'Extractor (haiku)':    { low: 0.0005, high: 0.0020, p: 0.97 },
  'Classifier (haiku)':   { low: 0.0003, high: 0.0015, p: 0.95 },
  'LogReader (haiku)':    { low: 0.0004, high: 0.0018, p: 0.96 },
  'Implementer (sonnet)': { low: 0.0080, high: 0.0250, p: 0.90 },
};

function argValue(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] !== undefined ? Number(argv[at + 1]) : undefined;
}

/**
 * 1サブエージェントのコスト試算（失敗時リトライ方式）
 */
function calcAgentCost({ name, low, high, p, count }) {
  const allHigh = count * high;
  const lowFirst = count * low + (1 - p) * count * high;
  const savingsPct = allHigh > 0
    ? Math.round((1 - lowFirst / allHigh) * 100 * 10) / 10
    : 0;
  return { name, count, allHigh, lowFirst, savingsPct };
}

/**
 * ワークフロー全体のコスト試算
 */
function calcWorkflowCost(passRateOverride, countOverride) {
  const agents = Object.entries(SUBAGENT_COSTS).map(([name, cost]) => {
    const count = countOverride || 10; // サブエージェントあたり10タスク
    const p = passRateOverride !== undefined ? passRateOverride : cost.p;
    return calcAgentCost({ name, low: cost.low, high: cost.high, p, count });
  });

  const totals = agents.reduce(
    (acc, a) => ({
      allHigh: acc.allHigh + a.allHigh,
      lowFirst: acc.lowFirst + a.lowFirst,
    }),
    { allHigh: 0, lowFirst: 0 }
  );

  const totalSavingsPct = totals.allHigh > 0
    ? Math.round((1 - totals.lowFirst / totals.allHigh) * 100 * 10) / 10
    : 0;

  return { agents, totals, totalSavingsPct };
}

export function main(argv = process.argv) {
  const verbose = argv.includes('--verbose');
  const passRate = argValue(argv, '--pass-rate');
  const count = argValue(argv, '--count');

  const result = calcWorkflowCost(passRate, count);

  // 出力構築
  const lines = [];
  lines.push('=== イベント資料生成ワークフロー コスト試算 ===');
  lines.push(`サブエージェント数: ${result.agents.length}`);
  lines.push(`タスク数/エージェント: ${count || 10}`);
  if (passRate !== undefined) lines.push(`正解率(全エージェント統一): ${passRate}`);
  lines.push('');

  // テーブル
  const header = `${'エージェント'.padEnd(25)} ${'タスク数'.padEnd(8)} ${'全部high($)'.padEnd(14)} ${'low→再実行($)'.padEnd(16)} ${'削減率'.padEnd(8)}`;
  lines.push(header);
  lines.push('─'.repeat(header.length));

  for (const a of result.agents) {
    const cost = SUBAGENT_COSTS[a.name];
    const pLabel = passRate !== undefined ? passRate : cost.p;
    lines.push(
      `${a.name.padEnd(25)} ${String(a.count).padEnd(8)} ${a.allHigh.toFixed(4).padEnd(14)} ${a.lowFirst.toFixed(4).padEnd(16)} ${`${a.savingsPct}%`.padEnd(8)}`
    );
  }

  lines.push('─'.repeat(header.length));
  lines.push(
    `${'合計'.padEnd(25)} ${''.padEnd(8)} ${result.totals.allHigh.toFixed(4).padEnd(14)} ${result.totals.lowFirst.toFixed(4).padEnd(16)} ${`${result.totalSavingsPct}%`.padEnd(8)}`
  );
  lines.push('');

  // ワークフロー説明
  lines.push('ワークフロー:');
  lines.push('  1. 過去事例の情報抽出 → Extractor (haiku)');
  lines.push('  2. 顧客要望の分類 → Classifier (haiku)');
  lines.push('  3. CIログの確認 → LogReader (haiku)');
  lines.push('  4. デザイン実装 → Implementer (sonnet)');
  lines.push('  5. 全体企画・構成判断 → 監督 (opus/deepseek)');
  lines.push('');

  if (verbose) {
    lines.push('各サブエージェントのコストモデル:');
    for (const [name, cost] of Object.entries(SUBAGENT_COSTS)) {
      lines.push(`  ${name}: low=$${cost.low} high=$${cost.high} p=${cost.p}`);
    }
  }

  return { lines: lines.join('\n'), result };
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const { lines } = main();
  process.stdout.write(lines + '\n');
}
