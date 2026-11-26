import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWatch, syncCalendar, buildInboxOp, queueSheetWrite, runInboxBatch } from '../tools/deadline-watch.mjs';
import { batchDeadlineOps } from '../tools/kim-inbox.mjs';
import { DEFAULT_CONFIG, HEADERS, createLedger } from '../tools/deadline-ledger.mjs';
import { main as inboxWorkerMain } from '../tools/lib/deadline-inbox-worker.mjs';

const homeFor = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deadline-batch-'));
const config = { ...DEFAULT_CONFIG, sheetId: 'mock', vehicleSheetId: '', calendar: { enabled: false } };
const row = (id, extra = {}) => ({
  id, title: 'test', kind: 'その他', assignee: 'kim', status: '未着手', due: '2026-11-27',
  rowNumber: Number(String(id).replace(/\D/g, '')) || 2, header: HEADERS, notifyCount: 0, ...extra,
});

test('Sheets remainingDays/lastNotified は1回の batchPatch にまとまる', async () => {
  const home = homeFor();
  const batches = [];
  const inboxCalls = [];
  const result = await runWatch({
    home, config, today: '2026-11-27', dryRun: false, state: {},
    rows: [row('D-1'), row('D-2', { rowNumber: 3 })],
    ledger: {
      read: async () => [row('D-1'), row('D-2', { rowNumber: 3 })],
      patch: async () => assert.fail('per-row patch should not run'),
      batchPatch: async entries => { batches.push(entries); return entries; },
    },
    sheets: {}, request: async () => assert.fail('http'),
    readInbox: async () => [],
    inboxBatch: async ops => {
      inboxCalls.push(ops);
      return ops.map(op => ({ key: op.key, ok: true, markNotified: !!op.markNotified, readOnly: false, notifyCount: op.notifyCount || 0 }));
    },
  });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
  assert.ok(batches[0].every(e => 'remainingDays' in e.changes && 'lastNotified' in e.changes));
  assert.equal(inboxCalls.length, 1);
  assert.equal(inboxCalls[0].length, 2);
  assert.equal(result.errors.length, 0);
});

test('watchdog 中断時も溜めた Sheets 書き込みを flush する', async () => {
  const home = homeFor();
  const batches = [];
  let seen = 0;
  await runWatch({
    home, config, today: '2026-11-27', dryRun: false, state: {},
    rows: [row('D-1'), row('D-2', { rowNumber: 3 }), row('D-3', { rowNumber: 4 })],
    runtime: {
      signal: {
        aborted: false,
        throwIfAborted() {
          seen++;
          if (seen > 2) {
            this.aborted = true;
            throw Object.assign(new Error('overall watchdog'), { code: 'DEADLINE_TIMEOUT', name: 'AbortError' });
          }
        },
      },
      step: async (_n, fn) => fn(),
      inboxMs: 1000,
    },
    ledger: {
      patch: async () => assert.fail('per-row'),
      batchPatch: async entries => { batches.push(entries.map(e => e.id)); return entries; },
    },
    sheets: {}, request: async () => ({}),
    readInbox: async () => [],
    inboxBatch: async () => [],
  }).catch(() => {});
  assert.ok(batches.length >= 1);
  assert.ok(batches[0].includes('D-1'));
});

test('kim-inbox batch は1ロックで処理し、使用中は最大3回再試行する', async () => {
  const home = homeFor();
  fs.mkdirSync(path.join(home, '.claude', 'kim-inbox'), { recursive: true });
  // Live PID so tryReclaimLock will not treat the lock as stale.
  const lock = path.join(home, '.claude', 'kim-inbox', 'info-aggregation.lock');
  fs.writeFileSync(lock, String(process.pid));
  const sleeps = [];
  const ops = [
    buildInboxOp({ row: row('D-10'), decision: { due: '2026-11-27', remainingDays: 0 }, config, markNotified: true }),
  ];
  const results = batchDeadlineOps(home, ops, {
    attempts: 3, backoffMs: 1,
    sleep: ms => {
      sleeps.push(ms);
      if (sleeps.length === 2) fs.unlinkSync(lock);
    },
  });
  assert.equal(sleeps.length, 2);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].markNotified, true);

  const busyHome = homeFor();
  fs.mkdirSync(path.join(busyHome, '.claude', 'kim-inbox'), { recursive: true });
  fs.writeFileSync(path.join(busyHome, '.claude', 'kim-inbox', 'info-aggregation.lock'), String(process.pid));
  const failed = batchDeadlineOps(busyHome, ops, { attempts: 3, backoffMs: 1, sleep: () => {} });
  assert.equal(failed[0].ok, false);
  assert.match(failed[0].error, /使用中/);
  assert.equal(failed[0].markNotified, false);
});

test('inbox worker batch と runInboxBatch が一括結果を返す', async () => {
  const home = homeFor();
  fs.mkdirSync(path.join(home, '.claude', 'kim-inbox'), { recursive: true });
  const ops = [
    buildInboxOp({ row: row('D-20'), decision: { due: '2026-12-01', remainingDays: 4 }, config, markNotified: true }),
    buildInboxOp({ row: row('D-21'), config, close: true }),
  ];
  const file = path.join(home, 'ops.json');
  fs.writeFileSync(file, JSON.stringify(ops));
  const fromWorker = inboxWorkerMain(['batch', file], home);
  assert.equal(fromWorker.length, 2);
  assert.equal(fromWorker[0].ok, true);
  assert.equal(fromWorker[1].ok, true);

  const fromRun = await runInboxBatch(ops, {
    home,
    batchImpl: async items => items.map(op => ({ key: op.key, ok: true, markNotified: !!op.markNotified })),
  });
  assert.equal(fromRun.length, 2);
});

test('使用中で失敗した通知は lastNotified を書かない', async () => {
  const batches = [];
  await runWatch({
    home: homeFor(), config, today: '2026-11-27', dryRun: false, state: {},
    rows: [row('D-1'), row('D-2', { rowNumber: 3 })],
    ledger: {
      patch: async () => assert.fail('per-row'),
      batchPatch: async entries => { batches.push(entries); return entries; },
    },
    sheets: {}, request: async () => ({}),
    readInbox: async () => [],
    inboxBatch: async ops => ops.map((op, i) => i === 0
      ? { key: op.key, ok: false, error: 'kim-inbox: 台帳が使用中です', markNotified: false }
      : { key: op.key, ok: true, markNotified: true, readOnly: false, notifyCount: 0 }),
  });
  assert.equal(batches.length, 1);
  const byId = Object.fromEntries(batches[0].map(e => [e.id, e.changes]));
  assert.equal(byId['D-1'].remainingDays, 0);
  assert.equal('lastNotified' in byId['D-1'], false);
  assert.equal(byId['D-2'].lastNotified, '2026-11-27');
});

test('Calendar: 日付・タイトル同一なら GET 後に PATCH/POST しない', async () => {
  const methods = [];
  const due = '2026-11-27';
  const base = { id: 'D-1', title: '提出物確認', kind: '提出', assignee: 'kim', status: '未着手', due, company: 'テスト商事', action: '提出' };
  const calendarConfig = { ...config, sheetId: 'ledger-1', calendar: { enabled: true, calendarId: 'kim@orgiast.jp', kimCalendarId: 'kim@orgiast.jp' } };
  const { readableEvent } = await import('../tools/lib/deadline-calendar.mjs');
  const label = readableEvent(base, calendarConfig, []);
  assert.ok(label);
  await syncCalendar(base, {
    config: calendarConfig, state: {},
    request: async (url, options = {}) => {
      methods.push(options.method || 'GET');
      if (!options.method || options.method === 'GET') {
        return { items: [{
          id: 'evt1', summary: label.summary, start: { date: due },
          extendedProperties: { private: { deadlineId: 'D-1', deadlineSheetId: 'ledger-1' } },
        }] };
      }
      assert.fail(`unexpected write ${options.method}`);
    },
  });
  assert.ok(methods.every(m => m === 'GET'));
  assert.equal(methods.length, 1);
});

test('queueSheetWrite は同一IDの変更をマージする', () => {
  const pending = new Map();
  queueSheetWrite(pending, row('D-1'), { remainingDays: 3 });
  queueSheetWrite(pending, row('D-1'), { lastNotified: '2026-11-27' });
  assert.deepEqual(pending.get('D-1').changes, { remainingDays: 3, lastNotified: '2026-11-27' });
});

test('createLedger.batchPatch は values.batchUpdate 1回', async () => {
  const batches = [];
  const sheets = {
    get: async () => [HEADERS, ['D-001', 'a', 'その他', '', '2026-11-27', '', '未着手', 'kim', '', '', '', '', '', '', '0', '', ''], ['D-002', 'b', 'その他', '', '2026-11-28', '', '未着手', 'kim', '', '', '', '', '', '', '0', '', '']],
    batchUpdate: async (id, data) => batches.push([id, data]),
    update: async () => assert.fail('update'),
  };
  const ledger = createLedger({ config: { sheetId: 's1' }, sheets });
  await ledger.batchPatch([
    { id: 'D-001', changes: { remainingDays: 1 } },
    { id: 'D-002', changes: { remainingDays: 2, lastNotified: '2026-11-27' } },
  ]);
  assert.equal(batches.length, 1);
  assert.ok(batches[0][1].length >= 3);
});
