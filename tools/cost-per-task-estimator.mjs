#!/usr/bin/env node
/**
 * 完了タスクあたりコスト推定ツール（X-0053）
 *
 * AIエージェントの完了タスクあたりコスト（CPCT）を推定する。
 * 指示の具体化レベル・再生成回数・モデル単価からCPCTを計算し、改善効果を可視化する。
 *
 * 使い方:
 *   node tools/cost-per-task-estimator.mjs                           # デフォルト（booth-design）
 *   node tools/cost-per-task-estimator.mjs --scenario research       # researchシナリオ
 *   node tools/cost-per-task-estimator.mjs --tries 2 --model opus    # カスタム
 *   node tools/cost-per-task-estimator.mjs --json                    # JSON出力
 *   node tools/cost-per-task-estimator.mjs --show-table              # 全シナリオ比較
 *   node tools/cost-per-task-estimator.mjs --cache-hit-rate 0.5      # キャッシュヒット率指定
 *   node tools/cost-per-task-estimator.mjs --target-tries 1.5        # 改善後の目標
 */
import { isEntry } from './is-entry.mjs';

// モデル別価格（$ / 1Mトークン）: 2026-11-18 時点（X-0055 と同じ価格表）
export const MODELS = {
  'haiku':  { input: 0.10, output: 0.50, cacheWrite: 0.125, cacheRead: 0.025, label: 'Haiku 5.5' },
  'sonnet': { input: 1.25, output: 6.25, cacheWrite: 1.56,  cacheRead: 0.31,  label: 'Sonnet 5.5' },
  'opus':   { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.75,  label: 'Opus 5.5' },
  'fable':  { input: 8.00, output: 24.00, cacheWrite: 10.00, cacheRead: 2.00, label: 'Fable 5.2' },
};

// シナリオ定義（完了タスクあたり）
export const SCENARIOS = {
  'booth-design':          { tries: 2.8, tokensPerTry: 50000, model: 'sonnet', label: 'ブースデザイン案生成',       description: 'デザイン案生成（2.8回試行）',       cacheHitRate: 0 },
  'booth-design-improved': { tries: 1.5, tokensPerTry: 40000, model: 'sonnet', label: 'ブースデザイン（改善後）',   description: '改善後（1.5回試行、キャッシュ活用）', cacheHitRate: 0.5 },
  'data-entry':            { tries: 1.2, tokensPerTry: 10000, model: 'haiku',  label: '定型データ入力',             description: '定型データ入力（Haiku）',             cacheHitRate: 0 },
  'research':              { tries: 1.5, tokensPerTry: 80000, model: 'opus',   label: '調査タスク',                 description: '調査タスク（Opus）',                 cacheHitRate: 0 },
  'multi-agent':           { tries: 3.0, tokensPerTry: 500000, model: 'sonnet', label: 'マルチエージェント',       description: 'マルチエージェント（Sonnet/Fable）', cacheHitRate: 0 },
};

function round2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * 完了タスクあたりコストを計算
 *
 * @param {object} opts
 * @param {string} [opts.scenario='booth-design'] - シナリオ名
 * @param {number} [opts.tries] - 平均試行回数（上書き）
 * @param {number} [opts.tokensPerTry] - 1試行あたり平均トークン消費（上書き）
 * @param {number} [opts.inputRatio=0.8] - 入力トークン比率（0.0〜1.0）
 * @param {number} [opts.cacheHitRate=0.0] - キャッシュヒット率（0.0〜1.0）
 * @param {string} [opts.model] - モデル名（上書き）
 * @param {number} [opts.targetTries] - 改善後の目標試行回数（省略可）
 */
export function estimateCostPerTask(opts = {}) {
  const scenarioName = opts.scenario || 'booth-design';
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) throw new Error(`未知のシナリオ: ${scenarioName}（booth-design / booth-design-improved / data-entry / research / multi-agent）`);

  const modelName = opts.model || scenario.model;
  const modelConfig = MODELS[modelName];
  if (!modelConfig) throw new Error(`未知のモデル: ${modelName}（haiku / sonnet / opus / fable）`);

  const tries = opts.tries ?? scenario.tries;
  const tokensPerTry = opts.tokensPerTry ?? scenario.tokensPerTry;
  const inputRatio = opts.inputRatio ?? 0.8;
  const cacheHitRate = opts.cacheHitRate ?? scenario.cacheHitRate ?? 0.0;

  if (tries <= 0) throw new Error('試行回数は正の数で指定してください');
  if (tokensPerTry <= 0) throw new Error('トークン数は正の数で指定してください');
  if (inputRatio < 0 || inputRatio > 1) throw new Error('inputRatio は0.0〜1.0の範囲で指定してください');
  if (cacheHitRate < 0 || cacheHitRate > 1) throw new Error('cacheHitRate は0.0〜1.0の範囲で指定してください');

  const totalInputTokens = Math.round(tries * tokensPerTry * inputRatio);
  const totalOutputTokens = Math.round(tries * tokensPerTry * (1 - inputRatio));
  const totalTokens = totalInputTokens + totalOutputTokens;

  // キャッシュなしのコスト
  const noCacheInput = (totalInputTokens / 1_000_000) * modelConfig.input;
  const noCacheOutput = (totalOutputTokens / 1_000_000) * modelConfig.output;
  const noCacheTotal = noCacheInput + noCacheOutput;
  const cost = {
    noCache: {
      input: round2(noCacheInput),
      output: round2(noCacheOutput),
      total: round2(noCacheTotal),
    },
  };

  // キャッシュありのコスト
  if (cacheHitRate > 0) {
    const cacheReadTokens = Math.round(totalInputTokens * cacheHitRate);
    const freshInputTokens = totalInputTokens - cacheReadTokens;
    const cacheInput = (freshInputTokens / 1_000_000) * modelConfig.input
      + (cacheReadTokens / 1_000_000) * modelConfig.cacheRead;
    const cacheOutput = noCacheOutput;
    const cacheTotal = cacheInput + cacheOutput;
    const savings = round2(noCacheTotal - cacheTotal);
    cost.cache = {
      input: round2(cacheInput),
      output: round2(cacheOutput),
      total: round2(cacheTotal),
      savings,
    };
  }

  const cpct = round2(noCacheTotal);
  const cpctCache = cacheHitRate > 0 ? round2(cost.cache.total) : cpct;

  const result = {
    scenario: scenario.label,
    model: modelConfig.label,
    tries,
    tokensPerTry,
    totalTokens,
    totalInputTokens,
    totalOutputTokens,
    cacheHitRate,
    cost,
    cpct,
    cpctCache,
  };

  // 改善後目標試行回数
  if (opts.targetTries !== undefined && opts.targetTries !== null) {
    const targetTries = opts.targetTries;
    const targetInputTokens = Math.round(targetTries * tokensPerTry * inputRatio);
    const targetOutputTokens = Math.round(targetTries * tokensPerTry * (1 - inputRatio));
    const targetNoCacheInput = (targetInputTokens / 1_000_000) * modelConfig.input;
    const targetNoCacheOutput = (targetOutputTokens / 1_000_000) * modelConfig.output;
    const targetNoCacheTotal = targetNoCacheInput + targetNoCacheOutput;
    const targetCpct = round2(targetNoCacheTotal);

    let targetCpctCache = targetCpct;
    if (cacheHitRate > 0) {
      const targetCacheReadTokens = Math.round(targetInputTokens * cacheHitRate);
      const targetFreshInputTokens = targetInputTokens - targetCacheReadTokens;
      const targetCacheInput = (targetFreshInputTokens / 1_000_000) * modelConfig.input
        + (targetCacheReadTokens / 1_000_000) * modelConfig.cacheRead;
      const targetCacheTotal = targetCacheInput + targetNoCacheOutput;
      targetCpctCache = round2(targetCacheTotal);
    }

    const savings = round2(cpct - targetCpct);
    const savingsPercent = cpct > 0 ? round2((savings / cpct) * 100) : 0;

    result.target = {
      tries: targetTries,
      cpct: targetCpct,
      cpctCache: targetCpctCache,
      savings,
      savingsPercent,
    };
  }

  return result;
}

/**
 * 結果を人間可読な表形式で表示
 */
export function formatResult(result) {
  const lines = [];
  const s = result;

  lines.push(`=== 完了タスクあたりコスト推定（X-0053） ===`);
  lines.push('');
  lines.push(`シナリオ:     ${s.scenario}`);
  lines.push(`モデル:       ${s.model}`);
  lines.push(`試行回数:     ${s.tries}`);
  lines.push(`1試行あたり:  ${s.tokensPerTry.toLocaleString()} tokens`);
  lines.push(`キャッシュ率: ${(s.cacheHitRate * 100).toFixed(0)}%`);
  lines.push('');
  lines.push(`--- トークン消費 ---`);
  lines.push(`  総入力トークン: ${s.totalInputTokens.toLocaleString()} tokens`);
  lines.push(`  総出力トークン: ${s.totalOutputTokens.toLocaleString()} tokens`);
  lines.push(`  総トークン:     ${s.totalTokens.toLocaleString()} tokens`);
  lines.push('');
  lines.push(`--- コスト ---`);
  lines.push(`  キャッシュなし:  $${s.cost.noCache.total.toFixed(2)}（入力 $${s.cost.noCache.input.toFixed(2)} + 出力 $${s.cost.noCache.output.toFixed(2)}）`);
  if (s.cost.cache) {
    lines.push(`  キャッシュあり:  $${s.cost.cache.total.toFixed(2)}（入力 $${s.cost.cache.input.toFixed(2)} + 出力 $${s.cost.cache.output.toFixed(2)}）`);
    lines.push(`  削減額:          $${s.cost.cache.savings.toFixed(2)}`);
  }
  const costLabel = s.cost.cache ? '（キャッシュあり）' : '（キャッシュなし）';
  lines.push(`  CPCT${s.cacheHitRate > 0 ? '（キャッシュなし）' : ''}: $${s.cpct.toFixed(4)}/task`);
  if (s.cacheHitRate > 0) {
    lines.push(`  CPCT（キャッシュあり）: $${s.cpctCache.toFixed(4)}/task`);
  }
  lines.push('');

  if (s.target) {
    const t = s.target;
    lines.push(`--- 改善効果（目標試行回数: ${t.tries}） ---`);
    lines.push(`  目標 CPCT:           $${t.cpct.toFixed(4)}/task`);
    if (s.cacheHitRate > 0) {
      lines.push(`  目標 CPCT（キャッシュあり）: $${t.cpctCache.toFixed(4)}/task`);
    }
    lines.push(`  削減額:              $${t.savings.toFixed(4)}/task`);
    lines.push(`  削減率:              ${t.savingsPercent.toFixed(1)}%`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 全シナリオ比較表
 */
export function formatTable(results) {
  const lines = [];
  lines.push('=== 全シナリオ比較（完了タスクあたりコスト） ===');
  lines.push('');
  lines.push('  # | シナリオ               | モデル   | 試行数 | 1試行(tok) | CPCT($)    | CPCTｷｬｯｼｭ($)');
  lines.push('  --+------------------------+----------+--------+-----------+------------+--------------');

  results.forEach((r, i) => {
    const cpctStr = r.cpct.toFixed(4).padStart(10);
    const cpctCacheStr = r.cost.cache ? r.cpctCache.toFixed(4).padStart(10) : '     N/A   ';
    lines.push(
      `  ${(i + 1).toString().padStart(1)} | ${r.scenario.padEnd(22)} | ${r.model.padEnd(8)} | ${r.tries.toString().padStart(5)}  | ${r.tokensPerTry.toString().padStart(9)} | ${cpctStr} | ${cpctCacheStr}`
    );
  });
  lines.push('');

  return lines.join('\n');
}

/**
 * CLI引数をパース
 */
export function parseArgs(args) {
  const value = (flag, fallback) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const has = (flag) => args.includes(flag);

  const scenario = value('--scenario', 'booth-design');
  const tries = value('--tries', null) ? Number(value('--tries', null)) : null;
  const tokensPerTry = value('--tokens-per-try', null) ? Number(value('--tokens-per-try', null)) : null;
  const model = value('--model', null);
  const cacheHitRate = value('--cache-hit-rate', null) ? Number(value('--cache-hit-rate', null)) : null;
  const targetTries = value('--target-tries', null) ? Number(value('--target-tries', null)) : null;
  const jsonOutput = has('--json');
  const showTable = has('--show-table');

  if (!SCENARIOS[scenario]) throw new Error(`--scenario は booth-design / booth-design-improved / data-entry / research / multi-agent のいずれかを指定してください`);
  if (model && !MODELS[model]) throw new Error(`--model は haiku / sonnet / opus / fable のいずれかを指定してください`);
  if (tries !== null && (tries <= 0 || !Number.isFinite(tries))) throw new Error('--tries は正の数で指定してください');
  if (tokensPerTry !== null && (tokensPerTry <= 0 || !Number.isFinite(tokensPerTry))) throw new Error('--tokens-per-try は正の数で指定してください');
  if (cacheHitRate !== null && (cacheHitRate < 0 || cacheHitRate > 1)) throw new Error('--cache-hit-rate は0.0〜1.0の範囲で指定してください');
  if (targetTries !== null && (targetTries <= 0 || !Number.isFinite(targetTries))) throw new Error('--target-tries は正の数で指定してください');

  return { scenario, tries, tokensPerTry, model, cacheHitRate, targetTries, jsonOutput, showTable };
}

/**
 * CLIエントリポイント
 */
export function run(args = process.argv.slice(2)) {
  const opts = parseArgs(args);

  if (opts.showTable) {
    const results = Object.keys(SCENARIOS).map((key) => {
      const s = SCENARIOS[key];
      return estimateCostPerTask({ scenario: key, model: s.model, cacheHitRate: s.cacheHitRate });
    });
    if (opts.jsonOutput) {
      return JSON.stringify(results.map((r) => ({
        scenario: r.scenario,
        model: r.model,
        tries: r.tries,
        tokensPerTry: r.tokensPerTry,
        totalTokens: r.totalTokens,
        cpct: r.cpct,
        cpctCache: r.cpctCache,
        cacheHitRate: r.cacheHitRate,
      })), null, 2);
    }
    return formatTable(results);
  }

  const result = estimateCostPerTask({
    scenario: opts.scenario,
    tries: opts.tries,
    tokensPerTry: opts.tokensPerTry,
    model: opts.model,
    cacheHitRate: opts.cacheHitRate,
    targetTries: opts.targetTries,
  });

  if (opts.jsonOutput) {
    return JSON.stringify(result, null, 2);
  }

  return formatResult(result);
}

if (isEntry(import.meta.url)) {
  try {
    const output = run();
    process.stdout.write(output + '\n');
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exit(1);
  }
}