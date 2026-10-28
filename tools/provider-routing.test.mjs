import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gatewayModel, routeCandidate } from './provider-routing.mjs';
import { executorCostUsd, callWithFallback } from './llm-fallback.mjs';
import { summarizeLedger, classifyBalance, alertProviderBalances, formatBalanceLine } from './provider-balance.mjs';
import { calculateBudgetStatus } from './budget-status.mjs';
import { previousMonthBudget } from './cost-monthly-report.mjs';
import { aggregateExecutor } from './ai-usage-local.mjs';
import { probeRateLimits, loadProbeKey } from './provider-ratelimit-probe.mjs';
import { resolveProvider } from './cheap-code.mjs';
import { resolveFallbackBackends } from './codex-do.mjs';

function temporary(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-routing-'));
  fs.mkdirSync(path.join(home, '.claude'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('legacy names and explicit OpenRouter models map without losing model selection', () => {
  for (const [provider, model, expected] of [
    ['kimi', undefined, 'moonshotai/kimi-k3'], ['kimi', 'kimi-k2.5', 'moonshotai/kimi-k2.5'],
    ['kimi', 'kimi-k2-turbo-preview', 'moonshotai/kimi-k2-0905'],
    ['deepseek', 'deepseek-flash', 'deepseek/deepseek-v4-flash'],
    ['deepseek', 'deepseek-v4-pro', 'deepseek/deepseek-v4-pro'],
    ['deepseek', 'deepseek/deepseek-v3.2', 'deepseek/deepseek-v3.2'],
  ]) {
    assert.equal(gatewayModel(provider, model), expected);
    assert.deepEqual(routeCandidate({ provider, model }), { provider: 'openrouter', model: expected });
  }
});

test('LLM CLI reads only the OpenRouter file, records real provider/model and billed USD', t => {
  const home = temporary(t);
  fs.writeFileSync(path.join(home, '.claude', 'openrouter.env'), 'export OPENROUTER_API_KEY="gateway-test"\n');
  const mock = path.join(home, 'mock.mjs');
  fs.writeFileSync(mock, `globalThis.fetch = async (url, init) => {
    if (url !== 'https://openrouter.ai/api/v1/chat/completions') throw new Error('native request');
    if (init.headers.Authorization !== 'Bearer gateway-test') throw new Error('wrong key');
    const model = JSON.parse(init.body).model;
    return new Response(JSON.stringify({ choices: [{ message: { content: model } }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.00123 } }));
  };`);
  for (const provider of ['kimi', 'deepseek']) {
    const output = execFileSync(process.execPath, ['--import', pathToFileURL(mock).href, fileURLToPath(new URL('./llm-ask.mjs', import.meta.url)), '--provider', provider, '--no-fallback', 'OK'], {
      encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home, OPENROUTER_API_KEY: '', DEEPSEEK_API_KEY: 'wrong-native-key', MOONSHOT_API_KEY: 'wrong-native-key' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(output.trim(), gatewayModel(provider));
  }
  const rows = fs.readFileSync(path.join(home, '.claude', 'executor-usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r => [r.provider, r.model, r.usd, r.failover]), [
    ['openrouter', 'moonshotai/kimi-k3', 0.00123, false], ['openrouter', 'deepseek/deepseek-v4-flash', 0.00123, false],
  ]);
});

test('model-specific estimates and measured cost agree across daily and monthly summaries', () => {
  const now = new Date('2026-10-28T00:00:00Z');
  const rows = [
    { t: now.toISOString(), provider: 'openrouter', model: 'moonshotai/kimi-k3', in: 1e6, out: 1e6 },
    { t: now.toISOString(), provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', in: 1e6, out: 1e6 },
    { t: now.toISOString(), provider: 'openrouter', model: 'moonshotai/kimi-k3', in: 1e6, out: 1e6, usd: 0.02 },
  ];
  assert.equal(executorCostUsd(rows[0]), 20.15);
  assert.equal(executorCostUsd(rows[1]), 0.273);
  assert.equal(executorCostUsd(rows[2]), 0.02);
  assert.equal(executorCostUsd({ ...rows[2], usd: 0 }), 0);
  assert.equal(executorCostUsd({ provider: 'deepseek', in: 1e6, out: 1e6 }), 1.37, 'historical native rates stay unchanged');
  const total = rows.reduce((n, r) => n + executorCostUsd(r), 0);
  assert.equal(summarizeLedger(rows, 'openrouter', now).todaySpendUsd, total);
  assert.ok(Math.abs(aggregateExecutor(rows, { now, jpyPerUsd: 150 })['2026-10'].OPENROUTER.jpy - total * 150) < 1e-9);
});

test('native balance and OFF alerts remain suppressed even with stale low/fault status', async t => {
  const home = temporary(t), lines = [];
  for (const provider of ['kimi', 'deepseek']) for (const status of ['low', 'autotopup_broken', 'ok']) {
    const row = { provider, status, balanceUsd: 0, autoTopUp: false };
    assert.equal(classifyBalance(row), 'via_openrouter');
    assert.match(formatBalanceLine([row]), /OpenRouter経由のため監視対象外.*native残高は参考表示/);
    const result = await alertProviderBalances([row], { home, dryRun: true, log: s => lines.push(s), notify: () => assert.fail('must not send') });
    assert.deepEqual(result.lines, []);
  }
  const live = await alertProviderBalances([{ provider: 'openrouter', status: 'low', balanceUsd: 0, autoTopUp: false }], { home, dryRun: true, log() {} });
  assert.match(live.lines.join('\n'), /残高注意: openrouter/);
});

test('rate probe and coding fallback work with an OpenRouter key only', async t => {
  const home = temporary(t);
  fs.writeFileSync(path.join(home, '.claude', 'openrouter.env'), 'OPENROUTER_API_KEY=gateway-test\n');
  fs.writeFileSync(path.join(home, '.claude', 'provider-cooldown.json'), JSON.stringify({ deepseek: { until: Date.now() + 86400000, reason: 'http_402' } }));
  fs.writeFileSync(path.join(home, '.claude', 'codex-fallback-order.json'), JSON.stringify(['cheap-code:deepseek', 'qwen']));
  const backends = resolveFallbackBackends(home, { executableAvailable: () => true });
  assert.equal(backends.length, 2);
  assert.ok(backends.every(b => b.model === 'deepseek/deepseek-v4-flash'));
  assert.equal(backends[1].baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(resolveProvider('deepseek').envFile, 'openrouter.env');
  for (const provider of ['kimi', 'deepseek']) {
    assert.equal(loadProbeKey(provider, { home, env: {} }), 'gateway-test');
    const result = await probeRateLimits({ provider, model: provider === 'kimi' ? 'kimi-k3' : 'deepseek-flash', key: 'gateway-test', fetchImpl: async (url, init) => {
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(JSON.parse(init.body).model, gatewayModel(provider));
      return new Response('{}');
    } });
    assert.equal(result.ok, true);
  }
});

test('daily cap and budget reports use actual billed USD rather than a generic gateway rate', async t => {
  const home = temporary(t), ledgerFile = path.join(home, '.claude', 'executor-usage.jsonl');
  const now = new Date('2026-10-28T00:00:00Z');
  const row = { t: now.toISOString(), provider: 'openrouter', model: 'moonshotai/kimi-k3', in: 1, out: 1, usd: 6 };
  fs.writeFileSync(ledgerFile, JSON.stringify(row) + '\n');
  await assert.rejects(callWithFallback({ start: { provider: 'kimi', model: 'kimi-k3' }, chain: [], ledgerFile,
    now: () => +now, payloadFor: () => assert.fail('daily cost cap must block before HTTP') }), /従量上限/);
  const config = { fixed: [], usdJpy: 150, monthlyBudgetJpy: 10000 };
  assert.equal(calculateBudgetStatus({ config, ledgerRows: [row], now }).variableKnownJpy, 900);
  const configFile = path.join(home, 'budget.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  assert.equal(previousMonthBudget({ home, now: new Date('2026-11-01T12:00:00Z'), configFile }).executorUsd, 6);
});
