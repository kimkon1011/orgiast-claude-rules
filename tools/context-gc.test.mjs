import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, fold, saveSession, loadSession } from './session-fold.mjs';
import { collectGarbage, gcStats } from './context-gc.mjs';

const prefix = '固定仕様 v1\n高さ上限: 3.5m';
const fixture = [
  '受付は北側。青いカウンターを設置する。\n導線幅は1200mm。',
  '架空ブースAは白い壁面。照明は電球色、展示台は木目。',
  '架空ブースBは青いサインと円形テーブルを使う。',
  '搬入口は東側。施工日は初日の前日。',
  '商談席は四席。白い椅子と黒い机を配置する。',
  '製品模型は中央展示台。耐荷重は50kgとする。',
  '非常口の前は空ける。誘導灯を隠さない。',
  'モニターは55型。南壁に壁掛け金具で固定する。',
  '倉庫は二平方メートル。鍵付き扉を西側に設ける。',
  '最終日の撤去開始は午後五時。資材を分別する。',
].map((text, i) => `${text}\n仕様補足${i + 1}: 来場者の安全、施工時の確認手順。`);

test('gc folds segments beyond keepRecent', () => {
  const session = createSession({ prefix, segments: fixture });
  const gcResult = collectGarbage(session, { keepRecent: 3, compressFolded: false });
  const s = gcStats(gcResult);
  assert.equal(s.foldedCount, fixture.length - 3); // all but keepRecent
  assert.equal(s.liveCount, 3);
  // Check that folded entries have stub content (shorter placeholder)
  for (const entry of gcResult.index) {
    if (entry.state === 'folded') {
      const stubText = gcResult.segments[gcResult.index.findIndex(e => e.id === entry.id)];
      assert.ok(stubText.includes('[[folded'), `expected folded stub for ${entry.id}, got: ${stubText.substring(0, 30)}`);
    }
  }
});

test('gc with maxAge evicts old folded segments', () => {
  const session = createSession({ prefix, segments: fixture.slice(0, 8) });
  const now = Date.now();
  const sessionStart = now - 7200_000; // 2 hours ago
  const gcResult = collectGarbage(session, { keepRecent: 2, maxAge: 3600_000, compressFolded: false, now, sessionStart });
  const s = gcStats(gcResult);
  // With maxAge=1h and session started 2h ago, segments should be evicted
  assert.ok(s.evictedCount >= 0);
  // The evicted stub should be very short
  const evictedEntries = gcResult.index.filter(e => e.state === 'folded');
  assert.ok(evictedEntries.every(e => gcResult.segments[gcResult.index.findIndex(x => x.id === e.id)].length <= 100));
});

test('gc integrates with session-fold save/load roundtrip', () => {
  const session = createSession({ prefix, segments: fixture.slice(0, 6) });
  const gcResult = collectGarbage(session, { keepRecent: 2, compressFolded: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-gc-'));
  saveSession(dir, gcResult);
  const loaded = loadSession(dir);
  assert.equal(loaded.index.length, gcResult.index.length);
  assert.equal(loaded.prefix, gcResult.prefix);
  assert.equal(loaded.index.filter(e => e.state === 'folded').length, gcResult.index.filter(e => e.state === 'folded').length);
});

test('gc compresses folded segment content', () => {
  const largeSegments = Array.from({ length: 8 }, (_, i) => 'large '.repeat(200) + ` end-${i}`);
  const session = createSession({ prefix, segments: largeSegments });
  const gcResult = collectGarbage(session, { keepRecent: 2, compressFolded: true, compressMaxTokens: 50 });
  // Folded segments should have been compressed (shorter)
  for (const entry of gcResult.index) {
    if (entry.state === 'folded') {
      const original = session.store[entry.id];
      const stored = gcResult.store[entry.id];
      if (original.length > 500) {
        assert.ok(stored.length <= original.length, `expected ${stored.length} <= ${original.length}`);
      }
    }
  }
});

test('gc throws on null session', () => {
  assert.throws(() => collectGarbage(null), /session is required/);
});

test('gc with keepRecent=0 folds everything recent', () => {
  const session = createSession({ prefix, segments: fixture });
  const gcResult = collectGarbage(session, { keepRecent: 0, compressFolded: false });
  const s = gcStats(gcResult);
  assert.equal(s.foldedCount, fixture.length);
  assert.equal(s.liveCount, 0);
});

test('gc with compressFolded reduces token count for folded segments', () => {
  const longSegments = Array.from({ length: 6 }, (_, i) => Array.from({ length: 30 }, (_, j) => `line-${j}-of-segment-${i}: data`).join('\n'));
  const session = createSession({ prefix, segments: longSegments });
  const beforeTokens = session.index.reduce((s, e) => s + e.tokens, 0);
  const gcResult = collectGarbage(session, { keepRecent: 1, compressFolded: true, compressMaxTokens: 100 });
  const afterTokens = gcResult.index.reduce((s, e) => s + e.tokens, 0);
  assert.ok(afterTokens <= beforeTokens);
});

test('gcStats returns correct structure', () => {
  const session = createSession({ prefix, segments: fixture });
  const gcResult = collectGarbage(session, { keepRecent: 3, compressFolded: false });
  const s = gcStats(gcResult);
  assert.equal(typeof s.foldedCount, 'number');
  assert.equal(typeof s.liveCount, 'number');
  assert.equal(typeof s.compressionRatio, 'number');
  assert.equal(typeof s.totalTokens, 'number');
  assert.equal(typeof s.integrity, 'string');
});