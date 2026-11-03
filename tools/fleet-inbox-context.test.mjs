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
  const result = buildContext([mail('expired', { expiresAt: new Date(NOW - 1).toISOString() }), mail('expired-cached', { status: 'expired' }), mail('done', { status: 'done' }), mail('live')], { label: 'nishi-PC', now: NOW });
  assert.doesNotMatch(result, /id=mail-(?:expired|done)/); assert.match(result, /期限切れ 2 件は このPCの auto-progress-watch が毎時チェックし通知/); assert.match(result, /id=mail-live/);
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
  assert.deepEqual(f.spawns.map(s => s.args.slice(1)), [['--poll', '--no-exec'], ['--sync-pending']]);
  for (const s of f.spawns) {
    assert.equal(s.cmd, process.execPath); assert.equal(s.options.stdio, 'ignore'); assert.equal(s.options.env.ORGIAST_HOME, f.home); assert.equal(s.unref, true);
    for (const [key, value] of Object.entries(backgroundSpawnOptions(f.deps.platform))) assert.equal(s.options[key], value);
  }
  assert.equal(fs.existsSync(path.join(f.dir, 'fleet-mail.lock')), false);
});
test('presentation queues durable seen/ack, and sync CLI sends both in order', async t => {
  const f = fixture(t, [mail('reply-abc')]); await f.run();
  const saved = readInbox(f.home, { unreadOnly: false })[0];
  assert.equal(saved.presentedSession, 't'); assert.equal(saved.presentedAt, new Date(NOW).toISOString()); assert.equal(saved.status, 'done'); assert.deepEqual(saved.pendingServer, ['seen', 'ack']);
  fs.writeFileSync(path.join(f.dir, 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.invalid\nFLEET_SHEET_TOKEN=test\n');
  const calls = [];
  await mailMain(['--sync-pending'], { home: f.home, stdout() {}, stderr() {}, request: async (kind, payload) => { calls.push({ kind, payload }); return payload.ids ? { ok: true, results: payload.ids.map(id => ({ id, ok: true })) } : { ok: true, mail: {} }; } });
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
  assert.ok(f.spawns.length > 0);
  for (const s of f.spawns) {
    for (const [key, value] of Object.entries(backgroundSpawnOptions('win32'))) assert.equal(s.options[key], value);
  }
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

test('C11 hook skips seen and presented writes when the inbox file is locked', async t => {
  const f = fixture(t, [mail('locked')]);
  const stored = readInbox(f.home, { unreadOnly: false })[0];
  const file = path.join(f.dir, 'fleet-inbox', `${stored.id}.json`), before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(`${file}.lock`, 'other process');
  await f.run(); assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.unlinkSync(`${file}.lock`); await f.run('UserPromptSubmit', 'retry');
  assert.equal(readInbox(f.home, { unreadOnly: false })[0].presentedSession, 'retry');
});

test('D4 poll freshness stat failure still presents and queues local inbox context', async t => {
  const f = fixture(t, [mail('visible')]);
  const stat = fs.statSync;
  t.mock.method(fs, 'statSync', (file, ...args) => {
    if (String(file).endsWith('.fleet-mail-last-poll.json')) throw Object.assign(new Error('private'), { code: 'EACCES' });
    return stat(file, ...args);
  });
  await f.run();
  assert.match(f.outputs[0].hookSpecificOutput.additionalContext, /id=mail-visible/);
  assert.ok(readInbox(f.home)[0].presentedAt);
  assert.deepEqual(f.errors, ['fleet-inbox-context: 受信判定失敗=1']);
  assert.equal(f.spawns.filter(s => s.args.includes('--poll')).length, 0);
});

test('D5 hook poll attempts are throttled for three minutes even when spawning fails', async t => {
  const f = fixture(t, [mail('visible')]); let time = NOW, attempts = 0;
  f.deps.now = () => time;
  f.deps.spawnImpl = (_cmd, args) => { if (args.includes('--poll')) { attempts++; throw new Error('offline'); } return { on() {}, unref() {} }; };
  await f.run(); await f.run();
  assert.equal(attempts, 1);
  time += POLL_STALE_MS; await f.run(); assert.equal(attempts, 1);
  time++; await f.run(); assert.equal(attempts, 2);
  assert.equal(f.outputs.length, 4);
});

test('D5 hook launches receive-only polling with no-exec', async t => {
  const f = fixture(t); await f.run();
  const args = f.spawns.find(s => s.args.includes('--poll')).args;
  assert.deepEqual(args.slice(1), ['--poll', '--no-exec']);
});

test('D10 failed messages never inflate the expired footer count', () => {
  const messages = [mail('failed', { status: 'failed', expiresAt: new Date(NOW - 1).toISOString() }), mail('expired', { status: 'expired' }), mail('live')];
  const result = selectContext(messages, { label: 'nishi-PC', now: NOW });
  assert.match(result.context, /期限切れ 1 件は このPCの auto-progress-watch が毎時チェックし通知/); assert.doesNotMatch(result.context, /id=mail-failed/);
});

import { updateQuestion } from './fleet-question-relay.mjs';
test('E relayed question and active hub resume appear even without inbox messages', async t => {
  const f = fixture(t);
  updateQuestion(f.home, 't', () => ({ sessionId: 't', relayedAt: new Date(NOW).toISOString(), sentId: 'mail-question-test' }));
  await f.run(); assert.match(f.outputs.at(-1).hookSpecificOutput.additionalContext, /kim-PC へ転送済み・回答待ち.*mail-question-test/);
  updateQuestion(f.home, 't', q => ({ ...q, resumingAt: new Date(NOW - 120000).toISOString() }));
  await f.run(); assert.match(f.outputs.at(-1).hookSpecificOutput.additionalContext, /kim-PC の回答で実行中（2 分前開始）/);
  const count = f.outputs.length; await f.run('UserPromptSubmit', 'other'); assert.equal(f.outputs.length, count);
});
test('E relay decisions retain answer command within entry budget, reports auto ack and consent guides the human', async t => {
  const decision = mail('relay', { why: '[判断依頼]', body: 'x'.repeat(20000), meta: JSON.stringify({ relay: { sessionId: 't', cwd: '.' } }) });
  const report = mail('report', { why: '報告', body: '[報告・返信不要] 完了' });
  const consent = mail('consent', { why: '[回答・返信不要]', body: '未オプトイン。承諾コマンド: node ...' });
  const f = fixture(t, [decision, report, consent]); await f.run();
  const context = f.outputs[0].hookSpecificOutput.additionalContext;
  assert.match(context, /回答: node tools\/fleet-mail.mjs --answer mail-relay --body-file <file>/);
  assert.match(context, /PC は未承諾。承諾コマンドを本人に渡す/); assert.match(context, /\[報告・返信不要\]/);
  assert.ok(context.length <= CONTEXT_LIMIT);
  const inbox = readInbox(f.home, { unreadOnly: false }); assert.equal(inbox.find(m => m.id === report.id).status, 'done'); assert.equal(inbox.find(m => m.id === decision.id).status, 'seen');
});

test('E answered question no longer displays waiting after execution finishes', async t => {
  const f = fixture(t);
  updateQuestion(f.home, 't', () => ({ sessionId: 't', relayedAt: new Date(NOW).toISOString(), answeredAt: new Date(NOW).toISOString(), drivenByHub: true, sentId: 'mail-question-test' }));
  await f.run(); assert.equal(f.outputs.length, 0);
});

import { questionContext } from './fleet-inbox-context.mjs';
import { RESUME_LIMIT_MS, FORWARDED_QUESTION_NOTICE } from './fleet-question-relay.mjs';
test('G10 stale resume is hidden and forwarded questions explain the separate session', t => {
  const f = fixture(t);
  updateQuestion(f.home, 't', () => ({ sessionId: 't', resumingAt: new Date(NOW - RESUME_LIMIT_MS + 1).toISOString() }));
  assert.match(questionContext(f.home, 't', NOW), /実行中/);
  updateQuestion(f.home, 't', q => ({ ...q, resumingAt: new Date(NOW - RESUME_LIMIT_MS).toISOString() }));
  assert.equal(questionContext(f.home, 't', NOW), '');
  updateQuestion(f.home, 't', q => ({ ...q, resumingAt: 'invalid', relayedAt: new Date(NOW).toISOString(), sentId: 'mail-relayed' }));
  const text = questionContext(f.home, 't', NOW);
  assert.doesNotMatch(text, /実行中/); assert.ok(text.includes(FORWARDED_QUESTION_NOTICE));
});


for (const [category, why] of ['[判断依頼]', '[作業依頼]', '[回答・返信不要]', '通常'].entries()) {
  test(`J category ${category + 1} shows newest entries up to its cap and counts older overflow`, () => {
    const messages = [2, 0, 4, 1, 3].map(i => mail(`order-${i}`, { why, createdAt: new Date(NOW + i * 1000).toISOString() }));
    const { shown, context } = selectContext(messages, { headless: false, now: NOW });
    const expected = [...messages].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, CATEGORY_LIMITS[category]);
    assert.deepEqual(shown.map(m => m.id), expected.map(m => m.id));
    assert.match(context, new RegExp(`他 ${messages.length - expected.length} 件`));
    assert.doesNotMatch(context, /id=mail-order-0/);
  });
}

test('802 failed prompts precede decisions and include interactive reply command', () => {
  const failed = mail('failed', { kind: 'prompt', status: 'failed', failReason: 'timeout', body: 'original question' });
  const result = selectContext([mail('decision', { why: '[判断依頼]' }), failed], { now: NOW, sessionId: 'new' });
  assert.equal(result.shown[0].id, failed.id);
  assert.match(result.context, /\[作業依頼\] 自動回答できなかった質問/);
  assert.match(result.context, /--reply mail-failed --body-file <file>/);
  assert.match(result.context, /timeout/);
});
test('802 sender hook displays cached failed status without network', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'fleet-mail-sent-status.json'), JSON.stringify({ 'mail-sent': { id: 'mail-sent', to: 'other-PC', status: 'failed', failReason: 'timeout' } }));
  const output = [];
  await main({ home: f.home, readStdin: async () => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'test' }), stdout: x => output.push(x), spawnImpl: () => ({ on() {}, unref() {} }) });
  assert.match(output.join(''), /other-PC への質問 mail-sent は相手の自動回答が失敗（timeout）/);
});

test('failed prompts are hidden only after 72 hours from failedAt', () => {
  for (const [age, visible] of [[72 * 3600000 - 1, true], [72 * 3600000, true], [72 * 3600000 + 1, false]]) {
    const failed = mail('aged', { kind: 'prompt', status: 'failed', failedAt: new Date(NOW - age).toISOString(), createdAt: new Date(NOW - 100 * 3600000).toISOString() });
    const result = selectContext([failed], { now: NOW });
    assert.equal(result.shown.length, visible ? 1 : 0);
    if (!visible) assert.equal(result.context, '');
  }
});

test('期限切れの追跡案内をPCごとに切り替える', () => {
  const messages = [mail('expired', { status: 'expired' })];
  assert.match(buildContext(messages, { label: 'kim-PC', now: NOW }), /fleet-chase が追跡中/);
  assert.match(buildContext(messages, { label: 'nishi-PC', now: NOW }), /このPCの auto-progress-watch が毎時チェックし通知/);
});
