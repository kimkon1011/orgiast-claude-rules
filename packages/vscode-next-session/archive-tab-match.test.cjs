const test = require('node:test');
const assert = require('node:assert/strict');
const { matchArchive, titleMatches, WINDOW_MS } = require('./archive-tab-match');
const now = Date.now();
const row = { sessionId: 'a', title: '長い会話のタイトル', archivedAt: new Date(now).toISOString() };
const match = options => matchArchive({ previousLabel: row.title, changedAt: now, currentLabel: 'Claude Code', now, rows: [row], ...options });
test('exact titles ignore surrounding whitespace; truncation permits only a nonempty prefix', () => {
  assert.equal(titleMatches(' 長い会話… ', ` ${row.title} `), true);
  assert.equal(match({ previousLabel: '長い会話…' }).reason, 'matched');
  assert.equal(titleMatches(' 長い会話のタイトル ', row.title), true);
  assert.equal(titleMatches('長い会話', row.title), false);
  assert.equal(titleMatches('…', row.title), false);
});
test('archive time and retry deadline must both be within ten minutes', () => {
  assert.equal(match({ changedAt: now - WINDOW_MS }).reason, 'matched');
  assert.equal(match({ changedAt: now - WINDOW_MS - 1 }).reason, 'expired');
  for (const offset of [-1, 1]) assert.equal(match({ rows: [{ ...row, archivedAt: new Date(now + offset * (WINDOW_MS + 1)).toISOString() }] }).reason, 'no-match');
  assert.equal(match({ rows: [{ ...row, archivedAt: 'bad' }] }).reason, 'no-match');
});
test('multiple archive candidates fail closed, duplicate ledger/audit evidence is one candidate', () => {
  assert.equal(match({ rows: [row, { ...row, sessionId: 'b' }] }).reason, 'ambiguous');
  assert.equal(match({ rows: [row, { ...row }] }).reason, 'matched');
});
test('renamed/reused tabs and manual new conversations without archive evidence stay open', () => {
  assert.equal(match({ currentLabel: '再開した作業' }).reason, 'label-changed');
  assert.equal(match({ rows: [] }).reason, 'no-match');
  assert.equal(match({ previousLabel: 'Claude Code' }).reason, 'no-match');
});
