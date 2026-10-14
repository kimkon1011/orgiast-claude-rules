import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { main, pollOnce, readInbox, syncMailState, resolveMailTarget, mailId, parseArgs, waitForReply, createClient, TERMINAL_STATUSES, hasDecisionRequest, updateInbox, presentMail, ACK_BATCH_LIMIT, SERVER_MAX_ATTEMPTS, CAPABILITY_BACKOFF_MS, INTERRUPTED_PROMPT_MS, INTERRUPTED_PROMPT_BODY, INBOX_LOCK_RETRIES, INBOX_LOCK_DELAY_MS } from './fleet-mail.mjs';
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
  const calls = [], output = [], errors = [], spawns = [];
  const deps = { home, pcMap, spawnImpl: (...args) => { spawns.push(args); return { on() {}, unref() {} }; }, identity: { hostname: pcMap[receiver].hostname }, now: () => now, stdout: s => output.push(s), stderr: s => errors.push(s),
    fetchBeacons: async () => ({ ok: false, beacons: [] }), dailySelfHeal: () => {}, autoRunFixNow: () => {},
    request: async (kind, payload) => { calls.push({ kind, payload: structuredClone(payload) }); return kind === 'mail-poll' ? { ok: true, messages: [] } : kind === 'mail-ack' && payload.ids ? { ok: true, results: payload.ids.map(id => ({ id, ok: true, mail: { id } })) } : { ok: true, mail: payload }; } };
  const save = m => fs.writeFileSync(path.join(inbox, `${m.id}.json`), JSON.stringify(m));
  const read = id => JSON.parse(fs.readFileSync(path.join(inbox, `${id}.json`), 'utf8'));
  return { home, dir, inbox, body, deps, calls, output, errors, spawns, save, read };
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
  assert.equal(f.read(mail().id).status, 'seen'); assert.deepEqual(f.read(mail().id).pendingServer, ['seen']); assert.equal(f.errors.length, 0); assert.equal(f.spawns.length, 1);
  f.deps.request = async (kind, payload) => { f.calls.push({ kind, payload }); return kind === 'mail-poll' ? { messages: [] } : kind === 'mail-ack' && payload.ids ? { ok: true, results: payload.ids.map(id => ({ id, ok: true })) } : { ok: true, mail: {} }; };
  await pollOnce(f.deps); assert.deepEqual(f.read(mail().id).pendingServer, []); assert.equal(f.calls[0].kind, 'mail-seen');
});
test('ack and ack --all-seen complete only selected mail and retry the server intent', async t => {
  const f = fixture(t); f.save(mail()); f.save(mail({ id: 'mail-presented', presentedAt: iso(-1) }));
  f.deps.request = async () => ({ ok: false, error: 'offline' });
  assert.equal(await main(['--ack', '--all-seen'], f.deps), 0);
  assert.equal(f.read('mail-presented').status, 'done'); assert.deepEqual(f.read('mail-presented').pendingServer, ['ack']); assert.equal(f.read(mail().id).status, 'delivered');
  assert.equal(await main(['--ack', mail().id], f.deps), 0); assert.equal(f.read(mail().id).status, 'done');
  f.deps.request = async (kind, payload) => { f.calls.push({ kind, payload }); return kind === 'mail-poll' ? { messages: [] } : kind === 'mail-ack' && payload.ids ? { ok: true, results: payload.ids.map(id => ({ id, ok: true })) } : { ok: true, mail: {} }; };
  await pollOnce(f.deps); assert.equal(f.calls.filter(c => c.kind === 'mail-ack').length, 1);
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
test('C3 corrupt local JSON is archived and recovered without mail-fail', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.inbox, 'mail-corrupt.json'), '{bad');
  fs.writeFileSync(path.join(f.dir, '.fleet-mail-processed'), 'mail-corrupt\n');
  const request = f.deps.request; f.deps.request = async (kind, payload) => kind === 'mail-poll' ? { messages: [mail()] } : kind === 'mail-get' ? { mail: mail({ id: payload.id }) } : request(kind, payload);
  await pollOnce(f.deps);
  assert.equal(f.read('mail-corrupt').status, 'delivered');
  assert.equal(f.calls.filter(c => c.kind === 'mail-fail').length, 0); assert.equal(f.read(mail().id).status, 'delivered');
  assert.ok(fs.existsSync(path.join(f.inbox, 'corrupt', 'mail-corrupt.json')));
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

test('C2 migration queues durable ack and drains one bounded batch per poll', async t => {
  const f = fixture(t), ids = Array.from({ length: ACK_BATCH_LIMIT + 1 }, (_, i) => `mail-migrate-${i}`);
  for (const id of ids) f.save(mail({ id }));
  fs.writeFileSync(path.join(f.dir, '.fleet-mail-processed'), ids.join('\n'));
  await pollOnce(f.deps);
  const batches = () => f.calls.filter(c => c.kind === 'mail-ack');
  assert.equal(batches().length, 1); assert.equal(batches()[0].payload.ids.length, ACK_BATCH_LIMIT);
  assert.equal(batches()[0].payload.from, receiver);
  const pending = readInbox(f.home, { unreadOnly: false }).filter(m => m.pendingServer?.includes('ack'));
  assert.equal(pending.length, 1); assert.equal(pending[0].status, 'done');
  await pollOnce(f.deps); assert.equal(batches().length, 2); assert.equal(batches()[1].payload.ids.length, 1);
  assert.ok(readInbox(f.home, { unreadOnly: false }).every(m => m.pendingServer.length === 0 && m.serverSyncedAt));
});
for (const code of ['EBUSY', 'EPERM', 'EACCES', 'ENOENT']) test(`C3 ${code} write failure retains poll receipt without quarantine or mail-fail`, async t => {
  const f = fixture(t), request = f.deps.request;
  f.deps.request = async (kind, payload) => kind === 'mail-poll' ? { messages: [mail(), mail({ id: 'mail-other' })] } : request(kind, payload);
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (src, dst) => {
    if (dst === path.join(f.inbox, `${mail().id}.json`)) throw Object.assign(new Error('private error detail'), { code });
    return rename(src, dst);
  });
  const first = await pollOnce(f.deps); mock.mock.restore();
  assert.equal(first.rejected, 0); assert.equal(f.read('mail-other').status, 'delivered');
  const batch = JSON.parse(fs.readFileSync(path.join(f.dir, '.fleet-mail-poll.json'), 'utf8'));
  assert.deepEqual(batch.successfulIds, ['mail-other']); assert.equal(fs.existsSync(path.join(f.inbox, 'quarantine')), false);
  assert.equal(f.calls.filter(c => c.kind === 'mail-fail').length, 0); assert.deepEqual(f.errors, ['fleet-mail: 保存再試行待ち=1']);
  await pollOnce(f.deps); assert.equal(f.read(mail().id).status, 'delivered');
  assert.equal(fs.existsSync(path.join(f.dir, '.fleet-mail-poll.json')), false);
});
test('C5 legacy label and hostname deliveries are accepted with a marker and count-only warning', async t => {
  const f = fixture(t);
  const hostname = pcMap[receiver].hostname;
  const incoming = [mail({ to: receiver.slice(0, -1) }), mail({ id: 'mail-host-legacy', to: hostname.slice(0, -1).toLowerCase() }), mail({ id: 'mail-host-exact', to: hostname.toLowerCase() })];
  f.deps.request = async () => ({ messages: incoming });
  const result = await pollOnce(f.deps); assert.equal(result.rejected, 0);
  assert.equal(f.read(mail().id).legacyTo, true); assert.equal(f.read('mail-host-legacy').legacyTo, true);
  assert.equal(f.read('mail-host-exact').legacyTo, undefined); assert.deepEqual(f.errors, ['fleet-mail: 旧形式宛先受信=2']);
  assert.equal(resolveMailTarget(hostname.toLowerCase(), pcMap).to, receiver);
});
test('C6 old GAS response backs off for an hour and abandons pending actions after bounded attempts', async t => {
  const f = fixture(t); f.save(mail()); let time = now;
  f.deps.now = () => time;
  f.deps.request = async (kind, payload) => {
    f.calls.push({ kind, payload }); return kind === 'mail-poll' ? { messages: [] } : { ok: true, action: 'updated', row: 2 };
  };
  await main(['--ack', mail().id], f.deps);
  for (let i = 1; i < SERVER_MAX_ATTEMPTS; i++) {
    await pollOnce(f.deps); assert.equal(f.read(mail().id).attempts.ack, i);
    time += CAPABILITY_BACKOFF_MS; await pollOnce(f.deps);
  }
  const saved = f.read(mail().id);
  assert.equal(saved.attempts.ack, SERVER_MAX_ATTEMPTS); assert.deepEqual(saved.pendingServer, []); assert.deepEqual(saved.abandonedServer, ['ack']);
  const count = f.calls.filter(c => c.kind === 'mail-ack').length;
  time += CAPABILITY_BACKOFF_MS; await pollOnce(f.deps); assert.equal(f.calls.filter(c => c.kind === 'mail-ack').length, count);
  const state = JSON.parse(fs.readFileSync(path.join(f.dir, '.fleet-mail-last-poll.json'), 'utf8'));
  assert.equal(state.serverCapabilities.seen, false); assert.ok(state.serverCapabilities.checkedAt); assert.ok(state.at);
  assert.equal(f.errors.filter(e => e === 'fleet-mail: 同期打切り=1').length, 1);
});
test('C6 transient errors increment attempts without losing local completion', async t => {
  const f = fixture(t); f.save(mail());
  f.deps.request = async kind => { if (kind === 'mail-poll') return { messages: [] }; throw new Error('offline'); };
  await main(['--ack', mail().id], f.deps);
  for (let i = 1; i < SERVER_MAX_ATTEMPTS; i++) await pollOnce(f.deps);
  assert.equal(f.read(mail().id).status, 'done'); assert.equal(f.read(mail().id).attempts.ack, SERVER_MAX_ATTEMPTS);
  assert.deepEqual(f.read(mail().id).pendingServer, []);
});
test('C8 all-seen ack leaves unanswered decisions pending while explicit ack remains available', async t => {
  const f = fixture(t); f.save(mail({ why: '[判断依頼] choose', seenAt: iso(-1) })); f.save(mail({ id: 'mail-note', seenAt: iso(-1) }));
  await main(['--ack', '--all-seen'], f.deps);
  assert.equal(f.read(mail().id).status, 'delivered'); assert.equal(f.read('mail-note').status, 'done');
  assert.deepEqual(f.calls.map(c => c.payload.id), ['mail-note']);
  await main(['--ack', mail().id], f.deps); assert.equal(f.read(mail().id).status, 'done');
});
test('C9 sweep records serverSyncedAt and never resends completed expiry or ack', async t => {
  const f = fixture(t); f.save(mail({ expiresAt: iso(-1) })); f.save(mail({ id: 'mail-no-reply', body: '[回答・返信不要] finished' }));
  await main(['--sweep'], f.deps); const count = f.calls.length;
  assert.ok(f.read(mail().id).serverSyncedAt); assert.ok(f.read('mail-no-reply').serverSyncedAt);
  await main(['--sweep'], f.deps); await pollOnce(f.deps);
  assert.equal(f.calls.filter(c => c.kind !== 'mail-poll').length, count);
});
test('C10 interrupted ordinary prompts reply once after two hours without spawning again', async t => {
  const f = fixture(t); let time = now;
  f.deps.now = () => time;
  f.save(mail({ kind: 'prompt', executionStartedAt: iso(0) }));
  time += INTERRUPTED_PROMPT_MS - 1; await pollOnce(f.deps);
  assert.equal(f.calls.filter(c => c.kind === 'mail-reply').length, 0);
  time++; await pollOnce(f.deps);
  assert.equal(f.calls.filter(c => c.kind === 'mail-reply').length, 1);
  assert.equal(f.calls.find(c => c.kind === 'mail-reply').payload.resultBody, INTERRUPTED_PROMPT_BODY);
  assert.equal(f.read(mail().id).status, 'done'); assert.equal(f.spawns.length, 0);
  await pollOnce(f.deps); assert.equal(f.calls.filter(c => c.kind === 'mail-reply').length, 1);
});
test('C11 busy inbox lock skips mutations and transport then permits retry', async t => {
  const f = fixture(t); f.save(mail()); const lock = path.join(f.inbox, `${mail().id}.json.lock`);
  fs.writeFileSync(lock, 'other owner');
  let calls = 0; const open = fs.openSync;
  const mocked = t.mock.method(fs, 'openSync', (...args) => { if (args[0] === lock && args[1] === 'wx') calls++; return open(...args); });
  assert.equal(updateInbox(mail().id, current => ({ ...current, status: 'done' }), { home: f.home }), null);
  assert.equal(calls, INBOX_LOCK_RETRIES + 1); assert.ok(INBOX_LOCK_DELAY_MS > 0); mocked.mock.restore();
  await main(['--ack', mail().id], f.deps); assert.equal(f.calls.length, 0); assert.equal(f.read(mail().id).status, 'delivered'); assert.equal(f.output.at(-1), '完了=0');
  fs.unlinkSync(lock); await main(['--ack', mail().id], f.deps); assert.equal(f.read(mail().id).status, 'done'); assert.equal(f.calls.length, 1);
});
test('C11 callback errors release locks and delayed server responses preserve hook fields', async t => {
  const f = fixture(t); f.save(mail());
  assert.throws(() => updateInbox(mail().id, () => { throw new Error('callback'); }, { home: f.home }), /callback/);
  assert.equal(fs.existsSync(path.join(f.inbox, `${mail().id}.json.lock`)), false);
  await syncMailState({ home: f.home, id: mail().id, action: 'ack', from: receiver, now: () => now, request: async () => {
    updateInbox(mail().id, m => ({ ...m, presentedAt: iso(0), presentedSession: 'concurrent-hook', pendingServer: [...m.pendingServer, 'seen'] }), { home: f.home });
    return { ok: true, mail: { status: 'done' } };
  } });
  assert.equal(f.read(mail().id).presentedSession, 'concurrent-hook'); assert.deepEqual(f.read(mail().id).pendingServer, ['seen']);
});
test('inbox displays only selected messages and uses detached seen synchronization', async t => {
  const f = fixture(t); f.save(mail()); f.save(mail({ id: 'mail-hidden', presentedAt: iso(-1) }));
  let requests = 0; f.deps.request = async () => { requests++; return {}; };
  await main(['--inbox', '--unseen', '--json'], f.deps);
  assert.equal(requests, 0); assert.equal(f.spawns.length, 1); assert.deepEqual(f.spawns[0][1].slice(1), ['--sync-pending']);
  assert.equal(f.spawns[0][2].detached, true); assert.deepEqual(f.read(mail().id).pendingServer, ['seen']);
  assert.equal(f.read('mail-hidden').pendingServer, undefined);
});
test('ack-only wait exits successfully with an explicit empty-body label', async () => {
  const result = await waitForReply('mail-ack-only', 1, { now: () => now, request: async () => ({ mail: { status: 'done', resultBody: '' } }) });
  assert.equal(result.exitCode, 0); assert.equal(result.text, '[ack のみ・本文なし]');
});
test('notes count as handled only when newly received', async t => {
  const f = fixture(t); f.deps.request = async () => ({ messages: [mail()] });
  assert.deepEqual((await pollOnce(f.deps)).handled, [mail().id]);
  assert.deepEqual((await pollOnce(f.deps)).handled, []);
});

test('C11 concurrent workers preserve every inbox read-modify-write update', async t => {
  const f = fixture(t); f.save(mail({ increments: 0 }));
  const iterations = 20, workers = 3;
  const source = `const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.module).then(({ updateInbox }) => {
      let completed = 0;
      for (let i = 0; i < workerData.iterations; i++) {
        const result = updateInbox(workerData.id, mail => {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
          return { ...mail, increments: mail.increments + 1 };
        }, { home: workerData.home });
        if (result) completed++;
      }
      parentPort.postMessage(completed);
    });`;
  const counts = await Promise.all(Array.from({ length: workers }, () => new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { module: new URL('./fleet-mail.mjs', import.meta.url).href, home: f.home, id: mail().id, iterations } });
    let completed;
    worker.on('message', value => { completed = value; }); worker.on('error', reject);
    worker.on('exit', code => code ? reject(new Error('worker failed')) : resolve(completed));
  })));
  assert.equal(counts.reduce((a, b) => a + b, 0), workers * iterations);
  assert.equal(f.read(mail().id).increments, workers * iterations);
});
test('C6 quarantine failures are bounded even when the same invalid broadcast is polled again', async t => {
  const f = fixture(t); let failures = 0;
  f.deps.request = async kind => {
    if (kind === 'mail-poll') return { messages: [mail({ to: 'all', kind: 'invalid' })] };
    failures++; throw new Error('offline');
  };
  for (let i = 0; i < SERVER_MAX_ATTEMPTS + 2; i++) await pollOnce(f.deps);
  assert.equal(failures, SERVER_MAX_ATTEMPTS);
  const record = JSON.parse(fs.readFileSync(path.join(f.inbox, 'quarantine', `${mail().id}.json`), 'utf8'));
  assert.deepEqual(record.pendingServer, []); assert.equal(record.attempts, SERVER_MAX_ATTEMPTS);
});

test('C6 presenting a seen-abandoned message never revives its exhausted retry queue', async t => {
  const f = fixture(t); f.save(mail());
  const request = async () => { throw new Error('offline'); };
  for (let i = 0; i < SERVER_MAX_ATTEMPTS; i++) await syncMailState({ home: f.home, id: mail().id, action: 'seen', request, from: receiver, now: () => now, stderr: () => {} });
  presentMail({ home: f.home, id: mail().id, sessionId: 'later', now: () => now });
  assert.deepEqual(f.read(mail().id).pendingServer, []); assert.deepEqual(f.read(mail().id).abandonedServer, ['seen']);
});

test('D5 poll no-exec saves prompts for the scheduled task without claiming or executing them', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'fleet-agent-optin.json'), JSON.stringify({ accept: ['prompt'] }));
  const request = f.deps.request;
  f.deps.request = async (kind, payload) => kind === 'mail-poll' ? { ok: true, messages: [mail({ kind: 'prompt' })] } : request(kind, payload);
  assert.equal(parseArgs(['--poll', '--no-exec'])['--no-exec'], true);
  await main(['--poll', '--no-exec'], f.deps);
  assert.equal(f.spawns.length, 0); assert.equal(f.read('mail-original').executionStartedAt, undefined);
  assert.equal(f.read('mail-original').status, 'delivered');
  assert.equal(f.calls.filter(c => c.kind === 'mail-reply' || c.kind === 'mail-seen').length, 0);
});

test('D6 arrivals run after all receipt and processing writes and preserve concurrent inbox updates', async t => {
  const f = fixture(t), snapshots = [];
  const messages = [mail({ id: 'mail-decision', why: '[判断依頼] 確認' }), mail({ id: 'mail-work', why: '[作業依頼] 確認' }), mail({ id: 'mail-normal' })];
  const request = f.deps.request;
  f.deps.request = async (kind, payload) => kind === 'mail-poll' ? { ok: true, messages } : request(kind, payload);
  f.deps.notifyArrival = async m => {
    snapshots.push({ count: readInbox(f.home, { unreadOnly: false }).length, decision: f.read('mail-decision') });
    updateInbox(m.id, current => ({ ...current, presentedSession: 'concurrent-hook' }), { home: f.home });
    return true;
  };
  await pollOnce(f.deps);
  assert.equal(snapshots.length, 2);
  for (const s of snapshots) { assert.equal(s.count, messages.length); assert.ok(s.decision.decisionRegisteredAt); assert.ok(s.decision.decisionAckAt); }
  for (const id of ['mail-decision', 'mail-work']) { assert.ok(f.read(id).arrivalNotifiedAt); assert.equal(f.read(id).presentedSession, 'concurrent-hook'); }
});

test('D6 arrival timeouts cap each call and total budget then retry unnotified mail next poll', async t => {
  const { ARRIVAL_TIMEOUT_MS, ARRIVAL_BUDGET_MS } = await import('./lib/fleet-mail-discord.mjs');
  const f = fixture(t); let elapsed = 0;
  const count = ARRIVAL_BUDGET_MS / ARRIVAL_TIMEOUT_MS + 2;
  for (let i = 0; i < count; i++) f.save(mail({ id: `mail-timeout-${i}`, priority: 'urgent' }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.deps.notificationNow = () => elapsed;
  const signals = [], late = [];
  f.deps.notifyArrival = async (_mail, { signal }) => { signals.push(signal); return new Promise(resolve => late.push(resolve)); };
  const running = pollOnce(f.deps);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  for (let i = 0; i < ARRIVAL_BUDGET_MS / ARRIVAL_TIMEOUT_MS; i++) {
    assert.equal(signals.length, i + 1);
    elapsed += ARRIVAL_TIMEOUT_MS; t.mock.timers.tick(ARRIVAL_TIMEOUT_MS); await flush();
    assert.equal(signals[i].aborted, true);
  }
  await running;
  assert.equal(signals.length, ARRIVAL_BUDGET_MS / ARRIVAL_TIMEOUT_MS);
  late.forEach(resolve => resolve(true)); await flush();
  assert.ok(readInbox(f.home).every(m => !m.arrivalNotifiedAt));
  const retried = [];
  await pollOnce({ ...f.deps, notifyArrival: async m => { retried.push(m.id); return true; } });
  assert.equal(retried.length, count); assert.ok(readInbox(f.home).every(m => m.arrivalNotifiedAt));
});

test('D6 final arrival receives only the remaining total budget', async t => {
  const { ARRIVAL_TIMEOUT_MS, ARRIVAL_BUDGET_MS } = await import('./lib/fleet-mail-discord.mjs');
  const f = fixture(t); let elapsed = 0; const calls = [];
  for (const suffix of ['a', 'b', 'c']) f.save(mail({ id: `mail-budget-${suffix}`, priority: 'urgent' }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.deps.notificationNow = () => elapsed;
  f.deps.notifyArrival = async (m, { signal }) => {
    calls.push({ id: m.id, signal });
    if (calls.length === 1) { elapsed = ARRIVAL_BUDGET_MS - ARRIVAL_TIMEOUT_MS / 2; return true; }
    return new Promise(() => {});
  };
  const running = pollOnce(f.deps);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  const remaining = ARRIVAL_BUDGET_MS - elapsed;
  elapsed += remaining; t.mock.timers.tick(remaining);
  await running;
  assert.equal(calls.length, 2); assert.equal(calls[1].signal.aborted, true);
  assert.ok(f.read('mail-budget-a').arrivalNotifiedAt);
  assert.equal(f.read('mail-budget-b').arrivalNotifiedAt, undefined); assert.equal(f.read('mail-budget-c').arrivalNotifiedAt, undefined);
});
