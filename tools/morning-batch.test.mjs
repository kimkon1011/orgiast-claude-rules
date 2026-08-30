import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addDecision, listDecisions } from './pending-decisions.mjs';
import { runMorning } from './morning-batch.mjs';

function home() { return fs.mkdtempSync(path.join(os.tmpdir(), 'morning-batch-')); }
const emptyIntake = async () => ({ decisions: [], count: 0, channelId: '123' });
test('does nothing when no pending decisions exist', async () => {
  const dir = home(); let fetches = 0;
  const result = await runMorning({ home: dir, intakeImpl: emptyIntake, fetchImpl: async () => { fetches++; } });
  assert.equal(result.count, 0); assert.equal(fetches, 0);
  assert.equal(fs.existsSync(path.join(dir, '.claude', 'next-session.md')), false);
});
test('posts once, appends TODO, and marks decisions batched', async () => {
  const dir = home(); const now = new Date('2026-08-31T07:00:00Z');
  addDecision({ source: 'discord-inbox', text: '見積確認', author: 'kim' }, { home: dir, now });
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return { ok: true, status: 204, text: async () => '' }; };
  await runMorning({ home: dir, now, intakeImpl: emptyIntake, webhookUrl: 'https://example.test/hook', fetchImpl });
  assert.equal(fetches, 1);
  const md = fs.readFileSync(path.join(dir, '.claude', 'next-session.md'), 'utf8');
  assert.match(md, /## 朝バッチ取り込み \(2026-08-31\)/); assert.match(md, /- \[ \] 見積確認/);
  assert.equal(listDecisions({ home: dir })[0].status, 'batched');
});
test('dry-run has no side effects', async () => {
  const dir = home(); const before = addDecision({ source: 'discord-inbox', text: 'dry', author: 'kim' }, { home: dir });
  const queue = path.join(dir, '.claude', 'pending-decisions.jsonl'); const original = fs.readFileSync(queue, 'utf8');
  let fetches = 0;
  const result = await runMorning({ home: dir, dryRun: true, intakeImpl: emptyIntake, fetchImpl: async () => { fetches++; } });
  assert.match(result.message, /dry/); assert.equal(fetches, 0); assert.equal(fs.readFileSync(queue, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(dir, '.claude', 'next-session.md')), false); assert.equal(listDecisions({ home: dir })[0].id, before.id);
});
test('adds TODOs inside an existing same-day section', async () => {
  const dir = home(); const now = new Date('2026-08-31T07:00:00');
  addDecision({ source: 'discord-inbox', text: '追加分', author: 'kim' }, { home: dir, now });
  const file = path.join(dir, '.claude', 'next-session.md');
  fs.writeFileSync(file, '## 朝バッチ取り込み (2026-08-31)\n- [ ] 既存\n## 後続\n本文\n');
  await runMorning({ home: dir, now, intakeImpl: emptyIntake, webhookUrl: 'https://example.test/hook', fetchImpl: async () => ({ ok: true, status: 204, text: async () => '' }) });
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.indexOf('追加分') < text.indexOf('## 後続'));
  assert.equal(text.match(/## 朝バッチ取り込み/g).length, 1);
});
