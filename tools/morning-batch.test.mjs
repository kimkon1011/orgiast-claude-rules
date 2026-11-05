import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addDecision, listDecisions } from './pending-decisions.mjs';
import { formatMorning, runMorning } from './morning-batch.mjs';

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
  // kim 席: 朝バッチの報告は Discord webhook ではなく kim-inbox 台帳へ1件入る（2026-10-27）。
  fs.writeFileSync(path.join(dir, '.claude', 'cost-reporter.env'), 'REPORTER_LABEL=kim-PC\n');
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return { ok: true, status: 204, text: async () => '' }; };
  await runMorning({ home: dir, now, intakeImpl: emptyIntake, webhookUrl: 'https://example.test/hook', fetchImpl });
  assert.equal(fetches, 0);
  const inboxDir = path.join(dir, '.claude', 'kim-inbox');
  assert.equal(fs.readdirSync(inboxDir).filter(f => f.endsWith('.json')).length, 1);
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
test('formats saved attachments as a count and readable path', () => {
  const message = formatMorning([{ capturedAt: '2026-08-31T18:59:00', author: '金功勇', text: 'これ', attachments: [{ filename: 'image.png', path: 'C:\\Users\\kim\\.claude\\inbox-attachments\\id\\0-image.png' }] }]);
  assert.match(message, /これ 📎1/);
  assert.match(message, /   📎 C:\\Users\\kim\\\.claude\\inbox-attachments\\id\\0-image\.png/);
});
test('shows failed attachment acquisition and leaves attachment-free rows unchanged', () => {
  const failed = formatMorning([{ capturedAt: '2026-08-31T18:59:00', author: 'kim', text: '失敗', attachments: [{ filename: 'bad.png', skipped: 'download-failed' }] }]);
  assert.match(failed, /失敗 📎1/); assert.match(failed, /📎 \(取得失敗: bad\.png\)/);
  const plain = formatMorning([{ capturedAt: '2026-08-31T18:59:00', author: 'kim', text: '通常' }]);
  assert.doesNotMatch(plain, /📎/);
});
test('通知本文を kim DM ヘルパに渡す', async () => {
  const dir = home(); addDecision({ source: 'discord-inbox', text: 'DM確認', author: 'kim' }, { home: dir });
  let sent = '';
  const result = await runMorning({ home: dir, intakeImpl: emptyIntake, notifyKimImpl: async (message) => { sent = message; return { delivered: 'dm' }; } });
  assert.match(sent, /DM確認/); assert.equal(result.sent, true);
});


test('October 9 legacy open decisions reach kim-inbox once and dry-run preserves the queue', async t => {
  const dir = home();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const capturedAt = '2026-10-09T06:00:00.000Z';
  const open = Array.from({ length: 5 }, (_, i) => ({
    id: `20261009060000000-00${i + 1}`, status: 'open', capturedAt,
    source: 'fleet-mail:nishi-PC', text: `legacy decision ${i + 1}`,
  }));
  const excluded = ['batched', 'resolved', 'closed', 'done', 'cancelled', 'invalid'].map(status => ({
    id: status, status, capturedAt, text: `excluded ${status}`,
  }));
  const pending = { id: 'new-pending', status: 'pending', capturedAt, text: 'new pending' };
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'cost-reporter.env'), 'REPORTER_LABEL=kim-PC\n');
  const queue = path.join(dir, '.claude', 'pending-decisions.jsonl');
  const original = [...open, pending, ...excluded].map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(queue, original);
  const options = { home: dir, intakeImpl: emptyIntake, fetchImpl: async () => assert.fail('unexpected network request') };
  const preview = await runMorning({ ...options, dryRun: true });
  assert.equal(preview.count, 6);
  assert.equal(fs.readFileSync(queue, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(dir, '.claude', 'kim-inbox')), false);
  const result = await runMorning(options);
  assert.equal(result.count, 6);
  assert.equal(result.sent, true);
  const inbox = path.join(dir, '.claude', 'kim-inbox');
  const files = fs.readdirSync(inbox).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const item = JSON.parse(fs.readFileSync(path.join(inbox, files[0]), 'utf8'));
  const handoff = fs.readFileSync(path.join(dir, '.claude', 'next-session.md'), 'utf8');
  for (const row of open) {
    assert.ok(item.text.includes(row.text));
    assert.ok(handoff.includes(row.id));
  }
  assert.doesNotMatch(item.text, /excluded/);
  const records = listDecisions({ home: dir });
  assert.ok(records.slice(0, 6).every(r => r.status === 'batched'));
  assert.deepEqual(records.slice(6), excluded);
  assert.equal((await runMorning(options)).count, 0);
  assert.equal(fs.readdirSync(inbox).filter(f => f.endsWith('.json')).length, 1);
});
