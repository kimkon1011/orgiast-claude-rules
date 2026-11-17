import assert from 'node:assert/strict';
import test from 'node:test';
import {
  estimateCostPerTask, formatResult, formatTable, parseArgs, run,
  MODELS, SCENARIOS,
} from './cost-per-task-estimator.mjs';

test('MODELS に4モデルが定義されている', () => {
  assert.equal(Object.keys(MODELS).length, 4);
  assert.ok(MODELS.haiku);
  assert.ok(MODELS.sonnet);
  assert.ok(MODELS.opus);
  assert.ok(MODELS.fable);
});

test('SCENARIOS に5シナリオが定義されている', () => {
  assert.equal(Object.keys(SCENARIOS).length, 5);
  assert.ok(SCENARIOS['booth-design']);
  assert.ok(SCENARIOS['booth-design-improved']);
  assert.ok(SCENARIOS['data-entry']);
  assert.ok(SCENARIOS['research']);
  assert.ok(SCENARIOS['multi-agent']);
});

test('estimateCostPerTask: 既定値（booth-design, Sonnet）', () => {
  const r = estimateCostPerTask();
  assert.equal(r.scenario, 'ブースデザイン案生成');
  assert.equal(r.model, 'Sonnet 5.5');
  assert.equal(r.tries, 2.8);
  assert.equal(r.tokensPerTry, 50000);
  assert.equal(r.cacheHitRate, 0);
  assert.ok(r.totalInputTokens > 0);
  assert.ok(r.totalOutputTokens > 0);
  assert.ok(r.totalTokens > 0);
  assert.ok(r.cpct > 0);
  assert.equal(r.cpct, r.cpctCache); // キャッシュなしの場合は同じ
  assert.ok(r.cost.noCache.total > 0);
  assert.equal(r.cost.cache, undefined); // cacheHitRate=0 なので cache は無し
});

test('estimateCostPerTask: キャッシュヒット率指定（booth-design, 50%）', () => {
  const r = estimateCostPerTask({ cacheHitRate: 0.5 });
  assert.equal(r.cacheHitRate, 0.5);
  assert.ok(r.cost.cache);
  assert.ok(r.cost.cache.total > 0);
  assert.ok(r.cost.cache.savings > 0);
  assert.ok(r.cpctCache < r.cpct); // キャッシュありの方が安い
  assert.ok(r.cost.cache.total < r.cost.noCache.total);
});

test('estimateCostPerTask: 改善後目標試行回数指定', () => {
  const r = estimateCostPerTask({ targetTries: 1.5 });
  assert.ok(r.target);
  assert.equal(r.target.tries, 1.5);
  assert.ok(r.target.cpct > 0);
  assert.ok(r.target.savings > 0);
  assert.ok(r.target.savingsPercent > 0);
  assert.ok(r.target.cpct < r.cpct); // 改善後の方が安い
});

test('estimateCostPerTask: 改善後目標＋キャッシュ', () => {
  const r = estimateCostPerTask({ cacheHitRate: 0.5, targetTries: 1.5 });
  assert.ok(r.target);
  assert.ok(r.cost.cache);
  assert.ok(r.target.cpctCache > 0);
  assert.ok(r.target.cpctCache < r.target.cpct); // キャッシュありの目標が安い
});

test('estimateCostPerTask: data-entryシナリオ', () => {
  const r = estimateCostPerTask({ scenario: 'data-entry' });
  assert.equal(r.scenario, '定型データ入力');
  assert.equal(r.model, 'Haiku 5.5');
  assert.equal(r.tries, 1.2);
  assert.equal(r.tokensPerTry, 10000);
  // Haiku は非常に安い
  assert.ok(r.cpct < 0.01);
});

test('estimateCostPerTask: researchシナリオ', () => {
  const r = estimateCostPerTask({ scenario: 'research' });
  assert.equal(r.scenario, '調査タスク');
  assert.equal(r.model, 'Opus 5.5');
  assert.ok(r.cpct > 0.2); // Opus なのである程度のコスト
});

test('estimateCostPerTask: multi-agentシナリオ', () => {
  const r = estimateCostPerTask({ scenario: 'multi-agent' });
  assert.equal(r.scenario, 'マルチエージェント');
  assert.equal(r.tries, 3.0);
  assert.equal(r.tokensPerTry, 500000);
  // 大量トークン消費
  assert.ok(r.totalTokens >= 1000000);
});

test('estimateCostPerTask: カスタムtries/tokens/inputRatio', () => {
  const r = estimateCostPerTask({
    tries: 5,
    tokensPerTry: 20000,
    inputRatio: 0.5,
  });
  assert.equal(r.tries, 5);
  assert.equal(r.tokensPerTry, 20000);
  // inputRatio=0.5 で入出力同数
  assert.equal(r.totalInputTokens, r.totalOutputTokens);
});

test('estimateCostPerTask: カスタムモデル上書き', () => {
  const r = estimateCostPerTask({ model: 'fable' });
  assert.equal(r.model, 'Fable 5.2');
  assert.ok(r.cpct > 0.5); // Fable は高額
});

test('estimateCostPerTask: booth-design-improvedシナリオ', () => {
  const r = estimateCostPerTask({ scenario: 'booth-design-improved' });
  assert.equal(r.scenario, 'ブースデザイン（改善後）');
  assert.equal(r.model, 'Sonnet 5.5');
  assert.equal(r.tries, 1.5);
  assert.equal(r.tokensPerTry, 40000);
});

test('estimateCostPerTask: 無効なシナリオでエラー', () => {
  assert.throws(() => estimateCostPerTask({ scenario: 'invalid' }), /未知のシナリオ/);
});

test('estimateCostPerTask: 無効なモデルでエラー', () => {
  assert.throws(() => estimateCostPerTask({ model: 'invalid' }), /未知のモデル/);
});

test('estimateCostPerTask: 無効なinputRatioでエラー', () => {
  assert.throws(() => estimateCostPerTask({ inputRatio: -0.1 }), /inputRatio/);
  assert.throws(() => estimateCostPerTask({ inputRatio: 1.5 }), /inputRatio/);
});

test('estimateCostPerTask: 無効なcacheHitRateでエラー', () => {
  assert.throws(() => estimateCostPerTask({ cacheHitRate: -0.1 }), /cacheHitRate/);
  assert.throws(() => estimateCostPerTask({ cacheHitRate: 1.5 }), /cacheHitRate/);
});

test('estimateCostPerTask: 無効なtriesでエラー', () => {
  assert.throws(() => estimateCostPerTask({ tries: 0 }), /試行回数/);
  assert.throws(() => estimateCostPerTask({ tries: -1 }), /試行回数/);
});

test('estimateCostPerTask: 無効なtokensPerTryでエラー', () => {
  assert.throws(() => estimateCostPerTask({ tokensPerTry: 0 }), /トークン数/);
  assert.throws(() => estimateCostPerTask({ tokensPerTry: -100 }), /トークン数/);
});

test('formatResult が文字列を返す', () => {
  const r = estimateCostPerTask();
  const output = formatResult(r);
  assert.equal(typeof output, 'string');
  assert.ok(output.includes('完了タスクあたりコスト推定'));
  assert.ok(output.includes(r.model));
  assert.ok(output.includes(`$${r.cpct.toFixed(4)}/task`));
});

test('formatResult キャッシュあり', () => {
  const r = estimateCostPerTask({ cacheHitRate: 0.5 });
  const output = formatResult(r);
  assert.ok(output.includes('キャッシュあり'));
  assert.ok(output.includes(`$${r.cost.cache.total.toFixed(2)}`));
  assert.ok(output.includes('CPCT（キャッシュあり）'));
});

test('formatResult 改善後目標表示', () => {
  const r = estimateCostPerTask({ targetTries: 1.5 });
  const output = formatResult(r);
  assert.ok(output.includes('改善効果'));
  assert.ok(output.includes(r.target.savingsPercent.toFixed(1)));
});

test('formatTable が全シナリオの文字列を返す', () => {
  const results = Object.keys(SCENARIOS).map((key) => {
    const s = SCENARIOS[key];
    return estimateCostPerTask({ scenario: key, model: s.model });
  });
  const output = formatTable(results);
  assert.equal(typeof output, 'string');
  assert.ok(output.includes('全シナリオ比較'));
  assert.ok(output.includes('ブースデザイン案生成'));
  assert.ok(output.includes('定型データ入力'));
  assert.ok(output.includes('調査タスク'));
  assert.ok(output.includes('マルチエージェント'));
  assert.ok(output.includes('CPCT'));
});

test('parseArgs: デフォルト値', () => {
  const opts = parseArgs([]);
  assert.equal(opts.scenario, 'booth-design');
  assert.equal(opts.tries, null);
  assert.equal(opts.tokensPerTry, null);
  assert.equal(opts.model, null);
  assert.equal(opts.cacheHitRate, null);
  assert.equal(opts.targetTries, null);
  assert.equal(opts.jsonOutput, false);
  assert.equal(opts.showTable, false);
});

test('parseArgs: 全てのフラグのパース', () => {
  const opts = parseArgs([
    '--scenario', 'research',
    '--tries', '2',
    '--tokens-per-try', '60000',
    '--model', 'opus',
    '--cache-hit-rate', '0.3',
    '--target-tries', '1.2',
    '--json',
    '--show-table',
  ]);
  assert.equal(opts.scenario, 'research');
  assert.equal(opts.tries, 2);
  assert.equal(opts.tokensPerTry, 60000);
  assert.equal(opts.model, 'opus');
  assert.equal(opts.cacheHitRate, 0.3);
  assert.equal(opts.targetTries, 1.2);
  assert.equal(opts.jsonOutput, true);
  assert.equal(opts.showTable, true);
});

test('parseArgs: 不正なシナリオでエラー', () => {
  assert.throws(() => parseArgs(['--scenario', 'invalid']), /--scenario は/);
});

test('parseArgs: 不正なモデルでエラー', () => {
  assert.throws(() => parseArgs(['--model', 'invalid']), /--model は/);
});

test('parseArgs: 不正なtriesでエラー', () => {
  assert.throws(() => parseArgs(['--tries', '0']), /--tries/);
  assert.throws(() => parseArgs(['--tries', '-1']), /--tries/);
  assert.throws(() => parseArgs(['--tries', 'abc']), /--tries/);
});

test('parseArgs: 不正なcacheHitRateでエラー', () => {
  assert.throws(() => parseArgs(['--cache-hit-rate', '1.5']), /--cache-hit-rate/);
  assert.throws(() => parseArgs(['--cache-hit-rate', '-0.1']), /--cache-hit-rate/);
});

test('parseArgs: 不正なtargetTriesでエラー', () => {
  assert.throws(() => parseArgs(['--target-tries', '0']), /--target-tries/);
});

test('run: デフォルト出力', () => {
  const output = run([]);
  assert.ok(output.includes('完了タスクあたりコスト推定'));
  assert.ok(output.includes('Sonnet'));
  assert.ok(output.includes('CPCT'));
});

test('run: JSON出力', () => {
  const output = run(['--json']);
  const parsed = JSON.parse(output);
  assert.equal(parsed.scenario, 'ブースデザイン案生成');
  assert.ok(parsed.cost);
  assert.ok(parsed.cost.noCache);
  assert.ok(parsed.cpct > 0);
});

test('run: --scenario research', () => {
  const output = run(['--scenario', 'research', '--json']);
  const parsed = JSON.parse(output);
  assert.equal(parsed.scenario, '調査タスク');
  assert.equal(parsed.model, 'Opus 5.5');
});

test('run: --show-table', () => {
  const output = run(['--show-table']);
  assert.ok(output.includes('全シナリオ比較'));
  assert.ok(output.includes('ブースデザイン案生成'));
  assert.ok(output.includes('定型データ入力'));
});

test('run: --show-table --json', () => {
  const output = run(['--show-table', '--json']);
  const parsed = JSON.parse(output);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 5);
  assert.ok(parsed[0].cpct > 0);
  assert.ok(parsed[1].cpct > 0);
});

test('run: --cache-hit-rate', () => {
  const output = run(['--cache-hit-rate', '0.5', '--json']);
  const parsed = JSON.parse(output);
  assert.equal(parsed.cacheHitRate, 0.5);
  assert.ok(parsed.cost.cache);
});

test('run: --target-tries', () => {
  const output = run(['--target-tries', '1.5', '--json']);
  const parsed = JSON.parse(output);
  assert.ok(parsed.target);
  assert.equal(parsed.target.tries, 1.5);
});

test('run: --scenario data-entry', () => {
  const output = run(['--scenario', 'data-entry', '--json']);
  const parsed = JSON.parse(output);
  assert.equal(parsed.scenario, '定型データ入力');
  assert.ok(parsed.cpct < 0.01); // Haiku で安い
});

test('キャッシュ率100%でコスト最小', () => {
  const r0 = estimateCostPerTask({ cacheHitRate: 0 });
  const r50 = estimateCostPerTask({ cacheHitRate: 0.5 });
  const r100 = estimateCostPerTask({ cacheHitRate: 1.0 });
  assert.ok(r50.cpctCache < r0.cpct, '50%キャッシュでコスト削減');
  assert.ok(r100.cpctCache < r50.cpctCache, '100%キャッシュでさらに削減');
});

test('targetTriesが小さいほど削減率が高い', () => {
  const base = estimateCostPerTask({ targetTries: 2.0 });
  const better = estimateCostPerTask({ targetTries: 1.0 });
  assert.ok(better.target.savingsPercent > base.target.savingsPercent);
});