import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { main, parseArgs, createClient, waitForReply, acquireLock, LOCK_MS, readInbox } from './fleet-mail.mjs';
import { main as register } from './register-fleet-mail.mjs';
import { consentCommand } from './fleet-agent.mjs';

function fixture(t, configured = true) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-mail-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir);
  if (configured) fs.writeFileSync(path.join(dir, 'fleet-sheet.env'), 'FLEET_SHEET_URL="https://example.invalid/mail"\nFLEET_SHEET_TOKEN=test-token\n');
  fs.writeFileSync(path.join(dir, 'cost-reporter.env'), 'REPORTER_LABEL=kim-PC\n');
  const body = path.join(home, 'body.txt'); fs.writeFileSync(body, '質問 $() `literal`');
  const calls = [], output = [], errors = [];
  const deps = { home, identity: { hostname: 'host-kim' }, stdout: t => output.push(t), stderr: t => errors.push(t),
    request: async (kind, payload) => { calls.push({ kind, payload }); return kind === 'mail-poll' ? { messages: [] } : { mail: payload }; } };
  return { home, dir, body, deps, calls, output, errors };
}
const mail = (overrides = {}) => ({ id: 'mail-20260921-1234', from: 'other-PC', to: 'kim-PC', kind: 'note', body: 'hello', why: 'status', status: 'new', createdAt: '2026-09-21T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', ...overrides });
function spawnDouble(calls, output = 'answer token=secret-value') {
  return (program, args, options) => {
    calls.push({ program, args, options });
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => { child.stdout.write(output); child.emit('close', 0); });
    return child;
  };
}

test('send uses file body, reporter identity, reason, expiry and mail-send envelope', async t => {
  const f = fixture(t); const transport = [];
  f.deps.now = () => Date.parse('2026-09-21T00:00:00Z'); f.deps.randomInt = () => 1234;
  delete f.deps.request;
  f.deps.fetch = async (url, opts) => { transport.push({ url, payload: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ ok: true, mail: {} }) }; };
  assert.equal(await main(['--send', '--to', 'other-PC', '--kind', 'prompt', '--body-file', f.body, '--why', '調査'], f.deps), 0);
  assert.deepEqual(transport[0].payload, { id: 'mail-20260921000000000-1234', from: 'kim-PC', to: 'other-PC', messageKind: 'prompt', body: '質問 $() `literal`', why: '調査', expiresAt: '2026-09-22T00:00:00.000Z', kind: 'mail-send', token: 'test-token' });
  assert.match(fs.readFileSync(path.join(f.dir, 'fleet-mail-sent.jsonl'), 'utf8'), /send-attempt/);
});
test('invalid CLI never accepts inline body, missing why, unsafe ids, invalid wait or mixed modes', () => {
  for (const args of [['--send','--body','oops'], ['--send'], ['--poll','--inbox'], ['--ack','../../escape'], ['--poll','--wait','-1'], ['--reply','mail-1']]) assert.throws(() => parseArgs(args));
});
test('poll saves notes unread, ack hides them, replay never resets read status', async t => {
  const f = fixture(t); f.deps.request = async () => ({ messages: [mail()] });
  await main(['--poll'], f.deps);
  assert.equal(readInbox(f.home)[0].body, 'hello');
  await main(['--ack', mail().id], f.deps);
  await main(['--poll'], f.deps);
  assert.equal(readInbox(f.home).length, 0);
  assert.equal(fs.readFileSync(path.join(f.dir, 'fleet-mail-received.jsonl'), 'utf8').trim().split('\n').length, 1);
});
test('prompt without opt-in never spawns and returns exact existing consent command', async t => {
  const f = fixture(t); f.deps.spawnImpl = () => assert.fail('must not spawn');
  f.deps.request = async (kind, payload) => { f.calls.push({ kind, payload }); return kind === 'mail-poll' ? { messages: [mail({ kind: 'prompt' })] } : { mail: {} }; };
  await main(['--poll'], f.deps);
  assert.equal(f.calls[1].payload.resultBody, `未オプトイン。承諾コマンド: ${consentCommand('prompt')}`);
});
test('opted-in prompt uses fixed header, local executable/cwd, bounded redacted result, no side-effect tools', async t => {
  const f = fixture(t); const spawns = [];
  fs.writeFileSync(path.join(f.dir, 'fleet-agent-optin.json'), '{"accept":["prompt"]}');
  f.deps.spawnImpl = spawnDouble(spawns, 'x'.repeat(9000) + ' token=secret-value');
  f.deps.repo = f.home;
  f.deps.request = async (kind, payload) => { f.calls.push({ kind, payload }); return kind === 'mail-poll' ? { messages: [mail({ kind: 'prompt', cwd: '/attacker', claudeExe: '/evil' })] } : { mail: {} }; };
  await main(['--poll'], f.deps);
  assert.equal(spawns.length, 1); assert.equal(spawns[0].options.cwd, f.home); assert.notEqual(spawns[0].program, '/evil');
  assert.match(spawns[0].args[1], /^これは other-PC PC の Claude Code からのメッセージです。/);
  assert.ok(spawns[0].args.includes('--strict-mcp-config')); assert.ok(spawns[0].args.includes('--tools'));
  assert.equal(spawns[0].options.shell, false);
  assert.equal(f.calls[1].payload.resultBody.length, 8000); assert.doesNotMatch(f.calls[1].payload.resultBody, /secret-value/);
  assert.doesNotMatch(fs.readFileSync(path.join(f.dir, 'fleet-agent-results', `${mail().id}.json`), 'utf8'), /secret-value/);
  await main(['--poll'], f.deps); assert.equal(spawns.length, 1);
});
test('failed reply resumes saved result without running prompt again', async t => {
  const f = fixture(t); const spawns = []; let fail = true;
  fs.writeFileSync(path.join(f.dir, 'fleet-agent-optin.json'), '{"accept":["prompt"]}'); f.deps.spawnImpl = spawnDouble(spawns);
  f.deps.request = async kind => { if (kind === 'mail-poll') return { messages: fail ? [mail({ kind: 'prompt' })] : [] }; if (fail) throw new Error('offline'); return { mail: {} }; };
  await assert.rejects(main(['--poll'], f.deps), /offline/); fail = false;
  await main(['--poll'], f.deps); assert.equal(spawns.length, 1);
  assert.equal(fs.existsSync(path.join(f.dir, 'fleet-mail.lock')), false);
});
test('dry-run leaves no inbox, processed file, lock, log or spawn', async t => {
  const f = fixture(t); const before = fs.readdirSync(f.dir);
  f.deps.request = async (kind, payload) => { assert.equal(payload.dryRun, true); return { messages: [mail({ kind: 'prompt' })] }; };
  await main(['--poll', '--dry-run', '--json'], f.deps);
  assert.deepEqual(fs.readdirSync(f.dir), before);
});
test('broadcast processed IDs exclude old first-page messages from future polls', async t => {
  const f = fixture(t); const params = [];
  f.deps.request = async (kind, p) => { params.push(p); return { messages: [mail({ to: 'all' })] }; };
  await main(['--poll'], f.deps); await main(['--poll'], f.deps);
  assert.deepEqual(params[1].processedIds, [mail().id]);
});
test('wait returns done body, timeout exit 2 and bounds sleep to deadline', async () => {
  let clock = 0, count = 0; const delays = [];
  const deps = { now: () => clock, sleepImpl: async ms => { delays.push(ms); clock += ms; }, request: async () => ({ mail: ++count > 1 ? { status: 'done', resultBody: 'answer' } : { status: 'new' } }) };
  assert.deepEqual(await waitForReply('mail-1', 60, deps), { exitCode: 0, text: 'answer' }); assert.deepEqual(delays, [15000]);
  clock = 0; deps.request = async () => ({ mail: null });
  assert.deepEqual(await waitForReply('mail-1', 16, deps), { exitCode: 2, text: '未返信（id=mail-1）' }); assert.equal(clock, 16000);
});
test('send --wait returns reply on stdout, reply CLI sends redacted body', async t => {
  const f = fixture(t);
  f.deps.request = async (kind, p) => { f.calls.push({ kind, p }); return { mail: { status: 'done', resultBody: 'answer' } }; };
  assert.equal(await main(['--send','--to','PC','--kind','note','--body-file', f.body,'--why','test','--wait','5'], f.deps), 0);
  assert.deepEqual(f.output, ['answer']);
  fs.writeFileSync(f.body, 'secret=do-not-log');
  await main(['--reply', 'mail-1', '--body-file', f.body], f.deps);
  assert.equal(f.calls.at(-1).p.resultBody, '[REDACTED]');
});
test('lock excludes concurrent poll and reclaims only after ten minutes', t => {
  const f = fixture(t); const file = path.join(f.dir, 'fleet-mail.lock');
  const release = acquireLock(file); assert.equal(typeof release, 'function'); assert.equal(acquireLock(file), null);
  const old = new Date(Date.now() - LOCK_MS - 1000); fs.utimesSync(file, old, old);
  const newer = acquireLock(file); assert.equal(typeof newer, 'function'); release(); assert.ok(fs.existsSync(file)); newer(); assert.ok(!fs.existsSync(file));
});
test('missing transport config is exit 0 without side effects or network', async t => {
  const f = fixture(t, false); f.deps.request = () => assert.fail('network called');
  assert.equal(await main(['--poll'], f.deps), 0); assert.equal(f.errors.length, 1); assert.equal(f.output.length, 0);
  assert.equal(await main(['--send','--to','PC','--kind','note','--body-file',f.body,'--why','test'], f.deps), 0);
});
test('transport rejects HTML, HTTP, API failures and old GAS fallback responses', async () => {
  for (const response of [{ ok: false, status: 403 }, { ok: true, json: async () => ({ ok: false, error: 'unauthorized' }) }, { ok: true, json: async () => ({ ok: true, action: 'updated' }) }]) {
    await assert.rejects(createClient({ url: 'https://example.invalid', token: 'x', fetchImpl: async () => response })('mail-poll', {}));
  }
});
test('setup repair wrapper only invokes PowerShell on configured Windows', t => {
  const f = fixture(t); const calls = [];
  const spawnImpl = (...args) => { calls.push(args); return { status: 0 }; };
  register({ home: f.home, platform: 'linux', spawnImpl }); assert.equal(calls.length, 0);
  register({ home: f.home, platform: 'win32', spawnImpl }); assert.equal(calls.length, 1); assert.match(calls[0][1].at(-1), /register-fleet-mail.ps1$/);
});

test('lost poll response retries its durable request id until inbox is saved', async t => {
  const f = fixture(t); const requests = []; let fail = true;
  f.deps.request = async (kind, p) => { requests.push(p.requestId); if (fail) throw new Error('connection lost'); return { messages: [mail()] }; };
  await assert.rejects(main(['--poll'], f.deps), /connection lost/); fail = false;
  await main(['--poll'], f.deps);
  assert.ok(requests[0]); assert.equal(requests[0], requests[1]);
  assert.equal(fs.existsSync(path.join(f.dir, '.fleet-mail-poll.json')), false);
  assert.equal(readInbox(f.home).length, 1);
});
test('prompt backlog is durable while each poll handles at most one prompt', async t => {
  const f = fixture(t); const spawns = [];
  fs.writeFileSync(path.join(f.dir, 'fleet-agent-optin.json'), '{"accept":["prompt"]}');
  f.deps.spawnImpl = spawnDouble(spawns); let first = true;
  f.deps.request = async kind => { if (kind !== 'mail-poll') return { mail: {} }; const messages = first ? [mail({ kind: 'prompt' }), mail({ id: 'mail-second', kind: 'prompt' }), mail({ id: 'mail-note' })] : []; first = false; return { messages }; };
  await main(['--poll'], f.deps); assert.equal(spawns.length, 1); assert.equal(readInbox(f.home).length, 3);
  await main(['--poll'], f.deps); assert.equal(spawns.length, 2);
});

test('dry-run secret redaction preserves valid JSON', async t => {
  const f = fixture(t);
  f.deps.request = async () => ({ messages: [mail({ body: 'token=secret' })] });
  await main(['--poll', '--dry-run'], f.deps);
  assert.equal(JSON.parse(f.output[0])[0].body, '[REDACTED]');
});
