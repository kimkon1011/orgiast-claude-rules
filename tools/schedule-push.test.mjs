import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_REMIND_MINUTES,
  addEvent,
  cancelEvent,
  duePushes,
  formatPush,
  applyPush,
  tick,
  main,
  emptyLedger,
  ledgerPath,
} from './schedule-push.mjs';

const start = '2026-11-20T13:30:00+09:00';

function event(overrides = {}) {
  return addEvent(emptyLedger(), { title: '古川さんへ電話', at: start, id: 'call-1', ...overrides }).events[0];
}

describe('duePushes', () => {
  it('開始30分より前はまだ出さない', () => {
    assert.deepEqual(duePushes([event()], new Date('2026-11-20T12:59:00+09:00')), []);
  });

  it('開始30分前になったら reminder を出す', () => {
    const due = duePushes([event()], new Date('2026-11-20T13:00:00+09:00'));
    assert.equal(due.length, 1);
    assert.equal(due[0].kind, 'reminder');
    assert.equal(due[0].event.id, 'call-1');
  });

  it('開始直後の猶予内ならまだ出す', () => {
    const due = duePushes([event()], new Date('2026-11-20T13:39:00+09:00'));
    assert.equal(due.length, 1);
    assert.equal(due[0].kind, 'reminder');
  });

  it('猶予を過ぎたら出さない', () => {
    assert.deepEqual(duePushes([event()], new Date('2026-11-20T13:41:00+09:00')), []);
  });

  it('すでに remindedAt がある予定は出さない', () => {
    const row = { ...event(), remindedAt: '2026-11-20T13:00:00.000Z' };
    assert.deepEqual(duePushes([row], new Date('2026-11-20T13:05:00+09:00')), []);
  });

  it('キャンセル済みは出さない', () => {
    const cancelled = cancelEvent(addEvent(emptyLedger(), { title: '古川さんへ電話', at: start, id: 'call-1' }), 'call-1');
    assert.deepEqual(duePushes(cancelled.events, new Date('2026-11-20T13:00:00+09:00')), []);
  });

  it('空きが分かった時点の announce を出す', () => {
    const row = event({ announceAt: '2026-11-20T11:16:00+09:00' });
    const due = duePushes([row], new Date('2026-11-20T11:16:30+09:00'));
    assert.equal(due.some((item) => item.kind === 'announce'), true);
  });

  it('枠の終了30分前にも window-end を出す', () => {
    const row = event({ at: '2026-11-20T13:30:00+09:00', windowEnd: '2026-11-20T17:00:00+09:00' });
    const due = duePushes([row], new Date('2026-11-20T16:30:00+09:00'));
    assert.equal(due.length, 1);
    assert.equal(due[0].kind, 'window-end');
  });
});

describe('formatPush', () => {
  it('reminder は開始時刻を日本語で書く', () => {
    const message = formatPush({ event: event(), kind: 'reminder' }, new Date('2026-11-20T13:00:00+09:00'));
    assert.match(message.title, /まもなく開始/);
    assert.match(message.body, /13:30/);
    assert.match(message.body, /30分前/);
  });

  it('announce は登録したことを伝える', () => {
    const message = formatPush({ event: event(), kind: 'announce' });
    assert.match(message.title, /予定が入りました/);
  });
});

describe('tick', () => {
  it('通知し、ledger に remindedAt を書いて二度出さない', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-push-'));
    const sent = [];
    const first = addEvent(emptyLedger(), { title: '古川さんへ電話', at: start, id: 'call-1' });
    const memory = { current: first };
    const result = await tick(home, {
      now: new Date('2026-11-20T13:00:00+09:00'),
      notify: async ({ message }) => { sent.push(message); },
      load: () => memory.current,
      save: (_home, ledger) => { memory.current = ledger; },
    });
    assert.equal(result.sent.length, 1);
    assert.equal(sent.length, 1);
    assert.ok(memory.current.events[0].remindedAt);
    const second = await tick(home, {
      now: new Date('2026-11-20T13:01:00+09:00'),
      notify: async ({ message }) => { sent.push(message); },
      load: () => memory.current,
      save: (_home, ledger) => { memory.current = ledger; },
    });
    assert.equal(second.sent.length, 0);
    assert.equal(sent.length, 1);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('dry-run では保存も通知もしない', async () => {
    const sent = [];
    const ledger = addEvent(emptyLedger(), { title: '古川さんへ電話', at: start, id: 'call-1' });
    const result = await tick('/tmp/unused', {
      now: new Date('2026-11-20T13:00:00+09:00'),
      dryRun: true,
      notify: async ({ message }) => { sent.push(message); },
      load: () => ledger,
      save: () => { throw new Error('should not save'); },
    });
    assert.equal(result.sent.length, 1);
    assert.equal(result.dryRun, true);
    assert.equal(sent.length, 0);
  });
});

describe('main add/list/cancel', () => {
  it('add して list で戻り、cancel できる', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-push-cli-'));
    const lines = [];
    await main(['add', '--title', '古川さんへ電話', '--at', start, '--id', 'call-1', '--announce-now', '--home', home], {
      home,
      out: (value) => lines.push(value),
    });
    assert.equal(fs.existsSync(ledgerPath(home)), true);
    await main(['list', '--home', home], { home, out: (value) => lines.push(value) });
    const listed = JSON.parse(lines.at(-1));
    assert.equal(listed.events[0].title, '古川さんへ電話');
    assert.ok(listed.events[0].announceAt);
    await main(['cancel', '--id', 'call-1', '--home', home], { home, out: (value) => lines.push(value) });
    const after = JSON.parse(fs.readFileSync(ledgerPath(home), 'utf8'));
    assert.equal(after.events[0].status, 'cancelled');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('defaults', () => {
  it('既定のリマインドは30分前', () => {
    assert.equal(DEFAULT_REMIND_MINUTES, 30);
  });
});
