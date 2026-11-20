import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliverDoneInbox } from './lib/auto-progress-done-inbox.mjs';
import { addItem, listItems } from './kim-inbox.mjs';

function home(t) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-delivery-'));
  fs.mkdirSync(path.join(h, '.claude/logs'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude/cost-reporter.env'), 'REPORTER_LABEL=kim-PC');
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  return h;
}

test('deliverDoneInbox registers report-only completions as info', async t => {
  const h = home(t);
  const kinds = [];
  const addKimInboxItem = (home, opts) => {
    kinds.push(opts.kind);
    return addItem(home, opts);
  };
  const rows = [{ sessionId: 'info-job', ts: '2026-11-01T00:00:00Z', status: 'done' }];

  await deliverDoneInbox(h, rows, '✅ 完了: 報告のみ', {
    io: { addKimInboxItem, listKimInboxItems: listItems },
  });

  assert.deepEqual(kinds, ['info']);
});

test('deliverDoneInbox registers completions requiring a decision as ask', async t => {
  const h = home(t);
  const kinds = [];
  const addKimInboxItem = (home, opts) => {
    kinds.push(opts.kind);
    return addItem(home, opts);
  };
  const rows = [{
    sessionId: 'ask-job',
    ts: '2026-11-02T00:00:00Z',
    status: 'done',
    nextKim: '公開してよいですか',
  }];

  await deliverDoneInbox(h, rows, '✅ 完了: 判断待ち', {
    io: { addKimInboxItem, listKimInboxItems: listItems },
  });

  assert.deepEqual(kinds, ['ask']);
});
