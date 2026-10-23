import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { backgroundSpawnOptions } from './lib/background-spawn.mjs';
import { main, pollOnce, readInbox, syncMailState, resolveMailTarget, mailId, parseArgs, waitForReply, createClient, TERMINAL_STATUSES, hasDecisionRequest, updateInbox, presentMail, ACK_BATCH_LIMIT, SERVER_MAX_ATTEMPTS, CAPABILITY_BACKOFF_MS, INTERRUPTED_PROMPT_MS, INTERRUPTED_PROMPT_BODY, INBOX_LOCK_RETRIES, INBOX_LOCK_DELAY_MS, INBOX_LOCK_STALE_MS, COMMAND_LOCK_RETRIES, COMMAND_LOCK_DELAY_MS, LOCK_BUSY_EXIT, notifyPendingArrivals } from './fleet-mail.mjs';
// --answer は headless 実行中（CLAUDE_HEADLESS=1 / ORGIAST_HEADLESS_JOB）に判断代行を拒否して 2 を返す。
// このテストを headless セッション（夜間 auto-session / CI 外の手動実行）から回すと answer 系だけが
// 環境依存で落ちるため、テストプロセス側で無効化する。本番の安全弁そのものは変更しない。
for (const key of ['CLAUDE_HEADLESS', 'ORGIAST_HEADLESS_JOB']) delete process.env[key];
const pcMap = JSON.parse(fs.readFileSync(new URL('../fleet-pc-map.json', import.meta.url), 'utf8'));
const labels = Object.keys(pcMap).filter(key => !key.startsWith('_'));
const receiver = labels[0], sender = labels.find(label => label !== receiver && pcMap[label].hostname);
const now = Date.parse('2026-10-14T00:00:00Z');
const iso = offset => new Date(now + offset).toISOString();
const mail = (overrides = {}) => ({ id: 'mail-original', from: sender, to: receiver, kind: 'note', body: 'body', why: 'test', status: 'delivered', createdAt: iso(-1000), receivedAt: iso(0), expiresAt: iso(86400000), ...overrides });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-v2-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.git'));
  const dir = path.join(home, '.claude'), inbox = path.join(dir, 'fleet-inbox'); fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.invalid/mail\nFLEET_SHEET_TOKEN=fixture\n');
  fs.writeFileSync(path.join(dir, 'cost-reporter.env'), `REPORTER_LABEL=${receiver}\n`);
  const body = path.join(home, 'body.txt'); fs.writeFileSync(body, 'nonempty test body');
  const calls = [], output = [], errors = [], spawns = [];
  const deps = { home, pcMap, spawnImpl: (...args) => { spawns.push(args); return { on() {}, unref() {} }; }, identity: { hostname: pcMap[receiver].hostname }, now: () => now, stdout: s => output.push(s), stderr: s => errors.push(s),
    fetchBeacons: async () => ({ ok: false, beacons: [] }), dailySelfHeal: () => {}, dailyLaneHealth: () => {}, autoRunFixNow: () => {}, dailyRuleCompliance: () => {},
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

function growiFixture(t, { hub = true, body = JSON.stringify({ growiAppend: [{ path: '/手順', anchor: '目印', lines: '追記' }] }) } = {}) {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.dir, 'fleet-sheet.env'), `FLEET_HUB=${hub ? receiver : sender}\n`);
  fs.writeFileSync(path.join(f.dir, 'growi.env'), '存在確認専用');
  f.save(mail({ why: '[growi-append] 手順更新', body }));
  f.deps.growiAppend = async item => ({ ok: true, path: item.pagePath, insertedLines: 1 });
  return f;
}

test('Growi 中継はハブかつ growi.env ありなら処理して返信する', async t => {
  const f = growiFixture(t); await pollOnce(f.deps);
  const sent = f.calls.find(call => call.kind === 'mail-send');
  assert.equal(sent.payload.replyTo, 'mail-original'); assert.match(sent.payload.body, /"ok":true/);
  assert.match(sent.payload.id, /^mail-reply-growi-[0-9a-f]{24}$/); // サーバーの mail-send は id 必須
  assert.ok(f.read('mail-original').growiAppendDoneAt);
});
test('Growi 中継はハブでなければ処理しない', async t => {
  const f = growiFixture(t, { hub: false }); await pollOnce(f.deps);
  assert.equal(f.calls.some(call => call.kind === 'mail-send'), false); assert.equal(f.read('mail-original').growiAppendDoneAt, undefined);
});
test('Growi 中継は処理済みメールを二重処理しない', async t => {
  const f = growiFixture(t); await pollOnce(f.deps); await pollOnce(f.deps);
  assert.equal(f.calls.filter(call => call.kind === 'mail-send').length, 1);
});
test('Growi 中継は不正 JSON でも失敗理由を返信する', async t => {
  const f = growiFixture(t, { body: '{不正' }); await pollOnce(f.deps);
  const sent = f.calls.find(call => call.kind === 'mail-send'); assert.match(sent.payload.body, /"ok":false/); assert.ok(f.read('mail-original').growiAppendDoneAt);
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
    const child = new EventEmitter(); child.unref = () => {}; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => { child.stdout.write('answer'); child.emit('close', 0); }); return child;
  };
  await pollOnce(f.deps); assert.equal(seenBeforeSpawn, true); assert.equal(f.read(mail().id).status, 'seen'); assert.deepEqual(f.read(mail().id).pendingServer, ['seen']);
  assert.equal(f.calls.some(c => c.kind === 'mail-reply'), false);
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
test('C10 interrupted ordinary prompts reply once after the runner grace period without spawning again', async t => {
  const f = fixture(t); let time = now;
  f.deps.now = () => time;
  f.save(mail({ kind: 'prompt', executionStartedAt: iso(0) }));
  time += INTERRUPTED_PROMPT_MS - 1; await pollOnce(f.deps);
  assert.equal(f.calls.filter(c => c.kind === 'mail-fail').length, 0);
  time++; await pollOnce(f.deps);
  assert.equal(f.calls.filter(c => c.kind === 'mail-fail').length, 1);
  assert.equal(f.calls.find(c => c.kind === 'mail-fail').payload.reason, 'timeout');
  assert.equal(f.read(mail().id).status, 'failed'); assert.equal(f.spawns.length, 0);
  await pollOnce(f.deps); assert.equal(f.calls.filter(c => c.kind === 'mail-fail').length, 1);
});
test('C11 busy inbox lock skips mutations and transport then permits retry', async t => {
  const f = fixture(t); f.save(mail()); const lock = path.join(f.inbox, `${mail().id}.json.lock`);
  fs.writeFileSync(lock, 'other owner');
  let calls = 0; const open = fs.openSync;
  const mocked = t.mock.method(fs, 'openSync', (...args) => { if (args[0] === lock && args[1] === 'wx') calls++; return open(...args); });
  assert.equal(updateInbox(mail().id, current => ({ ...current, status: 'done' }), { home: f.home }), null);
  assert.equal(calls, INBOX_LOCK_RETRIES + 1); assert.ok(INBOX_LOCK_DELAY_MS > 0); mocked.mock.restore();
  assert.equal(await main(['--ack', mail().id], f.deps), LOCK_BUSY_EXIT); assert.equal(f.calls.length, 0); assert.equal(f.read(mail().id).status, 'delivered'); assert.equal(f.output.length, 0);
  fs.unlinkSync(lock); await main(['--ack', mail().id], f.deps); assert.equal(f.read(mail().id).status, 'done'); assert.equal(f.calls.length, 1);
});
for (const code of ['EPERM', 'EBUSY']) for (const operation of ['openSync', 'mkdirSync', 'statSync']) {
  test(`C11 Windows ${operation} ${code} contention waits without stealing ownership`, t => {
    const f = fixture(t); f.save(mail());
    const lock = path.join(f.inbox, `${mail().id}.json.lock`);
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    t.after(() => Object.defineProperty(process, 'platform', descriptor));
    fs.writeFileSync(lock, 'other owner');
    const original = fs[operation]; let faults = 0, callbacks = 0;
    t.mock.method(fs, operation, (...args) => {
      if (args[0] === (operation === 'mkdirSync' ? `${lock}.reclaim` : lock) && faults++ === 0) {
        throw Object.assign(new Error('sharing conflict'), { code });
      }
      return original(...args);
    });
    const delays = [];
    t.mock.method(Atomics, 'wait', (...args) => {
      delays.push(args[3]);
      assert.equal(callbacks, 0);
      assert.equal(fs.readFileSync(lock, 'utf8'), 'other owner');
      assert.equal(fs.existsSync(`${lock}.reclaim`), false);
      fs.unlinkSync(lock); // The owner releases while this caller waits.
      return 'timed-out';
    });
    const result = updateInbox(mail().id, current => {
      callbacks++; return { ...current, status: 'done' };
    }, { home: f.home });
    assert.equal(result.status, 'done'); assert.equal(callbacks, 1);
    assert.equal(f.read(mail().id).status, 'done');
    assert.deepEqual(delays, [INBOX_LOCK_DELAY_MS]);
    assert.equal(fs.existsSync(lock), false);
  });
  test(`C11 persistent Windows ${operation} ${code} contention stays bounded`, t => {
    const f = fixture(t); f.save(mail());
    const lock = path.join(f.inbox, `${mail().id}.json.lock`);
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    t.after(() => Object.defineProperty(process, 'platform', descriptor));
    fs.writeFileSync(lock, 'other owner');
    const original = fs[operation]; let faults = 0;
    t.mock.method(fs, operation, (...args) => {
      if (args[0] === (operation === 'mkdirSync' ? `${lock}.reclaim` : lock)) {
        faults++; throw Object.assign(new Error('sharing conflict'), { code });
      }
      return original(...args);
    });
    const delays = [];
    t.mock.method(Atomics, 'wait', (...args) => { delays.push(args[3]); return 'timed-out'; });
    assert.equal(updateInbox(mail().id, () => assert.fail('no ownership'), { home: f.home }), null);
    assert.equal(faults, INBOX_LOCK_RETRIES + 1);
    assert.deepEqual(delays, Array(INBOX_LOCK_RETRIES).fill(INBOX_LOCK_DELAY_MS));
    assert.equal(fs.readFileSync(lock, 'utf8'), 'other owner');
    assert.equal(f.read(mail().id).status, 'delivered');
    assert.equal(fs.existsSync(`${lock}.reclaim`), false);
  });
}
for (const [platform, code] of [['linux', 'EPERM'], ['linux', 'EBUSY'], ['win32', 'EACCES'], ['win32', 'EIO']]) {
  test(`C11 unrelated ${platform} ${code} lock errors propagate`, t => {
    const f = fixture(t); f.save(mail());
    const lock = path.join(f.inbox, `${mail().id}.json.lock`);
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform });
    t.after(() => Object.defineProperty(process, 'platform', descriptor));
    const original = fs.openSync, error = Object.assign(new Error('lock failure'), { code });
    t.mock.method(fs, 'openSync', (...args) => { if (args[0] === lock) throw error; return original(...args); });
    t.mock.method(Atomics, 'wait', () => assert.fail('must not wait'));
    assert.throws(() => updateInbox(mail().id, () => assert.fail('no ownership'), { home: f.home }), e => e === error);
    assert.equal(f.read(mail().id).status, 'delivered');
  });
}
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
for (const platform of [process.platform, ...(process.platform === 'win32' ? [] : ['win32'])]) {
test(`inbox displays only selected messages and uses detached seen synchronization (${platform})`, async t => {
  const f = fixture(t); f.save(mail()); f.save(mail({ id: 'mail-hidden', presentedAt: iso(-1) }));
  let requests = 0; f.deps.request = async () => { requests++; return {}; };
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  let expectedOptions, exitCode;
  try {
    Object.defineProperty(process, 'platform', { value: platform });
    expectedOptions = backgroundSpawnOptions();
    exitCode = await main(['--inbox', '--unseen', '--json'], f.deps);
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
  assert.equal(exitCode, 0);
  assert.equal(requests, 0); assert.equal(f.spawns.length, 1); assert.deepEqual(f.spawns[0][1].slice(1), ['--sync-pending']);
  for (const [key, value] of Object.entries(expectedOptions)) assert.equal(f.spawns[0][2][key], value);
  assert.deepEqual(JSON.parse(f.output[0]).map(m => m.id), [mail().id]);
  assert.deepEqual(f.read(mail().id).pendingServer, ['seen']);
  assert.equal(f.read('mail-hidden').pendingServer, undefined);
});
}
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
  // updateInbox deliberately returns null when its bounded lock wait expires.
  // Every successful update must survive, even when some attempts were busy.
  const completed = counts.reduce((a, b) => a + b, 0);
  assert.ok(completed > 0 && completed <= workers * iterations);
  assert.equal(f.read(mail().id).increments, completed);
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

import { readQuestion, updateQuestion, relayQuestions, RELAY_WAIT_MS, RESUME_LIMIT_MS, HOOK_DEADLINE_MS } from './fleet-question-relay.mjs';
import { runPrompt, consentCommand, hubReport } from './fleet-agent.mjs';
import { runReadOnlyTask, runClaudeTask } from './fleet-task-runner.mjs';
function questionFixture(f, extra = {}) {
  const transcriptPath = path.join(f.home, 'session.jsonl'); fs.writeFileSync(transcriptPath, '');
  const question = { sessionId: 'session-hub', cwd: f.home, question: 'どちらにしますか？ token=private', options: [{ label: 'A' }], summary: '検証済み', askedAt: iso(-RELAY_WAIT_MS), questionHash: 'hash-question', drivenByHub: false, relayedAt: null, transcriptPath, transcriptOffset: 0, ...extra };
  updateQuestion(f.home, question.sessionId, () => question);
  fs.appendFileSync(path.join(f.dir, 'fleet-sheet.env'), `FLEET_HUB=${sender}\n`);
  return question;
}
function promptSpawn(f, { code = 0, output = '完了 token=private', onSpawn } = {}) {
  return (...args) => {
    f.spawns.push(args); onSpawn?.();
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    queueMicrotask(() => { child.stdout.emit('data', output); child.stderr.emit('data', 'stderr must not replace stdout'); child.emit('close', code); });
    return child;
  };
}
function hubPrompt(f, extra = {}) {
  fs.appendFileSync(path.join(f.dir, 'fleet-sheet.env'), `FLEET_HUB=${sender}\n`);
  fs.writeFileSync(path.join(f.dir, 'fleet-agent-optin.json'), JSON.stringify({ accept: ['claude-resume'] }));
  f.deps.resolveClaudeExe = () => ({ executable: '/fixture/claude', candidates: ['/fixture/claude'] });
  f.deps.spawnImpl = promptSpawn(f);
  const m = mail({ kind: 'prompt', exec: 'claude', execCwd: f.home, resumeSessionId: 'session-hub', body: 'Aで進めて', ...extra }); f.save(m); return m;
}
async function runHubPoll(f) {
  const launched = [];
  await pollOnce({ ...f.deps, spawnImpl: (...args) => { launched.push(args); return { on() {}, unref() {} }; } });
  for (const [, args] of launched) {
    assert.match(args[0], /fleet-task-runner\.mjs$/);
    await runClaudeTask({ ...f.deps, id: args[args.indexOf('--id') + 1] });
  }
}
test('E poll relays after ten minutes exactly once with metadata and a redacted summary', async t => {
  const f = fixture(t), q = questionFixture(f);
  await pollOnce(f.deps); await pollOnce(f.deps);
  const sends = f.calls.filter(c => c.kind === 'mail-send'); assert.equal(sends.length, 1);
  const payload = sends[0].payload;
  assert.equal(payload.to, sender); assert.equal(payload.priority, 'urgent'); assert.equal(payload.messageKind, 'note');
  assert.deepEqual(payload.meta.relay, { sessionId: q.sessionId, cwd: q.cwd, questionHash: q.questionHash, pcLabel: receiver });
  assert.doesNotMatch(payload.body, /private/); assert.ok(readQuestion(f.home, q.sessionId).relayedAt); assert.equal(readQuestion(f.home, q.sessionId).sentId, payload.id);
});
test('E no early relay, no relay after newer human input, hub-driven questions relay immediately', async t => {
  const f = fixture(t), q = questionFixture(f, { askedAt: iso(-RELAY_WAIT_MS + 1) });
  await pollOnce(f.deps); assert.equal(f.calls.filter(c => c.kind === 'mail-send').length, 0);
  updateQuestion(f.home, q.sessionId, current => ({ ...current, askedAt: iso(-RELAY_WAIT_MS) }));
  fs.appendFileSync(q.transcriptPath, JSON.stringify({ type: 'user', timestamp: iso(-1000), message: { content: 'A' } }) + '\n');
  await pollOnce(f.deps); assert.equal(f.calls.filter(c => c.kind === 'mail-send').length, 0);
  updateQuestion(f.home, q.sessionId, current => ({ ...current, askedAt: iso(0), drivenByHub: true }));
  await pollOnce(f.deps); assert.equal(f.calls.filter(c => c.kind === 'mail-send').length, 1);
});
test('E failed relay response retries with the same id, dry-run never relays', async t => {
  const f = fixture(t), q = questionFixture(f); let attempt = 0; const original = f.deps.request;
  f.deps.request = async (kind, payload) => { const result = await original(kind, payload); if (kind === 'mail-send' && !attempt++) throw new Error('lost response'); return result; };
  await pollOnce({ ...f.deps, dryRun: true }); assert.equal(f.calls.filter(c => c.kind === 'mail-send').length, 0);
  await pollOnce(f.deps); assert.equal(readQuestion(f.home, q.sessionId).relayedAt, null);
  await pollOnce(f.deps); const sends = f.calls.filter(c => c.kind === 'mail-send'); assert.equal(sends.length, 2); assert.equal(sends[0].payload.id, sends[1].payload.id);
});
test('E answer sends a Claude resume then acks the original, and retry keeps the same answer id', async t => {
  const f = fixture(t), q = questionFixture(f); const original = mail({ why: '[判断依頼]', meta: JSON.stringify({ relay: q }) }); f.save(original);
  const request = f.deps.request; let failAck = true;
  f.deps.request = async (kind, payload) => { const result = await request(kind, payload); if (kind === 'mail-get') return { ok: true, mail: original }; if (kind === 'mail-ack' && failAck) throw new Error('offline'); return result; };
  await assert.rejects(main(['--answer', original.id, '--body-file', f.body], f.deps), /offline/);
  failAck = false; assert.equal(await main(['--answer', original.id, '--body-file', f.body], f.deps), 0);
  const sends = f.calls.filter(c => c.kind === 'mail-send'); assert.equal(sends.length, 2); assert.deepEqual(sends[0].payload, sends[1].payload);
  const sent = sends[0].payload; assert.equal(sent.to, original.from); assert.equal(sent.exec, 'claude'); assert.equal(sent.resumeSessionId, q.sessionId); assert.equal(sent.execCwd, q.cwd); assert.equal(sent.expiresAt, iso(6 * 3600000));
  assert.equal(f.read(original.id).status, 'done'); assert.deepEqual(f.calls.slice(0, 3).map(c => c.kind), ['mail-get', 'mail-send', 'mail-ack']);
});
test('E manual decision cannot use answer and is given a note command without mutation', async t => {
  const f = fixture(t); f.deps.request = async (kind, payload) => { f.calls.push({ kind, payload }); return { ok: true, mail: mail({ why: '[判断依頼]' }) }; };
  assert.equal(await main(['--answer', 'mail-original', '--body-file', f.body], f.deps), 2);
  assert.deepEqual(f.calls.map(c => c.kind), ['mail-get']); assert.ok(f.errors.some(s => s.includes('--kind note') && s.includes(sender)));
});
test('E send claude resume carries body markers, structured execution fields and six hour expiry', async t => {
  const f = fixture(t);
  const args = ['--send', '--to', sender, '--kind', 'prompt', '--exec', 'claude', '--resume', 'session-hub', '--exec-cwd', f.home, '--body-file', f.body, '--why', '再開'];
  assert.equal(await main(args, f.deps), 0);
  const sent = f.calls.find(c => c.kind === 'mail-send').payload;
  assert.equal(sent.exec, 'claude'); assert.equal(sent.execCwd, f.home); assert.equal(sent.resumeSessionId, 'session-hub'); assert.match(sent.body, /fleet-resume: session-hub/); assert.equal(sent.expiresAt, iso(6 * 3600000));
  assert.throws(() => parseArgs(args.map(x => x === 'prompt' ? 'note' : x)), /prompt/);
  assert.throws(() => parseArgs(args.map(x => x === 'claude' ? 'codex' : x)), /resume/);
  assert.throws(() => parseArgs(args.map(x => x === 'session-hub' ? '../unsafe' : x)), /session/);
});
test('E received claude resume uses exact argv/cwd, marks hub state, clears running state and reports stdout only', async t => {
  const f = fixture(t); const m = hubPrompt(f); let during;
  f.deps.spawnImpl = promptSpawn(f, { onSpawn: () => { during = readQuestion(f.home, m.resumeSessionId); } });
  await runHubPoll(f);
  assert.equal(f.spawns.length, 1);
  const [exe, args, opts] = f.spawns[0]; assert.equal(exe, '/fixture/claude'); assert.deepEqual(args, ['-p', '--resume', m.resumeSessionId, '--', m.body]); assert.equal(opts.cwd, f.home); assert.equal(opts.env.CLAUDE_HEADLESS, '1'); assert.equal(opts.env.FLEET_DRIVEN_BY_HUB, '1');
  assert.equal(during.drivenByHub, true); assert.ok(during.resumingAt); assert.equal(readQuestion(f.home, m.resumeSessionId).resumingAt, undefined);
  const reply = f.calls.find(c => c.kind === 'mail-reply').payload.resultBody;
  assert.match(reply, /^完了 /); assert.doesNotMatch(reply, /private|stderr/); assert.equal(f.read(m.id).status, 'done');
});
test('E active session skips without consuming mail; thirty minute stale session may resume', async t => {
  const f = fixture(t), m = hubPrompt(f);
  updateQuestion(f.home, m.resumeSessionId, () => ({ sessionId: m.resumeSessionId, resumingAt: iso(-RESUME_LIMIT_MS + 1), drivenByHub: true }));
  await runHubPoll(f); assert.equal(f.spawns.length, 0); assert.equal(f.read(m.id).executionStartedAt, undefined);
  updateQuestion(f.home, m.resumeSessionId, q => ({ ...q, resumingAt: iso(-RESUME_LIMIT_MS) }));
  await runHubPoll(f); assert.equal(f.spawns.length, 1);
});
test('E new Claude session omits resume and unapproved prompt returns consent without launching', async t => {
  const f = fixture(t), m = hubPrompt(f, { resumeSessionId: undefined });
  await runHubPoll(f); assert.deepEqual(f.spawns[0][1], ['-p', '--', m.body]);
  f.save(mail({ ...m, id: 'mail-unapproved' })); fs.unlinkSync(path.join(f.dir, 'fleet-agent-optin.json'));
  await runHubPoll(f); assert.equal(f.spawns.length, 1); assert.match(f.calls.filter(c => c.kind === 'mail-send').at(-1).payload.body, /未オプトイン.*承諾コマンド/s);
});
test('E runPrompt enforces thirty minute timer, kills process and resolves failure', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let killed, timeout, callback;
  child.kill = signal => { killed = signal; };
  const promise = runPrompt({ claudeExe: 'mock', body: 'answer', cwd: '.', resumeSessionId: 'session', timeoutSeconds: RESUME_LIMIT_MS / 1000, spawnImpl: () => child,
    setTimer: (fn, ms) => { callback = fn; timeout = ms; return 1; }, clearTimer: () => {} });
  callback(); const result = await promise;
  assert.equal(timeout, RESUME_LIMIT_MS); assert.equal(killed, 'SIGKILL'); assert.equal(result.timedOut, true); assert.equal(result.exitCode, null);
});
test('E interrupted Claude execution fails at thirty minutes and never reruns', async t => {
  const f = fixture(t), m = hubPrompt(f, { executionStartedAt: iso(-RESUME_LIMIT_MS) });
  await pollOnce(f.deps); assert.equal(f.spawns.length, 0); assert.match(f.calls.find(c => c.kind === 'mail-send').payload.body, /自動回答.*timeout/s);
});

test('E real poll execution applies thirty minute timeout and returns failure with resume cleanup', async t => {
  const f = fixture(t), m = hubPrompt(f); let timeout, killed;
  f.deps.spawnImpl = (...args) => {
    f.spawns.push(args); const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = signal => { killed = signal; }; return child;
  };
  f.deps.promptSetTimer = (fn, ms) => { timeout = ms; queueMicrotask(fn); return 1; }; f.deps.promptClearTimer = () => {};
  await runHubPoll(f);
  assert.equal(timeout, RESUME_LIMIT_MS); assert.equal(killed, 'SIGKILL'); assert.equal(readQuestion(f.home, m.resumeSessionId).resumingAt, undefined);
  assert.match(f.calls.find(c => c.kind === 'mail-send').payload.body, /自動回答.*timeout/s);
});
test('E missing Claude executable reports candidates and releases session ownership', async t => {
  const f = fixture(t), m = hubPrompt(f);
  f.deps.spawnImpl = () => { const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); queueMicrotask(() => child.emit('error', new Error('spawn ENOENT'))); return child; };
  await runHubPoll(f);
  const reply = f.calls.find(c => c.kind === 'mail-send').payload.body;
  assert.match(reply, /実行失敗.*claude CLI.*候補.*\/fixture\/claude/s); assert.equal(readQuestion(f.home, m.resumeSessionId).resumingAt, undefined);
});
test('E tool_result human answers suppress forwarding and missing transcripts defer safely', async t => {
  const f = fixture(t), q = questionFixture(f);
  fs.appendFileSync(q.transcriptPath, JSON.stringify({ type: 'user', timestamp: iso(-1000), message: { content: [{ type: 'tool_result', content: 'A' }] } }) + '\n');
  await pollOnce(f.deps); assert.equal(f.calls.filter(c => c.kind === 'mail-send').length, 0);
  fs.unlinkSync(q.transcriptPath); await pollOnce(f.deps); assert.equal(f.calls.filter(c => c.kind === 'mail-send').length, 0);
});
test('E report truncates redacted stdout to 4000 characters and retry does not re-execute', async t => {
  const f = fixture(t), m = hubPrompt(f); f.deps.spawnImpl = promptSpawn(f, { output: 'token=' + 's'.repeat(5000) });
  const request = f.deps.request; let fail = true;
  f.deps.request = async (kind, payload) => { const result = await request(kind, payload); if (kind === 'mail-reply' && fail) throw new Error('lost response'); return result; };
  await runHubPoll(f); fail = false; await runHubPoll(f);
  assert.equal(f.spawns.length, 1); assert.equal(f.read(m.id).status, 'done');
  const replies = f.calls.filter(c => c.kind === 'mail-reply'); assert.equal(replies.length, 2); assert.equal(replies[0].payload.resultBody, replies[1].payload.resultBody); assert.doesNotMatch(replies[0].payload.resultBody, /ss/);
});


test('F1 stale inbox locks are reclaimed while fresh locks wait and skip', t => {
  const f = fixture(t); f.save(mail());
  const lock = path.join(f.inbox, `${mail().id}.json.lock`);
  fs.writeFileSync(lock, 'owner');
  const old = new Date(now - INBOX_LOCK_STALE_MS - 1); fs.utimesSync(lock, old, old);
  assert.equal(updateInbox(mail().id, m => ({ ...m, presentedSession: 'recovered' }), { home: f.home, now: () => now }).presentedSession, 'recovered');
  assert.equal(fs.existsSync(lock), false);
  fs.writeFileSync(lock, 'owner'); fs.utimesSync(lock, new Date(now), new Date(now));
  const delays = []; t.mock.method(Atomics, 'wait', (...args) => { delays.push(args[3]); return 'timed-out'; });
  assert.equal(updateInbox(mail().id, m => ({ ...m, status: 'done' }), { home: f.home, now: () => now }), null);
  assert.deepEqual(delays, Array(INBOX_LOCK_RETRIES).fill(INBOX_LOCK_DELAY_MS));
  assert.equal(f.read(mail().id).status, 'delivered'); assert.equal(fs.existsSync(lock), true);
});
for (const action of ['reply', 'ack', 'answer']) test(`F2 ${action} lock contention retries then exits 6 without transport`, async t => {
  const f = fixture(t); f.save(mail());
  const lock = path.join(f.inbox, `${mail().id}.json.lock`); fs.writeFileSync(lock, 'owner');
  const delays = []; t.mock.method(Atomics, 'wait', (...args) => { delays.push(args[3]); return 'timed-out'; });
  const args = [`--${action}`, mail().id, ...(action === 'ack' ? [] : ['--body-file', f.body])];
  assert.equal(await main(args, f.deps), LOCK_BUSY_EXIT);
  assert.deepEqual(delays, Array(COMMAND_LOCK_RETRIES).fill(COMMAND_LOCK_DELAY_MS));
  assert.equal(f.calls.length, 0); assert.equal(f.errors.length, 1); assert.equal(f.output.length, 0);
});
for (const action of ['reply', 'ack', 'answer']) for (const fault of ['lock', 'write']) test(`F2 ${action} successful send with ${fault} failure queues pendingLocal and poll never resends`, async t => {
  const f = fixture(t), q = questionFixture(f, { relayedAt: iso(0) });
  const original = mail({ why: '[判断依頼]', meta: { relay: q } }); f.save(original);
  const lock = path.join(f.inbox, `${original.id}.json.lock`), target = path.join(f.inbox, `${original.id}.json`);
  let failedWrite = false;
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (...args) => {
    if (failedWrite && args[1] === target) throw Object.assign(new Error('fixture write failure'), { code: 'EACCES' });
    return rename(...args);
  });
  const request = f.deps.request;
  f.deps.request = async (kind, payload) => {
    const response = await request(kind, payload);
    if (kind === 'mail-get') return { ok: true, mail: original };
    if (kind === (action === 'reply' ? 'mail-reply' : 'mail-ack')) {
      if (fault === 'lock') fs.writeFileSync(lock, 'owner'); else failedWrite = true;
      return { ok: true, mail: { status: 'done', resultAt: iso(0), resultBody: 'answer' } };
    }
    return response;
  };
  const args = [`--${action}`, original.id, ...(action === 'ack' ? [] : ['--body-file', f.body])];
  assert.equal(await main(args, f.deps), 0);
  const pending = path.join(f.inbox, '.pending', `${original.id}.json`);
  const record = JSON.parse(fs.readFileSync(pending, 'utf8'));
  assert.equal(record.pendingLocal.status, 'done'); assert.equal(record.pendingServer, undefined);
  assert.equal(readInbox(f.home, { unreadOnly: false })[0].status, 'done');
  const sends = f.calls.filter(c => ['mail-reply', 'mail-send', 'mail-ack'].includes(c.kind)).length;
  if (fault === 'lock') fs.unlinkSync(lock); else failedWrite = false;
  await pollOnce(f.deps);
  assert.equal(f.read(original.id).status, 'done'); assert.equal(fs.existsSync(pending), false);
  assert.equal(f.calls.filter(c => ['mail-reply', 'mail-send', 'mail-ack'].includes(c.kind)).length, sends);
  assert.deepEqual(f.read(original.id).pendingServer || [], []);
});
test('F2 transient command lock contention succeeds within the retry budget', async t => {
  const f = fixture(t); f.save(mail()); const lock = path.join(f.inbox, `${mail().id}.json.lock`); fs.writeFileSync(lock, 'owner');
  const delays = []; t.mock.method(Atomics, 'wait', (...args) => { delays.push(args[3]); fs.unlinkSync(lock); return 'timed-out'; });
  assert.equal(await main(['--ack', mail().id], f.deps), 0);
  assert.deepEqual(delays, [COMMAND_LOCK_DELAY_MS]); assert.equal(f.calls.length, 1);
});
test('F3 arrival notifications select only post-migration delivered and seen mail', async t => {
  const f = fixture(t), notified = [];
  const marker = path.join(f.dir, '.fleet-mail-v2-migrated'); fs.writeFileSync(marker, ''); fs.utimesSync(marker, new Date(now), new Date(now));
  for (const status of ['delivered', 'seen', ...TERMINAL_STATUSES]) f.save(mail({ id: `mail-${status}`, status, priority: 'urgent' }));
  f.save(mail({ id: 'mail-legacy', priority: 'urgent', receivedAt: iso(-1) }));
  f.save(mail({ id: 'mail-no-date', priority: 'urgent', receivedAt: undefined }));
  await notifyPendingArrivals({ ...f.deps, notifyArrival: async m => { notified.push(m.id); return true; } });
  assert.deepEqual(notified.sort(), ['mail-delivered', 'mail-seen']);
  assert.equal(fs.statSync(marker).mtimeMs, now);
});
test('F3 first poll creates migration marker before receiving new arrivals', async t => {
  const f = fixture(t), notified = [];
  f.save(mail({ id: 'mail-old', priority: 'urgent', receivedAt: iso(-1) }));
  f.deps.request = async () => ({ ok: true, messages: [mail({ id: 'mail-new', priority: 'urgent' })] });
  await pollOnce({ ...f.deps, notifyArrival: async m => { notified.push(m.id); return true; } });
  assert.deepEqual(notified, ['mail-new']); assert.equal(fs.statSync(path.join(f.dir, '.fleet-mail-v2-migrated')).mtimeMs, now);
});
test('F3 busy arrival reservation defers notification and final write contention cannot duplicate it', async t => {
  const f = fixture(t); f.save(mail({ priority: 'urgent' }));
  const lock = path.join(f.inbox, `${mail().id}.json.lock`); fs.writeFileSync(lock, 'owner');
  let notifications = 0, reserved;
  const deps = { ...f.deps, notifyArrival: async m => {
    notifications++; reserved = f.read(m.id).arrivalNotificationReservedAt;
    fs.writeFileSync(lock, 'other owner'); return true;
  } };
  await notifyPendingArrivals(deps); assert.equal(notifications, 0);
  fs.unlinkSync(lock);
  await notifyPendingArrivals(deps); assert.equal(notifications, 1); assert.ok(reserved);
  await notifyPendingArrivals(deps); assert.equal(notifications, 1);
  fs.unlinkSync(lock); await pollOnce(deps);
  assert.equal(notifications, 1); assert.equal(f.read(mail().id).arrivalNotifiedAt, iso(0));
});
test('F3 concurrent notification passes share one durable reservation', async t => {
  const f = fixture(t); f.save(mail({ priority: 'urgent' })); let notifications = 0;
  const deps = { ...f.deps, notifyArrival: async () => { notifications++; await notifyPendingArrivals(deps); return true; } };
  await notifyPendingArrivals(deps); assert.equal(notifications, 1); assert.ok(f.read(mail().id).arrivalNotifiedAt);
});

test('F2 answer payload lock retries then exits 6 without sending or acknowledging', async t => {
  const f = fixture(t), q = questionFixture(f, { relayedAt: iso(0) });
  const original = mail({ why: '[判断依頼]', meta: { relay: q } }); f.save(original);
  const answerDir = path.join(f.dir, 'fleet-answers'); fs.mkdirSync(answerDir);
  const lock = path.join(answerDir, `${original.id}.json.lock`); fs.writeFileSync(lock, 'owner');
  const request = f.deps.request;
  f.deps.request = async (kind, payload) => { const result = await request(kind, payload); return kind === 'mail-get' ? { ok: true, mail: original } : result; };
  const attempts = []; const open = fs.openSync;
  t.mock.method(fs, 'openSync', (...args) => { if (args[0] === lock && args[1] === 'wx') attempts.push(args); return open(...args); });
  assert.equal(await main(['--answer', original.id, '--body-file', f.body], f.deps), LOCK_BUSY_EXIT);
  assert.equal(attempts.length, COMMAND_LOCK_RETRIES + 1); assert.equal(f.errors.length, 1);
  assert.deepEqual(f.calls.map(c => c.kind), ['mail-get']); assert.equal(f.read(original.id).status, 'delivered');
});
test('F2 all-seen contention sends no partial batch and pendingLocal remains durable across a busy poll', async t => {
  const f = fixture(t); f.save(mail({ seenAt: iso(0) })); f.save(mail({ id: 'mail-other', seenAt: iso(0) }));
  const lock = path.join(f.inbox, 'mail-other.json.lock'); fs.writeFileSync(lock, 'owner');
  t.mock.method(Atomics, 'wait', () => 'timed-out');
  assert.equal(await main(['--ack', '--all-seen'], f.deps), LOCK_BUSY_EXIT); assert.equal(f.calls.length, 0);
  fs.unlinkSync(lock);
  const request = f.deps.request;
  f.deps.request = async (kind, payload) => { const response = await request(kind, payload); if (kind === 'mail-ack') fs.writeFileSync(lock, 'owner'); return response; };
  assert.equal(await main(['--ack', 'mail-other'], f.deps), 0);
  await pollOnce(f.deps);
  assert.equal(f.calls.filter(c => c.kind === 'mail-ack').length, 1);
  assert.equal(fs.existsSync(path.join(f.inbox, '.pending', 'mail-other.json')), true);
  fs.unlinkSync(lock); await pollOnce(f.deps);
  assert.equal(fs.existsSync(path.join(f.inbox, '.pending', 'mail-other.json')), false);
  assert.equal(f.calls.filter(c => c.kind === 'mail-ack').length, 1);
});

test('F2 ack completion journal preserves an already terminal broadcast state', async t => {
  const f = fixture(t);
  for (const status of TERMINAL_STATUSES) {
    const id = `mail-terminal-${status}`; f.save(mail({ id, to: 'all', status }));
    f.deps.request = async () => ({ ok: true, mail: { to: 'all', status: 'new' } });
    assert.equal(await main(['--ack', id], f.deps), 0);
    assert.equal(f.read(id).status, status); assert.deepEqual(f.read(id).pendingServer, []);
  }
});

// §11.4 safety regressions. All executions/transports are local doubles.
test('G1 prompt consent cannot authorize Claude resume; dedicated consent permits execution', async t => {
  const f = fixture(t), m = hubPrompt(f);
  fs.writeFileSync(path.join(f.dir, 'fleet-agent-optin.json'), JSON.stringify({ accept: ['prompt'] }));
  await runHubPoll(f);
  assert.equal(f.spawns.length, 0);
  assert.ok(f.calls.find(c => c.kind === 'mail-send').payload.body.includes(consentCommand('claude-resume')));
  const approved = hubPrompt(f, { id: 'mail-approved' });
  await runHubPoll(f);
  assert.equal(f.spawns.length, 1); assert.equal(f.read(approved.id).status, 'done');
  assert.equal(f.read(m.id).executionStartedAt, undefined);
});
for (const mode of ['spoof', 'unset']) test(`G2 ${mode} hub sender fails without execution`, async t => {
  const f = fixture(t), m = hubPrompt(f, mode === 'spoof' ? { from: receiver } : {});
  if (mode === 'unset') fs.writeFileSync(path.join(f.dir, 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.invalid/mail\nFLEET_SHEET_TOKEN=fixture\n');
  await runHubPoll(f);
  assert.equal(f.spawns.length, 0);
  assert.equal(f.calls.find(c => c.kind === 'mail-send').payload.reason, 'not-hub');
  assert.equal(f.calls.find(c => c.kind === 'mail-fail').payload.reason, 'not-hub');
  assert.equal(f.read(m.id).status, 'failed');
});
for (const mode of ['missing', 'file', 'no-git']) test(`G3 ${mode} cwd fails on receipt and answer before send`, async t => {
  const f = fixture(t);
  const cwd = mode === 'file' ? f.body : path.join(f.home, 'invalid-cwd');
  if (mode === 'no-git') fs.mkdirSync(cwd);
  hubPrompt(f, { execCwd: cwd });
  await runHubPoll(f);
  assert.equal(f.spawns.length, 0); assert.equal(f.calls.find(c => c.kind === 'mail-send').payload.reason, 'bad-cwd');
  const original = mail({ why: '[判断依頼]', meta: { relay: { sessionId: 'session-hub', cwd } } });
  f.deps.request = async (kind, payload) => { f.calls.push({ kind, payload }); return { ok: true, mail: original }; };
  f.calls.length = 0;
  assert.equal(await main(['--answer', original.id, '--body-file', f.body], f.deps), 2);
  assert.deepEqual(f.calls.map(c => c.kind), ['mail-get']); assert.match(f.errors.at(-1), /bad-cwd/);
});
test('G4 flag-like body is a positional argument after the terminator', async t => {
  const f = fixture(t), m = hubPrompt(f, { body: '--dangerously-skip-permissions do something' });
  await runHubPoll(f);
  assert.deepEqual(f.spawns[0][1], ['-p', '--resume', m.resumeSessionId, '--', m.body]);
});
for (const outcome of ['success', 'failure', 'timeout']) test(`G5 ${outcome} clears hub ownership and next question waits ten minutes`, async t => {
  const f = fixture(t), m = hubPrompt(f);
  f.deps.spawnImpl = promptSpawn(f, { code: outcome === 'failure' ? 1 : 0 });
  if (outcome === 'timeout') {
    f.deps.spawnImpl = () => { const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {}; return child; };
    f.deps.promptSetTimer = fn => { queueMicrotask(fn); return 1; }; f.deps.promptClearTimer = () => {};
  }
  await runHubPoll(f);
  const state = readQuestion(f.home, m.resumeSessionId);
  assert.equal(state.drivenByHub, false); assert.equal(state.resumingAt, undefined);
  const q = questionFixture(f, { ...state, question: 'next?', questionHash: 'next', askedAt: iso(0), relayedAt: null });
  assert.equal(await relayQuestions({ home: f.home, hub: sender, label: receiver, request: f.deps.request, now: () => now }), 0);
  assert.equal(await relayQuestions({ home: f.home, hub: sender, label: receiver, request: f.deps.request, now: () => now + RELAY_WAIT_MS }), 1);
  assert.ok(readQuestion(f.home, q.sessionId).relayedAt);
});
test('G6 poll detaches and releases lock within the hook deadline without waiting for the runner timeout', async t => {
  const f = fixture(t), m = hubPrompt(f); let unrefed = false;
  f.deps.spawnImpl = (...args) => { f.spawns.push(args); return { on() {}, unref() { unrefed = true; } }; };
  f.deps.promptSetTimer = () => assert.fail('poll must never start execution timer');
  f.deps.resolveClaudeExe = () => assert.fail('poll must never resolve Claude');
  const start = performance.now(); await pollOnce(f.deps);
  assert.ok(performance.now() - start < HOOK_DEADLINE_MS);
  assert.equal(unrefed, true); assert.equal(f.spawns[0][2].stdio, 'ignore');
  assert.equal(fs.existsSync(path.join(f.dir, 'fleet-mail.lock')), false);
  assert.equal(f.calls.some(c => c.kind === 'mail-reply'), false);
  assert.equal(readQuestion(f.home, m.resumeSessionId), null);
  await pollOnce(f.deps); assert.equal(f.spawns.length, 1);
});
test('G6 runner serializes concurrent resumes and preserves the first owner', async t => {
  const f = fixture(t), m = hubPrompt(f); let finish;
  f.deps.spawnImpl = () => { const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => {}; finish = () => c.emit('close', 0); return c; };
  const first = runClaudeTask({ ...f.deps, id: m.id });
  await new Promise(resolve => setImmediate(resolve));
  const secondMail = { ...m, id: 'mail-second', executionStartedAt: iso(0) }; f.save(secondMail);
  const second = await runClaudeTask({ ...f.deps, id: secondMail.id });
  assert.equal(second.skipped, 'session-busy'); assert.equal(f.read(secondMail.id).executionStartedAt, undefined);
  assert.equal(readQuestion(f.home, m.resumeSessionId).resumeMailId, m.id);
  finish(); await first;
  assert.equal(readQuestion(f.home, m.resumeSessionId).drivenByHub, false);
});
test('G7 failed execution with empty stdout reports stderr tail', async t => {
  const f = fixture(t); hubPrompt(f); f.deps.spawnImpl = promptSpawn(f, { code: 1, output: '' });
  await runHubPoll(f);
  assert.match(f.calls.find(c => c.kind === 'mail-send').payload.body, /自動回答.*exit-1.*stderr must not replace stdout/s);
  assert.equal(hubReport({ exitCode: 1, stdoutTail: '', outputTail: '', error: 'failure detail' }).outputTail.endsWith('failure detail'), true);
});
test('G9 answer rejects other recipients and detects changed retries unless forced', async t => {
  const f = fixture(t), q = questionFixture(f); let original = mail({ why: '[判断依頼]', to: sender, meta: { relay: q } });
  const request = f.deps.request;
  f.deps.request = async (kind, payload) => { const response = await request(kind, payload); return kind === 'mail-get' ? { ok: true, mail: original } : response; };
  const args = ['--answer', original.id, '--body-file', f.body];
  assert.equal(await main(args, f.deps), 2); assert.equal(f.calls.filter(c => c.kind === 'mail-send').length, 0);
  original = { ...original, to: receiver };
  assert.equal(await main(args, f.deps), 0);
  original.status = 'done';
  assert.equal(await main(args, f.deps), 0); assert.ok(f.output.includes('前回の回答を再送'));
  fs.writeFileSync(f.body, 'different answer');
  assert.equal(await main(args, f.deps), 3); assert.match(f.errors.at(-1), /本文が前回と異なる/);
  assert.equal(f.calls.filter(c => c.kind === 'mail-send').length, 2);
  assert.equal(await main([...args, '--force'], f.deps), 0);
  const sends = f.calls.filter(c => c.kind === 'mail-send');
  assert.equal(sends[0].payload.id, sends[1].payload.id); assert.notEqual(sends[1].payload.id, sends[2].payload.id);
  assert.match(sends[2].payload.body, /different answer$/);
});
import { QUESTION_RETENTION_MS, questionPath } from './fleet-question-relay.mjs';
test('G12 poll collects only expired question files and logs counts', async t => {
  const f = fixture(t); const q = questionFixture(f, { relayedAt: iso(0) });
  const old = questionPath(f.home, q.sessionId); const stale = new Date(now - QUESTION_RETENTION_MS - 1); fs.utimesSync(old, stale, stale);
  updateQuestion(f.home, 'recent', () => ({ sessionId: 'recent' }));
  const recent = questionPath(f.home, 'recent'); const boundary = new Date(now - QUESTION_RETENTION_MS); fs.utimesSync(recent, boundary, boundary);
  updateQuestion(f.home, 'active', () => ({ sessionId: 'active', resumingAt: iso(0) }));
  const active = questionPath(f.home, 'active'); fs.utimesSync(active, stale, stale);
  await pollOnce(f.deps);
  assert.equal(fs.existsSync(old), false); assert.equal(fs.existsSync(recent), true); assert.equal(fs.existsSync(active), true);
  assert.ok(f.errors.includes('fleet-mail: 質問回収=1'));
});

test('G6 runner revalidates consent sender and cwd after detached launch', async t => {
  for (const mode of ['consent', 'sender', 'cwd']) {
    const f = fixture(t), m = hubPrompt(f);
    await pollOnce({ ...f.deps, spawnImpl: () => ({ on() {}, unref() {} }) });
    if (mode === 'consent') fs.unlinkSync(path.join(f.dir, 'fleet-agent-optin.json'));
    if (mode === 'sender') fs.writeFileSync(path.join(f.dir, 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.invalid/mail\nFLEET_SHEET_TOKEN=fixture\n');
    if (mode === 'cwd') fs.rmdirSync(path.join(f.home, '.git'));
    const result = await runClaudeTask({ ...f.deps, id: m.id });
    assert.equal(f.spawns.length, 0);
    if (mode === 'consent') assert.ok(result.stderrTail.includes(consentCommand('claude-resume')));
    else assert.equal(result.reason, mode === 'sender' ? 'not-hub' : 'bad-cwd');
  }
});
test('G5 new session hook ownership is cleared when runner exits', async t => {
  const f = fixture(t), m = hubPrompt(f, { resumeSessionId: undefined });
  f.deps.spawnImpl = promptSpawn(f, { onSpawn: () => {
    updateQuestion(f.home, 'new-session', () => ({ sessionId: 'new-session', drivenByHub: true, resumeMailId: m.id }));
    updateQuestion(f.home, 'other-session', () => ({ sessionId: 'other-session', drivenByHub: true, resumeMailId: 'mail-unrelated' }));
  } });
  await runHubPoll(f);
  assert.equal(f.spawns[0][2].env.FLEET_RESUME_MAIL_ID, m.id);
  assert.equal(readQuestion(f.home, 'new-session').drivenByHub, false);
  assert.equal(readQuestion(f.home, 'other-session').drivenByHub, true);
});
test('G6 detached spawn failure is reported once without retrying execution', async t => {
  const f = fixture(t), m = hubPrompt(f); let spawns = 0;
  f.deps.spawnImpl = () => { spawns++; throw new Error('fixture spawn failure'); };
  await pollOnce(f.deps); await pollOnce(f.deps); await pollOnce(f.deps);
  assert.equal(spawns, 1); assert.equal(f.read(m.id).status, 'failed');
  assert.match(f.calls.find(c => c.kind === 'mail-send').payload.body, /runner 起動失敗/);
});

test('G9 answer detects differences beyond the transmitted length', async t => {
  const f = fixture(t), q = questionFixture(f), original = mail({ why: '[判断依頼]', meta: { relay: q } });
  const request = f.deps.request;
  f.deps.request = async (kind, payload) => { const result = await request(kind, payload); return kind === 'mail-get' ? { ok: true, mail: original } : result; };
  const body = 'x'.repeat(20000);
  fs.writeFileSync(f.body, body + 'A');
  const args = ['--answer', original.id, '--body-file', f.body];
  assert.equal(await main(args, f.deps), 0);
  fs.writeFileSync(f.body, body + 'B');
  assert.equal(await main(args, f.deps), 3); assert.equal(f.calls.filter(c => c.kind === 'mail-send').length, 1);
});

test('G5 poll clears interrupted or finished ownership before relaying another question', async t => {
  for (const finished of [false, true]) {
    const f = fixture(t), m = hubPrompt(f);
    questionFixture(f, { askedAt: iso(0), drivenByHub: true, resumingAt: iso(finished ? 0 : -RESUME_LIMIT_MS), resumeMailId: m.id });
    if (finished) { const dir = path.join(f.dir, 'fleet-agent-results'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, `${m.id}.json`), JSON.stringify(hubReport({ exitCode: 0, stdoutTail: 'done' }))); }
    f.save({ ...m, executionStartedAt: iso(-RESUME_LIMIT_MS) });
    await pollOnce(f.deps);
    assert.equal(readQuestion(f.home, m.resumeSessionId).drivenByHub, false);
    assert.equal(f.calls.filter(c => c.kind === 'mail-send' && !c.payload.id?.startsWith('mail-reply-fail-')).length, 0);
  }
});

test('G6 runner timeout includes launch delay and seen synchronization', async t => {
  const f = fixture(t), m = hubPrompt(f, { executionStartedAt: iso(-1000) }); let clock = now, timeout;
  const request = f.deps.request;
  f.deps.request = async (kind, payload) => { if (kind === 'mail-seen') clock += 1000; return request(kind, payload); };
  f.deps.now = () => clock;
  f.deps.promptSetTimer = (_fn, ms) => { timeout = ms; return 1; }; f.deps.promptClearTimer = () => {};
  await runClaudeTask({ ...f.deps, id: m.id });
  assert.equal(timeout, RESUME_LIMIT_MS - 2000);
  const late = hubPrompt(f, { id: 'mail-late', executionStartedAt: iso(-RESUME_LIMIT_MS) });
  const count = f.spawns.length;
  const result = await runClaudeTask({ ...f.deps, id: late.id });
  assert.equal(f.spawns.length, count); assert.equal(result.timedOut, true);
  assert.equal(readQuestion(f.home, late.resumeSessionId).drivenByHub, false);
});


for (const thrown of [false, true]) {
  for (const error of ['busy', 'fleet-mail read-back mismatch']) {
    test(`J send ${error} (${thrown ? 'transport exception' : 'server rejection'}) explains outcome without resending`, async t => {
      const f = fixture(t);
      f.deps.request = async (kind, payload) => {
        f.calls.push({ kind, payload: structuredClone(payload) });
        if (thrown) throw new Error(error);
        return { ok: false, error };
      };
      assert.equal(await main(sendArgs(f), f.deps), 1);
      assert.equal(f.calls.length, 1); assert.equal(f.output.length, 0);
      if (error === 'busy') assert.match(f.errors.at(-1), /送信されていない/);
      else {
        assert.match(f.errors.at(-1), /行は作成済みの可能性/);
        assert.ok(f.errors.at(-1).includes(`--sent-status ${f.calls[0].payload.id}`));
      }
      const log = fs.readFileSync(path.join(f.dir, 'fleet-mail-sent.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(log.filter(entry => entry.action === 'sent').length, 0);
    });
  }
}


for (const error of ['busy', 'fleet-mail read-back mismatch']) {
  test(`J real client ${error} retains send diagnostics and id`, async t => {
    const f = fixture(t);
    delete f.deps.request;
    f.deps.fetch = async (_url, options) => {
      f.calls.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: false, error }) };
    };
    assert.equal(await main(sendArgs(f), f.deps), 1);
    assert.equal(f.calls.length, 1);
    if (error === 'busy') assert.match(f.errors.at(-1), /送信されていない/);
    else assert.ok(f.errors.at(-1).includes(`--sent-status ${f.calls[0].id}`));
  });
}

for (const [result, reason] of [
  [{ exitCode: null, timedOut: true, stdoutTail: '', stderrTail: 'Permission allow rule (settings.json): warning' }, 'timeout'],
  [{ exitCode: 0, stdoutTail: 'Permission allow rule (settings.json): warning', stderrTail: '' }, 'empty'],
  [{ exitCode: 7, stdoutTail: 'partial', stderrTail: 'failure token=private' }, 'exit-7'],
  [{ exitCode: 0, stdoutTail: 'Permission allow rule (settings.json): warning\nanswer', stderrTail: 'warning must not appear' }, null],
]) test(`802 persisted runner result is collected as ${reason || 'stdout-only answer'}`, async t => {
  const f = fixture(t); f.save(mail({ kind: 'prompt', executionStartedAt: iso(-1000) }));
  fs.mkdirSync(path.join(f.dir, 'fleet-agent-results'));
  fs.writeFileSync(path.join(f.dir, 'fleet-agent-results', `${mail().id}.json`), JSON.stringify(result));
  await pollOnce(f.deps);
  assert.equal(f.spawns.length, 0);
  const replies = f.calls.filter(c => c.kind === 'mail-reply');
  if (reason) {
    assert.equal(replies.length, 0);
    assert.equal(f.calls.find(c => c.kind === 'mail-fail').payload.reason, reason);
    assert.equal(f.read(mail().id).status, 'failed');
    assert.equal(f.read(mail().id).failReason, reason);
    assert.doesNotMatch(f.calls.find(c => c.kind === 'mail-send').payload.body, /private/);
  } else assert.equal(replies[0].payload.resultBody, 'answer');
  await pollOnce(f.deps);
  assert.equal(f.spawns.length, 0);
  assert.equal(f.calls.filter(c => c.kind === 'mail-reply').length, reason ? 0 : 1);
});

test('802 failed mail accepts interactive reply as idempotent note and closes local task', async t => {
  const f = fixture(t); f.save(mail({ kind: 'prompt', status: 'failed', failReason: 'timeout' }));
  assert.equal(await main(['--reply', mail().id, '--body-file', f.body], f.deps), 0);
  const sent = f.calls.find(c => c.kind === 'mail-send').payload;
  assert.equal(sent.replyTo, mail().id); assert.equal(sent.to, sender);
  assert.equal(sent.body, 'nonempty test body'); assert.equal(sent.messageKind, 'note');
  assert.equal(f.calls.some(c => c.kind === 'mail-reply'), false);
  assert.equal(f.read(mail().id).status, 'done');
});

import { SENT_STATUS_MAX_LOOKUP_FAILURES, refreshSentStatus, stripClaudeWarnings } from './fleet-mail.mjs';
test('802 sender poll caches failure reason for the offline hook', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'fleet-mail-sent.jsonl'), JSON.stringify({ action: 'sent', id: 'mail-outbound' }) + '\n');
  await refreshSentStatus({ home: f.home, request: async (kind, payload) => {
    assert.equal(kind, 'mail-get'); assert.equal(payload.id, 'mail-outbound');
    return { ok: true, mail: { id: payload.id, to: sender, status: 'failed', failReason: 'timeout' } };
  } });
  const cached = JSON.parse(fs.readFileSync(path.join(f.dir, 'fleet-mail-sent-status.json')));
  assert.equal(cached['mail-outbound'].failReason, 'timeout');
});
test('821 sent status stops auto-polling an id the server never returns', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'fleet-mail-sent.jsonl'), JSON.stringify({ action: 'send-attempt', id: 'mail-never-sent' }) + '\n');
  let calls = 0; const messages = [];
  const request = async () => { calls++; throw new Error('timeout'); };
  for (let i = 0; i < SENT_STATUS_MAX_LOOKUP_FAILURES; i++) await refreshSentStatus({ home: f.home, request, stderr: m => messages.push(m) });
  assert.equal(calls, SENT_STATUS_MAX_LOOKUP_FAILURES);
  assert.equal(messages.filter(m => /再試行待ち/.test(m)).length, SENT_STATUS_MAX_LOOKUP_FAILURES - 1);
  assert.equal(messages.filter(m => /自動取得を打ち切り/.test(m)).length, 1);
  await refreshSentStatus({ home: f.home, request, stderr: m => messages.push(m) });
  assert.equal(calls, SENT_STATUS_MAX_LOOKUP_FAILURES, '打ち切り後は mail-get を呼ばない');
});
test('821 sent status counts an empty mail response as a lookup failure and resets after success', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'fleet-mail-sent.jsonl'), JSON.stringify({ action: 'send-attempt', id: 'mail-late' }) + '\n');
  let mail = null;
  const request = async (kind, payload) => ({ ok: true, mail });
  await refreshSentStatus({ home: f.home, request, stderr: () => {} });
  let cached = JSON.parse(fs.readFileSync(path.join(f.dir, 'fleet-mail-sent-status.json')));
  assert.equal(cached['mail-late'].lookupFailures, 1);
  mail = { id: 'mail-late', status: 'delivered' };
  await refreshSentStatus({ home: f.home, request, stderr: () => {} });
  cached = JSON.parse(fs.readFileSync(path.join(f.dir, 'fleet-mail-sent-status.json')));
  assert.equal(cached['mail-late'].status, 'delivered');
  assert.equal(cached['mail-late'].lookupFailures, undefined);
});
test('821 sent status never abandons a freshly sent id on transient timeouts', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'fleet-mail-sent.jsonl'), JSON.stringify({ action: 'sent', id: `mail-${Date.now()}-deadbeef` }) + '\n');
  let calls = 0;
  const request = async () => { calls++; throw new Error('timeout'); };
  for (let i = 0; i < SENT_STATUS_MAX_LOOKUP_FAILURES + 1; i++) await refreshSentStatus({ home: f.home, request, stderr: () => {} });
  assert.equal(calls, SENT_STATUS_MAX_LOOKUP_FAILURES + 1, 'sent 行がある id は一時的な失敗で打ち切らない');
});
test('821 sent status abandons an expired sent id so the retry noise stops', async t => {
  const f = fixture(t);
  const id = `mail-${Date.now() - 9 * 24 * 3600000}-abcd1234`;
  fs.writeFileSync(path.join(f.dir, 'fleet-mail-sent.jsonl'), JSON.stringify({ action: 'sent', id }) + '\n');
  let calls = 0;
  const request = async () => { calls++; throw new Error('timeout'); };
  for (let i = 0; i < SENT_STATUS_MAX_LOOKUP_FAILURES; i++) await refreshSentStatus({ home: f.home, request, stderr: () => {} });
  assert.equal(calls, SENT_STATUS_MAX_LOOKUP_FAILURES);
  await refreshSentStatus({ home: f.home, request, stderr: () => {} });
  assert.equal(calls, SENT_STATUS_MAX_LOOKUP_FAILURES, '期限切れ相当の id は打ち切り後 mail-get を呼ばない');
});
test('802 warning stripping keeps real answers and removes known configuration lines', () => {
  assert.equal(stripClaudeWarnings('Permission allow rule (settings.json): warning\r\nWarning: Invalid configuration entry\nanswer\nUnknown permission rule'), 'answer');
  assert.equal(stripClaudeWarnings('Permission is needed for the next step.'), 'Permission is needed for the next step.');
});

test('802 result transport retries preserve a long stdout answer without another execution', async t => {
  const f = fixture(t), answer = 'a'.repeat(6000);
  f.save(mail({ kind: 'prompt', executionStartedAt: iso(-1000) }));
  fs.mkdirSync(path.join(f.dir, 'fleet-agent-results'));
  fs.writeFileSync(path.join(f.dir, 'fleet-agent-results', `${mail().id}.json`), JSON.stringify({ exitCode: 0, stdoutTail: answer, stderrTail: 'warning' }));
  let fail = true; const request = f.deps.request;
  f.deps.request = async (kind, payload) => { const response = await request(kind, payload); if (kind === 'mail-reply' && fail) throw new Error('lost response'); return response; };
  await pollOnce(f.deps); fail = false; await pollOnce(f.deps);
  const replies = f.calls.filter(c => c.kind === 'mail-reply');
  assert.equal(replies.length, 2);
  assert.equal(replies[0].payload.resultBody, answer); assert.equal(replies[1].payload.resultBody, answer);
  assert.equal(f.spawns.length, 0);
});
