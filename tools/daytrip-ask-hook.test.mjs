import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { consumePending, pendingHash } from './daytrip-ask-hook.mjs';
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daytrip-hook-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'daytrip-detect');
  fs.mkdirSync(dir, { recursive: true });
  const pending = path.join(dir, 'pending.json');
  const write = (items = [{ number: 1, line: '1. 2026-11-02｜商談｜京都駅' }]) => fs.writeFileSync(pending, JSON.stringify({ items }));
  return { home, dir, pending, write };
}
const input = { session_id: 'session-a', hook_event_name: 'SessionStart' };
test('missing or empty pending produces no output', t => {
  const opts = setup(t);
  assert.equal(consumePending(input, opts), null);
  opts.write([]);
  assert.equal(consumePending(input, opts), null);
  assert.ok(!fs.existsSync(path.join(opts.dir, 'shown.json')));
});
test('same session once, another session again, changed number set again', t => {
  const opts = setup(t); opts.write();
  const first = consumePending(input, opts);
  assert.equal(first.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(first.hookSpecificOutput.additionalContext, /🚗 日帰り出張の確認（カレンダーから自動検出）/);
  assert.match(first.hookSpecificOutput.additionalContext, /node ".*daytrip-detect\.mjs" --answer/);
  assert.match(first.hookSpecificOutput.additionalContext, /1\. 2026-11-02｜商談｜京都駅\n距離: © OpenStreetMap contributors（概算）$/);
  assert.equal(consumePending({ ...input, hook_event_name: 'UserPromptSubmit' }, opts), null);
  assert.ok(consumePending({ ...input, session_id: 'session-b' }, opts));
  opts.write([{ number: 1, line: 'one' }, { number: 2, line: 'two' }]);
  const next = consumePending({ ...input, hook_event_name: 'UserPromptSubmit' }, opts);
  assert.equal(next.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(next.hookSpecificOutput.additionalContext, /one\ntwo/);
  opts.write([{ number: 2, line: 'two' }, { number: 1, line: 'one' }]);
  assert.equal(consumePending(input, opts), null);
});
test('broken JSON and invalid inputs produce no output', t => {
  const opts = setup(t);
  fs.writeFileSync(opts.pending, '{');
  assert.equal(consumePending(input, opts), null);
  opts.write();
  assert.equal(consumePending({}, opts), null);
  assert.equal(consumePending({ ...input, hook_event_name: 'Stop' }, opts), null);
  fs.writeFileSync(path.join(opts.dir, 'shown.json'), '{');
  assert.equal(consumePending(input, opts), null);
});
test('shown entries expire after thirty days, session keys cannot alter prototypes', t => {
  const opts = setup(t), now = Date.parse('2026-11-02T12:00:00Z'); opts.write();
  fs.writeFileSync(path.join(opts.dir, 'shown.json'), JSON.stringify({ expired: { hash: 'old', at: now - 31 * 86400000 }, recent: { hash: 'new', at: now - 86400000 } }));
  assert.ok(consumePending({ ...input, session_id: '__proto__' }, { ...opts, now }));
  const shown = JSON.parse(fs.readFileSync(path.join(opts.dir, 'shown.json')));
  assert.ok(!Object.hasOwn(shown, 'expired')); assert.ok(Object.hasOwn(shown, 'recent'));
  assert.ok(Object.hasOwn(shown, '__proto__'));
  assert.equal(consumePending({ ...input, session_id: '__proto__' }, { ...opts, now }), null);
  assert.ok(consumePending({ ...input, session_id: '__proto__' }, { ...opts, now: now + 31 * 86400000 }));
});
test('hash uses the number set only', () => {
  assert.equal(pendingHash([{ number: 2 }, { number: 1 }]), pendingHash([{ number: 1 }, { number: 2 }, { number: 1 }]));
});
test('CLI emits JSON only with pending, malformed stdin is silent', t => {
  const opts = setup(t); opts.write();
  const run = stdin => spawnSync(process.execPath, [fileURLToPath(new URL('./daytrip-ask-hook.mjs', import.meta.url))], { input: stdin, encoding: 'utf8', timeout: 5000, env: { ...process.env, ORGIAST_HOME: opts.home, HOME: opts.home } });
  const first = run(JSON.stringify(input));
  assert.equal(first.status, 0, first.stderr); assert.equal(first.stderr, '');
  assert.equal(JSON.parse(first.stdout).hookSpecificOutput.hookEventName, 'SessionStart');
  for (const stdin of [JSON.stringify(input), '{', '']) {
    const result = run(stdin);
    assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  }
});
