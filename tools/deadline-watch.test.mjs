import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluate, effectiveDue, formatDigest, syncCalendar, hasSentReply, manualOperation, runWatch, main, parseArgs, vehicleRows } from './deadline-watch.mjs';
import { DEFAULT_CONFIG } from './deadline-ledger.mjs';
const config = { ...DEFAULT_CONFIG, sheetId: 'test', vehicleSheetId: '', calendar: { enabled: false } };
const base = { id: 'D-001', title: '回答', due: '2026-11-06', kind: '回答・返信', status: '未着手', assignee: 'kim' };
function homeFor(t) { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deadline-watch-')); t.after(() => fs.rmSync(home, { recursive: true, force: true })); return home; }

test('段階、担当、対応中、延期、完了を正しく判定', () => {
  assert.equal(evaluate(base, '2026-11-04', config).stage, false);
  assert.equal(evaluate({ ...base, kind: '訴訟・法務' }, '2026-11-04', config).stage, true);
  assert.equal(evaluate({ ...base, kind: '訴訟・法務', status: '対応中' }, '2026-11-04', config).stage, false);
  assert.equal(evaluate({ ...base, kind: '支払', assignee: '経理' }, '2026-10-30', config).kim, false);
  assert.equal(evaluate({ ...base, assignee: '経理' }, '2026-11-03', config).kim, true);
  assert.equal(evaluate({ ...base, status: '完了' }, '2026-11-07', config).stage, false);
  assert.equal(evaluate(base, '2026-11-07', config).stage, true);
  assert.equal(effectiveDue({ ...base, status: '延期', notes: '延期先: 2026-11-20' }), '2026-11-20');
  assert.equal(effectiveDue({ ...base, status: '延期', notes: '不明' }), null);
  assert.throws(() => parseArgs(['--defer','D-001','--until','2026-02-30']));
  assert.throws(() => parseArgs(['--fixture','x']));
});

test('Calendar: 通常の追加・完了行のDELETE', async () => {
  const calls = [], state = {};
  const calendarConfig = { ...config, calendar: { enabled: true, calendarId: 'kim@orgiast.jp' } };
  const request = async (url, options) => { calls.push([url, options]); return options.method ? {} : { items: [] }; };
  await syncCalendar(base, { config: calendarConfig, state, request });
  const body = calls.at(-1)[1].body;
  assert.deepEqual(body.start, { date: '2026-11-06' }); assert.deepEqual(body.end, { date: '2026-11-07' });
  assert.equal(body.extendedProperties.private.deadlineId, base.id);
  assert.deepEqual(body.reminders.overrides.map(x => x.minutes), [10080,1440]);
  assert.match(calls[0][0], /privateExtendedProperty=deadlineId%3AD|privateExtendedProperty=deadlineId%3D/);
  // 完了行の DELETE
  const closedCalls = [];
  await syncCalendar({ ...base, status: '完了' }, { config: calendarConfig, state: {}, request: async (u,o) => { closedCalls.push(o); return { items: [{ id: 'old' }] }; } });
  assert.equal(closedCalls.at(-1).method, 'DELETE');
});

test('Calendar: 403でstate.calendarSync=falseになり後続はスキップ', async () => {
  const state = {}; let saved = 0, logs = 0;
  const persist = () => saved++;
  const log = () => logs++;
  const calendarConfig = { ...config, calendar: { enabled: true, calendarId: 'kim@orgiast.jp' } };
  const failReq = async () => { throw Object.assign(Error('scope'), { status: 403 }); };
  // 1回目: 403 → calendarSync=false
  await syncCalendar(base, { config: calendarConfig, state, request: failReq, persist, log });
  assert.equal(state.calendarSync, false);
  assert.equal(saved, 1);
  assert.equal(logs, 1);
  // 2回目: calendarSync=false なので即スキップ（persist/log 増えない）
  const saved2 = saved, logs2 = logs;
  await syncCalendar(base, { config: calendarConfig, state, request: failReq, persist, log });
  assert.equal(saved, saved2);
  assert.equal(logs, logs2);
});

test('Calendar: disabledなら即return', async () => {
  const state = {};
  const calendarConfig = { ...config, calendar: { enabled: false } };
  const neverCalled = async () => { throw Error('should not be called'); };
  await syncCalendar(base, { config: calendarConfig, state, request: neverCalled });
  assert.deepEqual(state, {});
});

test('同スレッドの検出後SENTのみ完了証拠とする', async () => {
  const row = { ...base, source: 'Gmail', detectedAt: '2026-11-04T10:00:00Z', notes: '{"mailbox":"kim@orgiast.jp","threadId":"thread"}\n延期先: 2026-11-20' };
  assert.ok(await hasSentReply(row, async () => ({ messages: [{ labelIds: ['SENT'], internalDate: Date.parse('2026-11-05') }] })));
  assert.equal(await hasSentReply(row, async () => ({ messages: [{ labelIds: ['INBOX'], internalDate: Date.parse('2026-11-05') }, { labelIds: ['SENT'], internalDate: Date.parse('2026-11-01') }] })), false);
});

test('手動操作は更新後にinboxを閉じ、期限未確認の候補は承認しない', async t => {
  const rows = [{ ...base }], candidates = [{ ...base, id: 'D-002', title: '別の候補', rowNumber: 2, status: '候補' }, { ...base, id: 'D-003', rowNumber: 3, status: '候補', due: null }];
  const operations = [];
  const ledger = { read: async tab => tab === '候補' ? candidates : rows, append: async items => rows.push(...items), patch: async (id, changes, tab) => { operations.push('patch'); Object.assign((tab === '候補' ? candidates : rows).find(r => r.id === id), changes); } };
  const args = { ledger, home: homeFor(t), today: '2026-11-04', config, notify: async () => operations.push('close') };
  await manualOperation({ ...args, operation: 'defer', id: 'D-001', until: '2026-11-20' });
  assert.equal(effectiveDue(rows[0]), '2026-11-20'); assert.deepEqual(operations, ['patch','close']);
  const result = await manualOperation({ ...args, operation: 'approve', id: '全部' });
  assert.equal(result[1].skipped, '期限未確認'); assert.equal(rows.length, 2); assert.equal(rows[1].status, '未着手');
  await manualOperation({ ...args, operation: 'done', id: 'D-001' }); assert.equal(rows[0].completedAt, '2026-11-04');
});

test('支払完了を自動反映、車検は読取のみ、同日再実行は再通知を数えない', async t => {
  const home = homeFor(t), calls = [], changes = [];
  const rows = [{ ...base, due: '2026-11-05', kind: '支払', completedAt: '2026-11-04' }, { ...base, id: 'V01', readOnly: true, due: '2026-10-27', kind: '車検' }, { ...base, id: 'D-002', due: '2026-11-05', lastNotified: '2026-11-04' }];
  const result = await runWatch({ home, config, rows, today: '2026-11-04', ledger: { patch: async (id, change) => changes.push({ id, change }) }, request: async () => assert.fail('network'), notify: async a => calls.push(a), state: {} });
  assert.equal(result.errors.length, 0); assert.equal(result.decisions[0].status, '完了');
  assert.ok(calls.find(x => x.row.id === 'D-001').close);
  assert.equal(result.decisions.find(x => x.id === 'D-002').notify, false);
  assert.ok(changes.every(x => x.id !== 'V01'));
});

test('fixture dry-runはネットワーク、ローカル書込、heartbeatを呼ばない', async t => {
  const home = homeFor(t), output = [];
  const code = await main(['--dry-run','--now','2026-11-04','--fixture','tools/fixtures/deadline/ledger.json'], { home, stdout: x => output.push(x), request: async () => assert.fail('network'), heartbeat: async () => assert.fail('heartbeat'), notify: async () => assert.fail('notify') });
  assert.equal(code, 0); assert.deepEqual(fs.readdirSync(home), []);
  const result = JSON.parse(output[0]); assert.equal(result.errors.length, 0);
  assert.deepEqual(result.decisions.filter(x => x.notify).map(x => x.id), ['D-001','D-002','D-004','D-006','V01']);
  assert.match(formatDigest([base], '2026-11-04', config), /担当 kim/);
});

test('旧seedのメッセージIDからスレッドを取得して返信完了を照合', async () => {
  const calls=[];
  assert.equal(await hasSentReply({...base,source:'Gmail',detectedAt:'2026-11-03',notes:'{"mailbox":"seisaku-team@orgiast.jp","messageId":"mail-one"}\n確認メモ'},async url=>{
    calls.push(url); return url.includes('/messages/') ? {threadId:'actual-thread'} : {messages:[{labelIds:['SENT'],internalDate:Date.parse('2026-11-04')}]};
  }),true);
  assert.match(calls[1],/threads\/actual-thread/);
});

test('Gmailの完了照合に失敗しても期限通知を届け、失敗として記録する', async t => {
  const row = { ...base, due: '2026-11-05', source: 'Gmail', detectedAt: '2026-11-03', notes: '{"mailbox":"kim@orgiast.jp","threadId":"thread"}' };
  const changes = [], notices = [];
  const result = await runWatch({ home: homeFor(t), config, rows: [row], today: '2026-11-04',
    ledger: { patch: async (id, change) => changes.push(change) },
    request: async () => { throw Error('Gmail unavailable'); }, notify: async args => notices.push(args), state: {} });
  assert.equal(result.decisions[0]?.notify, true);
  assert.equal(result.decisions[0]?.status, '未着手');
  assert.equal(notices.length, 1); assert.ok(!notices[0].close);
  assert.ok(changes.some(change => change.notifyCount === 1));
  assert.ok(changes.every(change => change.status !== '完了'));
  assert.deepEqual(result.errors, [{ id: row.id, phase: 'auto-close', error: 'Gmail unavailable' }]);
});

test('不存在のfixtureで本番の読取へfallbackしない', async t => {
  const home=homeFor(t), errors=[];
  assert.equal(await main(['--dry-run','--fixture',path.join(home,'missing.json')],{home,config,stderr:e=>errors.push(e),sheets:{get:()=>assert.fail('live read')}}),1);
  assert.match(errors[0],/fixture/); assert.deepEqual(fs.readdirSync(home),[]);
});

test('鍵なし席はseat checkでスキップされる（注入seatCheck）', async t => {
  const home=homeFor(t), output=[], heartbeats=[];
  const code = await main(['--now','2026-11-04'], { home, stdout: x => output.push(x), skipSeatCheck: false, seatCheck: () => ({ kim: false }), sheets: { get: () => assert.fail('no network') }, request: () => assert.fail('no network'), heartbeat: async (info) => heartbeats.push(info), notify: () => assert.fail('no notify') });
  assert.equal(code, 0);
  const result = JSON.parse(output[0]);
  assert.equal(result.skip, true);
  assert.equal(result.reason, '鍵なし席のためスキップ');
  assert.equal(heartbeats.length, 1);
  assert.equal(heartbeats[0].ok, true);
  assert.match(heartbeats[0].summary, /スキップ/);
});

test('例外時はheartbeatがok=falseでsummaryに期限追跡エラーを含む', async t => {
  const home=homeFor(t), output=[], heartbeats=[];
  const code = await main(['--now','2026-11-04'], { home, stdout: x => output.push(x), skipSeatCheck: false, seatCheck: () => ({ kim: true }), config: { sheetId: 'test' }, sheets: { get: () => { throw Error('シート読取失敗'); } }, request: () => assert.fail('no network'), heartbeat: async (info) => heartbeats.push(info), notify: () => assert.fail('no notify') });
  assert.equal(code, 1);
  assert.equal(heartbeats.length, 1);
  assert.equal(heartbeats[0].ok, false);
  assert.match(heartbeats[0].summary, /期限追跡エラー/);
  assert.doesNotMatch(heartbeats[0].summary, /スキップ/);
});

test('鍵持ちのkim席はfixtureモードで通常動作（fixtureはseat checkをスキップ）', async t => {
  const home=homeFor(t), output=[];
  const code = await main(['--dry-run','--now','2026-11-04','--fixture','tools/fixtures/deadline/ledger.json'], { home, stdout: x => output.push(x), skipSeatCheck: false, request: async () => assert.fail('network'), heartbeat: async () => assert.fail('heartbeat'), notify: async () => assert.fail('notify') });
  assert.equal(code, 0);
  const result = JSON.parse(output[0]);
  assert.equal(result.skip, undefined);
  assert.deepEqual(result.decisions.filter(x => x.notify).map(x => x.id), ['D-001','D-002','D-004','D-006','V01']);
});
