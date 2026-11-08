import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileCosts, run, serviceForVendor } from './ai-cost-unify.mjs';
import { aggregateExecutor, collectLocalUsage, monthWindow, normalizeProvider } from './ai-usage-local.mjs';
import { COST_PER_MILLION } from './llm-fallback.mjs';
import { collectClaudeStats, collectCodexUsage, resetParseCacheForTests } from './usage-stats.mjs';
import { jstMonthKey } from './cost-monthly-report.mjs';
const now = new Date('2026-10-05T00:00:00Z');
const vendor = (name, amount) => ({ vendor: name, monthly: { '2026-09': amount }, payers: [{ name: 'kim', count: 1 }] });
const freee = { currency: 'JPY', period: { start: '2026-09-01', end: '2026-09-30' }, vendors: [vendor('GROQ', 100), vendor('MISTRAL', 50)] };
const local = { jpyPerUsd: 155, months: { '2026-09': { GROQ: { jpy: 90 }, DEEPSEEK: { jpy: 10 }, ANTHROPIC: { jpy: null } } } };
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cost-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
test('full outer join, fixed null, service mapping, and pending selection', () => {
  const result = reconcileCosts(freee, local, { now });
  const by = Object.fromEntries(result.summary.rows.map((r) => [r.service, r]));
  assert.equal(by.Groq.state, '両方にあり'); assert.equal(by.Groq.difference, 10); assert.equal(by.Groq.payerName, 'kim');
  assert.equal(by.Mistral.state, '実測に無い'); assert.equal(by.Mistral.difference, '');
  assert.equal(by.DeepSeek.state, 'freeeに無い（要確認）');
  assert.equal(by.ANTHROPIC.billing, '定額'); assert.equal(by.ANTHROPIC.localJpy, null); assert.equal(by.ANTHROPIC.difference, '');
  assert.notEqual(by.ANTHROPIC.state, '判定不能');
  assert.deepEqual(result.pending.rows.map((r) => r.service).sort(), ['ANTHROPIC', 'DeepSeek']);
  assert(result.pending.rows.every((r) => r.description === `AI利用料 ${r.service} ${r.month}`));
  assert.equal(result.pending.months.length, 13);
  assert.equal(serviceForVendor('ANTHROPIC'), 'ANTHROPIC');
  assert.equal(serviceForVendor('MOONSHOT'), serviceForVendor('KIMI'));
});
test('freee plus fixed usage is both present with empty difference; unknown is not free', () => {
  const result = reconcileCosts({ ...freee, vendors: [vendor('OPENAI', 3000)] }, { jpyPerUsd: 150, months: { '2026-09': { OPENAI: { jpy: null }, GLM: { jpy: null, billing: '判定不能' } } } }, { now });
  const openai = result.summary.rows.find((r) => r.service.includes('OpenAI'));
  assert.equal(openai.state, '両方にあり'); assert.equal(openai.billing, '定額'); assert.equal(openai.difference, '');
  assert.equal(result.summary.rows.find((r) => r.service === 'GLM').state, '判定不能');
  assert.equal(result.pending.rows.length, 0);
});
test('merged aliases sum once and ambiguous payers stay omitted; months include empty replacement', () => {
  const f = { ...freee, vendors: [vendor('OPENAI', 5), { ...vendor('OPENAI_CHATGPT', 6), payers: [{ name: 'other' }] }] };
  const result = reconcileCosts(f, { months: {}, jpyPerUsd: 150 }, { now, months: 2 });
  assert.equal(result.summary.rows.length, 1); assert.equal(result.summary.rows[0].freeeJpy, 11);
  assert(!Object.hasOwn(result.summary.rows[0], 'payerName'));
  assert.deepEqual(result.pending.months, ['2026-09','2026-10']); assert.deepEqual(result.pending.rows, []);
  assert.throws(() => monthWindow(0), /正の整数/);
  assert.throws(() => reconcileCosts({ ...freee, currency: 'USD' }, local), /JPY/);
});
test('executor reuses pricing, JST boundary, FX evidence, unknown and fixed never become zero', () => {
  const r = (provider, t, extra = {}) => ({ provider, t, in: 1000000, out: 1000000, ...extra });
  const rows = [r('groq', '2026-08-31T14:59:59Z'), r('groq', '2026-08-31T15:00:00Z'), r('glm', '2026-09-01'), r('codex', '2026-09-01'), r('gemini', '2026-09-01', { usd: 2, searches: 3 }), r('grok','2026-09-01'), r('groq','broken')];
  const months = aggregateExecutor(rows, { jpyPerUsd: 155, now });
  assert.equal(months['2026-08'].GROQ.calls, 1);
  assert.equal(months['2026-09'].GROQ.jpy, (COST_PER_MILLION.groq[0] + COST_PER_MILLION.groq[1]) * 155);
  assert.equal(months['2026-09'].GLM.jpy, null); assert.equal(months['2026-09'].OPENAI.jpy, null);
  assert.equal(months['2026-09'].GEMINI.jpy, 310); assert.equal(months['2026-09'].GEMINI.searches, 3);
  assert(months['2026-09'].XAI); assert.equal(normalizeProvider('z-ai'), 'GLM');
  const usage = collectLocalUsage({ now, jpyPerUsd: 155, ledger: () => rows, claude: () => ({ months: { '2026-09': { outputTokens: 123, calls: 1 } } }), codex: () => ({ months: {} }) });
  assert.equal(usage.jpyPerUsd, 155); assert.equal(usage.months['2026-09'].ANTHROPIC.outTok, 123); assert.equal(usage.months['2026-09'].ANTHROPIC.jpy, null);
});
test('real Claude/Codex collectors split sessions by event month and deduplicate cumulative tokens', (t) => {
  const home = fixture(t), cdir = path.join(home, '.claude/projects/p'), xdir = path.join(home, '.codex/sessions');
  fs.mkdirSync(cdir, { recursive: true }); fs.mkdirSync(xdir, { recursive: true });
  const old = process.env.CODEX_SESSIONS_DIRS; process.env.CODEX_SESSIONS_DIRS = xdir;
  t.after(() => { if (old === undefined) delete process.env.CODEX_SESSIONS_DIRS; else process.env.CODEX_SESSIONS_DIRS = old; resetParseCacheForTests(); });
  const timestamps = ['2026-08-31T14:59:59Z','2026-08-31T15:00:00Z','2026-08-31T15:01:00Z','2026-11-01T00:00:00Z'];
  fs.writeFileSync(path.join(cdir, 'session.jsonl'), timestamps.map((timestamp, i) => JSON.stringify({ timestamp, message: { id: `m${i === 2 ? 1 : i}`, model: 'claude-sonnet', usage: { output_tokens: [10,20,20,99][i] }, content: [] } })).join('\n'));
  fs.writeFileSync(path.join(xdir, 'session.jsonl'), timestamps.map((timestamp, i) => JSON.stringify({ timestamp, payload: { info: { total_token_usage: { output_tokens: [10,30,30,100][i] } } } })).join('\n'));
  resetParseCacheForTests();
  const options = { home, now: +now, days: 100, monthKey: jstMonthKey };
  for (const collect of [collectClaudeStats, collectCodexUsage]) {
    const stats = collect(options);
    assert.equal(stats.months['2026-08'].outputTokens, 10); assert.equal(stats.months['2026-09'].outputTokens, 20); assert(!stats.months['2026-11']);
  }
});
function cliFixture(t) {
  const home = fixture(t); fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.invalid/ledger\nFLEET_SHEET_TOKEN=test-token\n');
  const f = path.join(home, 'freee.json'), l = path.join(home, 'local.json'); fs.writeFileSync(f, JSON.stringify(freee)); fs.writeFileSync(l, JSON.stringify(local));
  const requests = [], output = [], io = { log: (s) => output.push(s), error: (s) => output.push(s) };
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://example.invalid/ledger'); const body = JSON.parse(options.body); requests.push(body);
    return { ok: true, status: 200, text: async () => JSON.stringify(body.kind === 'ai-cost-describe' ? { ok: true, tabs: { AI費用サマリ: { headers: [], rowCount: 0 }, freee登録待ち: { headers: [], rowCount: 0 } } } : { ok: true }) };
  };
  return { args: ['--freee',f,'--local',l], deps: { home, now, io, fetchImpl }, requests, output };
}
test('dry run performs real injected describe only; normal run sends summary then pending', async (t) => {
  const x = cliFixture(t);
  assert.equal(await run([...x.args, '--dry-run'], x.deps), 0);
  assert.deepEqual(x.requests.map((r) => r.kind), ['ai-cost-describe']);
  assert(x.output.some((s) => s.includes('155 JPY')));
  x.requests.length = 0;
  assert.equal(await run([...x.args, '--force'], x.deps), 0);
  assert.deepEqual(x.requests.map((r) => r.kind), ['ai-cost-describe','ai-cost-summary','ai-cost-pending']);
  assert.equal(x.requests[1].force, true);
});
test('failed describe aborts even dry-run, failed summary prevents pending; missing config skips', async (t) => {
  const x = cliFixture(t);
  assert.equal(await run([...x.args,'--dry-run'], { ...x.deps, fetchImpl: async () => { throw new Error('offline'); } }), 1);
  assert(x.output.some((s) => s.includes('offline')));
  const base = x.deps.fetchImpl;
  assert.equal(await run(x.args, { ...x.deps, fetchImpl: async (url, opts) => {
    if (JSON.parse(opts.body).kind === 'ai-cost-summary') return { ok: true, status: 200, text: async () => '{"ok":false,"error":"busy"}' };
    return base(url, opts);
  } }), 1);
  assert(!x.requests.some((r) => r.kind === 'ai-cost-pending'));
  const errors = []; assert.equal(await run([], { home: fixture(t), io: { error: (s) => errors.push(s) }, fetchImpl: () => assert.fail('HTTP forbidden') }), 0); assert.equal(errors.length, 1);
});
