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

test('Calendar: 403直後の2回目はリクエストを出さない（バックオフ）、until過去で再試行、成功で復帰', async () => {
  const calls = [], state = {}; let saved = 0, logs = 0;
  const persist = () => saved++;
  const log = () => logs++;
  const calendarConfig = { ...config, calendar: { enabled: true, calendarId: 'kim@orgiast.jp' } };
  const request = async (url, options) => { calls.push([url, options]); return options.method ? {} : { items: [] }; };
  // 通常の追加
  await syncCalendar(base, { config: calendarConfig, state, request, persist, log });
  const body = calls.at(-1)[1].body;
  assert.deepEqual(body.start, { date: '2026-11-06' }); assert.deepEqual(body.end, { date: '2026-11-07' });
  assert.equal(body.extendedProperties.private.deadlineId, base.id);
  assert.deepEqual(body.reminders.overrides.map(x => x.minutes), [10080,1440]);
  assert.match(calls[0][0], /privateExtendedProperty=deadlineId%3AD|privateExtendedProperty=deadlineId%3D/);
  // 1回目: 403 → until が未来に設定される
  saved = 0; logs = 0;
  const failReq = async () => { throw Object.assign(Error('scope'), { status: 403 }); };
  await syncCalendar(base, { config: calendarConfig, state, request: failReq, persist, log });
  const c0 = saved; const l0 = logs;
  assert.equal(state.calendar403.count, 1);
  assert.ok(state.calendar403.until > Date.now());
  // 2回目: until が未来なのでリクエストを出さない（公式1: スキップ、saved/logs 増えない）
  await syncCalendar(base, { config: calendarConfig, state, request: failReq, persist, log });
  assert.equal(saved, c0); assert.equal(logs, l0);
  assert.equal(state.calendar403.count, 1); // count も増えない
  // 3回目: until を過去に巻き戻して呼ぶ → 再試行する（公式2）
  state.calendar403.until = 0;
  const callCountBefore = calls.length;
  await syncCalendar(base, { config: calendarConfig, state, request: failReq, persist, log });
  assert.equal(state.calendar403.count, 2);
  assert.equal(state.calendar403.until > Date.now(), true);
  // 4回目: 再び until を過去に巻き戻し成功させる → calendar403 が消える（公式3: 自動復帰）
  state.calendar403.until = 0;
  state.calendar403.count = 2;
  delete state.calendar403.notified;
  await syncCalendar(base, { config: calendarConfig, state, request, persist, log });
  assert.equal(state.calendar403, undefined, '成功時に calendar403 が削除される');
  // 完了行の DELETE は従来通り
  const closedCalls = [];
  await syncCalendar({ ...base, status: '完了' }, { config: calendarConfig, state: {}, request: async (u,o) => { closedCalls.push(o); return { items: [{ id: 'old' }] }; } });
  assert.equal(closedCalls.at(-1).method, 'DELETE');
});

test('Calendar: 3回連続403でnotifyKimがちょうど1回、4回目は呼ばれない', async () => {
  const state = {}; const notifyCalls = [];
  const failReq = async () => { throw Object.assign(Error('scope'), { status: 403 }); };
  const notifyKim = async home => { notifyCalls.push(home); };
  const calendarConfig = { ...config, calendar: { enabled: true, calendarId: 'kim@orgiast.jp' } };
  // 1回目（count 1）
  await syncCalendar(base, { config: calendarConfig, state, request: failReq, persist: () => {}, log: () => {}, notifyKim });
  assert.equal(notifyCalls.length, 0);
  // 2回目（count 2）
  state.calendar403.until = 0;
  await syncCalendar(base, { config: calendarConfig, state, request: failReq, persist: () => {}, log: () => {}, notifyKim });
  assert.equal(notifyCalls.length, 0);
  // 3回目（count 3）→ notifyKim が初めて呼ばれる
  state.calendar403.until = 0;
  await syncCalendar(base, { config: calendarConfig, state, request: failReq, persist: () => {}, log: () => {}, notifyKim });
  assert.equal(notifyCalls.length, 1);
  assert.equal(state.calendar403.notified, true);
  // 4回目（count 4、notified 済み）→ notifyKim は呼ばれない（公式4）
  state.calendar403.until = 0;
  await syncCalendar(base, { config: calendarConfig, state, request: failReq, persist: () => {}, log: () => {}, notifyKim });
  assert.equal(notifyCalls.length, 1);
});

test('Calendar: 旧形式 state.calendarSync=false を後方互換で calendar403 に変換', async () => {
  const state = { calendarSync: false }; let saved = 0;
  const persist = () => saved++;
  const calendarConfig = { ...config, calendar: { enabled: true, calendarId: 'kim@orgiast.jp' } };
  await syncCalendar(base, { config: calendarConfig, state, request: async () => { throw Object.assign(Error('no call'), { status: 403 }); }, persist, log: () => {} });
  assert.equal(state.calendarSync, undefined, '旧フラグが削除される');
  assert.ok(state.calendar403, 'calendar403 が作成される');
  assert.equal(state.calendar403.count, 3);
  assert.ok(state.calendar403.until > Date.now());
  assert.equal(state.calendar403.notified, false);
  // 変換直後は until が未来なのでリクエストを出さない
  const reqCalls = [];
  await syncCalendar(base, { config: calendarConfig, state, request: async (u, o) => reqCalls.push(o), persist, log: () => {} });
  assert.equal(reqCalls.length, 0, 'until 未来のためスキップ');
  // until を過去に巻き戻すと再試行される（公式5）
  state.calendar403.until = 0;
  await syncCalendar(base, { config: calendarConfig, state, request: async () => { throw Object.assign(Error('scope'), { status: 403 }); }, persist, log: () => {} });
  assert.equal(state.calendar403.count, 4);
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

test('鍵なし席はseat checkでスキップされる', async t => {
  const home=homeFor(t), output=[], heartbeats=[];
  fs.writeFileSync(path.join(home,'.claude.json'), JSON.stringify({oauthAccount:{emailAddress:'seisaku-team@orgiast.jp'}}));
  const code = await main(['--now','2026-11-04'], { home, stdout: x => output.push(x), skipSeatCheck: false, sheets: { get: () => assert.fail('no network') }, request: () => assert.fail('no network'), heartbeat: async (info) => heartbeats.push(info), notify: () => assert.fail('no notify') });
  assert.equal(code, 0);
  const result = JSON.parse(output[0]);
  assert.equal(result.skip, true);
  assert.match(result.reason, /DWD key/);
  assert.equal(heartbeats.length, 1);
  assert.match(heartbeats[0].summary, /スキップ/);
});

test('鍵持ちのkim席はfixtureモードで通常動作（fixtureはseat checkをスキップ）', async t => {
  const home=homeFor(t), output=[];
  const code = await main(['--dry-run','--now','2026-11-04','--fixture','tools/fixtures/deadline/ledger.json'], { home, stdout: x => output.push(x), skipSeatCheck: false, request: async () => assert.fail('network'), heartbeat: async () => assert.fail('heartbeat'), notify: async () => assert.fail('notify') });
  assert.equal(code, 0);
  const result = JSON.parse(output[0]);
  assert.equal(result.skip, undefined);
  assert.deepEqual(result.decisions.filter(x => x.notify).map(x => x.id), ['D-001','D-002','D-004','D-006','V01']);
});
