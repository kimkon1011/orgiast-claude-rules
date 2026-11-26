import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, syncCalendar, inboxBatch } from '../tools/deadline-watch.mjs';
import { DEFAULT_CONFIG, HEADERS, serializeRow } from '../tools/deadline-ledger.mjs';
import { applyDeadlineBatch, listItems } from '../tools/kim-inbox.mjs';
import { retryBatch } from '../tools/lib/deadline-inbox-worker.mjs';

const config = { ...DEFAULT_CONFIG, sheetId: 'mock', vehicleSheetId: '', calendar: { enabled: false } };
const row = id => ({ id, title: 'test', kind: 'その他', assignee: 'kim', status: '未着手', due: '2026-11-27' });
const homeFor = t => { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deadline-batch-test-')); t.after(() => fs.rmSync(home, { recursive: true, force: true })); return home; };
test('production path: one Sheets read/write and one inbox batch; failed delivery remains retryable', async t => {
  const reads = [], writes = [], batches = [];
  const code = await main(['--now', '2026-11-27'], {
    home: homeFor(t), config, skipSeatCheck: true, stdout: () => {}, stderr: () => {}, heartbeat: async () => {},
    request: async () => assert.fail('unexpected HTTP'), readInbox: async () => [],
    sheets: { get: async (...args) => { reads.push(args); return [HEADERS, ...['D-1','D-2'].map(id => serializeRow(row(id)))]; },
      batchUpdate: async (...args) => writes.push(args) },
    notifyBatch: async ({ actions }) => { batches.push(actions); return [{ ok: true }, { ok: false, error: '台帳が使用中です' }]; },
  });
  assert.equal(code, 1);
  assert.equal(reads.length, 1); assert.equal(writes.length, 1); assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
  const cells = writes[0][1];
  assert.equal(cells.length, 4);
  assert.ok(cells.some(x => x.range.endsWith('N2')));
  assert.ok(!cells.some(x => x.range.endsWith('N3')));
});
test('batch locks retry three times and only retry lock contention', async () => {
  let calls = 0; const waits = [];
  const result = await retryBatch('', [], { apply: () => { if (++calls < 4) throw Error('台帳が使用中です'); return ['ok']; }, sleep: async ms => waits.push(ms) });
  assert.deepEqual(result, ['ok']); assert.deepEqual(waits, [100,200,400]);
  calls = 0;
  await assert.rejects(retryBatch('', [], { apply: () => { calls++; throw Error('台帳が使用中です'); }, sleep: async () => {} }), /使用中/);
  assert.equal(calls, 4);
});
test('local batch adds, updates and closes without duplicate records', t => {
  const home = homeFor(t);
  const results = applyDeadlineBatch(home, [{key:'D-1',text:'first'}, {key:'D-1',text:'second'}, {key:'D-2',text:'other'}, {key:'D-2',close:true}]);
  assert.ok(results.every(r => r.ok));
  const items = listItems(home);
  assert.equal(items.length, 2);
  assert.equal(items.find(i => i.key === 'D-1').text, 'second');
  assert.equal(items.find(i => i.key === 'D-2').status, 'seen');
});
test('watchdog flushes queued cells with independent bounded signal', async t => {
  const writes = [];
  const code = await main(['--now','2026-11-27'], {
    home: homeFor(t), config, skipSeatCheck: true, stdout: () => {}, stderr: () => {}, heartbeat: async () => {},
    timeouts: { totalMs: 150, httpMs: 1000, inboxMs: 1000 },
    request: async () => assert.fail('unexpected HTTP'), readInbox: async () => [],
    sheets: { get: async () => [HEADERS, serializeRow(row('D-1'))], batchUpdate: async (...args) => writes.push(args) },
    notifyBatch: async () => new Promise(() => {}),
  });
  assert.equal(code, 2); assert.equal(writes.length, 1);
  assert.deepEqual(writes[0][1].map(x => x.range), ["'期限台帳'!F2"]);
});
test('unchanged calendar event uses a single GET after reconciliation', async () => {
  const cfg = { ...config, calendar: { enabled: true } }, state = {};
  const r = { ...row('D-1'), company: 'テスト会社', assignee: 'Claude' };
  let event, calls = [];
  const request = async (url, options) => {
    calls.push([url, options.method]);
    if (options.method === 'POST') { event = options.body; return event; }
    if (url.includes('?')) return { items: [] };
    return event;
  };
  await syncCalendar(r, { config: cfg, state, request });
  assert.ok(event); calls = [];
  await syncCalendar({ ...r, remainingDays: 0 }, { config: cfg, state, request });
  assert.equal(calls.length, 1); assert.equal(calls[0][1], undefined);
});

test('worker receives all actions in one child invocation', async t => {
  const home = homeFor(t);
  const result = await inboxBatch({ home, actions: [
    { row: row('D-1'), close: false, decision: { due: '2026-11-27', remainingDays: 0 }, config },
    { row: row('D-2'), close: true, config },
  ] });
  assert.deepEqual(result, [{ok:true}, {ok:true}]);
  assert.equal(listItems(home).filter(i => i.kind === 'deadline').length, 1);
});
