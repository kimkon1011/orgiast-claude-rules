import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { main, pollOnce, readInbox, syncMailState, resolveMailTarget, mailId, parseArgs, waitForReply, createClient, TERMINAL_STATUSES, hasDecisionRequest } from './fleet-mail.mjs';
const pcMap = JSON.parse(fs.readFileSync(new URL('../fleet-pc-map.json', import.meta.url), 'utf8'));
const labels = Object.keys(pcMap).filter(key => !key.startsWith('_'));
const receiver = labels[0], sender = labels.find(label => label !== receiver && pcMap[label].hostname);
const now = Date.parse('2026-10-14T00:00:00Z');
const iso = offset => new Date(now + offset).toISOString();
const mail = (overrides = {}) => ({ id: 'mail-original', from: sender, to: receiver, kind: 'note', body: 'body', why: 'test', status: 'delivered', createdAt: iso(-1000), expiresAt: iso(86400000), ...overrides });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-v2-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'), inbox = path.join(dir, 'fleet-inbox'); fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.invalid/mail\nFLEET_SHEET_TOKEN=fixture\n');
  fs.writeFileSync(path.join(dir, 'cost-reporter.env'), `REPORTER_LABEL=${receiver}\n`);
  const body = path.join(home, 'body.txt'); fs.writeFileSync(body, 'nonempty test body');
  const calls = [], output = [], errors = [];
  const deps = { home, pcMap, identity: { hostname: pcMap[receiver].hostname }, now: () => now, stdout: s => output.push(s), stderr: s => errors.push(s),
    fetchBeacons: async () => ({ ok: false, beacons: [] }), dailySelfHeal: () => {}, autoRunFixNow: () => {},
    request: async (kind, payload) => { calls.push({ kind, payload: structuredClone(payload) }); return kind === 'mail-poll' ? { ok: true, messages: [] } : { ok: true, mail: payload }; } };
  const save = m => fs.writeFileSync(path.join(inbox, `${m.id}.json`), JSON.stringify(m));
  const read = id => JSON.parse(fs.readFileSync(path.join(inbox, `${id}.json`), 'utf8'));
  return { home, dir, inbox, body, deps, calls, output, errors, save, read };
}
const sendArgs = (f, to = sender, extra = []) => ['--send', '--to', to, '--kind', 'note', '--body-file', f.body, '--why', 'test', ...extra];

test('partial kim is exit 4 with roster candidates on the real dry-run send path and no writes', async t => {
  const f = fixture(t), before = fs.readdirSync(f.dir);
  f.deps.request = () => assert.fail('must not send');
  assert.equal(await main(sendArgs(f, 'kim', ['--dry-run']), f.deps), 4);
  const expected = labels.filter(label => label.startsWith('kim')).sort().slice(0, 5);
  assert.ok(expected.length);
  for (const label of expected) assert.ok(f.errors[0].includes(label));
  assert.deepEqual(fs.readdirSync(f.dir), before);
  assert.equal(await main(sendArgs(f, 'kim', ['--force']), f.deps), 4);
});
test('exact remote name, label, hostname and all resolve to canonical targets', () => {
  for (const label of labels) {
    assert.equal(resolveMailTarget(label, pcMap).to, label);
    const entry = pcMap[label];
    if (entry.remoteName) assert.equal(resolveMailTarget(entry.remoteName, pcMap).to, label);
    if (entry.hostname) assert.equal(resolveMailTarget(entry.hostname, pcMap).to, label);
  }
  assert.equal(resolveMailTarget('all', pcMap).to, 'all');
  assert.deepEqual(resolveMailTarget('new-host', pcMap, [{ label: 'beacon-label', hostname: 'new-host' }]), { to: 'beacon-label', resolved: true });
  assert.equal(resolveMailTarget('new-h', pcMap, [{ label: 'beacon-label', hostname: 'new-host' }]).resolved, false);
});
test('send ids have timestamp + random 8 hex; duplicate retries once with a different id', async t => {
  const f = fixture(t); let n = 0;
  f.deps.randomBytes = () => Buffer.from([0, 0, 0, ++n]);
  f.deps.request = async (kind, payload) => { f.calls.push({ kind, payload: structuredClone(payload) }); return { ok: true, duplicate: f.calls.length === 1, mail: payload }; };
  assert.equal(await main(sendArgs(f), f.deps), 0);
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[0].payload.id, f.calls[1].payload.id);
  for (const { payload } of f.calls) {
    assert.match(payload.id, /^mail-\d+-[a-f0-9]{8}$/); assert.equal(payload.auto, false); assert.equal(payload.hop, 0);
  }
  assert.ok(f.errors.some(s => s.includes(`--sent-status ${f.calls[1].payload.id}`)));
  f.calls.length = 0;
  f.deps.request = async (_kind, payload) => { f.calls.push(structuredClone(payload)); return { ok: true, duplicate: true, mail: payload }; };
  assert.equal(await main(sendArgs(f), f.deps), 1); assert.equal(f.calls.length, 2);
  assert.notEqual(mailId(), mailId());
});
test('urgent override and automatic tags reach mail-send; valid dry-run is side-effect free', async t => {
  const f = fixture(t);
  for (const extra of [['--priority', 'urgent'], []]) {
    if (!extra.length) fs.writeFileSync(f.body, '  [作業依頼] action');
    assert.equal(await main(sendArgs(f, sender, extra), f.deps), 0); assert.equal(f.calls.at(-1).payload.priority, 'urgent');
  }
  const count = f.calls.length, before = fs.readFileSync(path.join(f.dir, 'fleet-mail-sent.jsonl'), 'utf8');
  assert.equal(await main(sendArgs(f, sender, ['--dry-run']), f.deps), 0);
  assert.equal(f.calls.length, count); assert.equal(fs.readFileSync(path.join(f.dir, 'fleet-mail-sent.jsonl'), 'utf8'), before);
});
test('processed migration marks only existing inbox ids done and removes the legacy file', async t => {
  const f = fixture(t); f.save(mail()); f.save(mail({ id: 'mail-unprocessed' })); f.save(mail({ id: 'mail-failed', status: 'failed' }));
  const file = path.join(f.dir, '.fleet-mail-processed'); fs.writeFileSync(file, 'mail-original\nmail-missing\nmail-failed\n../../escape\n');
  await pollOnce(f.deps);
  assert.equal(fs.existsSync(file), false); assert.equal(f.read('mail-original').status, 'done'); assert.equal(f.read('mail-failed').status, 'failed');
  assert.equal(f.read('mail-unprocessed').status, 'delivered'); assert.equal(fs.existsSync(path.join(f.inbox, 'mail-missing.json')), false);
});
test('interactive done/failed/expired prompts and already-started prompts are never re-executed', async t => {
  const f = fixture(t);
  for (const status of TERMINAL_STATUSES) f.save(mail({ id: `mail-${status}`, status, kind: 'prompt' }));
  f.save(mail({ id: 'mail-started', kind: 'prompt', executionStartedAt: iso(-1000) }));
  f.deps.spawnImpl = () => assert.fail('must not spawn');
  await pollOnce(f.deps); assert.equal(f.calls.filter(c => c.kind === 'mail-reply').length, 0);
  assert.equal(f.read('mail-done').status, 'done');
});
test('one poison message cannot block the batch; quarantine uses safe names and reports mail-fail', async t => {
  const f = fixture(t);
  const messages = [null, mail({ id: '../../bad' }), mail({ id: 'mail-bad', kind: 'bad' }), mail()];
  const original = f.deps.request;
  f.deps.request = async (kind, payload) => kind === 'mail-poll' ? { messages } : original(kind, payload);
  const result = await pollOnce(f.deps);
  assert.equal(result.rejected, 3); assert.equal(f.read('mail-original').status, 'delivered');
  const names = fs.readdirSync(path.join(f.inbox, 'quarantine')); assert.equal(names.length, 3); assert.ok(names.every(name => /^mail-[\w-]+\.json$/.test(name)));
  assert.deepEqual(f.calls.filter(c => c.kind === 'mail-fail').map(c => c.payload.id), ['mail-bad']);
  assert.equal(fs.existsSync(path.join(f.dir, '.fleet-mail-poll.json')), false);
});
test('poll receipt confirms only durable successes if one inbox path is unwritable', async t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.inbox, 'mail-bad.json'));
  f.deps.request = async kind => kind === 'mail-poll' ? { messages: [mail({ id: 'mail-bad' }), mail()] } : { ok: true, mail: {} };
  await pollOnce(f.deps);
  const batch = JSON.parse(fs.readFileSync(path.join(f.dir, '.fleet-mail-poll.json'), 'utf8'));
  assert.deepEqual(batch.successfulIds, ['mail-original']); assert.equal(f.read('mail-original').status, 'delivered');
});
test('failed mail-fail transport stays in quarantine and retries on the next poll', async t => {
  const f = fixture(t); let first = true;
  f.deps.request = async (kind, payload) => {
    f.calls.push({ kind, payload });
    if (kind === 'mail-poll') return { messages: first ? [mail({ kind: 'invalid' })] : [] };
    if (first) throw new Error('offline'); return { ok: true, mail: {} };
  };
  await pollOnce(f.deps); first = false; await pollOnce(f.deps);
  const record = JSON.parse(fs.readFileSync(path.join(f.inbox, 'quarantine', `${mail().id}.json`), 'utf8'));
  assert.deepEqual(record.pendingServer, []); assert.equal(f.calls.filter(c => c.kind === 'mail-fail').length, 2);
});
test('reply receipts join a sent original once and do not cause an automatic reply', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'fleet-mail-sent.jsonl'), `${JSON.stringify({ id: 'mail-sent', action: 'sent' })}\nmalformed\n`);
  const reply = mail({ id: 'mail-reply-test', replyTo: 'mail-sent', body: 'answer', auto: true });
  f.deps.request = async kind => { assert.equal(kind, 'mail-poll'); return { messages: [reply] }; };
  await pollOnce(f.deps); await pollOnce(f.deps);
  const joined = fs.readFileSync(path.join(f.dir, 'fleet-mail-replies.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(joined.length, 1); assert.equal(joined[0].id, reply.replyTo); assert.equal(joined[0].resultBody, reply.body);
});
test('local expiry excludes pending mail while retaining completed mail', async t => {
  const f = fixture(t); f.save(mail({ expiresAt: iso(-1) })); f.save(mail({ id: 'mail-done', status: 'done', expiresAt: iso(-1) }));
  await pollOnce(f.deps); assert.equal(f.read(mail().id).status, 'expired'); assert.equal(f.read('mail-done').status, 'done'); assert.equal(readInbox(f.home).length, 0);
});
test('inbox --unseen selects unpresented pending mail and records seen with a retry queue', async t => {
  const f = fixture(t); f.save(mail()); f.save(mail({ id: 'mail-presented', presentedAt: iso(-500) })); f.save(mail({ id: 'mail-expired', expiresAt: iso(-1) }));
  f.deps.request = async () => { throw new Error('unknown action'); };
  assert.equal(await main(['--inbox', '--unseen', '--json'], f.deps), 0);
  assert.deepEqual(JSON.parse(f.output[0]).map(m => m.id), [mail().id]);
  assert.equal(f.read(mail().id).status, 'seen'); assert.deepEqual(f.read(mail().id).pendingServer, ['seen']); assert.equal(f.errors.length, 1);
  f.deps.request = async (kind, payload) => { f.calls.push({ kind, payload }); return kind === 'mail-poll' ? { messages: [] } : { ok: true, mail: {} }; };
  await pollOnce(f.deps); assert.deepEqual(f.read(mail().id).pendingServer, []); assert.equal(f.calls[0].kind, 'mail-seen');
});
test('ack and ack --all-seen complete only selected mail and retry the server intent', async t => {
  const f = fixture(t); f.save(mail()); f.save(mail({ id: 'mail-presented', presentedAt: iso(-1) }));
  f.deps.request = async () => ({ ok: false, error: 'unknown action' });
  assert.equal(await main(['--ack', '--all-seen'], f.deps), 0);
  assert.equal(f.read('mail-presented').status, 'done'); assert.deepEqual(f.read('mail-presented').pendingServer, ['ack']); assert.equal(f.read(mail().id).status, 'delivered');
  assert.equal(await main(['--ack', mail().id], f.deps), 0); assert.equal(f.read(mail().id).status, 'done');
  f.deps.request = async (kind, payload) => { f.calls.push({ kind, payload }); return kind === 'mail-poll' ? { messages: [] } : { ok: true, mail: {} }; };
  await pollOnce(f.deps); assert.equal(f.calls.filter(c => c.kind === 'mail-ack').length, 2);
});
test('old GAS fallback responses warn once without exiting; durable action remains pending', async t => {
  const f = fixture(t); f.save(mail());
  f.deps.request = createClient({ url: 'https://example.invalid', token: 'fixture', fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, action: 'updated' }) }) });
  assert.equal(await main(['--ack', mail().id], f.deps), 0); assert.equal(f.errors.length, 1); assert.deepEqual(f.read(mail().id).pendingServer, ['ack']);
});
test('sweep expires obsolete mail, completes old replies/no-reply notes, preserves unanswered decisions', async t => {
  const f = fixture(t);
  f.save(mail({ expiresAt: iso(-1) }));
  f.save(mail({ id: 'mail-reply-old', createdAt: iso(-73 * 3600000), expiresAt: iso(1000) }));
  f.save(mail({ id: 'mail-no-reply', why: '[回答・返信不要] complete' }));
  f.save(mail({ id: 'mail-decision', why: '[判断依頼] open', expiresAt: iso(-1) }));
  assert.equal(await main(['--sweep'], f.deps), 0);
  assert.equal(f.read(mail().id).status, 'expired'); assert.equal(f.read('mail-reply-old').status, 'done'); assert.equal(f.read('mail-no-reply').status, 'done'); assert.equal(f.read('mail-decision').status, 'delivered');
  assert.equal(f.calls.filter(c => c.kind === 'mail-ack').length, 2); assert.equal(f.calls.find(c => c.kind === 'mail-fail').payload.reason, 'expired');
  assert.deepEqual(f.output, ['完了=2 / 期限切れ=1']);
});
test('reply-to-reply is exit 3 unless forced, and human reply includes metadata', async t => {
  const f = fixture(t); f.save(mail({ id: 'mail-reply-test', hop: 1 }));
  assert.equal(await main(['--reply', 'mail-reply-test', '--body-file', f.body], f.deps), 3); assert.equal(f.calls.length, 0);
  assert.equal(await main(['--reply', 'mail-reply-test', '--body-file', f.body, '--force'], f.deps), 0);
  assert.equal(f.calls[0].payload.auto, false); assert.equal(f.calls[0].payload.hop, 2);
});
test('wait-for seen returns on seen or done, reports terminal failures, and defaults to done', async () => {
  for (const status of ['seen', 'done']) {
    const result = await waitForReply('mail-test', 1, { now: () => now, request: async () => ({ mail: { status } }), waitFor: 'seen' }); assert.equal(result.exitCode, 0);
  }
  assert.equal((await waitForReply('mail-test', 1, { now: () => now, request: async () => ({ mail: { status: 'expired' } }) })).exitCode, 1);
  assert.equal(parseArgs(['--send', '--to', sender, '--kind', 'note', '--body-file', 'fixture', '--why', 'test', '--wait', '1', '--wait-for', 'seen'])['--wait-for'], 'seen');
  assert.throws(() => parseArgs(['--send', '--to', sender, '--kind', 'note', '--body-file', 'fixture', '--why', 'test', '--wait-for', 'seen']));
});
test('sent-status includes delivery/seen actors and every state timestamp', async t => {
  const f = fixture(t), record = mail({ seenAt: iso(0), seenBy: 'headless', ackAt: iso(0), failedAt: iso(0), deliveredBy: receiver, deliveredAt: iso(-1), resultAt: iso(0) });
  f.deps.request = async () => ({ mail: record }); await main(['--sent-status', record.id], f.deps);
  for (const key of ['status', 'createdAt', 'expiresAt', 'deliveredAt', 'deliveredBy', 'seenAt', 'seenBy', 'resultAt', 'ackAt', 'failedAt']) assert.ok(f.output[0].includes(`${key}: ${record[key]}`));
});
test('automatic prompts do not execute or reply, and decision receipts are single auto sends', async t => {
  const f = fixture(t); f.save(mail({ kind: 'prompt', auto: true })); f.save(mail({ id: 'mail-decision', why: '[判断依頼] pending' }));
  f.deps.spawnImpl = () => assert.fail('no headless decision');
  await pollOnce(f.deps); await pollOnce(f.deps);
  const sent = f.calls.filter(c => c.kind === 'mail-send'); assert.equal(sent.length, 1); assert.equal(sent[0].payload.auto, true); assert.equal(sent[0].payload.hop, 1); assert.equal(sent[0].payload.replyTo, 'mail-decision');
  assert.equal(f.read('mail-decision').status, 'delivered'); assert.equal(f.calls.filter(c => c.kind === 'mail-reply').length, 0);
});
test('headless records mail-seen before spawn and keeps failed seen synchronization pending', async t => {
  const f = fixture(t); f.save(mail({ kind: 'prompt' })); fs.writeFileSync(path.join(f.dir, 'fleet-agent-optin.json'), '{"accept":["prompt"]}');
  const request = f.deps.request; f.deps.request = async (kind, payload) => { if (kind === 'mail-seen') { f.calls.push({ kind, payload }); throw new Error('unknown action'); } return request(kind, payload); };
  f.deps.resolveClaudeExe = () => 'fixture-claude';
  let seenBeforeSpawn = false;
  f.deps.spawnImpl = () => {
    seenBeforeSpawn = f.calls.some(c => c.kind === 'mail-seen' && c.payload.seenBy === 'headless');
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => { child.stdout.write('answer'); child.emit('close', 0); }); return child;
  };
  await pollOnce(f.deps); assert.equal(seenBeforeSpawn, true); assert.equal(f.read(mail().id).status, 'done'); assert.deepEqual(f.read(mail().id).pendingServer, ['seen']);
  const reply = f.calls.find(c => c.kind === 'mail-reply'); assert.equal(reply.payload.auto, true); assert.equal(reply.payload.hop, 1);
});
test('server terminal state wins over a delayed seen response', async t => {
  const f = fixture(t); f.save(mail());
  await syncMailState({ home: f.home, id: mail().id, action: 'seen', seenBy: 'headless', now: () => now,
    request: async () => ({ ok: true, mail: { status: 'done', resultBody: 'interactive answer', resultAt: iso(0) } }) });
  assert.equal(f.read(mail().id).status, 'done'); assert.equal(f.read(mail().id).resultBody, 'interactive answer');
});
test('corrupt local JSON is isolated and cannot block new mail or migration', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.inbox, 'mail-corrupt.json'), '{bad');
  fs.writeFileSync(path.join(f.dir, '.fleet-mail-processed'), 'mail-corrupt\n');
  const request = f.deps.request; f.deps.request = async (kind, payload) => kind === 'mail-poll' ? { messages: [mail()] } : request(kind, payload);
  await pollOnce(f.deps);
  assert.equal(f.read('mail-corrupt').status, 'failed'); assert.equal(f.read(mail().id).status, 'delivered');
  assert.ok(fs.existsSync(path.join(f.inbox, 'quarantine', 'mail-corrupt.json')));
  assert.equal(fs.existsSync(path.join(f.dir, '.fleet-mail-processed')), false);
});
test('interactive reply made while a prompt runs prevents automatic duplicate reply', async t => {
  const f = fixture(t); f.save(mail({ kind: 'prompt' })); fs.writeFileSync(path.join(f.dir, 'fleet-agent-optin.json'), '{"accept":["prompt"]}');
  f.deps.resolveClaudeExe = () => 'fixture-claude';
  f.deps.spawnImpl = () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => { f.save({ ...f.read(mail().id), status: 'done', resultBody: 'interactive' }); child.stdout.write('automatic'); child.emit('close', 0); }); return child;
  };
  await pollOnce(f.deps); assert.equal(f.calls.filter(c => c.kind === 'mail-reply').length, 0); assert.equal(f.read(mail().id).resultBody, 'interactive');
});
test('manual reply caches the server fixed reply body and cannot resurrect server-expired mail', async t => {
  const f = fixture(t); f.save(mail());
  f.deps.request = async () => ({ ok: true, duplicate: true, mail: { status: 'done', resultBody: 'first answer', resultAt: iso(-10) }, reply: { body: 'first answer' } });
  assert.equal(await main(['--reply', mail().id, '--body-file', f.body], f.deps), 0); assert.equal(f.read(mail().id).resultBody, 'first answer');
  f.save(mail()); f.deps.request = async () => ({ ok: true, mail: { status: 'expired' } });
  assert.equal(await main(['--reply', mail().id, '--body-file', f.body, '--force'], f.deps), 1); assert.equal(f.read(mail().id).status, 'expired');
});
test('legacy readAt-only inbox producers stay read; v2 delivered/seen are governed only by status', t => {
  const f = fixture(t); f.save(mail({ readAt: iso(-1) }));
  f.save(mail({ id: 'mail-v2-delivered', readAt: iso(-1), presentedAt: null }));
  f.save(mail({ id: 'mail-v2-seen', status: 'seen', readAt: iso(-1), seenAt: iso(-1) }));
  assert.deepEqual(readInbox(f.home).map(m => m.id).sort(), ['mail-v2-delivered', 'mail-v2-seen']);
});

test('execution markers do not hide a body-prefix human decision request', () => {
  assert.equal(hasDecisionRequest(mail({ body: '<!-- fleet-exec: codex -->\n<!-- fleet-exec-cwd: /fixture -->\n[判断依頼] 方針' })), true);
});

test('arrival notification fires once per urgent id and retries a failed channel without quarantining mail', async t => {
  const f = fixture(t), arrivals = [];
  const urgent = mail({ priority: 'urgent' });
  f.deps.request = async kind => kind === 'mail-poll' ? { ok: true, messages: [urgent] } : { ok: true };
  f.deps.notifyArrival = async message => { arrivals.push(message.id); return arrivals.length > 1; };
  await pollOnce(f.deps); assert.equal(f.read(urgent.id).arrivalNotifiedAt, undefined); assert.equal(f.read(urgent.id).status, 'delivered');
  await pollOnce(f.deps); assert.equal(f.read(urgent.id).arrivalNotifiedAt, iso(0));
  await pollOnce(f.deps); assert.equal(arrivals.length, 2);
});
test('normal notes and replies inheriting request reasons do not trigger arrival notifications', async t => {
  const f = fixture(t), arrivals = [];
  f.deps.request = async kind => kind === 'mail-poll' ? { ok: true, messages: [mail(), mail({ id: 'mail-reply-one', why: '[判断依頼] 元件名' })] } : { ok: true };
  f.deps.notifyArrival = async message => { arrivals.push(message.id); return true; };
  await pollOnce(f.deps); assert.equal(arrivals.length, 0);
});
