import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectCases, transcriptRecords, nextBatch, renderState, resumeText, HEADINGS, bytes } from './lib/case-handoff.mjs';
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
