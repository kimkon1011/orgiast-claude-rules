import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSession, fold, unfold, search, stats, saveSession, loadSession, terms } from './session-fold.mjs';

const prefix = '固定仕様 v1\n高さ上限: 3.5m\n🚧 安全第一';
const prefixHash = crypto.createHash('sha256').update(Buffer.from(prefix)).digest('hex');
const fixture = [
  '受付は北側。青いカウンターを設置する。\n導線幅は1200mm。🙂',
  '架空ブースAは白い壁面。照明は電球色、展示台は木目。',
  '架空ブースBは青いサインと円形テーブルを使う。',
  '搬入口は東側。施工日は初日の前日、工具箱を用意。',
  '商談席は四席。白い椅子と黒い机を配置する。',
  '製品模型は中央展示台。耐荷重は50kgとする。',
  '非常口の前は空ける。誘導灯を隠さない。',
  'モニターは55型。南壁に壁掛け金具で固定する。',
  '倉庫は二平方メートル。鍵付き扉を西側に設ける。',
  '最終日の撤去開始は午後五時。資材を分別する。',
].map((text, i) => `${text}\n仕様補足${i + 1}: 来場者の安全、施工時の確認手順、設営後の清掃、担当者間の引継ぎ事項を記録する。寸法と配置は図面との整合を二名で確認し、変更点は匿名の管理票へ残す。`);

function assertPrefixStable(before, after) {
  assert.equal(Buffer.compare(Buffer.from(after.prefix), Buffer.from(before.prefix)), 0);
  assert.equal(after.prefixSha256, before.prefixSha256);
  assert.equal(after.prefixSha256, prefixHash);
}
function assertIndexHashes(session) {
  for (const entry of session.index) {
    const actual = crypto.createHash('sha256').update(Buffer.from(session.store[entry.id])).digest('hex');
    assert.equal(entry.sha256, actual, entry.id);
  }
}
function assertReduced(before, after) { assert.ok(stats(after).totalTokens < stats(before).totalTokens); }

test('(a) fold then unfold restores Japanese, newlines, and emoji byte-for-byte', () => {
  const original = createSession({ prefix, segments: fixture });
  const restored = unfold(fold(original, { keepRecent: 2 }), original.index.slice(0, -2).map(x => x.id));
  fixture.forEach((text, i) => assert.deepEqual(Buffer.from(restored.segments[i]), Buffer.from(text)));
});

test('(b) repeated fold/unfold keeps prefix bytes and fixed sha256', () => {
  let session = createSession({ prefix, segments: fixture });
  const original = session;
  for (let i = 0; i < 3; i++) {
    session = fold(session, { keepRecent: 2 });
    session = unfold(session, ['seg-0001', 'seg-0002']);
    assertPrefixStable(original, session);
  }
  assert.equal(prefixHash, '5021d4d34af789f0d7baf53c88fc7a6e22133b2cc894c62f9654b1db20a390f6');
});

test('(c) identical input produces identical index and stubs', () => {
  const one = fold(createSession({ prefix, segments: fixture }), { keepRecent: 2 });
  const two = fold(createSession({ prefix, segments: fixture }), { keepRecent: 2 });
  assert.equal(JSON.stringify({ index: one.index, segments: one.segments }), JSON.stringify({ index: two.index, segments: two.segments }));
});

test('(d) invalid ID, tampered store, and corrupt index throw explicit Errors', () => {
  const session = fold(createSession({ prefix, segments: fixture }), { keepRecent: 2 });
  assert.throws(() => unfold(session, ['seg-9999']), /seg-9999/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-fold-'));
  saveSession(dir, session);
  fs.writeFileSync(path.join(dir, 'store', 'seg-0001.txt'), 'tampered');
  assert.throws(() => loadSession(dir), /sha256 mismatch.*seg-0001/);
  fs.writeFileSync(path.join(dir, 'index.json'), '{broken');
  assert.throws(() => loadSession(dir), /invalid index\.json/);
});

test('(e) fold reduces live input tokens', () => {
  const before = createSession({ prefix, segments: fixture });
  assertReduced(before, fold(before, { keepRecent: 2 }));
});

test('(f) calibrated checks accept real fold and reject three bad implementations', () => {
  const before = createSession({ prefix, segments: fixture });
  const real = fold(before, { keepRecent: 2 });
  assert.doesNotThrow(() => { assertPrefixStable(before, real); assertIndexHashes(real); assertReduced(before, real); });
  const changesPrefix = structuredClone(real); changesPrefix.prefix += '!'; changesPrefix.prefixSha256 = crypto.createHash('sha256').update(changesPrefix.prefix).digest('hex');
  const breaksHash = structuredClone(real); breaksHash.index[0].sha256 = '0'.repeat(64);
  const doesNothing = structuredClone(before);
  assert.throws(() => assertPrefixStable(before, changesPrefix));
  assert.throws(() => assertIndexHashes(breaksHash));
  assert.throws(() => assertReduced(before, doesNothing));
});

test('(g) search finds folded synthetic segments and breaks ties by ID', () => {
  const session = fold(createSession({ prefix, segments: fixture }), { keepRecent: 0 });
  const commonWeight = Math.log(1 + 10 / (1 + 2));
  const rareWeight = Math.log(1 + 10 / (1 + 1));
  assert.deepEqual(search(session, '青い カウンター', { k: 1 }), [{ id: 'seg-0001', score: 2 * commonWeight + 3 * rareWeight }]);
  assert.deepEqual(search(session, '白い', { k: 2 }), [{ id: 'seg-0002', score: commonWeight }, { id: 'seg-0005', score: commonWeight }]);
});

test('search uses CJK bi-grams for unspaced Japanese queries', () => {
  const session = fold(createSession({ prefix, segments: fixture }), { keepRecent: 0 });
  const hits = search(session, '南壁に設置する大型画面', { k: 3 });
  assert.ok(hits.some(hit => hit.id === 'seg-0008'), hits);
});

test('terms keeps lowercase ASCII runs separate from CJK bi-grams', () => {
  assert.deepEqual(terms('Reブース'), ['re', 'ブー', 'ース']);
  assert.deepEqual(terms('AEOとGEO'), ['aeo', 'geo']);
});

test('search ranks one rare term above multiple ubiquitous terms with IDF', () => {
  const segments = [
    'common1 common2',
    'rare',
    ...Array.from({ length: 8 }, (_, i) => `common1 common2 filler${i}`),
  ];
  const session = fold(createSession({ prefix, segments }), { keepRecent: 0 });
  const hits = search(session, 'common1 common2 rare', { k: 2 });
  assert.equal(hits[0].id, 'seg-0002');
  assert.ok(hits[0].score > hits[1].score);

  const simpleScores = session.index.map(entry => ({
    id: entry.id,
    score: ['common1', 'common2', 'rare'].filter(term => session.store[entry.id].includes(term)).length,
  })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  assert.equal(simpleScores[0].id, 'seg-0001');
  assert.equal(simpleScores[0].score, 2);
  assert.equal(simpleScores.find(hit => hit.id === 'seg-0002').score, 1);
});

test('search finds ASCII terms in mixed-script queries', () => {
  const session = fold(createSession({ prefix, segments: ['通常ブースの説明', 'Reブースの設計'] }), { keepRecent: 0 });
  const hits = search(session, 'Reブース', { k: 2 });
  assert.equal(hits[0].id, 'seg-0002');
  assert.ok(hits.some(hit => hit.id === 'seg-0002'));
});

test('save/load preserves fixed index key order and complete session', () => {
  const session = fold(createSession({ prefix, segments: fixture }), { keepRecent: 3 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-fold-save-'));
  saveSession(dir, session);
  const raw = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
  assert.ok(raw.indexOf('"version"') < raw.indexOf('"prefix"'));
  assert.ok(raw.indexOf('"prefix"') < raw.indexOf('"prefixSha256"'));
  assert.ok(raw.indexOf('"prefixSha256"') < raw.indexOf('"index"'));
  assert.deepEqual(loadSession(dir), session);
});
