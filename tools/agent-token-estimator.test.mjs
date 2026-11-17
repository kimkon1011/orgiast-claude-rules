import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTokenCost, formatResult, formatTips, parseArgs, run, MODELS, SCENARIOS, PROMPT_TIPS } from './agent-token-estimator.mjs';

test('MODELS に4モデルが定義されている', () => {
  assert.equal(Object.keys(MODELS).length, 4);
  assert.ok(MODELS.haiku);
  assert.ok(MODELS.sonnet);
  assert.ok(MODELS.opus);
  assert.ok(MODELS.fable);
});

test('SCENARIOS に3シナリオが定義されている', () => {
  assert.equal(Object.keys(SCENARIOS).length, 3);
  assert.equal(SCENARIOS.chat.multiplier, 1);
  assert.equal(SCENARIOS.agent.multiplier, 4);
  assert.equal(SCENARIOS.multi.multiplier, 15);
});

test('PROMPT_TIPS に5件以上の改善提案がある', () => {
  assert.ok(PROMPT_TIPS.length >= 5);
});

test('estimateTokenCost: デフォルト（単一エージェント・Sonnet）', () => {
  const result = estimateTokenCost();
  assert.equal(result.scenario, '単一エージェント');
  assert.equal(result.model, 'Sonnet 5.5');
  assert.equal(result.turns, 10);
  assert.equal(result.effectiveAgents, 1);
  assert.equal(result.chatRatio, 4); // agent は chat の4倍
  assert.ok(result.totalInputTokens > 0);
  assert.ok(result.totalOutputTokens > 0);
  assert.ok(result.noCache.total > 0);
  assert.ok(result.cache.total > 0);
  assert.ok(result.savings > 0); // キャッシュありで削減される
});

test('estimateTokenCost: チャットモード', () => {
  const result = estimateTokenCost({ mode: 'chat' });
  assert.equal(result.scenario, '標準チャット');
  assert.equal(result.chatRatio, 1);
});

test('estimateTokenCost: マルチエージェントモード', () => {
  const result = estimateTokenCost({ mode: 'multi' });
  assert.equal(result.scenario, 'マルチエージェント');
  assert.ok(result.chatRatio > 4); // 15x だが、エージェント数のスケーリングで変動
  assert.ok(result.effectiveAgents >= 3);
});

test('estimateTokenCost: Haikuモデル', () => {
  const result = estimateTokenCost({ model: 'haiku' });
  assert.equal(result.model, 'Haiku 5.5');
  assert.ok(result.noCache.total < 0.1); // Haiku は非常に安い
});

test('estimateTokenCost: Fableモデル', () => {
  const result = estimateTokenCost({ model: 'fable' });
  assert.equal(result.model, 'Fable 5.2');
  assert.ok(result.noCache.total > result.cache.total);
});

test('estimateTokenCost: カスタムパラメータ', () => {
  const result = estimateTokenCost({
    mode: 'multi',
    model: 'opus',
    turns: 20,
    inputTokensPerTurn: 50000,
    numAgents: 3,
  });
  assert.equal(result.turns, 20);
  assert.equal(result.effectiveAgents, 3);
  assert.equal(result.inputPerTurn, 50000);
});

test('estimateTokenCost: キャッシュなし', () => {
  const result = estimateTokenCost({ useCache: false });
  assert.equal(result.cache, null);
  assert.equal(result.savings, 0);
});

test('estimateTokenCost: 無効なモードでエラー', () => {
  assert.throws(() => estimateTokenCost({ mode: 'invalid' }), /未知のモード/);
});

test('estimateTokenCost: 無効なモデルでエラー', () => {
  assert.throws(() => estimateTokenCost({ model: 'invalid' }), /未知のモデル/);
});

test('formatResult が文字列を返す', () => {
  const result = estimateTokenCost();
  const output = formatResult(result);
  assert.equal(typeof output, 'string');
  assert.ok(output.includes('エージェントトークン消費推定'));
  assert.ok(output.includes(result.model));
  assert.ok(output.includes(`$${result.noCache.total.toFixed(2)}`));
});

test('formatTips が文字列を返す', () => {
  const output = formatTips();
  assert.equal(typeof output, 'string');
  assert.ok(output.includes('プロンプト設計の改善提案'));
  for (const tip of PROMPT_TIPS) {
    assert.ok(output.includes(tip.title));
  }
});

test('parseArgs: デフォルト値', () => {
  const opts = parseArgs([]);
  assert.equal(opts.mode, 'agent');
  assert.equal(opts.model, 'sonnet');
  assert.equal(opts.turns, 10);
  assert.equal(opts.useCache, true);
  assert.equal(opts.jsonOutput, false);
  assert.equal(opts.showTips, false);
});

test('parseArgs: カスタム値', () => {
  const opts = parseArgs(['--mode', 'multi', '--model', 'opus', '--turns', '20', '--json', '--tips', '--no-cache']);
  assert.equal(opts.mode, 'multi');
  assert.equal(opts.model, 'opus');
  assert.equal(opts.turns, 20);
  assert.equal(opts.jsonOutput, true);
  assert.equal(opts.showTips, true);
  assert.equal(opts.useCache, false);
});

test('parseArgs: --agents', () => {
  const opts = parseArgs(['--agents', '5']);
  assert.equal(opts.agents, 5);
});

test('parseArgs: 不正なturnsでエラー', () => {
  assert.throws(() => parseArgs(['--turns', '0']), /1以上/);
  assert.throws(() => parseArgs(['--turns', '-1']), /1以上/);
  assert.throws(() => parseArgs(['--turns', 'abc']), /1以上/);
});

test('parseArgs: 不正なmodeでエラー', () => {
  assert.throws(() => parseArgs(['--mode', 'invalid']), /--mode は/);
});

test('parseArgs: 不正なmodelでエラー', () => {
  assert.throws(() => parseArgs(['--model', 'invalid']), /--model は/);
});

test('run: デフォルト出力', () => {
  const output = run([]);
  assert.ok(output.includes('エージェントトークン消費推定'));
  assert.ok(output.includes('Sonnet'));
});

test('run: JSON出力', () => {
  const output = run(['--json']);
  const parsed = JSON.parse(output);
  assert.equal(parsed.scenario, '単一エージェント');
  assert.ok(parsed.noCache);
  assert.ok(parsed.cache);
});

test('run: JSON出力＋tips', () => {
  const output = run(['--json', '--tips']);
  const parsed = JSON.parse(output);
  assert.ok(parsed.tips);
  assert.equal(parsed.tips.length, PROMPT_TIPS.length);
});

test('run: マルチエージェント', () => {
  const output = run(['--mode', 'multi', '--json']);
  const parsed = JSON.parse(output);
  assert.equal(parsed.scenario, 'マルチエージェント');
  assert.ok(parsed.chatRatio >= 10);
});

test('run: Haikuモデルで低コスト確認', () => {
  const output = run(['--model', 'haiku', '--json']);
  const parsed = JSON.parse(output);
  assert.ok(parsed.noCache.total < 1.0); // Haiku は1ドル未満
});

test('run: tips表示', () => {
  const output = run(['--tips']);
  assert.ok(output.includes('固定プレフィックスの階層化'));
  assert.ok(output.includes('チェックポイント要約'));
});

test('エージェント数を指定したマルチエージェント', () => {
  const result = estimateTokenCost({ mode: 'multi', numAgents: 5 });
  assert.equal(result.effectiveAgents, 5);
});

test('キャッシュありのコストがキャッシュなしより安い', () => {
  for (const model of ['haiku', 'sonnet', 'opus', 'fable']) {
    const result = estimateTokenCost({ model, mode: 'multi', turns: 20 });
    assert.ok(result.cache.total < result.noCache.total, `${model}: キャッシュ(${result.cache.total}) < なし(${result.noCache.total})`);
  }
});

test('ターン数が増えるとキャッシュ削減率が向上する', () => {
  const short = estimateTokenCost({ turns: 2 });
  const long = estimateTokenCost({ turns: 50 });
  assert.ok(long.savings > short.savings, '長期セッションの削減率が高い');
});