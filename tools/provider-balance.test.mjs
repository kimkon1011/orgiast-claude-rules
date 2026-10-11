import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyBalance, collectProviderBalances, fetchProviderBalance, formatBalanceLine } from './provider-balance.mjs';

test('confirmed provider response shapes are parsed', async () => {
  const cases = [
    ['deepseek', { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.34' }] }, 12.34],
    ['openrouter', { data: { total_credits: 20, total_usage: 3.25 } }, 16.75],
    ['kimi', { data: { available_balance: 9.5 } }, 9.5],
  ];
  for (const [provider, body, expected] of cases) assert.equal((await fetchProviderBalance({ provider, key: 'secret', url: 'https://example.test', fetchImpl: async () => new Response(JSON.stringify(body)) })).balanceUsd, expected);
});
test('401 and network failures remain unmeasurable, never zero', async () => {
  const denied = await fetchProviderBalance({ provider: 'deepseek', key: 'secret', url: 'x', fetchImpl: async () => new Response('', { status: 401 }) });
  assert.equal(denied.balanceUsd, null); assert.match(denied.reason, /401/);
  const offline = await fetchProviderBalance({ provider: 'deepseek', key: 'secret', url: 'x', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(offline.balanceUsd, null); assert.match(offline.reason, /offline/);
});
test('anomaly and low thresholds are strict at specified boundaries', () => {
  assert.equal(classifyBalance({ todaySpendUsd: 1, avg7dSpendUsd: 0.49, balanceUsd: 9, autoTopUp: false }), 'anomaly');
  assert.equal(classifyBalance({ todaySpendUsd: 1, avg7dSpendUsd: 0.5, balanceUsd: 9, autoTopUp: false }), 'ok');
  assert.equal(classifyBalance({ todaySpendUsd: 0.99, avg7dSpendUsd: 0, balanceUsd: 9, autoTopUp: false }), 'ok');
  assert.equal(classifyBalance({ todaySpendUsd: 0, avg7dSpendUsd: 0, balanceUsd: 2.99, autoTopUp: false }), 'low');
  assert.equal(classifyBalance({ todaySpendUsd: 0, avg7dSpendUsd: 0, balanceUsd: 2.99, autoTopUp: true }), 'ok');
});

test('genspark prepaid credits are parsed without a USD parse reason', async () => {
  // REST(実測 2026-09-13)は素の `credit_balance` を返す。`gsk me` の CLI は同じ値を `data` で包む。
  for (const body of [{ credit_balance: 124857.7 }, { status: 'ok', message: 'success', data: { credit_balance: 124857.7 } }]) {
    const result = await fetchProviderBalance({ provider: 'genspark', key: 'secret', url: 'https://example.test', fetchImpl: async () => new Response(JSON.stringify(body)) });
    assert.deepEqual(result, { balanceUsd: null, credits: 124857.7 });
    assert.equal('reason' in result, false);
  }

  const missing = await fetchProviderBalance({ provider: 'genspark', key: 'secret', url: 'https://example.test', fetchImpl: async () => new Response(JSON.stringify({ data: {} })) });
  assert.equal(missing.credits, null);
  assert.ok(missing.reason);
});

test('genspark credit threshold and formatting are independent of USD balance', () => {
  assert.equal(classifyBalance({ credits: 4999, balanceUsd: 100, autoTopUp: true }), 'low');
  assert.equal(classifyBalance({ credits: 5000, balanceUsd: 0, autoTopUp: false }), 'ok');
  assert.match(formatBalanceLine([{ provider: 'genspark', credits: 124857.7, autoTopUp: null }]), /genspark 124857\.7cr\(前払い\)/);
});

test('Groq の課金台帳が無料枠表示まで伝わり、異常判定は維持される', async t => {
  const home = mkdtempSync(join(tmpdir(), 'provider-billing-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const rows = await collectProviderBalances({ home, appendHistory: false, fetchImpl: async () => new Response('{}') });
  const groq = rows.find(r => r.provider === 'groq');
  assert.equal(groq.billing, 'free');
  assert.match(groq.reason, /high demand.*2026-09-09.*spend_anomaly.*429/);
  assert.equal(formatBalanceLine([groq]), '💳 残高: groq 無料枠(有料化不可)');
  assert.equal(classifyBalance({ ...groq, todaySpendUsd: 2, avg7dSpendUsd: 0.1 }), 'anomaly');
  assert.match(formatBalanceLine([{ ...groq, billing: 'postpaid' }]), /自動不明/);
});

// 通知は実Discordへ接続せず、配信結果と永続状態の両方を検証する。
const { alertProviderBalances, main } = await import('./provider-balance.mjs');
const { readFileSync, existsSync } = await import('node:fs');
const NOW = new Date('2026-10-09T13:00:00Z');
const lowRow = { provider: 'kimi', balanceUsd: 0, autoTopUp: false, status: 'low', todaySpendUsd: 0, avg7dSpendUsd: 0 };
function alertFixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'balance-alert-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const messages = [];
  return { home, now: NOW, messages, log() {}, warn() {}, notify: async (text, options) => {
    assert.equal(options.webhookFallback, false);
    messages.push(text); return { delivered: 'dm' };
  } };
}
test('low→1通、同日再実行は抑止、翌日再通知、ok復旧は1回', async t => {
  const io = alertFixture(t);
  await alertProviderBalances([lowRow], io);
  assert.equal(io.messages.length, 1);
  assert.match(io.messages[0], /残高注意: kimi \$0.00（オートチャージ OFF）。チャージ画面: https:\/\/platform.kimi.ai\/console\/pay/);
  await alertProviderBalances([{ ...lowRow, balanceUsd: 1 }], io);
  assert.equal(io.messages.length, 1);
  const next = { ...io, now: new Date('2026-10-10T13:00:00Z') };
  await alertProviderBalances([lowRow], next);
  assert.equal(io.messages.length, 2);
  await alertProviderBalances([{ ...lowRow, status: 'unmeasurable', balanceUsd: null }], next);
  assert.equal(io.messages.length, 2);
  const recovered = { ...lowRow, status: 'ok', balanceUsd: 20 };
  await alertProviderBalances([recovered], next);
  await alertProviderBalances([recovered], next);
  assert.equal(io.messages.length, 3);
  assert.equal(io.messages[2], '復旧: kimi $20.00');
});
test('十分な残高でもOFFは7日に1通、既知でない課金URLを作らない', async t => {
  const io = alertFixture(t);
  const rows = [{ ...lowRow, provider: 'deepseek', balanceUsd: 50, status: 'ok' }];
  await alertProviderBalances(rows, io);
  await alertProviderBalances(rows, { ...io, now: new Date(NOW.getTime() + 6 * 86400000) });
  assert.deepEqual(io.messages, ['オートチャージが OFF: deepseek（方針は全プロバイダ ON）']);
  await alertProviderBalances(rows, { ...io, now: new Date(NOW.getTime() + 7 * 86400000) });
  assert.equal(io.messages.length, 2);
  await alertProviderBalances([{ ...lowRow, provider: 'genspark', credits: 10, balanceUsd: null, autoTopUp: 'unknown' }], io);
  assert.match(io.messages[2], /残高注意: genspark 10cr/);
  assert.doesNotMatch(io.messages[2], /https|\$null/);
});
test('異常支出でも$5未満OFFは通知、lowは自動チャージONでも通知', async t => {
  const io = alertFixture(t);
  await alertProviderBalances([
    { ...lowRow, status: 'anomaly', balanceUsd: 4.99 },
    { ...lowRow, provider: 'openrouter', autoTopUp: true },
  ], io);
  assert.equal(io.messages.length, 1);
  assert.match(io.messages[0], /kimi \$4.99/);
  assert.match(io.messages[0], /openrouter.*ON.*https:\/\/openrouter.ai\/credits/);
  assert.equal(classifyBalance({ ...lowRow, balanceUsd: 4.99 }), 'low');
  assert.equal(classifyBalance({ ...lowRow, balanceUsd: 5 }), 'ok');
});
test('notify例外・未配信・webhookは送信済みにせずexit 0、再実行でDM', async t => {
  const io = alertFixture(t);
  for (const notify of [async () => { throw new Error('secret'); }, async () => ({ delivered: 'none' }), async () => ({ delivered: 'webhook' })]) {
    assert.equal(await main(['--alert'], { ...io, notify, collect: async () => [lowRow] }), 0);
    assert.equal(existsSync(join(io.home, '.claude', 'provider-balance-alert-state.json')), false);
  }
  await alertProviderBalances([lowRow], io);
  assert.equal(io.messages.length, 1);
});
test('dry-runはfetchで残高取得して通知・履歴・状態ファイルを変更しない', async t => {
  const io = alertFixture(t);
  const lines = [];
  const old = process.env.MOONSHOT_API_KEY;
  process.env.MOONSHOT_API_KEY = 'mock';
  t.after(() => { if (old === undefined) delete process.env.MOONSHOT_API_KEY; else process.env.MOONSHOT_API_KEY = old; });
  let fetches = 0;
  assert.equal(await main(['--alert', '--dry-run'], { ...io, log: text => lines.push(text), fetchImpl: async () => {
    fetches++; return new Response(JSON.stringify({ data: { available_balance: 0 } }));
  } }), 0);
  assert.ok(fetches > 0);
  assert.match(lines.join('\n'), /残高注意: kimi \$0.00/);
  assert.equal(io.messages.length, 0);
  assert.equal(existsSync(join(io.home, '.claude')), false);
  await alertProviderBalances([lowRow], io);
  const file = join(io.home, '.claude', 'provider-balance-alert-state.json');
  const before = readFileSync(file, 'utf8');
  await alertProviderBalances([{ ...lowRow, status: 'ok', balanceUsd: 20 }], { ...io, dryRun: true });
  assert.equal(readFileSync(file, 'utf8'), before);
});
test('同時起動で二重通知しない、JST日付で翌日通知する', async t => {
  const io = alertFixture(t);
  await Promise.all([alertProviderBalances([lowRow], io), alertProviderBalances([lowRow], io)]);
  assert.equal(io.messages.length, 1);
  await alertProviderBalances([lowRow], { ...io, now: new Date('2026-10-09T15:00:00Z') });
  assert.equal(io.messages.length, 2);
});
test('不正引数はAPIを呼ばずexit 2', async () => {
  for (const argv of [['--typo'], ['--dry-run']]) assert.equal(await main(argv, { collect: () => assert.fail('must not fetch') }), 2);
});
test('APIのnull残高は$0として誤通知しない', async () => {
  const row = await fetchProviderBalance({ provider: 'kimi', key: 'mock', url: 'x', fetchImpl: async () => new Response('{"data":{"available_balance":null}}') });
  assert.equal(row.balanceUsd, null);
});
