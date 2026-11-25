import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sessionDigest, run } from './auto-progress-digest.mjs';
const now = Date.parse('2026-11-02T10:00:00Z');
const row = (id, extra = {}) => ({ ts: new Date(now - 1000).toISOString(), sessionId: id, owner: 'kim@orgiast.jp', status: 'open', label: `作業${id}`, promise: '調査を続ける', nextKim: 'なし', nextClaude: '修正を検証する', ...extra });
function fixture(t, rows) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-digest-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, now, io: { label: 'kim-PC', readLedger: () => rows } };
}
test('at most five one-line items with next actor/action and priority', t => {
  const f = fixture(t, Array.from({ length: 9 }, (_, n) => row(String(n), { deadlineAt: new Date(now + (n - 2) * 3600000).toISOString() })));
  const out = sessionDigest({ ...f, dryRun: true }); assert.equal(out.split('\n').length, 5);
  assert.match(out.split('\n')[0], /作業0.*期限超過.*Claude が 修正を検証/);
});
test('once daily across both hooks, next JST day can show pending deadlines', t => {
  const f = fixture(t, [row('1', { deadlineAt: new Date(now - 1).toISOString() })]);
  assert.ok(sessionDigest(f)); assert.equal(sessionDigest(f), ''); assert.ok(sessionDigest({ ...f, now: now + 86400000 }));
});
test('exclude other owner, done latest revision, old unchanged and other PCs', t => {
  const rows = [row('other', { owner: 'other@example.com' }), row('done'), row('done', { status: 'done' }), row('old', { ts: '2020-01-01' })];
  const f = fixture(t, rows); assert.equal(sessionDigest(f), ''); f.io.label = 'other-PC'; rows.push(row('new')); assert.equal(sessionDigest(f), '');
});
test('status changes are displayed next day without listing unchanged items', t => {
  const rows = [row('1')], f = fixture(t, rows); assert.ok(sessionDigest(f)); rows[0].status = 'stalled';
  assert.match(sessionDigest({ ...f, now: now + 86400000 }), /停止中/);
  assert.equal(sessionDigest({ ...f, now: now + 2 * 86400000 }), '');
});
test('preview never consumes the daily summary and human action names kim', t => {
  const f = fixture(t, [row('1', { status: 'waiting_user', nextKim: '修復範囲を選ぶ' })]);
  assert.match(sessionDigest({ ...f, dryRun: true }), /kim が 修復範囲を選ぶ/); assert.deepEqual(fs.readdirSync(f.home), []); assert.ok(sessionDigest(f));
});

test('kim summaries never use the old outbound digest delivery', async t => {
  const f = fixture(t, [row('1', { status: 'waiting_user', nextKim: '担当を判断する' })]);
  const out = await run({ ...f, slot: '朝', io: { ...f.io, localOwner: 'kim@orgiast.jp', notify: () => assert.fail('kim outbound digest') } });
  assert.equal(out.sent, false);
  assert.equal(out.skipped, 'session-context-only');
  assert.ok(sessionDigest(f));
});

test('real SessionStart and UserPromptSubmit CLI emit once without import-cycle deadlock', t => {
  const rows = [row('cli', { deadlineAt: new Date(now - 1).toISOString() })], f = fixture(t, rows);
  fs.mkdirSync(path.join(f.home, '.claude'));
  fs.writeFileSync(path.join(f.home, '.claude/cost-reporter.env'), 'REPORTER_LABEL=kim-PC\n');
  fs.writeFileSync(path.join(f.home, '.claude/auto-progress-ledger.jsonl'), JSON.stringify(rows[0]) + '\n');
  const script = fileURLToPath(new URL('./auto-progress-inbox-hook.mjs', import.meta.url));
  const call = event => execFileSync(process.execPath, [script], { input: JSON.stringify({session_id:'cli', hook_event_name:event}), encoding:'utf8', timeout:10000, env:{...process.env, ORGIAST_HOME:f.home} });
  const first = JSON.parse(call('SessionStart'));
  assert.match(first.hookSpecificOutput.additionalContext, /進捗まとめ.*[\s\S]*作業cli/);
  assert.equal(call('UserPromptSubmit'), '');
});
