import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectCases, transcriptRecords, nextBatch, renderState, resumeText, HEADINGS, bytes, hash } from './lib/case-handoff.mjs';
import { redactForShare } from './lib/share-secrets.mjs';
import { client, atomic } from './case-handoff.mjs';

const identity = { sessionId: 'session-1', account: 'kim@orgiast.jp', pc: 'kim-PC' };
const source = { ...identity, file: '20261029-kim-session-1.md', timestamp: '2026-10-29T01:00:00Z' };
const row = (uuid, type, content) => JSON.stringify({ uuid, type, timestamp: source.timestamp, message: { content } });
const transcript = [row('u1', 'user', '案件261021KGSを続けて'), row('a1', 'assistant', [{ type: 'text', text: '決定しました' }]), row('u2', 'user', '次の作業')].join('\n') + '\n';
test('detect IDs, multiple cases, cached names and reject partial keys', () => {
  assert.deepEqual(detectCases('261021KGS と 261029AB、261021KGS'), ['261021KGS', '261029AB']);
  assert.deepEqual(detectCases('展示会Aを再開', [{ id: '261021KGS', name: '展示会A' }]), ['261021KGS']);
  assert.deepEqual(detectCases('TEST000000ZZ 1261021KGS 261021KGSXYZQ'), []);
  assert.deepEqual(detectCases('C0001 と展示会A', [{ id: 'C0042', name: '展示会A' }]), ['C0001', 'C0042']);
});
test('preserve all user/assistant text, separate tools and retain file/Drive references', () => {
  const text = '長文'.repeat(10000);
  const raw = row('a', 'assistant', [{ type: 'text', text }, { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/report.pdf', driveId: 'drive-file-123' } }]) + '\n' +
    row('b', 'user', [{ type: 'tool_result', tool_use_id: 't1', content: '結'.repeat(600) }]);
  const records = transcriptRecords(raw);
  assert.ok(records[0].markdown.includes(text)); assert.match(records[0].markdown, /\/tmp\/report.pdf/);
  assert.match(records[0].markdown, /drive-file-123/); assert.ok(!records[1].markdown.includes('結'.repeat(501)));
  assert.equal(records[1].role, 'tool');
});
test('shared redaction catches PEM, JSON/env credentials and bearer before result truncation', () => {
  const values = ['ORGIAST_SHARED_SECRET=example-secret', '{"private_key":"-----BEGIN PRIVATE KEY-----\\nexample-private\\n-----END PRIVATE KEY-----"}',
    'Authorization: Bearer sample-access', 'GEMINI_API_KEY=sample-key', 'ghp_abcdefghijklmnopqrstuvwxyz', 'password: "sample-pass"'];
  const redacted = redactForShare(values.join('\n'));
  for (const secret of ['example-secret', 'example-private', 'sample-access', 'sample-key', 'abcdefghijklmnopqrstuvwxyz', 'sample-pass']) assert.ok(!redacted.includes(secret), secret);
});
test('UUID checkpoints are deterministic and incomplete tail never acknowledged', () => {
  const one = nextBatch(transcript, '', identity, '261021KGS');
  assert.equal(one.batchId, nextBatch(transcript, '', identity, '261021KGS').batchId);
  assert.equal(one.userCount, 2); assert.equal(nextBatch(transcript, one.lastUuid, identity, '261021KGS'), null);
  assert.equal(nextBatch(transcript + '{"uuid":', '', identity, '261021KGS').lastUuid, 'u2');
  assert.throws(() => nextBatch(transcript, 'lost', identity, '261021KGS'), /uuid/);
  assert.throws(() => transcriptRecords('{bad}\n' + transcript), /line 1/);
});

test('empty internal records do not change content; v2 distinguishes cursor and content under the same end UUID', () => {
  const raw = JSON.stringify({ type: 'progress', uuid: 'internal' }) + '\n' + transcript;
  const a = nextBatch(raw, '', identity, '261021KGS');
  const b = nextBatch(raw, 'internal', identity, '261021KGS');
  assert.equal(a.markdown, b.markdown); assert.equal(a.lastUuid, b.lastUuid);
  assert.notEqual(a.batchId, b.batchId); assert.equal(a.version, 2);
  assert.notEqual(a.batchId, nextBatch(raw.replace('次の作業', '変更'), '', identity, '261021KGS').batchId);
  assert.notEqual(a.batchId, nextBatch(raw, '', identity, '261029AB').batchId);
  assert.equal(a.batchId, nextBatch(raw, '', identity, '261021KGS').batchId);
});

test('identical UUID-less bridge records have distinct stable checkpoints instead of rolling the cursor back', () => {
  const bridge = JSON.stringify({ type: 'bridge-session', bridgeId: 'same' });
  const raw = bridge + '\n' + transcript + bridge + '\n';
  const records = transcriptRecords(raw);
  assert.notEqual(records[0].uuid, records.at(-1).uuid);
  const batch = nextBatch(raw, '', identity, '261021KGS');
  assert.equal(nextBatch(raw, batch.lastUuid, identity, '261021KGS'), null);
  const extended = raw + row('new', 'user', '追加発言') + '\n' + bridge + '\n';
  const next = nextBatch(extended, batch.lastUuid, identity, '261021KGS');
  assert.equal(next.userCount, 1); assert.ok(!next.markdown.includes('案件261021KGSを続けて'));
  assert.equal(nextBatch(extended, next.lastUuid, identity, '261021KGS'), null);
  const legacy = nextBatch(raw, `line-${hash(bridge)}`, identity, '261021KGS');
  assert.equal(legacy.userCount, 2); assert.equal(legacy.lastUuid, batch.lastUuid);
});

test('known 409 codes are shown safely and only Drive conflicts use bounded jittered retries', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'case-codes-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const code of ['batch_changed', 'drive_busy', 'drive_contention', 'state_not_ready', 'secret-upstream-text']) {
    let calls = 0; const delays = [];
    const c = client({ home, ...identity, random: () => 0.5, sleep: async ms => delays.push(ms), fetchImpl: async () => {
      calls++; return Response.json({ code, error: 'transcript-secret' }, { status: 409 });
    } });
    await assert.rejects(c.request({}, {}), e => e.message.includes('HTTP 409') && !e.message.includes('secret') &&
      (code === 'secret-upstream-text' || e.message.includes(`[${code}]`)));
    const retryable = ['drive_busy', 'drive_contention'].includes(code);
    assert.equal(calls, retryable ? 4 : 1); assert.deepEqual(delays, retryable ? [750, 1250, 2250] : []);
  }
});

test('Drive contention retries the identical persisted batch and advances cursor only after success', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'case-retry-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'session.jsonl'); fs.writeFileSync(file, transcript);
  const bodies = [];
  const c = client({ home, ...identity, sleep: async () => {}, fetchImpl: async (_url, init) => {
    bodies.push(init.body);
    assert.equal(JSON.parse(fs.readFileSync(c.bindingFile(identity.sessionId))).cursors['261021KGS'], undefined);
    c.stage(identity.sessionId);
    return bodies.length === 1 ? Response.json({ code: 'drive_contention' }, { status: 409 }) : Response.json({ batchId: JSON.parse(init.body).batchId, stateReady: true });
  } });
  c.bind(identity.sessionId, ['261021KGS'], file); c.stage(identity.sessionId);
  assert.deepEqual(await c.drain(), { sent: 1, remaining: 0 }); assert.equal(bodies[0], bodies[1]);
  assert.equal(JSON.parse(fs.readFileSync(c.bindingFile(identity.sessionId))).cursors['261021KGS'], 'u2');
});

test('a conflicting legacy batch is retained without starving an unrelated case', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'case-fair-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'session.jsonl'); fs.writeFileSync(file, transcript);
  const c = client({ home, ...identity, fetchImpl: async (_url, init) => {
    const b = JSON.parse(init.body);
    return b.caseId === '261021KGS' ? Response.json({ code: 'batch_changed' }, { status: 409 }) : Response.json({ batchId: b.batchId, stateReady: true });
  } });
  c.bind(identity.sessionId, ['261021KGS', 'C0039'], file); c.stage(identity.sessionId);
  const queued = path.join(c.base, 'case-queue', `261021KGS-${identity.sessionId}.json`);
  const legacy = JSON.parse(fs.readFileSync(queued)); legacy.version = 1; legacy.batchId = hash(`${legacy.sessionId}\n${legacy.lastUuid}`); atomic(queued, legacy);
  const before = fs.readFileSync(queued, 'utf8');
  await assert.rejects(c.drain(), /batch_changed/);
  assert.equal(fs.readFileSync(queued, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(queued)), [path.basename(queued)]);
  assert.equal(JSON.parse(fs.readFileSync(c.bindingFile(identity.sessionId))).cursors.C0039, 'u2');
});
test('state keeps all headings within 4KB, resume within 6KB in Japanese', () => {
  const long = 'あ'.repeat(10000);
  const state = renderState({ purpose: long, customer: long, decisions: [{ text: long }], next: long, files: long }, source, [{ ...identity, at: source.timestamp }]);
  assert.ok(bytes(state) <= 4096); for (const heading of HEADINGS) assert.ok(state.includes(`## ${heading}`));
  assert.ok(state.includes(`[${source.file} ${source.timestamp}]`));
  assert.ok(bytes(resumeText(state, long)) <= 6144);
});
test('failure keeps exact batch queued, successful replay advances cursor once, cold resume is bounded', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'case-test-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'session.jsonl'); fs.writeFileSync(file, transcript);
  let fail = true; const batches = new Set(); let calls = 0;
  const c = client({ home, ...identity, fetchImpl: async (_url, init) => {
    if (init.method === 'GET') return Response.json({ state: renderState({}, source), log: '' });
    const b = JSON.parse(init.body); calls++; if (fail) throw Error('offline');
    batches.add(b.batchId); return Response.json({ batchId: b.batchId, stateReady: true });
  } });
  c.bind(identity.sessionId, ['261021KGS'], file); c.stage(identity.sessionId);
  await assert.rejects(c.drain(), /offline/); assert.equal(fs.readdirSync(path.join(c.base, 'case-queue')).filter(n => n.endsWith('.json')).length, 1);
  fail = false; assert.equal((await c.drain()).sent, 1); assert.equal((await c.drain()).sent, 0);
  assert.equal(batches.size, 1); assert.equal(calls, 2);
  assert.ok(bytes(await c.resume('261021KGS')) <= 6144); assert.ok(fs.existsSync(path.join(c.base, 'case-sessions/261021KGS/STATE.md')));
});

test('setup converge installs all four hooks with matching verification and repairs a missing hook', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'case-setup-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'tools/setup-manifest.json'), 'utf8'));
  const items = manifest.items.filter(i => i.id.startsWith('settings:case-handoff-'));
  assert.equal(items.length, 4); const mf = path.join(home, 'manifest.json'); atomic(mf, { version: 1, items });
  const run = () => spawnSync(process.execPath, [path.join(repo, 'tools/setup.mjs'), '--converge', '--home', home, '--manifest', mf, '--json'],
    { env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo, FLEET_BEACON: '0' }, encoding: 'utf8' });
  const first = run(); assert.equal(first.status, 0, first.stdout + first.stderr);
  const settings = path.join(home, '.claude/settings.json'); const saved = JSON.parse(fs.readFileSync(settings));
  saved.hooks.SessionEnd = []; atomic(settings, saved);
  const second = run(); assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(JSON.parse(second.stdout).items.every(i => i.status === 'OK'), true, second.stdout);
});

test('debounced Stop sends a complete multi-batch burst then defers new speech for ten minutes', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'case-burst-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'session.jsonl');
  fs.writeFileSync(file, row('one', 'user', '長'.repeat(40000)) + '\n' + row('two', 'assistant', '文'.repeat(40000)) + '\n');
  const c = client({ home, ...identity, fetchImpl: async (_url, init) => Response.json({ batchId: JSON.parse(init.body).batchId, stateReady: true }) });
  c.bind(identity.sessionId, ['261021KGS'], file); c.stage(identity.sessionId);
  assert.deepEqual(await c.drain({ dueOnly: true }), { sent: 2, remaining: 0 });
  fs.appendFileSync(file, row('three', 'user', '追加') + '\n'); c.stage(identity.sessionId);
  assert.deepEqual(await c.drain({ dueOnly: true }), { sent: 0, remaining: 1 });
  assert.deepEqual(await c.drain(), { sent: 1, remaining: 0 });
});

test('adding a case while the worker awaits acknowledgment retains both bindings and the cursor', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'case-binding-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'session.jsonl'); fs.writeFileSync(file, transcript);
  const c = client({ home, ...identity, fetchImpl: async (_url, init) => {
    c.bind(identity.sessionId, ['261029AB'], file);
    return Response.json({ batchId: JSON.parse(init.body).batchId, stateReady: true });
  } });
  c.bind(identity.sessionId, ['261021KGS'], file); c.stage(identity.sessionId); await c.drain();
  const binding = JSON.parse(fs.readFileSync(c.bindingFile(identity.sessionId)));
  assert.deepEqual(binding.cases, ['261021KGS', '261029AB']);
  assert.equal(binding.cursors['261021KGS'], 'u2'); assert.equal(binding.cursors['261029AB'], 'u2');
  fs.writeFileSync(`${c.bindingFile(identity.sessionId)}.lock`, String(process.pid));
  assert.throws(() => c.bind(identity.sessionId, ['261030AB'], file), /使用中/);
  assert.ok(!JSON.parse(fs.readFileSync(c.bindingFile(identity.sessionId))).cases.includes('261030AB'));
});
