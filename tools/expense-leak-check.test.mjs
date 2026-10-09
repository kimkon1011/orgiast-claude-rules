import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RULES, LIMITS, HEADER, TAB, parseArgs, ruleVerdict, merchantToken, amountVariants, gmailQuery, parseYahoo, weeklySkip, collectTxns, searchEvidence, runCheck, sheetRows, dmText, atomicJson } from './expense-leak-check.mjs';
import { createSheetsClient } from './lib/sheets-dwd.mjs';

const opts = (args = []) => parseArgs(args, { EXPENSE_LEAK_TODAY: '2026-10-09', EXPENSE_LEAK_HOME: '/tmp/expense-test' });
const wallet = { id: 7, type: 'credit_card', name: '金立替／テスト' };
const txn = (id, extra = {}) => ({ id, walletable_id: wallet.id, walletable_type: wallet.type, status: 1, date: '2026-10-01', description: 'テスト商店', amount: 1599, account: wallet.name, ...extra });
const budget = () => ({ gmail: { 'kim@orgiast.jp': 0, 'seisaku-team@orgiast.jp': 0 }, yahoo: 0, yahooUnavailable: false, yahooFailed: false, yahooUnverified: 0 });
const emptySearch = async (script) => ({ code: 0, stdout: script.includes('gmail-search') ? '{"messages":[]}' : '（該当なし）' });
const metadata = { sheets: [{ properties: { title: TAB, gridProperties: { rowCount: 1000 } } }] };
function harness(transactions, overrides = {}) {
  const calls = { searches: 0, notify: 0, append: [], save: [] };
  let written = [];
  const state = overrides.state || { lastRunAt: null, txns: {} };
  const injected = {
    state,
    freeeGet: async (path) => path.endsWith('walletables') ? { walletables: [wallet] } : { wallet_txns: transactions },
    search: async (...args) => { calls.searches++; return emptySearch(...args); },
    sheets: {
      metadata: async () => metadata,
      ensure: async () => metadata.sheets[0].properties,
      get: async (_, range) => range.includes('L2:') ? (overrides.existing || []) : written,
      append: async (_, range, rows) => { calls.append.push(rows); written = rows; return { updates: { updatedRange: `'${TAB}'!A2:M${rows.length + 1}` } }; },
    },
    notify: async (_, options) => { assert.equal(options.webhookFallback, false); calls.notify++; return { delivered: 'dm' }; },
    save: async (path, value) => calls.save.push({ path, value: structuredClone(value) }),
    ...overrides,
  };
  return { injected, calls, state };
}

test('CLI uses JST window, validates dates, and bounds verification to five', () => {
  assert.equal(opts().from, '2026-07-11');
  assert.equal(opts().to, '2026-10-09');
  assert.throws(() => opts(['--from', '2026-02-30']));
  assert.throws(() => opts(['--limit', '0']));
  assert.throws(() => opts(['--verification']));
  assert.equal(opts(['--verification', '--limit', '5']).verification, true);
});
test('private and expense expectations derive from exported RULES', () => {
  for (const rule of RULES.alwaysPrivate) for (const term of rule.terms) for (const amount of rule.amounts || [1599]) {
    assert.equal(ruleVerdict(txn(1, { description: term, amount })), '私用(自動)');
  }
  const specific = RULES.alwaysPrivate.find((r) => r.amounts);
  const unmatched = Math.max(...specific.amounts) + 1;
  assert.equal(ruleVerdict(txn(1, { description: specific.terms[0], amount: unmatched })), null);
  for (const word of RULES.alwaysExpense) assert.equal(ruleVerdict(txn(1, { description: word })), '経費(確認不要)');
  assert.equal(ruleVerdict(txn(1, { description: 'ｱｲﾃﾑ' }), ['アイテム']), '私用(自動)');
  assert.equal(ruleVerdict(txn(1, { description: 'APCO STORE' })), null);
});
test('merchant/amount/date normalization prevents query syntax injection', () => {
  assert.equal(merchantToken('ｱﾏｿﾞﾝﾏｰｹｯﾄ／カード'), 'アマゾン');
  assert.deepEqual(amountVariants(1599), ['1599', '1,599', '¥1,599', '1599円']);
  const q = gmailQuery(txn(1));
  assert.ok(q.includes('"テスト商店"'));
  for (const value of amountVariants(txn(1).amount)) assert.ok(q.includes(`"${value}"`));
  const times = [...q.matchAll(/(?:after|before):(\d+)/g)].map((m) => Number(m[1]));
  assert.equal(times[1] - times[0], 21 * 86400);
});
test('weekly Tuesday skip, Monday run, same-day duplicate and old state', () => {
  assert.equal(weeklySkip('2026-10-13', '2026-10-12T03:00:00+09:00'), true);
  assert.equal(weeklySkip('2026-10-12', '2026-10-09T03:00:00+09:00'), false);
  assert.equal(weeklySkip('2026-10-12', '2026-10-12T03:00:00+09:00'), true);
  assert.equal(weeklySkip('2026-10-13', '2026-10-01T03:00:00+09:00'), false);
  assert.equal(weeklySkip('2026-10-13', null), false);
});
test('paginates 100 + remainder, client-filters status, and verifies absent cached ids', async () => {
  const state = { txns: { '2': { verdict: 'x' }, '999': { verdict: 'x' }, '1000': { verdict: 'x' } } };
  const offsets = [];
  const r = await collectTxns(async (path, params) => {
    if (path.endsWith('walletables')) return { walletables: [wallet, { ...wallet, id: 8, name: '会社口座' }] };
    if (path.endsWith('/999')) return { wallet_txn: { status: 3 } };
    if (path.endsWith('/1000')) return { wallet_txn: { status: 1 } };
    offsets.push(params.offset);
    assert.equal(params.limit, 100);
    assert.equal(params.walletable_type, wallet.type);
    return { wallet_txns: params.offset === 0 ? Array.from({ length: 100 }, (_, i) => txn(i + 1, { status: i === 1 ? 2 : 1 })) : [txn(101, { status: 4 })] };
  }, opts(), state);
  assert.deepEqual(offsets, [0, 100]);
  assert.equal(r.candidates.length, 99);
  assert.deepEqual(r.statusCounts, { 1: 99, 2: 1, 4: 1 });
  assert.deepEqual(Object.keys(state.txns), ['1000']);
});
test('date or account filter mismatch fails instead of leaking other accounts into output', async () => {
  await assert.rejects(() => collectTxns(async (path) => path.endsWith('walletables') ? { walletables: [wallet] } : { wallet_txns: [txn(1, { walletable_id: 999 })] }, opts(), { txns: {} }), /mismatch/);
});
test('Yahoo children are serial and exit 2 disables all later Yahoo queries', async () => {
  let active = 0; let maximum = 0; let yahooCalls = 0;
  const b = budget();
  const search = async (script, args) => {
    assert.ok(!args.includes('--open'));
    active++; maximum = Math.max(maximum, active);
    await new Promise((r) => setTimeout(r, 2));
    active--;
    if (script.includes('yahoo')) { yahooCalls++; return { code: 2, stdout: '' }; }
    return { code: 0, stdout: '{"messages":[]}' };
  };
  for (let i = 0; i < 3; i++) await searchEvidence(txn(i), opts(), b, { search, timeLeft: () => true, timeout: () => 1000 });
  assert.equal(maximum, 1);
  assert.equal(yahooCalls, 1);
  assert.equal(b.yahooUnavailable, true);
  assert.equal(b.gmail['kim@orgiast.jp'], 3);
});
test('Yahoo parser requires date-window, merchant and exact amount', () => {
  const t = txn(1);
  assert.equal(parseYahoo('1. テスト商店 領収書 1,599円 2026/10/02 12:00', t, opts().today).evidence.length, 1);
  assert.equal(parseYahoo('1. テスト商店 領収書 1,599円 2025/10/02 12:00', t, opts().today).evidence.length, 0);
  assert.equal(parseYahoo('1. 別の店舗 領収書 1,599円 2026/10/02 12:00', t, opts().today).evidence.length, 0);
  assert.equal(parseYahoo('1. テスト商店 領収書 11599円 2026/10/02 12:00', t, opts().today).evidence.length, 0);
  assert.equal(parseYahoo('1. テスト商店 領収書 1599円 12:00', t, opts().today).unverified, 1);
});
test('query budgets never exceed exported limits and return deferred', async () => {
  const b = budget();
  b.gmail = Object.fromEntries(Object.keys(b.gmail).map((u) => [u, LIMITS.gmail])); b.yahoo = LIMITS.yahoo;
  const r = await searchEvidence(txn(1), opts(), b, { search: () => assert.fail('budget should prevent search'), timeLeft: () => true, timeout: () => 1 });
  assert.equal(r.deferred, '未検索(上限)');
});
test('dry run does not write state, Sheet or DM', async () => {
  const h = harness([txn(1)]);
  const r = await runCheck(opts(['--dry-run']), h.injected);
  assert.equal(r.results[0].verdict, '不明(要確認)');
  assert.equal(h.calls.notify, 0); assert.equal(h.calls.append.length, 0);
  assert.ok(h.calls.save.every((x) => x.path === opts().out));
});
test('verification writes at most five RAW rows, marks them and caches all ids', async () => {
  const h = harness(Array.from({ length: 6 }, (_, i) => txn(i + 1)));
  const o = opts(['--limit', '5', '--verification']);
  const first = await runCheck(o, h.injected);
  assert.equal(first.failed, undefined);
  assert.equal(first.appended, 5); assert.equal(h.calls.notify, 1);
  assert.ok(h.calls.append[0].every((row) => row.length === HEADER.length && row[12] === '検証(削除可)'));
  const searched = h.calls.searches;
  const second = await runCheck({ ...o, dryRun: true }, h.injected);
  assert.equal(second.cacheHits, 5);
  assert.equal(h.calls.searches, searched);
  assert.equal(h.calls.notify, 1);
});
test('existing Sheet id is never appended again and human status is untouched', async () => {
  const h = harness([txn(1)], { existing: [['1']] });
  const r = await runCheck(opts(), h.injected);
  assert.equal(r.appended, 0);
  assert.equal(h.calls.append.length, 0);
});
test('Gmail outage remains retryable and raw child error is not persisted', async () => {
  const h = harness([txn(1)], { search: async () => ({ code: 1, stdout: 'secret must not be logged' }) });
  const r = await runCheck(opts(), h.injected);
  assert.equal(r.results[0].deferred, true);
  assert.equal(h.state.txns['1'].verdict, undefined);
  assert.equal(r.appended, 0);
  assert.ok(!JSON.stringify(r).includes('secret must'));
});
test('verified Gmail evidence survives Yahoo unavailable and uses account-specific thread link', async () => {
  const h = harness([txn(1)], { search: async (script) => script.includes('yahoo') ? { code: 2, stdout: '' } : { code: 0, stdout: JSON.stringify({ messages: [{ threadId: 'abc', date: '2026-10-01T12:00:00+09:00', subject: '領収書', from: 'shop@example.test' }] }) } });
  const r = await runCheck(opts(['--dry-run']), h.injected);
  assert.equal(r.yahooUnavailable, true);
  assert.equal(r.results[0].verdict, '証跡あり(要申請)');
  assert.equal(r.results[0].evidence[0].link, 'https://mail.google.com/mail/u/kim@orgiast.jp/#all/abc');
  assert.match(dmText(r), /ヤフオク再ログイン/);
});
test('time cutoff checkpoints pending ids without a verdict', async () => {
  let calls = 0;
  const h = harness([txn(1)], { timeLeft: () => ++calls <= 1 });
  const r = await runCheck(opts(['--dry-run']), h.injected);
  assert.equal(r.results[0].verdict, '未検索(時間上限)');
  assert.equal(h.calls.searches, 0);
  assert.ok(h.calls.save.length > 0);
});
test('expense rule still searches both mailboxes; private rule never searches', async () => {
  const privateRule = RULES.alwaysPrivate.find((r) => !r.amounts);
  const h = harness([txn(1, { description: RULES.alwaysExpense[0] }), txn(2, { description: privateRule.terms[0] })]);
  const r = await runCheck(opts(['--dry-run']), h.injected);
  assert.equal(r.results[0].verdict, '経費(確認不要)');
  assert.equal(r.results[1].verdict, '私用(自動)');
  assert.equal(r.searches.gmail['kim@orgiast.jp'], 1);
});
test('Sheet error checkpoints classification for retry without another inbox search', async () => {
  const h = harness([txn(1)]);
  h.injected.sheets.append = async () => { throw new Error('Sheets POST HTTP 503'); };
  const r = await runCheck(opts(), h.injected);
  assert.equal(r.failed, true);
  assert.equal(h.calls.notify, 0);
  assert.equal(h.state.lastRunAt, null);
  assert.equal(h.state.txns['1'].verdict, '不明(要確認)');
});
test('Sheets helper appends RAW and checks existing headers without rewriting', async () => {
  const requests = [];
  const client = createSheetsClient({ getToken: async () => 'fake-token', fetchImpl: async (url, init) => {
    requests.push({ url, init });
    return { ok: true, json: async () => url.includes('fields=') ? metadata : { values: [HEADER] } };
  } });
  await client.ensure('test', TAB, HEADER);
  assert.ok(requests.every((r) => r.init.method === 'GET'));
  await client.append('test', `'${TAB}'!A:M`, [sheetRows([{ ...txn(1), verdict: '不明(要確認)', evidence: [] }], opts().today)[0]]);
  assert.match(requests.at(-1).url, /valueInputOption=RAW/);
});
test('real CLI weekly skip exits 0 without credentials and leaves state unchanged', async () => {
  const home = await mkdtemp(join(tmpdir(), 'expense-weekly-'));
  const env = { ...process.env, EXPENSE_LEAK_HOME: home, EXPENSE_LEAK_TODAY: '2026-10-13' };
  const o = parseArgs(['--weekly'], env);
  const state = { lastRunAt: '2026-10-13T03:00:00+09:00', txns: {} };
  await atomicJson(o.statePath, state);
  const before = await readFile(o.statePath, 'utf8');
  const stdout = execFileSync(process.execPath, [fileURLToPath(new URL('./expense-leak-check.mjs', import.meta.url)), '--weekly'], { env, encoding: 'utf8' });
  assert.equal(stdout.trim(), 'skip: weekly expense-leak-check');
  assert.equal(await readFile(o.statePath, 'utf8'), before);
  await rm(home, { recursive: true });
});

test('new Sheet tab and header are created atomically without shifting frozen rows', async () => {
  let created = false;
  const writes = [];
  const client = createSheetsClient({ getToken: async () => 'fake-token', fetchImpl: async (url, init) => {
    if (init.method === 'POST') {
      const body = JSON.parse(init.body); writes.push(body);
      created = true;
      return { ok: true, json: async () => ({ replies: [{ addSheet: { properties: body.requests[0].addSheet.properties } }, {}] }) };
    }
    return { ok: true, json: async () => url.includes('fields=') ? { sheets: [{ properties: { sheetId: 1, title: '既存' } }] } : { values: created ? [HEADER] : [] } };
  } });
  await client.ensure('test', TAB, HEADER);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].requests.length, 2);
  assert.equal(writes[0].requests[0].addSheet.properties.gridProperties.frozenRowCount, 1);
  assert.equal(writes[0].requests[1].updateCells.start.sheetId, writes[0].requests[0].addSheet.properties.sheetId);
});
