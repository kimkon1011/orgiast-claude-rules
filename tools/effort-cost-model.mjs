#!/usr/bin/env node
/**
 * effort-cost-model.mjs — 失敗時リトライ方式（全 low ＋ 失敗分だけ high 再実行）のコストモデル
 *
 * AIニュース提案 X-0021「Claude effort調整とHaikuサブエージェントでコスト4割減」の
 * コスト削減率を検証可能にする。依存パッケージなし（stdlib のみ）。
 *
 * モデル:
 *   allHighCost   = taskCount × highCostPerTask
 *   lowFirstCost  = taskCount × lowCostPerTask + (1 - passRate) × taskCount × highCostPerTask
 *   savingsPct    = (1 - lowFirstCost / allHighCost) × 100  （少数第1位まで丸め）
 *
 * 使い方:
 *   node tools/effort-cost-model.mjs --pass-rate 0.97 --low-cost 0.17 --high-cost 0.29 --count 100
 *   引数欠落時はデフォルト (0.97, 0.17, 0.29, 100) を使い、結果を JSON で stdout に出力する。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

function argValue(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] !== undefined ? Number(argv[at + 1]) : undefined;
}

/**
 * @param {object} p
 * @param {number} p.taskCount        タスク数（正の整数）
 * @param {number} p.passRate         低 effort の正解率（0〜1）
 * @param {number} p.lowCostPerTask   low 1タスクあたりコスト（USD）
 * @param {number} p.highCostPerTask  high 1タスクあたりコスト（USD）
 * @returns {{allHighCost: number, lowFirstCost: number, savingsPct: number, explanationJp: string}}
 */
export function effortSavings({ taskCount, passRate, lowCostPerTask, highCostPerTask }) {
  if (!Number.isInteger(taskCount) || taskCount <= 0) {
    throw new Error(`taskCount は正の整数が必要です（got: ${taskCount}）`);
  }
  if (typeof passRate !== 'number' || Number.isNaN(passRate) || passRate < 0 || passRate > 1) {
    throw new Error(`passRate は 0〜1 の範囲が必要です（got: ${passRate}）`);
  }
  for (const [name, v] of [['lowCostPerTask', lowCostPerTask], ['highCostPerTask', highCostPerTask]]) {
    if (typeof v !== 'number' || Number.isNaN(v) || v < 0) {
      throw new Error(`${name} は 0 以上の数値が必要です（got: ${v}）`);
    }
  }

  const allHighCost = taskCount * highCostPerTask;
  const lowFirstCost = taskCount * lowCostPerTask + (1 - passRate) * taskCount * highCostPerTask;
  const savingsPct = Math.round((1 - lowFirstCost / allHighCost) * 100 * 10) / 10;

  const explanationJp =
    `失敗時リトライ方式の削減率: (1 - (taskCount×lowCostPerTask + (1-passRate)×taskCount×highCostPerTask) / ` +
    `(taskCount×highCostPerTask)) × 100 = ${savingsPct}% ` +
    `（全部 high の $${allHighCost.toFixed(2)} に対し low→再実行は $${lowFirstCost.toFixed(2)}、正解率 ${passRate}）`;

  return { allHighCost, lowFirstCost, savingsPct, explanationJp };
}

export function main(argv = process.argv) {
  const passRate = argValue(argv, '--pass-rate') ?? 0.97;
  const lowCostPerTask = argValue(argv, '--low-cost') ?? 0.17;
  const highCostPerTask = argValue(argv, '--high-cost') ?? 0.29;
  const taskCount = argValue(argv, '--count') ?? 100;

  const result = effortSavings({ taskCount, passRate, lowCostPerTask, highCostPerTask });
  return {
    passRate,
    lowCostPerTask,
    highCostPerTask,
    taskCount,
    allHighCost: Number(result.allHighCost.toFixed(2)),
    lowFirstCost: Number(result.lowFirstCost.toFixed(2)),
    savingsPct: result.savingsPct,
    explanationJp: result.explanationJp,
  };
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  process.stdout.write(JSON.stringify(main(), null, 2) + '\n');
}