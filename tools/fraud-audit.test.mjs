/** Offline rule boundaries, JST conversion and read-only CLI contract tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runChecks, parseEnv, fetchSnapshot, renderReport, main } from './fraud-audit.mjs';

const DAY = 86_400_000;
const base = { id: 'd1', deal_no: 'D-001', customer_id: 'customer-12345', status: '商談中', sales_owner: '担当A', created_at: '2026-10-05T03:00:00Z', updated_at: '2026-10-05T03:00:00Z' };
const rules = (rule, overrides = {}) => runChecks([{ ...base, ...overrides }], []).filter((finding) => finding.rule === rule);
const plus = (date, ms) => new Date(Date.parse(date) + ms).toISOString();

test('won-amount-edited: strictly beyond 30 days; won_at also qualifies non-won status', () => {
  const won_at = '2026-09-01T12:00:00+09:00';
  for (const offset of [-1, 0, 1]) {
    const found = rules('won-amount-edited', { won_at, updated_at: plus(won_at, 30 * DAY + offset) });
    assert.equal(found.length, offset > 0 ? 1 : 0);
    if (found.length) assert.match(found[0].detail, /won_at=.*updated_at=.*差日数=/);
  }
  assert.equal(rules('won-amount-edited', { status: '受注', won_at, updated_at: plus(won_at, 31 * DAY) })[0].severity, 'medium');
  for (const invalid of [null, '', 'invalid']) {
    assert.equal(rules('won-amount-edited', { status: '受注', won_at: invalid }).length, 0);
    assert.equal(rules('won-amount-edited', { won_at, updated_at: invalid }).length, 0);
  }
  assert.equal(rules('won-amount-edited', { won_at, updated_at: plus(won_at, -DAY) }).length, 0);
});

test('profit-mismatch: numeric strings and both sides of strict 1.0pp boundary', () => {
  for (const [rate, count] of [['30.000', 0], ['30.999', 0], ['31', 0], ['31.001', 1], ['29', 0], ['28.999', 1]]) {
    const found = rules('profit-mismatch', { sales_amount: '1000000', profit_amount: '300000', profit_rate: rate });
    assert.equal(found.length, count, rate);
    if (count) {
      assert.equal(found[0].severity, 'high');
      assert.match(found[0].detail, /実算値=30\.000000%, 記録値=/);
    }
  }
});

test('profit-mismatch: missing/invalid numbers skip; zero profit is set', () => {
  for (const field of ['sales_amount', 'profit_amount', 'profit_rate']) {
    for (const value of [null, undefined, '', '  ', 'NaN', 'bad', 'Infinity', false]) {
      assert.equal(rules('profit-mismatch', { sales_amount: '100', profit_amount: '30', profit_rate: '50', [field]: value }).length, 0);
    }
  }
  for (const sales_amount of ['0', '-1']) assert.equal(rules('profit-mismatch', { sales_amount, profit_amount: '30', profit_rate: '50' }).length, 0);
  assert.equal(rules('profit-mismatch', { sales_amount: '100', profit_amount: '0', profit_rate: '2' }).length, 1);
});

test('won-but-archived: won only, self archive requires matching nonblank owner', () => {
  const archived_at = '2026-10-01T00:00:00Z';
  const found = rules('won-but-archived', { status: '受注', archived_at, archived_by: base.sales_owner });
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'high');
  assert.match(found[0].detail, /自己アーカイブ/);
  assert.doesNotMatch(rules('won-but-archived', { status: '受注', archived_at, archived_by: '別担当' })[0].detail, /自己アーカイブ/);
  assert.doesNotMatch(rules('won-but-archived', { status: '受注', archived_at, archived_by: null, sales_owner: null })[0].detail, /自己アーカイブ/);
  assert.equal(rules('won-but-archived', { archived_at }).length, 0);
  for (const empty of [null, '', ' ']) assert.equal(rules('won-but-archived', { status: '受注', archived_at: empty }).length, 0);
});

test('won-no-owner: null, empty and whitespace, won status required', () => {
  for (const sales_owner of [null, undefined, '', '  ']) {
    assert.equal(rules('won-no-owner', { status: '受注', sales_owner })[0].severity, 'medium');
    assert.equal(rules('won-no-owner', { sales_owner }).length, 0);
  }
  assert.equal(rules('won-no-owner', { status: '受注' }).length, 0);
});

function duplicatePair(overrides = {}, offset = 7 * DAY) {
  return [{ ...base, sales_amount: '1000000' }, { ...base, id: 'd2', deal_no: 'D-002', sales_amount: 1000000, created_at: plus(base.created_at, offset), ...overrides }];
}
test('duplicate-deal: inclusive 7-day boundary, unordered input and pair detail', () => {
  for (const offset of [-1, 0, 1]) {
    const found = runChecks(duplicatePair({}, 7 * DAY + offset).reverse(), []).filter((f) => f.rule === 'duplicate-deal');
    assert.equal(found.length, offset <= 0 ? 1 : 0);
    if (found.length) {
      assert.equal(found[0].severity, 'medium');
      assert.match(found[0].detail, /D-001 \/ D-002/);
    }
  }
});

test('duplicate-deal: different customer/amount, nonpositive/missing amounts and invalid dates excluded', () => {
  for (const change of [{ customer_id: 'other' }, { customer_id: null }, { sales_amount: '999999' }, { sales_amount: '0' }, { sales_amount: '-1' }, { sales_amount: '' }, { sales_amount: 'bad' }, { created_at: '' }, { created_at: 'invalid' }]) {
    assert.equal(runChecks(duplicatePair(change), []).filter((f) => f.rule === 'duplicate-deal').length, 0);
  }
  const missing = duplicatePair().map((deal) => ({ ...deal, customer_id: null }));
  assert.equal(runChecks(missing, []).filter((f) => f.rule === 'duplicate-deal').length, 0);
});

test('duplicate-deal: three close deals produce three unique pairs without mutating inputs', () => {
  const deals = [...duplicatePair({}, DAY), { ...base, id: 'd3', deal_no: 'D-003', sales_amount: '1000000' }];
  const before = structuredClone(deals);
  assert.equal(runChecks(deals, []).filter((f) => f.rule === 'duplicate-deal').length, 3);
  assert.deepEqual(deals, before);
});

test('big-discount: inclusive 40% boundary, numeric strings, won and positive amounts required', () => {
  for (const [sales_amount, count] of [['600.01', 0], ['600', 1], ['599.99', 1]]) {
    const found = rules('big-discount', { status: '受注', estimate_amount: '1000', sales_amount });
    assert.equal(found.length, count);
    if (count) assert.equal(found[0].severity, 'info');
  }
  for (const change of [{ status: '商談中' }, { estimate_amount: '0' }, { estimate_amount: '-1' }, { estimate_amount: '' }, { sales_amount: '0' }, { sales_amount: '-1' }, { sales_amount: 'NaN' }]) {
    assert.equal(rules('big-discount', { status: '受注', estimate_amount: '1000', sales_amount: '500', ...change }).length, 0);
  }
});

test('after-hours-update: JST 22:00/05:00 boundaries from UTC, independent of host timezone', () => {
  for (const [updated_at, count] of [
    ['2026-10-05T12:30:00Z', 0], // Monday JST 21:30
    ['2026-10-05T12:59:59Z', 0],
    ['2026-10-05T13:00:00Z', 1], // JST 22:00
    ['2026-10-05T15:30:00Z', 1], // Tuesday JST 00:30
    ['2026-10-05T19:59:59Z', 1],
    ['2026-10-05T20:00:00Z', 0], // JST 05:00
    ['2026-10-06T05:00:00+09:00', 0],
  ]) {
    const found = rules('after-hours-update', { updated_at });
    assert.equal(found.length, count, updated_at);
    if (count) assert.equal(found[0].severity, 'info');
  }
  assert.match(rules('after-hours-update', { updated_at: '2026-10-05T15:30:00Z' })[0].detail, /2026-10-06T00:30:00\.000\+09:00/);
});

test('after-hours-update: JST Sunday daytime and UTC Sunday that is JST Monday', () => {
  assert.match(rules('after-hours-update', { updated_at: '2026-10-04T03:00:00Z' })[0].detail, /日曜日/);
  assert.equal(rules('after-hours-update', { updated_at: '2026-10-04T21:00:00Z' }).length, 0);
  assert.equal(rules('after-hours-update', { updated_at: '2026-10-03T03:00:00Z' }).length, 0);
  for (const updated_at of [null, '', 'invalid']) assert.equal(rules('after-hours-update', { updated_at }).length, 0);
});

test('customer lookup and first eight characters fallback', () => {
  const deal = { ...base, status: '受注', sales_owner: '' };
  assert.equal(runChecks([deal], [{ id: base.customer_id, company_name: '顧客会社' }])[0].customer, '顧客会社');
  assert.equal(runChecks([deal], [])[0].customer, 'customer');
  assert.deepEqual(runChecks([], []), []);
});

test('dotenv: CRLF, comments, quotes, export prefix, BOM and no interpolation', () => {
  const parsed = parseEnv('\uFEFF# comment\r\n A = unquoted # comment\r\nexport B="quoted#value" # tail\r\nC=\'literal $A\'\r\nD=\n');
  assert.deepEqual({ ...parsed }, { A: 'unquoted', B: 'quoted#value', C: 'literal $A', D: '' });
  assert.throws(() => parseEnv('A="unterminated'), /引用符/);
});

// Deliberately synthetic credentials; these are never real API secrets.
const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://audit-fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fixture-only-key' };
const ok = (rows) => ({ ok: true, status: 200, text: async () => JSON.stringify(rows) });
test('fetchSnapshot: only specified GET requests, columns, limits and auth headers', async () => {
  const requests = [];
  const snapshot = await fetchSnapshot(env, async (url, options) => {
    requests.push({ url: new URL(url), options });
    return ok(requests.length === 1 ? [base] : []);
  });
  assert.equal(requests.length, 2);
  for (const { url, options } of requests) {
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.apikey, env.SUPABASE_SERVICE_ROLE_KEY);
    assert.equal(options.headers.Authorization, `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
    assert.equal(url.searchParams.get('limit'), '10000');
  }
  assert.equal(requests[0].url.pathname, '/rest/v1/deals');
  assert.equal(requests[0].url.searchParams.get('order'), 'updated_at.desc');
  assert.equal(requests[0].url.searchParams.get('select'), 'id,deal_no,customer_id,deal_title,status,progress,sales_owner,estimate_amount,sales_amount,profit_amount,profit_rate,won_at,lost_at,archived_at,archived_by,archived_reason,created_at,updated_at');
  assert.equal(requests[1].url.pathname, '/rest/v1/customers');
  assert.equal(requests[1].url.searchParams.get('select'), 'id,company_name');
  assert.deepEqual(snapshot.deals, [base]);
  assert.ok(Number.isFinite(Date.parse(snapshot.fetchedAt)));
});

test('fetch failures: HTTP status/body preserved, credentials redacted, network errors sanitized', async () => {
  await assert.rejects(fetchSnapshot(env, async () => ({ ok: false, status: 403, text: async () => `denied ${env.NEXT_PUBLIC_SUPABASE_URL} ${env.SUPABASE_SERVICE_ROLE_KEY}` })), (error) => {
    assert.match(error.message, /HTTP 403\ndenied/);
    assert.ok(!error.message.includes(env.NEXT_PUBLIC_SUPABASE_URL));
    assert.ok(!error.message.includes(env.SUPABASE_SERVICE_ROLE_KEY));
    return true;
  });
  await assert.rejects(fetchSnapshot(env, async () => { throw new Error(env.SUPABASE_SERVICE_ROLE_KEY); }), /GET に失敗/);
  await assert.rejects(fetchSnapshot(env, async () => ok({ message: 'not rows' })), /JSON 配列/);
  await assert.rejects(fetchSnapshot({}, async () => assert.fail('must not fetch')), /環境変数/);
});

test('report: severities, full counts, minimum filter, escaped cells and empty sections', () => {
  const found = runChecks([{ ...base, status: '受注', archived_at: base.updated_at, sales_owner: '', updated_at: '2026-10-05T15:30:00Z' }], [{ id: base.customer_id, company_name: '会社|名\n<script>' }]);
  const report = renderReport(found, { mode: 'snapshot', dealCount: 1, minSeverity: 'medium', generatedAt: '2026-10-09T00:00:00Z' });
  assert.match(report, /high 1 \/ medium 1 \/ info 1/);
  assert.match(report, /## high/);
  assert.match(report, /## medium/);
  assert.doesNotMatch(report, /## info/);
  assert.match(report, /会社&#124;名<br>&lt;script&gt;/);
  assert.equal((renderReport([], { mode: 'fetch', dealCount: 0 }).match(/該当なし/g) || []).length, 3);
});

async function fixture(t, snapshot = { fetchedAt: '2026-10-09T00:00:00Z', deals: [base], customers: [] }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fraud-audit-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input.json');
  await fs.writeFile(input, JSON.stringify(snapshot));
  let output = '';
  let errors = '';
  return { dir, input, io: { fetchImpl: async () => assert.fail('snapshot must not fetch'), stdout: (text) => { output += text; }, stderr: (text) => { errors += text; } }, output: () => output, errors: () => errors };
}

test('snapshot CLI: real process exit codes 0/2, stdout and --out, no network', async (t) => {
  const f = await fixture(t, { fetchedAt: base.created_at, deals: [{ ...base, status: '受注', archived_at: base.updated_at }], customers: [] });
  assert.equal(await main(['--snapshot', f.input], f.io), 0);
  assert.match(f.output(), /モード: snapshot \/ 対象案件数: 1/);
  const out = path.join(f.dir, 'report.md');
  assert.equal(await main(['--snapshot', f.input, '--out', out, '--fail-on-high', '--min-severity', 'high'], f.io), 2);
  assert.doesNotMatch(await fs.readFile(out, 'utf8'), /## medium/);
  for (const [extra, code] of [[[], 0], [['--fail-on-high'], 2]]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./fraud-audit.mjs', import.meta.url)), '--snapshot', f.input, ...extra], { encoding: 'utf8' });
    assert.equal(result.status, code, result.stderr);
  }
});

test('snapshot CLI: fail-on-high stays zero when only medium findings exist', async (t) => {
  const f = await fixture(t, { fetchedAt: base.created_at, deals: [{ ...base, status: '受注', sales_owner: '' }], customers: [] });
  assert.equal(await main(['--snapshot', f.input, '--fail-on-high'], f.io), 0);
});

test('CLI validates arguments, snapshot schema and file paths; returns 1', async (t) => {
  const f = await fixture(t);
  for (const args of [[], ['--snapshot'], ['--snapshot', f.input, '--env-file', 'x'], ['--snapshot', f.input, '--json', 'x'], ['--snapshot', f.input, '--min-severity', 'low'], ['--snapshot', f.input, '--unknown'], ['--snapshot', f.input, '--out', f.input], ['--snapshot', f.input, '--snapshot', f.input]]) {
    assert.equal(await main(args, f.io), 1);
  }
  for (const content of ['{broken', '{}', '{"fetchedAt":"invalid","deals":[],"customers":[]}', '{"fetchedAt":"2026-10-09","deals":[null],"customers":[]}']) {
    await fs.writeFile(f.input, content);
    assert.equal(await main(['--snapshot', f.input], f.io), 1);
  }
  assert.equal(await main(['--snapshot', path.join(f.dir, 'absent.json')], f.io), 1);
});

test('fetch CLI: snapshot round trip, report output, no secret output even if API echoes it', async (t) => {
  const f = await fixture(t);
  const envFile = path.join(f.dir, '.env');
  await fs.writeFile(envFile, Object.entries(env).map(([key, value]) => `${key}="${value}"`).join('\n'));
  const json = path.join(f.dir, 'snapshot.json');
  const out = path.join(f.dir, 'report.md');
  const io = { ...f.io, fetchImpl: async (url) => ok(url.includes('/deals?') ? [{ ...base, status: '受注', archived_at: base.updated_at, sales_owner: env.SUPABASE_SERVICE_ROLE_KEY }] : [{ id: base.customer_id, company_name: env.NEXT_PUBLIC_SUPABASE_URL }]) };
  assert.equal(await main(['--env-file', envFile, '--json', json, '--out', out], io), 0);
  assert.equal(f.output(), '');
  const report = await fs.readFile(out, 'utf8');
  const snapshot = await fs.readFile(json, 'utf8');
  assert.match(report, /モード: fetch/);
  for (const value of Object.values(env)) {
    assert.ok(!report.includes(value));
    assert.ok(!snapshot.includes(value));
  }
  assert.equal(JSON.parse(snapshot).deals.length, 1);
  assert.equal(await main(['--snapshot', json, '--fail-on-high'], f.io), 2);
  assert.equal(await main(['--env-file', envFile], { ...io, fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'service unavailable' }) }), 1);
  assert.match(f.errors(), /HTTP 500\nservice unavailable/);
  assert.equal(await main(['--env-file', envFile, '--out', out, '--json', out], io), 1);
});
