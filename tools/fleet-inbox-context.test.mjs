import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { buildContext, selectContext, main, shouldReceivePoll, POLL_STALE_MS, ENTRY_LIMIT, CONTEXT_LIMIT, CATEGORY_LIMITS, FOOTER } from './fleet-inbox-context.mjs';
import { backgroundSpawnOptions } from './lib/background-spawn.mjs';
import { readInbox, main as mailMain } from './fleet-mail.mjs';
const NOW = Date.parse('2026-10-14T12:00:00Z');
const mail = (id, extra = {}) => ({ id: `mail-${id}`, from: 'PC', kind: 'note', body: '本文', why: '確認', status: 'delivered', createdAt: new Date(NOW).toISOString(), ...extra });
function fixture(t, messages = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-context-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(path.join(dir, 'fleet-inbox'), { recursive: true });
  for (const message of messages) fs.writeFileSync(path.join(dir, 'fleet-inbox', `${message.id}.json`), JSON.stringify(message));
  const spawns = [], outputs = [], errors = [];
  const deps = { home, headless: false, now: () => NOW, platform: 'linux', stderr: x => errors.push(x), stdout: x => outputs.push(JSON.parse(x)),
    spawnImpl: (cmd, args, options) => { const call = { cmd, args, options, unref: false }; spawns.push(call); return { on() {}, unref() { call.unref = true; } }; } };
  const run = (event = 'UserPromptSubmit', session = 't') => main({ ...deps, readStdin: async () => JSON.stringify({ hook_event_name: event, session_id: session }) });
  return { home, dir, spawns, outputs, errors, deps, run };
}
test('empty inbox uses no context', () => assert.equal(buildContext([]), ''));
test('priority buckets and per-category caps come from the presentation policy', () => {
  const kinds = ['[判断依頼]', '[作業依頼]', '[回答・返信不要]', '通常'];
  const messages = kinds.flatMap((why, category) => Array.from({ length: 9 }, (_, i) => mail(`${category}-${i}`, { why, body: '' })));
  const { shown, context } = selectContext(messages.reverse(), { headless: false });
  assert.deepEqual(shown.map(m => Number(m.id.split('-')[1])), CATEGORY_LIMITS.flatMap((count, i) => Array(count).fill(i)));
  assert.ok(context.length <= CONTEXT_LIMIT);
});
test('newest notes come first independent of inbox filename order', () => {
  const { shown } = selectContext([mail('old', { createdAt: '2020-01-01' }), mail('new', { createdAt: '2026-01-01' }), mail('middle', { createdAt: '2025-01-01' })]);
  assert.deepEqual(shown.map(m => m.id), ['mail-new', 'mail-middle']);
});
test('entry and total budgets hold while retaining the exact unseen footer', () => {
  const { context, shown } = selectContext(Array.from({ length: 100 }, (_, i) => mail(i, { why: '[判断依頼]', body: '長'.repeat(20000) })), { headless: false });
  assert.ok(context.length <= CONTEXT_LIMIT); assert.ok(context.endsWith(FOOTER));
  for (const m of shown) { const start = context.indexOf(`id=${m.id} /`); assert.ok(context.slice(start).split('\n').slice(0, 2).join('\n').length < ENTRY_LIMIT); }
});
test('masks secrets before clipping, including sender and reason', () => {
  assert.doesNotMatch(buildContext([mail('secret', { from: 'token=private', why: 'api_key=secret', body: 'https://discord.com/api/webhooks/123/private' })]), /private|secret|webhooks\/123/);
});
test('expired and terminal messages never appear; expired count includes cached expired state', () => {
  const result = buildContext([mail('expired', { expiresAt: new Date(NOW - 1).toISOString() }), mail('expired-cached', { status: 'expired' }), mail('done', { status: 'done' }), mail('live')], { now: NOW });
  assert.doesNotMatch(result, /id=mail-(?:expired|done)/); assert.match(result, /期限切れ 2 件は除外/); assert.match(result, /id=mail-live/);
});
test('headless decisions remain pending and cannot be acted on', () => {
  const { shown, context } = selectContext([mail('decision', { why: '[判断依頼] 承認' }), mail('normal')], { headless: true });
  assert.deepEqual(shown.map(m => m.id), ['mail-normal']); assert.doesNotMatch(context, /承認|id=mail-decision/); assert.match(context, /判断を代行せず返信しない/);
});
test('reply inherits request why without becoming a decision request', () => {
  const { context, shown } = selectContext([mail('reply-abc', { why: '[判断依頼] 元件名' })], { headless: true });
  assert.equal(shown.length, 1); assert.match(context, /\[回答・返信不要\]/); assert.doesNotMatch(context, /判断依頼は kim/);
});
test('same session yields only count; another session re-presents unresolved seen items', async t => {
  const f = fixture(t, [mail('pending')]);
  await f.run('SessionStart'); await f.run();
  assert.match(f.outputs[0].hookSpecificOutput.additionalContext, /id=mail-pending/);
  assert.match(f.outputs[1].hookSpecificOutput.additionalContext, /^他 1 件/);
  assert.doesNotMatch(f.outputs[1].hookSpecificOutput.additionalContext, /id=mail-pending/);
  await f.run('UserPromptSubmit', 'another');
  assert.match(f.outputs[2].hookSpecificOutput.additionalContext, /id=mail-pending/);
});
test('SessionStart output event and detached ensure arguments are correct', async t => {
  const f = fixture(t, [mail('one')]); await f.run('SessionStart');
  assert.equal(f.outputs[0].hookSpecificOutput.hookEventName, 'SessionStart');
  assert.deepEqual(f.spawns.find(s => s.args[0].endsWith('register-fleet-mail.mjs')).args.slice(1), ['--ensure', '--quiet']);
});
test('hook starts poll and sync without GAS, locks, pipes or child waiting', async t => {
  const f = fixture(t, [mail('one')]);
  const previous = globalThis.fetch; globalThis.fetch = () => { throw new Error('hook network forbidden'); };
  t.after(() => { globalThis.fetch = previous; });
  await f.run();
  assert.equal(f.errors.length, 0);
  assert.deepEqual(f.spawns.map(s => s.args.slice(1)), [['--poll'], ['--sync-pending']]);
  for (const s of f.spawns) { assert.equal(s.cmd, process.execPath); assert.equal(s.options.stdio, 'ignore'); assert.equal(s.options.env.ORGIAST_HOME, f.home); assert.equal(s.unref, true); assert.equal(s.options.detached, backgroundSpawnOptions('linux').detached); }
  assert.equal(fs.existsSync(path.join(f.dir, 'fleet-mail.lock')), false);
});
test('presentation queues durable seen/ack, and sync CLI sends both in order', async t => {
  const f = fixture(t, [mail('reply-abc')]); await f.run();
  const saved = readInbox(f.home, { unreadOnly: false })[0];
  assert.equal(saved.presentedSession, 't'); assert.equal(saved.presentedAt, new Date(NOW).toISOString()); assert.equal(saved.status, 'done'); assert.deepEqual(saved.pendingServer, ['seen', 'ack']);
  fs.writeFileSync(path.join(f.dir, 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.invalid\nFLEET_SHEET_TOKEN=test\n');
  const calls = [];
  await mailMain(['--sync-pending'], { home: f.home, stdout() {}, stderr() {}, request: async (kind, payload) => { calls.push({ kind, payload }); return { ok: true }; } });
  assert.deepEqual(calls.map(c => c.kind), ['mail-seen', 'mail-ack']); assert.match(calls[0].payload.seenBy, /:t$/);
  assert.deepEqual(readInbox(f.home, { unreadOnly: false })[0].pendingServer, []);
  await f.run('UserPromptSubmit', 'another'); assert.equal(f.outputs.length, 1);
});
test('fresh last-poll suppresses poll, inflight poll does not masquerade as success', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, '.fleet-mail-poll.json'), '{}'); assert.equal(shouldReceivePoll(f.home), true);
  const marker = path.join(f.dir, '.fleet-mail-last-poll.json'); fs.writeFileSync(marker, '{}');
  const now = fs.statSync(marker).mtimeMs;
  assert.equal(shouldReceivePoll(f.home, { now: () => now + POLL_STALE_MS }), false);
  assert.equal(shouldReceivePoll(f.home, { now: () => now + POLL_STALE_MS + 1 }), true);
});
test('malformed input and spawn errors fail open without leaking error details', async t => {
  const f = fixture(t, [mail('one')]);
  await main({ ...f.deps, readStdin: async () => '{' }); assert.equal(f.errors.length, 1);
  await main({ ...f.deps, readStdin: async () => '{"hook_event_name":"SessionStart"}', spawnImpl() { throw new Error('token=private'); } });
  assert.equal(f.outputs.length, 1); assert.doesNotMatch(f.errors.join('\n'), /private/);
});
test('Windows launch uses the shared hidden-background policy', async t => {
  const f = fixture(t); await main({ ...f.deps, platform: 'win32', readStdin: async () => '{"hook_event_name":"SessionStart"}' });
  for (const s of f.spawns) { assert.equal(s.options.windowsHide, backgroundSpawnOptions('win32').windowsHide); assert.equal(s.options.detached, undefined); }
});

test('presenting local messages never launches synchronous identity or network commands', async t => {
  const f = fixture(t, [mail('local')]);
  const original = childProcess.spawnSync;
  let calls = 0;
  childProcess.spawnSync = () => { calls++; throw new Error('synchronous subprocess forbidden'); };
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawnSync = original; syncBuiltinESMExports(); });
  await f.run();
  assert.equal(calls, 0); assert.equal(f.errors.length, 0);
  assert.ok(readInbox(f.home)[0].presentedAt);
});

test('ordinary prompt execution is not injected as an ordinary note', () => {
  const { shown, context } = selectContext([mail('prompt', { kind: 'prompt' }), mail('note')]);
  assert.deepEqual(shown.map(m => m.id), ['mail-note']);
  assert.doesNotMatch(context, /id=mail-prompt/); assert.match(context, /他 1 件/);
});
