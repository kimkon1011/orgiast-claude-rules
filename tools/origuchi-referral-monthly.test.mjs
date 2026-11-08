import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shouldRunMonthly, matchesTaxInclusive, parseProjects, uninvoicedProjects, planUpdates, buildEmail, buildDm, fetchDeals, runMonthly } from './origuchi-referral-monthly.mjs';
import { createSheetsClient } from './lib/sheets-dwd.mjs';
const now = new Date('2026-10-20T15:00:00Z');
const projectRows = [['状況'], ['納品完了', '株式会社例', '展示会', 'quote1', 100000, '', '', 10000, '', '', '', '', '', '', '', '', 200000], ['確定', '進行社', '制作', 'quote2', 999, '', '', '', '', '', '', '', '', '', '', '', 300000]];
const projects = parseProjects(projectRows);
const header = ['見積書URL', '請求書', '請求書金額', '支払日', 'メモ'];
const records = [header, ['quote1', 'invoice', 10000, '未払', '株式会社例']];
const deal = { id: 1, type: 'expense', partner_id: 117417637, amount: 11000, payments: [{ date: '2026-10-01', amount: 11000 }], receipts: [{ id: 123 }] };
test('JST month boundary, catch-up after day one, force', () => {
  assert.equal(shouldRunMonthly({ now, marker: { lastSentMonth: '2026-10' } }), false);
  assert.equal(shouldRunMonthly({ now, marker: { lastSentMonth: '2026-09' } }), true);
  assert.equal(shouldRunMonthly({ now: '2026-09-30T15:00:00Z', marker: { lastSentMonth: '2026-09' } }), true);
  assert.equal(shouldRunMonthly({ now, marker: { lastSentMonth: '2026-10' }, force: true }), true);
});
test('tax match rounds and rejects missing or invalid amounts', () => {
  assert.ok(matchesTaxInclusive('10,005円', 11006));
  assert.ok(matchesTaxInclusive('274,378（税込301,816）', 301816));
  assert.equal(matchesTaxInclusive('429,814（税込472,795／3件分）', 472795), false);
  for (const net of ['', undefined, 'abc', 0, -1]) assert.equal(matchesTaxInclusive(net, 0), false);
  assert.equal(matchesTaxInclusive(10000, 10000), false);
});
test('missing invoices and safe external email use R for pipeline', () => {
  assert.equal(uninvoicedProjects(projects, [header]).length, 1);
  const mail = buildEmail(projects, [header], now);
  for (const text of ['展示会', '10,000円', 'keiri2@orgiast.jp', '300,000円', '株式会社オージャスト 金 功勇']) assert.ok(mail.body.includes(text));
  assert.doesNotMatch(mail.body, /未払|freee|999円/);
  assert.equal(uninvoicedProjects(projects, records).length, 0);
});
test('updates B/D only for unique fully paid invoice and adds missing row', () => {
  const plan = planUpdates(projects, records, [deal], now);
  assert.equal(plan.updates[0].paid, '2026-10-01');
  assert.equal(plan.updates[0].url, 'https://secure.freee.co.jp/receipts/123');
  assert.equal(plan.additions.length, 0);
  const missing = planUpdates(projects, [header], [], now);
  assert.deepEqual(missing.additions[0], ['quote1', 'ご請求書未受領（2026/10/21 時点）', '', '', '株式会社例']);
});
test('ambiguity, partial payments, missing evidence and unpaid remain review only', () => {
  for (const deals of [[], [deal, { ...deal, id: 2 }], [{ ...deal, payments: [] }], [{ ...deal, payments: [{ date: '2026-10-01', amount: 5000 }] }], [{ ...deal, receipts: [] }]]) {
    const p = planUpdates(projects, records, deals, now);
    assert.equal(p.updates.length, 0); assert.equal(p.review.length, 1);
  }
  assert.equal(planUpdates(projects, [...records, ['quote2', 'invoice2', 10000, '未払']], [deal], now).updates.length, 0);
});
test('DM contains account link, updates and internal review', () => {
  const body = buildDm(planUpdates(projects, records, [], now));
  assert.match(body, /authuser=kim@orgiast.jp#drafts/); assert.match(body, /kim@orgiast.jp で開く/); assert.match(body, /freee 未登録/);
});
test('freee paginates all history with fetch stub and rejects HTTP failure', async () => {
  const calls = [];
  const deals = await fetchDeals({ getToken: async () => 'stub', fetchImpl: async url => {
    calls.push(new URL(url)); return { ok: true, json: async () => ({ deals: calls.length === 1 ? Array.from({ length: 100 }, () => deal) : [deal] }) };
  } });
  assert.equal(deals.length, 101); assert.equal(calls[1].searchParams.get('offset'), '100');
  assert.equal(calls[0].searchParams.has('start_issue_date'), false);
  await assert.rejects(fetchDeals({ getToken: async () => 'stub', fetchImpl: async () => ({ ok: false, status: 503 }) }), /503/);
});
test('Sheets update uses RAW PUT with DWD kim', async () => {
  let request;
  const client = createSheetsClient({ getToken: async opts => { assert.equal(opts.impersonate, 'kim@orgiast.jp'); return 'stub'; }, fetchImpl: async (url, opts) => { request = { url, ...opts }; return { ok: true, json: async () => ({}) }; } });
  await client.update('id', "'紹介料支払記録'!D2", [['2026-10-01']]);
  assert.match(request.url, /valueInputOption=RAW/); assert.equal(request.method, 'PUT');
});
function harness(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'origuchi-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let rows = records.map(r => [...r]); const calls = [];
  const deps = {
    sheets: { get: async (_id, range) => range.includes('B2:R') ? projectRows : rows,
      update: async (_id, range, values) => { calls.push(range); const m = /!([BD])(\d+)$/.exec(range); assert.ok(m); rows[Number(m[2]) - 1][m[1] === 'B' ? 1 : 3] = values[0][0]; },
      append: async () => { throw new Error('unexpected append'); } },
    fetchDeals: async () => [deal], createDraft: async opts => { calls.push('draft'); assert.equal(opts.user, 'kim@orgiast.jp'); return { id: 'draft1' }; },
    deleteDraft: async () => { calls.push('delete draft'); },
    sendDm: async (_target, body) => { calls.push(body); },
  };
  return { home, calls, deps };
}
test('dry run has no writes, draft, DM or marker even if force', async t => {
  const h = harness(t); const result = await runMonthly({ home: h.home, dryRun: true, force: true, now }, h.deps);
  assert.ok(result.email.body.includes('展示会')); assert.deepEqual(h.calls, []); assert.deepEqual(fs.readdirSync(h.home), []);
});
test('live writes only payment record then draft, DM, once per month', async t => {
  const h = harness(t); await runMonthly({ home: h.home, now }, h.deps);
  assert.deepEqual(h.calls.slice(0, 3), ["'紹介料支払記録'!B2", "'紹介料支払記録'!D2", 'draft']);
  assert.equal((await runMonthly({ home: h.home, now }, h.deps)).skipped, true);
});
test('read failure sends stage DM and never creates a draft', async t => {
  const h = harness(t); h.deps.fetchDeals = async () => { throw new Error('HTTP 503'); };
  await assert.rejects(runMonthly({ home: h.home, now }, h.deps), /freee 読み取り/);
  assert.equal(h.calls.length, 1); assert.match(h.calls[0], /HTTP 503/);
});
test('DM failure deletes newly created draft and leaves month incomplete', async t => {
  const h = harness(t); const send = h.deps.sendDm; h.deps.sendDm = async () => { throw new Error('offline'); };
  await assert.rejects(runMonthly({ home: h.home, now }, h.deps), /Discord DM/);
  assert.ok(h.calls.includes('delete draft'));
  const marker = JSON.parse(fs.readFileSync(path.join(h.home, '.claude/origuchi-referral-monthly.json')));
  assert.equal(marker.lastSentMonth, undefined); assert.equal(marker.pending, undefined);
});
test('ambiguous Gmail failure blocks duplicate creation on retry', async t => {
  const h = harness(t); let attempts = 0;
  h.deps.createDraft = async () => { attempts++; throw new Error('timeout'); };
  await assert.rejects(runMonthly({ home: h.home, now }, h.deps), /timeout/);
  await assert.rejects(runMonthly({ home: h.home, now }, h.deps), /下書き作成結果が不明/);
  assert.equal(attempts, 1);
});

test('G deposit date excludes only approaches at 90 JST calendar days, including serial dates', () => {
  const rows = [['状況']];
  const add = (customer, date, status = 'アプローチリスト') => rows.push([status, customer, '案件', customer, 100, date, '2000/01/01']);
  add('89日前社', '2026/7/24');
  add('90日前社', '2026-07-23');
  add('91日前社', '2026/07/22');
  const serial = (Date.UTC(2026, 6, 23) - Date.UTC(1899, 11, 30)) / 86400000;
  add('90日前シリアル社', serial + 0.75);
  add('89日前シリアル社', serial + 1);
  add('空欄社', '');
  add('不正日付社', '2026/02/30');
  add('不明社', '未定');
  add('未来社', '2027/01/01');
  add('古い確定社', '2000/01/01', '確定');
  add('古い納品完了社', '2000/01/01', '納品完了');
  const parsed = parseProjects(rows);
  assert.equal(parsed[0].depositDate, '2026/7/24');
  const { body } = buildEmail(parsed, [header], now);
  for (const name of ['89日前社', '89日前シリアル社', '空欄社', '不正日付社', '不明社', '未来社', '古い確定社', '古い納品完了社']) assert.ok(body.includes(name), name);
  for (const name of ['90日前社', '91日前社', '90日前シリアル社']) assert.ok(!body.includes(name), name);
  assert.match(body, /アプローチリスト：6件/);
  // One second before JST midnight, the 90-day row is still only 89 days old.
  assert.ok(buildEmail(parsed, [header], new Date(now.getTime() - 1000)).body.includes('90日前社'));
});

test('monthly dry run lists excluded count and companies at end of DM', async t => {
  const h = harness(t);
  const get = h.deps.sheets.get;
  h.deps.sheets.get = async (id, range) => range.includes('B2:R') ? [...projectRows,
    ['アプローチリスト', '残す社', '最近', 'recent', 1, '2026/07/24'],
    ['アプローチリスト', '除外A社', '古いA', 'old-a', 1, '2026/07/23'],
    ['アプローチリスト', '除外B社', '古いB', 'old-b', 1, '2026/07/22'],
  ] : get(id, range);
  const result = await runMonthly({ home: h.home, dryRun: true, now }, h.deps);
  assert.match(result.email.body, /残す社/);
  assert.doesNotMatch(result.email.body, /除外A社|除外B社/);
  assert.match(result.dm, /メールから外した古いアプローチ案件：2件\n・除外A社／古いA\n・除外B社／古いB$/);
  assert.deepEqual(h.calls, []);
});

test('DM reports zero excluded approaches', () => {
  assert.match(buildDm(planUpdates(projects, records, [], now)), /メールから外した古いアプローチ案件：0件\nなし$/);
});
