import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { escalateKimDecisions, escalationRowKey, escalationText } from './auto-progress-escalate.mjs';
const H = 3600000;
const now = Date.parse('2026-11-04T10:00:00Z');
const row = (hours, extra = {}) => ({ ts: new Date(now - hours * H).toISOString(), sessionId: `session-${hours}`, status: 'waiting_user', nextKim: 'kim の承認が必要です', promise: '返信を確認して報告', pc: 'test-PC', ...extra });
function setup(t, rows) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'escalate-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, now, io: { readLedger: () => rows, notifyKim: async () => ({ delivered: 'dm' }) } };
}
test('48h boundary, older timestamp, statuses and owner filtering', async t => {
  const opts = setup(t, [row(47.99), row(48), row(49, { status: 'done' }), row(50, { nextKim: '設定を保存' }), row(1, { lastCheckedAt: new Date(now - 50 * H).toISOString() }), row(60, { lastCheckedAt: new Date(now).toISOString() }), row(1, { ts: 'invalid' })]);
  const result = await escalateKimDecisions({ ...opts, dryRun: true });
  assert.equal(result.targets.length, 3);
  assert.equal(result.sent, 0);
  assert.equal(fs.existsSync(path.join(opts.home, '.claude')), false);
});
test('successful delivery persists dedup and allows retry at 24h', async t => {
  const r = row(60), opts = setup(t, [r]);
  let calls = 0;
  opts.io.notifyKim = async (text, options) => { calls++; assert.equal(options.kind, 'ask'); assert.equal(options.kimActionRequired, true); assert.equal(options.sessionId, r.sessionId); return { delivered: 'dm' }; };
  assert.equal((await escalateKimDecisions(opts)).sent, 1);
  const state = JSON.parse(fs.readFileSync(path.join(opts.home, '.claude/auto-progress-escalated.json')));
  assert.equal(state[escalationRowKey(r)], new Date(now).toISOString());
  assert.equal((await escalateKimDecisions({ ...opts, now: now + 24 * H - 1 })).targets.length, 0);
  assert.equal((await escalateKimDecisions({ ...opts, now: now + 24 * H })).sent, 1);
  assert.equal(calls, 2);
});
test('blocked and throwing deliveries continue without recording success', async t => {
  const rows = [row(60), row(61), row(62)], opts = setup(t, rows), errors = [];
  let calls = 0;
  opts.io.stderr = text => errors.push(text);
  opts.io.notifyKim = async () => { calls++; if (calls === 1) return { delivered: 'blocked', reason: 'policy' }; if (calls === 2) throw new Error('offline'); return { delivered: 'dm' }; };
  assert.equal((await escalateKimDecisions(opts)).sent, 1);
  assert.equal(calls, 3);
  assert.match(errors[0], /blocked/);
  assert.match(errors[1], /offline/);
  const state = JSON.parse(fs.readFileSync(path.join(opts.home, '.claude/auto-progress-escalated.json')));
  assert.deepEqual(Object.keys(state), [escalationRowKey(rows[2])]);
});
test('dry-run never sends or modifies existing state', async t => {
  const opts = setup(t, [row(60)]);
  opts.io.notifyKim = () => assert.fail('dry-run must not send');
  fs.mkdirSync(path.join(opts.home, '.claude'));
  const file = path.join(opts.home, '.claude/auto-progress-escalated.json');
  fs.writeFileSync(file, '{}\n');
  assert.equal((await escalateKimDecisions({ ...opts, dryRun: true })).targets.length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), '{}\n');
  assert.equal(fs.existsSync(file + '.lock'), false);
});
test('nextKim が空または なし の行は owner が kim でも escalate 対象外', async t => {
  const opts = setup(t, [
    { ...row(60), owner: 'kim-PC', nextKim: '' },
    { ...row(61), owner: 'kim-PC', nextKim: 'なし' },
    { ...row(62), owner: 'kim-PC', nextKim: '　なし　' },
    { ...row(63), owner: 'kim-PC', nextKim: 'kim の承認が必要' },
  ]);
  const result = await escalateKimDecisions({ ...opts, dryRun: true });
  assert.equal(result.targets.length, 1);
  assert.ok(result.targets[0].text.includes('kim の承認が必要'));
});
test('message preserves decision text and caps context lengths', () => {
  const text = escalationText(row(60, { nextKim: 'あ'.repeat(2001), promise: '約'.repeat(81) }), now);
  assert.match(text, /判断待ち 2日/);
  assert.ok(text.includes('あ'.repeat(2000)));
  assert.ok(!text.includes('あ'.repeat(2001)));
  assert.ok(!text.includes('約'.repeat(81)));
  assert.match(text, /PC test-PC \/ セッション session- \/ 台帳 ts/);
});
