import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  normalizeText,
  diffRatio,
  recordDecision,
  readCorrections,
  examples,
  ensureVoice,
  context,
  gmailSync,
  promote,
  metrics,
  nightly,
} from './reply-learning.mjs';

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
}

function writeSeed(home, content) {
  const d = path.join(home, '.claude', 'reply-learning');
  fs.mkdirSync(d, { recursive: true });
  const seedPath = path.join(d, 'test-seed.md');
  fs.writeFileSync(seedPath, content, 'utf-8');
  return seedPath;
}

function sampleItem(overrides = {}) {
  return {
    id: 'i1',
    key: 'k1',
    channel: 'chat',
    from: { name: 'A', id: 'a1', external: false },
    category: 'general',
    body: 'hello',
    draft: { text: 'draft1', createdAt: '2025-01-01T00:00:00Z' },
    decision: { verdict: 'approved', finalText: 'draft1', reason: 'ok', at: '2025-01-01T00:00:00Z' },
    ...overrides,
  };
}

test('diffRatio: same is 0, different between 0 and 1, normalize handles fullwidth and spaces', () => {
  assert.strictEqual(diffRatio('abc', 'abc'), 0);
  const r = diffRatio('abc', 'abd');
  assert.ok(r > 0 && r < 1);
  assert.strictEqual(diffRatio('ＡＢＣ', 'ABC'), 0);
  assert.strictEqual(diffRatio('a  b   c', 'a b c'), 0);
  assert.strictEqual(diffRatio('  hello  ', 'hello'), 0);
  assert.strictEqual(diffRatio('', ''), 0);
  assert.strictEqual(diffRatio('a', 'b'), 1);
});

test('recordDecision: approved diffRatio 0, edited >0, rejected final null, duplicate not appended', () => {
  const home = mkHome();
  const item = sampleItem({ decision: { verdict: 'approved', finalText: 'draft1', reason: 'ok', at: '2025-01-01T00:00:00Z' } });
  const r1 = recordDecision(home, item, { now: new Date('2025-01-01T00:00:00Z'), source: 'manual' });
  assert.strictEqual(r1.appended, true);
  assert.strictEqual(r1.row.final, 'draft1');
  assert.strictEqual(r1.row.diffRatio, 0);
  assert.strictEqual(r1.row.source, 'manual');

  const r2 = recordDecision(home, item, { now: new Date('2025-01-01T00:00:00Z'), source: 'manual' });
  assert.strictEqual(r2.appended, false);
  const rows = readCorrections(home);
  assert.strictEqual(rows.length, 1);

  const itemEdited = sampleItem({ draft: { text: 'draft1', createdAt: '2025-01-01T00:00:00Z' }, decision: { verdict: 'edited', finalText: 'draft2', reason: 'edit', at: '2025-01-01T00:00:00Z' } });
  const r3 = recordDecision(home, itemEdited, { now: new Date('2025-01-01T01:00:00Z'), source: 'manual' });
  assert.strictEqual(r3.appended, true);
  assert.ok(r3.row.diffRatio > 0);

  const itemRejected = sampleItem({ decision: { verdict: 'rejected', finalText: null, reason: 'no', at: '2025-01-01T02:00:00Z' } });
  const r4 = recordDecision(home, itemRejected, { now: new Date('2025-01-01T02:00:00Z'), source: 'manual' });
  assert.strictEqual(r4.appended, true);
  assert.strictEqual(r4.row.final, null);
});

test('examples priority: from match first, category match second, others included, rejected excluded', () => {
  const home = mkHome();
  const base = {
    id: 'x', key: 'x', channel: 'chat', from: { name: 'B', id: 'b', external: false }, category: 'other', body: 'x',
    draft: { text: 'd', createdAt: '2025-01-01T00:00:00Z' },
  };
  const items = [
    { ...base, id: 'iA', key: 'kA', from: { name: 'A', id: 'a', external: false }, category: 'question', decision: { verdict: 'approved', finalText: 'fA', reason: 'r', at: '2025-01-01T00:00:00Z' } },
    { ...base, id: 'iB', key: 'kB', from: { name: 'B', id: 'b', external: false }, category: 'question', decision: { verdict: 'approved', finalText: 'fB', reason: 'r', at: '2025-01-01T01:00:00Z' } },
    { ...base, id: 'iC', key: 'kC', from: { name: 'C', id: 'c', external: false }, category: 'general', decision: { verdict: 'approved', finalText: 'fC', reason: 'r', at: '2025-01-01T02:00:00Z' } },
    { ...base, id: 'iD', key: 'kD', from: { name: 'D', id: 'd', external: false }, category: 'question', decision: { verdict: 'rejected', finalText: null, reason: 'r', at: '2025-01-01T03:00:00Z' } },
  ];
  for (const item of items) {
    recordDecision(home, item, { now: new Date('2025-01-01T00:00:00Z'), source: 'manual' });
  }
  const result = examples(home, { from: 'A', category: 'question', limit: 5 });
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0].verdict, 'approved');
  assert.strictEqual(result[0].from.name, 'A');
  assert.strictEqual(result[1].category, 'question');
  assert.strictEqual(result[1].from.name, 'B');
  const hasRejected = result.some(r => r.verdict === 'rejected');
  assert.strictEqual(hasRejected, false);
});

test('context: records usage and includes voiceRules from seed', () => {
  const home = mkHome();
  const seedPath = writeSeed(home, '# Voice\nBe polite.');
  const ctx = context(home, { itemId: 'ctx1', from: { name: 'A', id: 'a', external: false }, category: 'general', channel: 'chat', limit: 3, now: new Date('2025-01-01T00:00:00Z'), seedPath });
  assert.ok(Array.isArray(ctx.examples));
  assert.ok(ctx.voiceRules.includes('Be polite.'));
  assert.ok(typeof ctx.voiceVersion === 'string');
  const usagePath = path.join(home, '.claude', 'reply-learning', 'usage.jsonl');
  const lines = fs.readFileSync(usagePath, 'utf-8').trim().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1);
  const usage = JSON.parse(lines[0]);
  assert.strictEqual(usage.itemId, 'ctx1');
  assert.ok(Array.isArray(usage.examplesUsed));
  assert.strictEqual(usage.voiceVersion, ctx.voiceVersion);
});

test('gmailSync: first call returns corrections, second call returns 0, unmatched returns reasons', async () => {
  const home = mkHome();
  const item = {
    id: 'g1', key: 'gk1', channel: 'email', from: { name: 'G', id: 'g', external: true }, category: 'general',
    body: 'email body', draft: { text: 'draft reply', createdAt: '2025-01-01T00:00:00Z' },
    thread: 'thread1',
  };
  const deps = {
    listItems: async (h, filter) => {
      assert.strictEqual(h, home);
      assert.strictEqual(filter.channel, 'email');
      return [item];
    },
    searchGmail: async ({ user, query, max, withBody }) => {
      return {
        messages: [
          { id: 'msg1', threadId: 'thread1', internalDate: '1735776000000', body: 'different body' },
        ],
      };
    },
  };
  const r1 = await gmailSync(home, { days: 1, dryRun: false, now: new Date('2025-01-02T00:00:00Z'), users: ['u1'], deps });
  assert.strictEqual(r1.scanned, 1);
  assert.strictEqual(r1.matched, 1);
  assert.strictEqual(r1.corrections, 1);
  assert.strictEqual(r1.approved, 0);
  assert.strictEqual(r1.skipped, 0);
  const corr = readCorrections(home);
  const gmailCorr = corr.filter(c => c.source === 'gmail');
  assert.strictEqual(gmailCorr.length, 1);
  assert.strictEqual(gmailCorr[0].verdict, 'edited');

  const r2 = await gmailSync(home, { days: 1, dryRun: false, now: new Date('2025-01-02T00:00:00Z'), users: ['u1'], deps });
  assert.strictEqual(r2.corrections, 0);
  assert.strictEqual(r2.matched, 0);
  assert.strictEqual(r2.skipped, 1);

  const depsNoMatch = {
    listItems: async () => [item],
    searchGmail: async () => ({ messages: [{ id: 'msg2', threadId: 'thread2', internalDate: '1700000000000', body: 'diff' }] }),
  };
  const r3 = await gmailSync(home, { days: 1, dryRun: false, now: new Date('2025-01-02T00:00:00Z'), users: ['u1'], deps: depsNoMatch });
  assert.strictEqual(r3.matched, 0);
  assert.ok(r3.reasons.length > 0);
});

test('promote: two same type adds rule and changelog, conflict calls addItem(ask), dryRun does nothing', async () => {
  const home = mkHome();
  const d = path.join(home, '.claude', 'reply-learning');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'corrections.jsonl'), [
    JSON.stringify({ key: 'k1', channel: 'chat', from: { name: 'A', id: 'a', external: false }, category: 'general', verdict: 'edited', final: 'reply1', diffRatio: 0.5, source: 'manual', ts: '2025-01-01T00:00:00Z' }),
    JSON.stringify({ key: 'k2', channel: 'chat', from: { name: 'B', id: 'b', external: false }, category: 'general', verdict: 'edited', final: 'reply2', diffRatio: 0.4, source: 'manual', ts: '2025-01-01T01:00:00Z' }),
  ].join('\n'), 'utf-8');
  const voicePath = path.join(d, 'kim-voice.md');
  fs.writeFileSync(voicePath, '# Kim Voice\n## 自動昇格ルール\n', 'utf-8');

  const deps = {
    ask: async (prompt) => {
      if (prompt.includes('contradicts') || prompt.includes('矛盾')) {
        return JSON.stringify({ contradicts: false, with: '' });
      }
      return JSON.stringify({ type: 'test', rule: '署名を付ける' });
    },
    addItem: async (h, opts) => {
      assert.strictEqual(h, home);
      return { id: 'new' };
    },
  };
  const r1 = await promote(home, { dryRun: false, now: new Date('2025-01-02T00:00:00Z'), deps });
  assert.strictEqual(r1.examined, 2);
  assert.strictEqual(r1.candidates.length, 1);
  assert.strictEqual(r1.candidates[0].count, 2);
  assert.strictEqual(r1.promoted.length, 1);
  const voiceAfter = fs.readFileSync(voicePath, 'utf-8');
  assert.ok(voiceAfter.includes('自動昇格'));
  const changelogPath = path.join(d, 'kim-voice.changelog.md');
  const changelog = fs.readFileSync(changelogPath, 'utf-8');
  assert.ok(changelog.includes('+'));

  // conflict case
  const home2 = mkHome();
  const d2 = path.join(home2, '.claude', 'reply-learning');
  fs.mkdirSync(d2, { recursive: true });
  fs.writeFileSync(path.join(d2, 'corrections.jsonl'), [
    JSON.stringify({ key: 'k3', channel: 'chat', from: { name: 'A', id: 'a', external: false }, category: 'general', verdict: 'edited', final: 'reply3', diffRatio: 0.3, source: 'manual', ts: '2025-01-01T00:00:00Z' }),
    JSON.stringify({ key: 'k4', channel: 'chat', from: { name: 'B', id: 'b', external: false }, category: 'general', verdict: 'edited', final: 'reply4', diffRatio: 0.2, source: 'manual', ts: '2025-01-01T01:00:00Z' }),
  ].join('\n'), 'utf-8');
  fs.writeFileSync(path.join(d2, 'kim-voice.md'), '# Kim Voice\n## 自動昇格ルール\n', 'utf-8');
  let addItemCalled = false;
  const depsConflict = {
    ask: async (prompt) => (prompt.includes('矛盾') ? JSON.stringify({ contradicts: true, with: '既存ルール' }) : JSON.stringify({ type: 'test', rule: '敬語を簡潔に' })),
    addItem: async (h, opts) => {
      addItemCalled = true;
      assert.strictEqual(opts.kind, 'ask');
      return { id: 'ask1' };
    },
  };
  const r2 = await promote(home2, { dryRun: false, now: new Date('2025-01-02T00:00:00Z'), deps: depsConflict });
  assert.strictEqual(r2.promoted.length, 0);
  assert.strictEqual(r2.conflicts.length, 1);
  assert.strictEqual(addItemCalled, true);

  // dryRun
  const home3 = mkHome();
  const d3 = path.join(home3, '.claude', 'reply-learning');
  fs.mkdirSync(d3, { recursive: true });
  fs.writeFileSync(path.join(d3, 'corrections.jsonl'), [
    JSON.stringify({ key: 'k5', channel: 'chat', from: { name: 'A', id: 'a', external: false }, category: 'general', verdict: 'edited', final: 'reply5', diffRatio: 0.5, source: 'manual', ts: '2025-01-01T00:00:00Z' }),
    JSON.stringify({ key: 'k6', channel: 'chat', from: { name: 'B', id: 'b', external: false }, category: 'general', verdict: 'edited', final: 'reply6', diffRatio: 0.4, source: 'manual', ts: '2025-01-01T01:00:00Z' }),
  ].join('\n'), 'utf-8');
  fs.writeFileSync(path.join(d3, 'kim-voice.md'), '# Kim Voice\n## 自動昇格ルール\n', 'utf-8');
  let addItemDry = false;
  const depsDry = {
    ask: async (prompt) => (prompt.includes('矛盾') ? JSON.stringify({ contradicts: false, with: '' }) : JSON.stringify({ type: 'test', rule: '日程は相手候補を先に' })),
    addItem: async () => { addItemDry = true; },
  };
  const r3 = await promote(home3, { dryRun: true, now: new Date('2025-01-02T00:00:00Z'), deps: depsDry });
  assert.strictEqual(r3.promoted.length, 1);
  assert.strictEqual(addItemDry, false);
  const voiceDry = fs.readFileSync(path.join(d3, 'kim-voice.md'), 'utf-8');
  assert.strictEqual(voiceDry, '# Kim Voice\n## 自動昇格ルール\n');
});

test('metrics: computes aggregated values, sheet path appends rows and saves sheet-id.txt', async () => {
  const home = mkHome();
  const d = path.join(home, '.claude', 'reply-learning');
  fs.mkdirSync(d, { recursive: true });
  const items = [
    { channel: 'chat', category: 'q', verdict: 'approved', final: 'ok', diffRatio: 0 },
    { channel: 'chat', category: 'q', verdict: 'edited', final: 'edited', diffRatio: 0.5 },
    { channel: 'chat', category: 'q', verdict: 'rejected', final: null, diffRatio: 1 },
  ];
  fs.writeFileSync(path.join(d, 'corrections.jsonl'), items.map((it, i) => JSON.stringify({ key: `m${i}`, channel: it.channel, from: { name: 'M', id: 'm', external: false }, category: it.category, verdict: it.verdict, final: it.final, diffRatio: it.diffRatio, source: 'manual', ts: '2025-01-01T00:00:00Z' })).join('\n'), 'utf-8');

  let appendCalls = 0;
  const deps = {
    sheets: {
      append: async (id, range, rows) => { appendCalls++; },
      get: async () => ({ values: [] }),
    },
    createSpreadsheet: async () => 'sheet123',
    addItem: async (h, opts) => {
      assert.strictEqual(opts.kind, 'info');
      assert.ok(opts.text.includes('spreadsheets/d/sheet123'));
      return { id: 'info1' };
    },
  };
  const r = await metrics(home, { since: '2025-01-01T00:00:00Z', sheet: true, dryRun: false, now: new Date('2025-01-02T00:00:00Z'), deps, extra: {} });
  assert.strictEqual(r.rows.length, 1);
  const row = r.rows[0];
  assert.strictEqual(row.channel, 'chat');
  assert.strictEqual(row.category, 'q');
  assert.strictEqual(row.decided, 3);
  assert.strictEqual(row.approvedRate, 1 / 3);
  assert.strictEqual(row.meanDiff, 0.5);
  assert.strictEqual(row.rejectRate, 1 / 3);
  assert.strictEqual(row.noReplyRate, 0);
  const sheetIdPath = path.join(home, '.claude', 'reply-learning', 'sheet-id.txt');
  assert.ok(fs.existsSync(sheetIdPath));
  assert.strictEqual(fs.readFileSync(sheetIdPath, 'utf-8').trim(), 'sheet123');
  assert.ok(appendCalls >= 2);
});

test('nightly: gmailSync throw but other steps run, ok:false, nightly.log written', async () => {
  const home = mkHome();
  const d = path.join(home, '.claude', 'reply-learning');
  fs.mkdirSync(d, { recursive: true });
  const deps = {
    gapCheck: async () => ({ targets: 3, enqueued: 1 }),
    listItems: async () => { throw new Error('gmail fail'); },
    searchGmail: async () => { throw new Error('gmail fail'); },
    ask: async () => JSON.stringify({ category: 'test', type: 'x' }),
    addItem: async () => ({ id: 'x' }),
    sheets: { append: async () => {}, get: async () => ({ values: [] }) },
    createSpreadsheet: async () => 'sheetN',
  };
  const r = await nightly(home, { dryRun: false, now: new Date('2025-01-01T00:00:00Z'), deps });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(typeof r.steps, 'object');
  assert.ok(r.steps.gmailSync && r.steps.gmailSync.error);
  assert.ok(r.steps.promote && !r.steps.promote.error);
  assert.deepStrictEqual(r.steps.gapCheck, { targets: 3, enqueued: 1 });
  const logPath = path.join(home, '.claude', 'reply-learning', 'nightly.log');
  assert.ok(fs.existsSync(logPath));
  const logLines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
  assert.strictEqual(logLines.length, 1);
});
