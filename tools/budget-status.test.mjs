import test from 'node:test'; import assert from 'node:assert/strict'; import { calculateBudgetStatus, formatBudgetStatus } from './budget-status.mjs';
const base = { monthlyBudgetJpy: 150000, usdJpy: 150, fixed: [{ name: 'unknown', jpy: null }, { name: 'usd', usd: 10 }, { name: 'cap', jpy: 20000, kind: 'cap' }] };
test('null fixed cost is omitted and reported unfilled', () => { const s = calculateBudgetStatus({ config: base, now: new Date('2026-09-06T00:00:00') }); assert.equal(s.fixedJpy, 1500); assert.deepEqual(s.unfilled, ['unknown']); assert.match(formatBudgetStatus(s), /未記入: unknown/); });
test('usdJpy changes converted fixed cost', () => { const a = calculateBudgetStatus({ config: base, now: new Date('2026-09-06') }), b = calculateBudgetStatus({ config: { ...base, usdJpy: 200 }, now: new Date('2026-09-06') }); assert.equal(a.fixedJpy, 1500); assert.equal(b.fixedJpy, 2000); });

test('Anthropic uses max of admin usage and receipts; other vendors are display-only', () => {
  for (const [usage, paid, expected] of [[10, 25, 25], [40, 25, 40]]) {
    const receipts = { anthropicMtdUsd: paid, otherMtdUsd: 999, byVendor: { anthropic: paid, openai: 999 } };
    const result = calculateBudgetStatus({ config: base, developerPlatform: { available: true, totalUsd: usage, byOrg: { 'オージャスト': { totalUsd: usage } } }, receipts });
    assert.equal(result.variableKnownJpy, expected * 150); assert.deepEqual(result.sources.receipts, receipts);
    assert.match(formatBudgetStatus(result), /領収書\(Gmail・全アカウント\): Anthropic \$25.00 \/ その他 \$999.00/);
    assert.match(formatBudgetStatus(result), /org: オージャスト/);
  }
  assert.equal(calculateBudgetStatus({ config: base, receipts: { anthropicMtdUsd: 25 } }).variableKnownJpy, 3750);
});
test('collection discovers env keys and reads JST current-month receipt ledger', async (t) => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { collectBudgetStatus } = await import('./budget-status.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-budget-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const configFile = path.join(home, 'budget.json'); fs.writeFileSync(configFile, JSON.stringify(base));
  fs.writeFileSync(path.join(home, '.claude', 'cost-monitor.env'), 'ANTHROPIC_ADMIN_KEY=one\nANTHROPIC_ADMIN_KEY_SEISAKU=two\n');
  const rows = [
    { kind: 'receipt', vendor: 'anthropic', date: '2026-09-30T15:00:00Z', amountUsd: 50 },
    { kind: 'receipt', vendor: 'openai', date: '2026-10-01T00:00:00Z', amountUsd: 10 },
    { kind: 'receipt', vendor: 'anthropic', date: '2026-09-30T14:59:59Z', amountUsd: 999 },
    { kind: 'failed_payment', vendor: 'anthropic', date: '2026-10-01T00:00:00Z', amountUsd: 999 },
  ];
  fs.writeFileSync(path.join(home, '.claude', 'ai-receipts.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'));
  const seen = new Set();
  const result = await collectBudgetStatus({ home, configFile, now: new Date('2026-10-01T01:00:00Z'), fetchImpl: async (url, options) => {
    const key = options.headers['x-api-key']; seen.add(key);
    return { ok: true, json: async () => url.endsWith('/me') ? { name: key, id: key } : { data: [] } };
  } });
  assert.deepEqual([...seen], ['one', 'two']);
  assert.deepEqual(result.sources.receipts, { anthropicMtdUsd: 50, otherMtdUsd: 10, byVendor: { anthropic: 50, openai: 10 } });
});
