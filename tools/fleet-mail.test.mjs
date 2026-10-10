import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { main, parseArgs, createClient, waitForReply, acquireLock, LOCK_MS, readInbox, findPriorReply, resolveRemoteName, parseExecMarkers } from './fleet-mail.mjs';
import { main as register } from './register-fleet-mail.mjs';
import { consentCommand } from './fleet-agent.mjs';
import { listDecisions, markDecisions, queuePath } from './pending-decisions.mjs';

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
for (const to of ['作業用011', '作業用０１１', '  作業用011　']) {
  test(`send resolves remoteName ${JSON.stringify(to)} to the PC label (not a possibly shared hostname)`, async t => {
    const f = fixture(t);
    f.deps.pcMap = { 'kimko-PC': { remoteName: '作業用011', hostname: 'DESKTOP-PPD5V8I' } };
    assert.equal(await main(['--send', '--to', to, '--kind', 'note', '--body-file', f.body, '--why', 'test'], f.deps), 0);
    assert.equal(f.calls[0].payload.to, 'kimko-PC');
    assert.deepEqual(f.errors, [`${to} → kimko-PC`]);
    const logs = fs.readFileSync(path.join(f.dir, 'fleet-mail-sent.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(logs.every(entry => entry.to === 'kimko-PC'));
  });
}
test('send preserves unmatched targets without stderr output', async t => {
  const f = fixture(t);
  f.deps.pcMap = { 'kimko-PC': { remoteName: '作業用011', hostname: 'DESKTOP-PPD5V8I' } };
  for (const to of ['other-PC', '  other-ＰＣ　', 'all', '作業用01']) {
    assert.equal(await main(['--send', '--to', to, '--kind', 'note', '--body-file', f.body, '--why', 'test'], f.deps), 0);
    assert.equal(f.calls.at(-1).payload.to, to);
  }
  assert.deepEqual(f.errors, []);
});
test('resolveRemoteName normalizes roster names and falls back to the PC label', () => {
  assert.deepEqual(resolveRemoteName('作業用011', { 'kimko-PC': { remoteName: '　作業用０１１ ' } }), { to: 'kimko-PC', resolved: true });
});
test('resolveRemoteName excludes reserved keys and unverified entries', () => {
  const pcMap = {
    _note: { remoteName: '作業用011', hostname: 'wrong-note' },
    _unverified: { remoteName: '作業用011', hostname: 'wrong-unverified', 'other-PC': { remoteName: '作業用012', hostname: 'wrong-nested' } }
  };
  for (const to of ['作業用011', '作業用012']) assert.deepEqual(resolveRemoteName(to, pcMap), { to, resolved: false });
});
test('resolveRemoteName passes through missing or invalid roster data', () => {
  for (const pcMap of [undefined, null, 'broken', [], { bad: null, other: { remoteName: 11 } }]) {
    assert.deepEqual(resolveRemoteName(' 作業用０１１ ', pcMap), { to: ' 作業用０１１ ', resolved: false });
  }
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
test('findPriorReply: sent.jsonl with reply line blocks reply without --force', async t => {
  const f = fixture(t);
  const sentFile = path.join(f.dir, 'fleet-mail-sent.jsonl');
  fs.writeFileSync(sentFile, `${JSON.stringify({ at: '2025-01-01T00:00:00Z', action: 'reply', id: 'mail-123' })}\n`);
  assert.equal(await main(['--reply', 'mail-123', '--body-file', f.body], f.deps), 3);
  assert.equal(f.calls.length, 0);
  assert.ok(f.errors.some(e => e.includes('返信済み')));
});
test('findPriorReply: --force sends and marks forced', async t => {
  const f = fixture(t);
  const sentFile = path.join(f.dir, 'fleet-mail-sent.jsonl');
  fs.writeFileSync(sentFile, `${JSON.stringify({ at: '2025-01-01T00:00:00Z', action: 'reply', id: 'mail-123' })}\n`);
  assert.equal(await main(['--reply', 'mail-123', '--body-file', f.body, '--force'], f.deps), 0);
  assert.equal(f.calls.length, 1);
  const sentLog = fs.readFileSync(sentFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(sentLog[sentLog.length - 1].forced, true);
});
test('inbox updated after reply, second reply blocked', async t => {
  const f = fixture(t);
  const inboxDir = path.join(f.dir, 'fleet-inbox');
  fs.mkdirSync(inboxDir);
  const mailObj = mail({ status: 'new', resultBody: '' });
  fs.writeFileSync(path.join(inboxDir, 'mail-20260921-1234.json'), JSON.stringify(mailObj));
  fs.writeFileSync(f.body, 'test reply');
  assert.equal(await main(['--reply', 'mail-20260921-1234', '--body-file', f.body], f.deps), 0);
  const updated = JSON.parse(fs.readFileSync(path.join(inboxDir, 'mail-20260921-1234.json'), 'utf8'));
  assert.equal(updated.status, 'done');
  assert.equal(updated.resultBody, 'test reply');
  assert.ok(updated.readAt);
  assert.ok(updated.resultAt);
  assert.equal(f.calls.length, 1);
  // second attempt without --force should fail
  assert.equal(await main(['--reply', 'mail-20260921-1234', '--body-file', f.body], f.deps), 3);
  assert.equal(f.calls.length, 1); // no extra network call
  assert.ok(f.errors.some(e => e.includes('返信済み')));
});
test('request fails: inbox unchanged, no sent log', async t => {
  const f = fixture(t);
  const inboxDir = path.join(f.dir, 'fleet-inbox');
  fs.mkdirSync(inboxDir);
  const mailObj = mail({ status: 'new', resultBody: '' });
  fs.writeFileSync(path.join(inboxDir, 'mail-20260921-1234.json'), JSON.stringify(mailObj));
  f.deps.request = async () => { throw new Error('network error'); };
  await assert.rejects(() => main(['--reply', 'mail-20260921-1234', '--body-file', f.body], f.deps), /network error/);
  // inbox should still be 'new'
  const after = JSON.parse(fs.readFileSync(path.join(inboxDir, 'mail-20260921-1234.json'), 'utf8'));
  assert.equal(after.status, 'new');
  // sent.jsonl should not have a reply line
  const sentFile = path.join(f.dir, 'fleet-mail-sent.jsonl');
  if (fs.existsSync(sentFile)) {
    const lines = fs.readFileSync(sentFile, 'utf8').trim().split('\n');
    assert.equal(lines.filter(l => l.includes('"action":"reply"')).length, 0);
  }
});
test('findPriorReply: malformed lines ignored, different id ignored', async t => {
  const f = fixture(t);
  const sentFile = path.join(f.dir, 'fleet-mail-sent.jsonl');
  fs.writeFileSync(sentFile, `garbage\n${JSON.stringify({ at: '2025-01-01T00:00:00Z', action: 'reply', id: 'mail-other' })}\n`);
  // no prior for mail-123 → should proceed
  assert.equal(await main(['--reply', 'mail-123', '--body-file', f.body], f.deps), 0);
  assert.equal(f.calls.length, 1);
});
test('parseArgs: --poll --force rejects, --reply --body-file --force accepts', t => {
  assert.throws(() => parseArgs(['--poll', '--force']), /option not applicable/);
  const opts = parseArgs(['--reply', 'mail-1', '--body-file', 'x', '--force']);
  assert.equal(opts['--reply'], 'mail-1');
  assert.equal(opts['--body-file'], 'x');
  assert.equal(opts['--force'], true);
});
test('findPriorReply treats a damaged inbox file as no record', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.dir, 'fleet-inbox'));
  fs.writeFileSync(path.join(f.dir, 'fleet-inbox', 'mail-9.json'), '{broken');
  assert.equal(findPriorReply(f.dir, 'mail-9'), null);
  fs.writeFileSync(path.join(f.dir, 'fleet-inbox', 'mail-9.json'), JSON.stringify({ id: 'mail-9', status: 'done', resultAt: '2026-10-01T00:00:00Z' }));
  assert.deepEqual(findPriorReply(f.dir, 'mail-9'), { at: '2026-10-01T00:00:00Z', action: 'inbox-done' });
});

for (const [why, body, subject] of [
  ['  [判断依頼] 見積承認', '詳細', '見積承認'],
  ['', '  [判断依頼] 本文の件名\n詳細', '本文の件名'],
  ['優先する件名', '[判断依頼] 本文', '優先する件名'],
  ['[判断依頼] ', '[判断依頼] 本文の件名\n詳細', '本文の件名'],
]) {
  test(`decision note uses subject ${JSON.stringify(why)} / ${JSON.stringify(body)}`, async t => {
    const f = fixture(t);
    f.deps.request = async () => ({ messages: [mail({ why, body })] });
    assert.equal(await main(['--poll'], f.deps), 0);
    const decisions = listDecisions({ home: f.home });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].source, `fleet-mail:other-PC:${mail().id}`);
    assert.equal(decisions[0].text, `[判断依頼] ${subject} / from=other-PC id=${mail().id}`);
    assert.equal(decisions[0].status, 'pending');
  });
}
test('ordinary notes and marked prompts do not create decisions', async t => {
  const f = fixture(t);
  f.deps.request = async kind => kind === 'mail-poll' ? { messages: [mail(), mail({ id: 'mail-prompt', kind: 'prompt', why: '[判断依頼] 確認' })] } : { mail: {} };
  await main(['--poll'], f.deps);
  assert.deepEqual(listDecisions({ home: f.home }), []);
});
test('repeated decision note stays unique, including an already batched source', async t => {
  const f = fixture(t);
  f.deps.request = async () => ({ messages: [mail({ why: '[判断依頼] 承認' })] });
  await main(['--poll'], f.deps);
  await main(['--poll'], f.deps);
  const decisions = listDecisions({ home: f.home });
  assert.equal(decisions.length, 1);
  markDecisions([decisions[0].id], { home: f.home, status: 'batched' });
  // Exercise source deduplication even when local mail receipt tracking was lost.
  fs.unlinkSync(path.join(f.dir, '.fleet-mail-processed'));
  fs.unlinkSync(path.join(f.dir, 'fleet-inbox', `${mail().id}.json`));
  await main(['--poll'], f.deps);
  assert.deepEqual(listDecisions({ home: f.home }), [{ ...decisions[0], status: 'batched' }]);
});
test('decision text is limited to 200 characters', async t => {
  const f = fixture(t);
  const why = '[判断依頼] ' + '件'.repeat(300);
  f.deps.request = async () => ({ messages: [mail({ why })] });
  await main(['--poll'], f.deps);
  assert.equal(listDecisions({ home: f.home })[0].text, `${why} / from=other-PC id=${mail().id}`.slice(0, 200));
});
test('decision storage failure is logged without stopping receipt of the batch', async t => {
  const f = fixture(t);
  fs.mkdirSync(queuePath({ home: f.home }));
  f.deps.request = async () => ({ messages: [mail({ why: '[判断依頼] 承認' }), mail({ id: 'mail-next' })] });
  assert.equal(await main(['--poll'], f.deps), 0);
  assert.equal(readInbox(f.home).length, 2);
  const failure = JSON.parse(fs.readFileSync(path.join(f.dir, 'fleet-mail-decision-intake-failed.jsonl'), 'utf8'));
  assert.equal(failure.id, mail().id);
  assert.ok(failure.error);
});

// --- 2026-10-10 事故の再発防止: --sent-status / 返信ガイド / 受領確認自動返信 / 判断依頼ガード ---
test('--sent-status shows status, deliveredAt and resultAt without side effects', async t => {
  const f = fixture(t);
  f.deps.request = async (kind, p) => { f.calls.push({ kind, p }); return { mail: { id: p.id, status: 'done', deliveredAt: '2026-10-10T01:00:00Z', resultAt: '2026-10-10T02:00:00Z' } }; };
  assert.equal(await main(['--sent-status', 'mail-1'], f.deps), 0);
  assert.deepEqual(f.calls, [{ kind: 'mail-get', p: { id: 'mail-1' } }]);
  assert.match(f.output[0], /status: done/);
  assert.match(f.output[0], /deliveredAt: 2026-10-10T01:00:00Z/);
  assert.match(f.output[0], /resultAt: 2026-10-10T02:00:00Z/);
});
test('--sent-status reports missing mail as exit 4', async t => {
  const f = fixture(t);
  f.deps.request = async () => ({ mail: null });
  assert.equal(await main(['--sent-status', 'mail-1'], f.deps), 4);
  assert.ok(f.errors.some(e => e.includes('見つかりません')));
});
test('--reply prints delivery guidance pointing to --sent-status', async t => {
  const f = fixture(t);
  f.deps.request = async () => ({ mail: {} });
  assert.equal(await main(['--reply', 'mail-1', '--body-file', f.body], f.deps), 0);
  assert.deepEqual(f.output, ['返信済み: mail-1', '返信は相手の受信タスクが拾うまで届きません。届いたかは --sent-status mail-1 で確認']);
});
test('decision note auto-acknowledges with decision id and original deadline', async t => {
  const f = fixture(t);
  f.deps.request = async (kind, p) => { f.calls.push({ kind, p }); return kind === 'mail-poll' ? { messages: [mail({ why: '[判断依頼] 承認' })] } : { mail: {} }; };
  await main(['--poll'], f.deps);
  const ack = f.calls.find(c => c.kind === 'mail-reply');
  assert.ok(ack, '受領確認の mail-reply が送信されている');
  assert.equal(ack.p.id, mail().id);
  assert.equal(ack.p.from, 'kim-PC');
  assert.match(ack.p.resultBody, /^受領しました。kim の判断待ちとして登録（決定ID \d{8,}-\d{3}）。回答は kim が決めた後に別の note で送ります。期限: 2099-01-01T00:00:00Z$/);
  const sentLog = fs.readFileSync(path.join(f.dir, 'fleet-mail-sent.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(sentLog.some(entry => entry.action === 'decision-ack' && entry.id === mail().id));
  // 受領確認で inbox を既読化しない: 対話セッションが kim へ聞くまで残る
  assert.equal(readInbox(f.home).length, 1);
});
test('decision ack failure does not fail the poll and is logged', async t => {
  const f = fixture(t);
  f.deps.request = async kind => { if (kind === 'mail-poll') return { messages: [mail({ why: '[判断依頼] 承認' })] }; throw new Error('ack offline'); };
  assert.equal(await main(['--poll'], f.deps), 0);
  assert.equal(readInbox(f.home).length, 1);
  const failure = JSON.parse(fs.readFileSync(path.join(f.dir, 'fleet-mail-decision-ack-failed.jsonl'), 'utf8'));
  assert.equal(failure.id, mail().id);
  assert.ok(failure.error);
});
test('prompt containing a decision request is skipped headlessly: no spawn, no reply, logged', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'fleet-agent-optin.json'), '{"accept":["prompt"]}');
  f.deps.spawnImpl = () => assert.fail('判断依頼プロンプトを実行してはならない');
  f.deps.request = async (kind, p) => { f.calls.push({ kind, p }); return kind === 'mail-poll' ? { messages: [mail({ kind: 'prompt', why: '[判断依頼] 進行方針' })] } : { mail: {} }; };
  await main(['--poll'], f.deps);
  assert.ok(!f.calls.some(c => c.kind === 'mail-reply'), '判断依頼への返信は行わない');
  const skip = JSON.parse(fs.readFileSync(path.join(f.dir, 'fleet-mail-decision-request-skipped.jsonl'), 'utf8'));
  assert.equal(skip.id, mail().id);
  const result = JSON.parse(fs.readFileSync(path.join(f.dir, 'fleet-agent-results', `${mail().id}.json`), 'utf8'));
  assert.match(result.outputTail, /decision-request-skipped/);
  // 処理済みとして記録され、次の poll で再扱いしない
  await main(['--poll'], f.deps);
  const skips = fs.readFileSync(path.join(f.dir, 'fleet-mail-decision-request-skipped.jsonl'), 'utf8').trim().split('\n');
  assert.equal(skips.length, 1);
});
test('pollOnce with executePrompts:false receives notes and leaves prompts for the task', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'fleet-agent-optin.json'), '{"accept":["prompt"]}');
  f.deps.spawnImpl = () => assert.fail('hook 経由の受信で prompt を実行してはならない');
  f.deps.request = async () => ({ messages: [mail({ kind: 'prompt' }), mail({ id: 'mail-note-2' })] });
  const { pollOnce } = await import('./fleet-mail.mjs');
  const output = [], errors = [];
  const result = await pollOnce({ home: f.home, identity: { hostname: 'host-kim' }, request: f.deps.request, executePrompts: false, spawnImpl: f.deps.spawnImpl, stdout: t2 => output.push(t2), stderr: t2 => errors.push(t2) });
  assert.equal(result.handled.length, 1); // note のみ処理済み
  assert.equal(readInbox(f.home).length, 2);
  const processed = fs.readFileSync(path.join(f.dir, '.fleet-mail-processed'), 'utf8').trim().split('\n');
  assert.ok(!processed.includes(mail().id), 'prompt は未処理のまま受信タスクに残す');
  assert.ok(processed.includes('mail-note-2'));
  const lastPoll = JSON.parse(fs.readFileSync(path.join(f.dir, '.fleet-mail-last-poll.json'), 'utf8'));
  assert.ok(lastPoll.at);
});
test('register --ensure skips PowerShell when both tasks probe healthy', t => {
  const f = fixture(t);
  const calls = [];
  const spawnImpl = (program, args) => {
    calls.push({ program, args });
    const command = args.find(a => a.includes('Get-ScheduledTask')) || '';
    if (command) return { status: 0, stdout: 'ok' };
    return { status: 0, stdout: 'registered' };
  };
  register({ home: f.home, platform: 'win32', spawnImpl, ensure: true });
  assert.ok(calls.every(c => c.args.join(' ').includes('-Command')), '健康判定の probe のみで再登録しない');
});

// --- --exec codex: 相手PCの Codex に実装させる経路 ---
const execMail = (overrides = {}) => mail({ kind: 'prompt', body: '<!-- fleet-exec: codex -->\n実装して', ...overrides });
function detachedDouble(calls) {
  return (program, args, options) => {
    calls.push({ program, args, options });
    return { unref: () => { calls.at(-1).unrefed = true; } };
  };
}

test('parseExecMarkers strips the exec marker and optional cwd marker', () => {
  assert.deepEqual(parseExecMarkers('<!-- fleet-exec: codex -->\n本文'), { exec: 'codex', cwd: null, body: '本文' });
  assert.deepEqual(parseExecMarkers('<!-- fleet-exec: codex -->\n<!-- fleet-exec-cwd: /repo -->\n本文'), { exec: 'codex', cwd: '/repo', body: '本文' });
  assert.deepEqual(parseExecMarkers('普通の本文'), { exec: null, cwd: null, body: '普通の本文' });
});

test('send --exec codex inserts markers, defaults expiry to +6h and logs exec', async t => {
  const f = fixture(t); const transport = [];
  f.deps.now = () => Date.parse('2026-09-21T00:00:00Z'); f.deps.randomInt = () => 1234;
  delete f.deps.request;
  f.deps.fetch = async (url, opts) => { transport.push({ url, payload: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ ok: true, mail: {} }) }; };
  assert.equal(await main(['--send', '--to', 'other-PC', '--kind', 'prompt', '--body-file', f.body, '--why', '実装', '--exec', 'codex', '--exec-cwd', '/repo'], f.deps), 0);
  assert.equal(transport[0].payload.body, '<!-- fleet-exec: codex -->\n<!-- fleet-exec-cwd: /repo -->\n質問 $() `literal`');
  assert.equal(transport[0].payload.expiresAt, '2026-09-21T06:00:00.000Z');
  const logs = fs.readFileSync(path.join(f.dir, 'fleet-mail-sent.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(logs.every(entry => entry.exec === 'codex'));
  // 本文ファイル自体は変更しない
  assert.equal(fs.readFileSync(f.body, 'utf8'), '質問 $() `literal`');
});

test('send --exec codex without cwd inserts only the exec marker', async t => {
  const f = fixture(t); const transport = [];
  f.deps.now = () => Date.parse('2026-09-21T00:00:00Z'); f.deps.randomInt = () => 1234;
  delete f.deps.request;
  f.deps.fetch = async (url, opts) => { transport.push({ payload: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ ok: true, mail: {} }) }; };
  await main(['--send', '--to', 'other-PC', '--kind', 'prompt', '--body-file', f.body, '--why', '実装', '--exec', 'codex'], f.deps);
  assert.equal(transport[0].payload.body, '<!-- fleet-exec: codex -->\n質問 $() `literal`');
});

test('parseArgs rejects --exec with note and unknown exec values', () => {
  assert.throws(() => parseArgs(['--send', '--to', 'PC', '--kind', 'note', '--body-file', 'x', '--why', 'y', '--exec', 'codex']), /--exec は --kind prompt でのみ使えます/);
  assert.throws(() => parseArgs(['--send', '--to', 'PC', '--kind', 'prompt', '--body-file', 'x', '--why', 'y', '--exec', 'gemini']), /--exec は codex のみ対応/);
  assert.throws(() => parseArgs(['--send', '--to', 'PC', '--kind', 'prompt', '--body-file', 'x', '--why', 'y', '--exec-cwd', '/repo']), /--exec-cwd は --exec codex と併用/);
});

test('exec codex without opt-in replies with consent command and never spawns', async t => {
  const f = fixture(t);
  f.deps.spawnImpl = () => assert.fail('未オプトインで runner を起動してはならない');
  f.deps.request = async (kind, p) => { f.calls.push({ kind, p }); return kind === 'mail-poll' ? { messages: [execMail()] } : { mail: {} }; };
  await main(['--poll'], f.deps);
  const reply = f.calls.find(c => c.kind === 'mail-reply');
  assert.equal(reply.p.resultBody, `未オプトイン。承諾コマンド: ${consentCommand('codex')}`);
  assert.equal(fs.existsSync(path.join(f.dir, 'fleet-agent-results', `${execMail().id}.json`)), false);
});

test('exec codex first poll detaches runner, records executionStartedAt and does not reply', async t => {
  const f = fixture(t); const spawns = [];
  fs.writeFileSync(path.join(f.dir, 'fleet-agent-optin.json'), '{"accept":["codex"]}');
  f.deps.spawnImpl = detachedDouble(spawns);
  f.deps.request = async (kind, p) => { f.calls.push({ kind, p }); return kind === 'mail-poll' ? { messages: [execMail()] } : { mail: {} }; };
  await main(['--poll'], f.deps);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].options.detached, true);
  assert.equal(spawns[0].options.stdio, 'ignore');
  assert.equal(spawns[0].unrefed, true);
  assert.match(spawns[0].args[0], /fleet-task-runner\.mjs$/);
  assert.deepEqual(spawns[0].args.slice(1), ['--id', execMail().id]);
  assert.ok(!f.calls.some(c => c.kind === 'mail-reply'), '初回は返信しない');
  const inbox = JSON.parse(fs.readFileSync(path.join(f.dir, 'fleet-inbox', `${execMail().id}.json`), 'utf8'));
  assert.ok(inbox.executionStartedAt);
  // 実行中は processed に入れない（結果ファイル待ち）
  assert.ok(!fs.existsSync(path.join(f.dir, '.fleet-mail-processed')) || !fs.readFileSync(path.join(f.dir, '.fleet-mail-processed'), 'utf8').includes(execMail().id));
});

test('exec codex replies and marks processed once the result file exists', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'fleet-agent-optin.json'), '{"accept":["codex"]}');
  fs.mkdirSync(path.join(f.dir, 'fleet-agent-results'), { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'fleet-agent-results', `${execMail().id}.json`), JSON.stringify({ exitCode: 0, outputTail: '[fleet-exec codex] exit=0 cwd=/repo 所要=3分' }));
  f.deps.spawnImpl = () => assert.fail('結果ファイルがあるときは runner を起動しない');
  f.deps.request = async (kind, p) => { f.calls.push({ kind, p }); return kind === 'mail-poll' ? { messages: [execMail()] } : { mail: {} }; };
  await main(['--poll'], f.deps);
  const reply = f.calls.find(c => c.kind === 'mail-reply');
  assert.match(reply.p.resultBody, /\[fleet-exec codex\] exit=0/);
  assert.ok(fs.readFileSync(path.join(f.dir, '.fleet-mail-processed'), 'utf8').includes(execMail().id));
});

test('exec codex times out after two hours without a result file', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'fleet-agent-optin.json'), '{"accept":["codex"]}');
  const started = '2026-09-21T00:00:00Z';
  f.deps.now = () => Date.parse('2026-09-21T03:00:00Z');
  f.deps.spawnImpl = () => assert.fail('タイムアウト時は runner を起動しない');
  f.deps.request = async (kind, p) => { f.calls.push({ kind, p }); return kind === 'mail-poll' ? { messages: [execMail({ executionStartedAt: started })] } : { mail: {} }; };
  await main(['--poll'], f.deps);
  const reply = f.calls.find(c => c.kind === 'mail-reply');
  assert.equal(reply.p.resultBody, 'codex 実行がタイムアウト（結果ファイル未生成）');
  assert.ok(fs.readFileSync(path.join(f.dir, '.fleet-mail-processed'), 'utf8').includes(execMail().id));
});

test('exec codex still running within two hours neither replies nor spawns', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'fleet-agent-optin.json'), '{"accept":["codex"]}');
  f.deps.now = () => Date.parse('2026-09-21T01:00:00Z');
  f.deps.spawnImpl = () => assert.fail('実行中は runner を再起動しない');
  f.deps.request = async (kind, p) => { f.calls.push({ kind, p }); return kind === 'mail-poll' ? { messages: [execMail({ executionStartedAt: '2026-09-21T00:00:00Z' })] } : { mail: {} }; };
  await main(['--poll'], f.deps);
  assert.ok(!f.calls.some(c => c.kind === 'mail-reply'));
});

test('exec codex with a decision request is skipped headlessly', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'fleet-agent-optin.json'), '{"accept":["codex"]}');
  f.deps.spawnImpl = () => assert.fail('判断依頼は実行しない');
  f.deps.request = async (kind, p) => { f.calls.push({ kind, p }); return kind === 'mail-poll' ? { messages: [execMail({ why: '[判断依頼] 方針' })] } : { mail: {} }; };
  await main(['--poll'], f.deps);
  assert.ok(!f.calls.some(c => c.kind === 'mail-reply'));
  const skip = JSON.parse(fs.readFileSync(path.join(f.dir, 'fleet-mail-decision-request-skipped.jsonl'), 'utf8'));
  assert.equal(skip.id, execMail().id);
});

test('exec codex is not executed when executePrompts is false', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'fleet-agent-optin.json'), '{"accept":["codex"]}');
  f.deps.spawnImpl = () => assert.fail('hook 経由の受信で runner を起動してはならない');
  f.deps.request = async () => ({ messages: [execMail()] });
  const { pollOnce } = await import('./fleet-mail.mjs');
  const result = await pollOnce({ home: f.home, identity: { hostname: 'host-kim' }, request: f.deps.request, executePrompts: false, spawnImpl: f.deps.spawnImpl, stdout: () => {}, stderr: () => {} });
  assert.equal(result.handled.length, 0);
  assert.equal(readInbox(f.home).length, 1);
});

