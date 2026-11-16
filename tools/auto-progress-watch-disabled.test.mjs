import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { progressHome, notificationMocks } from './test-helpers/auto-progress-home.mjs';
import { ledgerFile, readLedger, writeLedger } from './auto-progress-ledger.mjs';
import { run, resumeSession } from './auto-progress-watch.mjs';
import { drainExternalQueue } from './auto-progress-external-monitor.mjs';
import { saveEvent, readEvents } from './lib/external-monitor-state.mjs';

function fixture(t) {
  const home = progressHome('resume-disabled-');
  const before = process.env.ORGIAST_AUTO_RESUME;
  delete process.env.ORGIAST_AUTO_RESUME;
  t.after(() => {
    before === undefined ? delete process.env.ORGIAST_AUTO_RESUME : process.env.ORGIAST_AUTO_RESUME = before;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test('resumeSession は無効時に実行役を呼ばない', async t => {
  const home = fixture(t);
  assert.deepEqual(await resumeSession({ sessionId: 's' }, { home, io: { runChild: () => assert.fail('no child') } }),
    { outcome: 'disabled', reason: '自動再開は廃止（config/auto-resume.json）' });
});

for (const kind of ['stalled', 'waiting_user', 'overdue-check', 'overdue-start', 'scheduled-start']) {
  test(`${kind}: 自動再開せず同じ行の通知は1回、失敗した通知だけ再試行`, async t => {
    const home = fixture(t);
    let now = Date.parse('2026-11-14T05:00:00Z');
    const row = { sessionId: 's', ts: new Date(now - 4 * 3600000).toISOString(), cwd: home,
      promise: '成果物を仕上げる', label: '成果物', nextKim: 'なし', status: 'open' };
    if (kind === 'waiting_user') row.status = 'waiting_user';
    if (kind === 'overdue-check') Object.assign(row, { check: 'node check.mjs', deadlineAt: new Date(now - 1000).toISOString() });
    if (kind.endsWith('-start')) Object.assign(row, { status: 'scheduled', startWhen: 'node ready.mjs',
      deadlineAt: new Date(now + (kind === 'scheduled-start' ? 3600000 : -1000)).toISOString() });
    writeLedger(ledgerFile(home), [row]);
    let attempts = 0;
    const notices = [];
    const io = { ...notificationMocks, clock: () => now, transcriptFiles: [], sheetConfig: () => null,
      digest: async () => ({}), escalateKimDecisions: async () => ({}),
      transcriptEvidence: () => ({ count: 0, lastAt: 0, snippets: [] }),
      recentFiles: () => ({ names: [], lastAt: 0 }), autoSessionRuns: () => ({ names: [], lastAt: 0 }),
      judge: () => ({ verdict: 'stalled', reason: '停滞' }),
      executeCheck: async () => ({ code: kind === 'scheduled-start' ? 0 : 1, text: '未完了' }),
      resume: () => assert.fail('no resume'), addKimInboxItem: async (_home, item) => {
        if (++attempts === 1) throw new Error('temporary inbox failure');
        notices.push(item); return { id: 'notice' };
      } };
    const dry = await run({ home, now, dryRun: true, io });
    assert.equal(dry.resumed, 0);
    assert.equal(attempts, 0);
    for (let i = 0; i < 3; i++) {
      const result = await run({ home, now, io });
      assert.equal(result.resumed, 0);
      now += 3600000;
    }
    assert.equal(attempts, 2);
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /自動再開は行いません.*claude --resume s/);
    const saved = readLedger(ledgerFile(home))[0];
    assert.equal(saved.status, 'stalled');
    assert.equal(saved.resumeOutcome, 'disabled');
    assert.equal(saved.resumeCount ?? 0, 0);
  });
}

test('外部新着キューも再開せず、同じセッションへの通知は1回', async t => {
  const home = fixture(t);
  const now = Date.now();
  const event = { key: 'a'.repeat(64), channel: 'gmail', message: { sender: 'test', at: new Date(now).toISOString(), text: 'new message' },
    row: { sessionId: 's' }, inboxId: 'receipt', state: 'pending', queuedAt: new Date(now).toISOString() };
  saveEvent(home, event);
  let notices = 0;
  const options = { home, now, resume: () => assert.fail('no resume'), io: { addKimInboxItem: async () => { notices++; return { id: 'notice' }; } } };
  await drainExternalQueue(options);
  saveEvent(home, { ...event, key: 'b'.repeat(64) });
  await drainExternalQueue(options);
  await drainExternalQueue({ ...options, now: now + 3600000 });
  assert.equal(notices, 1);
  assert.ok(readEvents(home).every(e => e.state === 'disabled'));
});
