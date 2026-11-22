import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, tokyoToday, retryUuid } from './lahaina-daily-post.mjs';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-post-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calendarPath = path.join(dir, 'calendar.json');
  fs.writeFileSync(calendarPath, JSON.stringify([{ date: '2026-11-18', theme: 'テスト', ask: '写真' }]));
  return { home: dir, inbox: async () => ({}), date: '2026-11-18', calendarPath, quotaPath: path.join(dir, 'quota.json'), sentPath: path.join(dir, 'sent.jsonl'), log: () => {} };
}
test('monthly 429 registers approval, never marks sent; wait period uses Beeper each day', async t => {
  const f = fixture(t); let bot = 0, beeper = 0;
  const sender = () => { bot++; throw new Error('HTTP 429 You have reached your monthly limit.'); };
  const fallback = ({ text, date }) => { beeper++; assert.match(text, /11\/18/); assert.equal(date, f.date); return { state: 'presented' }; };
  await run({ ...f, sender, fallback }); await run({ ...f, sender, fallback });
  assert.equal(bot, 1); assert.equal(beeper, 2); assert.equal(fs.existsSync(f.sentPath), false);
  assert.equal(JSON.parse(fs.readFileSync(f.quotaPath)).until, '2026-12-01');
});
test('dry-run quota fallback leaves disk unchanged, including simulated 429', async t => {
  const f = fixture(t);
  await run({ ...f, dryRun: true, sender: () => { throw new Error('429 monthly limit'); }, fallback: ({ dryRun }) => { assert.equal(dryRun, true); return { dryRun }; } });
  assert.equal(fs.existsSync(f.quotaPath), false); assert.equal(fs.existsSync(f.sentPath), false);
});
test('any 429 uses standing fallback, ordinary errors surface, non-monthly quota is not persisted', async t => {
  const f = fixture(t);
  let calls = 0;
  await run({ ...f, sender: () => { throw new Error('429 rate limit'); }, fallback: () => { calls++; return { state: 'blocked' }; } });
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(f.quotaPath), false);
  await assert.rejects(run({ ...f, sender: () => { throw new Error('500 failure'); } }), /500 failure/);
  await assert.rejects(run({ ...f, sender: () => { throw new Error('429 monthly limit'); }, fallback: () => { throw new Error('Beeper down'); } }), /Beeper down/);
});
test('bot success and approved Beeper sent state prevent repeat; malformed result fails', async t => {
  const f = fixture(t);
  await assert.rejects(run({ ...f, sender: () => 'ok' }), /HTTP 200/);
  await run({ ...f, sender: () => `push 1/1: HTTP 200 sentMessages=1 ids=test retryKey=${retryUuid(f.date)}` });
  await run({ ...f, sender: () => { throw new Error('duplicate'); } });
  assert.equal(fs.readFileSync(f.sentPath, 'utf8').trim().split('\n').length, 1);
});
test('09:00 schedule guard and Tokyo date', async t => {
  assert.equal(tokyoToday(new Date('2026-11-17T16:00:00Z')), '2026-11-18');
  await run({ ...fixture(t), scheduled: true, now: new Date('2026-11-17T23:00:00Z'), sender: () => { throw new Error('too early'); } });
});
