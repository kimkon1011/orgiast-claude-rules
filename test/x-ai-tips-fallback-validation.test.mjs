import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, selectProposals } from '../tools/x-ai-tips-collect.mjs';

const now = new Date('2026-11-25T12:00:00Z');
const config = {
  minLikes: 5,
  maxOutputTokens: 1000,
  estimatedRates: { inputPerMillion: 0, outputPerMillion: 0, post: 0, profile: 0 },
};

const topic = {
  query: 'AI tips',
  purpose: 'cost',
};

const emptyState = {};
const emptyRecords = [];

function makeItem(overrides = {}) {
  return {
    url: 'https://x.com/author/status/123456789',
    author: '@testauthor',
    title: 'テスト提案',
    summary: 'これはテスト用の提案です',
    steps: '具体的な手順1、手順2',
    purpose: 'cost',
    category: 'tool',
    postedAt: '2026-11-24T12:00:00Z',
    likes: 10,
    ...overrides,
  };
}

// ===== buildRequest tests =====

test('buildRequest: 本経路のプロンプトに likes 確認不能の除外条件が含まれる', () => {
  const req = buildRequest(topic, now, config, false);
  const content = req.input[0].content;
  assert.ok(content.includes('確認不能の投稿は除外'), '本経路でも確認不能の除外は維持');
  assert.ok(content.includes('5 未満'), '本経路のしきい値条件は維持');
});

test('buildRequest: 迂回経路のプロンプトに likes 省略許可が含まれる', () => {
  const req = buildRequest(topic, now, config, true);
  const content = req.input[0].content;
  assert.ok(content.includes('likes を省略してよい'), '迂回経路では省略許可が出ている');
  assert.ok(content.includes('出典 URL（x.com の投稿 URL）は必須'), 'URL必須は維持');
  assert.ok(!content.includes('確認不能の投稿は除外'), '迂回経路には除外条件が無い');
});

// ===== selectProposals: isFallback = true =====

test('selectProposals(isFallback=true): likes/postedAt 欠落の item を通す', () => {
  const items = [makeItem({ postedAt: undefined, likes: undefined })];
  const result = selectProposals(items, emptyRecords, { ...emptyState }, topic, now, config, true);
  assert.equal(result.invalid, 0, '迂回経路では likes/postedAt 欠落を通す');
  assert.equal(result.added.length, 1, '1件追加');
  assert.equal(result.added[0].source, 'x-fallback', 'source は x-fallback');
  assert.equal(result.added[0].likes, null, 'likes 欠落は null で保存');
  assert.equal(result.added[0].postedAt, null, 'postedAt 欠落は null で保存');
});

test('selectProposals(isFallback=true): postedAt のみ欠落の item を通す', () => {
  const items = [makeItem({ postedAt: undefined, likes: 10 })];
  const result = selectProposals(items, emptyRecords, { ...emptyState }, topic, now, config, true);
  assert.equal(result.invalid, 0);
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].source, 'x-fallback');
  assert.equal(result.added[0].likes, 10, 'likes があればその値で保存');
  assert.equal(result.added[0].postedAt, null, 'postedAt のみ欠落');
});

test('selectProposals(isFallback=true): likes のみ欠落の item を通す', () => {
  const items = [makeItem({ likes: undefined })];
  const result = selectProposals(items, emptyRecords, { ...emptyState }, topic, now, config, true);
  assert.equal(result.invalid, 0);
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].source, 'x-fallback');
  assert.equal(result.added[0].likes, null, 'likes のみ欠落');
  assert.ok(result.added[0].postedAt, 'postedAt は維持');
});

test('selectProposals(isFallback=true): URL 欠落は弾く', () => {
  const items = [makeItem({ url: undefined })];
  const result = selectProposals(items, emptyRecords, { ...emptyState }, topic, now, config, true);
  assert.equal(result.added.length, 0);
  assert.equal(result.invalid, 1, 'URL 欠落は迂回経路でも弾く');
});

test('selectProposals(isFallback=true): author 欠落は弾く', () => {
  const items = [makeItem({ author: undefined })];
  const result = selectProposals(items, emptyRecords, { ...emptyState }, topic, now, config, true);
  assert.equal(result.added.length, 0);
  assert.equal(result.invalid, 1, 'author 欠落は迂回経路でも弾く');
});

test('selectProposals(isFallback=true): title 欠落は弾く', () => {
  const items = [makeItem({ title: undefined })];
  const result = selectProposals(items, emptyRecords, { ...emptyState }, topic, now, config, true);
  assert.equal(result.added.length, 0);
  assert.equal(result.invalid, 1, 'title 欠落は迂回経路でも弾く');
});

test('selectProposals(isFallback=true): summary 欠落は弾く', () => {
  const items = [makeItem({ summary: undefined })];
  const result = selectProposals(items, emptyRecords, { ...emptyState }, topic, now, config, true);
  assert.equal(result.added.length, 0);
  assert.equal(result.invalid, 1, 'summary 欠落は迂回経路でも弾く');
});

test('selectProposals(isFallback=true): steps 欠落は弾く', () => {
  const items = [makeItem({ steps: undefined })];
  const result = selectProposals(items, emptyRecords, { ...emptyState }, topic, now, config, true);
  assert.equal(result.added.length, 0);
  assert.equal(result.invalid, 1, 'steps 欠落は迂回経路でも弾く');
});

test('selectProposals(isFallback=true): purpose 不一致は弾く', () => {
  const items = [makeItem({ purpose: 'site' })];
  const result = selectProposals(items, emptyRecords, { ...emptyState }, topic, now, config, true);
  assert.equal(result.added.length, 0);
  assert.equal(result.invalid, 1, 'purpose 不一致は迂回経路でも弾く');
});

test('selectProposals(isFallback=true): source は x-fallback', () => {
  const items = [makeItem({})];
  const result = selectProposals(items, emptyRecords, { ...emptyState }, topic, now, config, true);
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].source, 'x-fallback');
});

// ===== selectProposals: isFallback = false (本経路) =====

test('selectProposals(isFallback=false): likes 欠落は弾く', () => {
  const items = [makeItem({ likes: undefined })];
  const result = selectProposals(items, emptyRecords, { ...emptyState }, topic, now, config, false);
  assert.equal(result.added.length, 0);
  assert.equal(result.invalid, 1, '本経路では likes 欠落を弾く');
});

test('selectProposals(isFallback=false): postedAt 欠落は弾く', () => {
  const items = [makeItem({ postedAt: undefined })];
  const result = selectProposals(items, emptyRecords, { ...emptyState }, topic, now, config, false);
  assert.equal(result.added.length, 0);
  assert.equal(result.invalid, 1, '本経路では postedAt 欠落を弾く');
});

test('selectProposals(isFallback=false): likes が minLikes 未満は弾く', () => {
  const items = [makeItem({ likes: 1 })];
  const result = selectProposals(items, emptyRecords, { ...emptyState }, topic, now, config, false);
  assert.equal(result.added.length, 0);
  assert.equal(result.invalid, 1, '本経路では likes 不足を弾く');
});

test('selectProposals(isFallback=false): postedAt が範囲外は弾く', () => {
  const items = [makeItem({ postedAt: '2026-11-20T12:00:00Z' })]; // 5日前 > 2日
  const result = selectProposals(items, emptyRecords, { ...emptyState }, topic, now, config, false);
  assert.equal(result.added.length, 0);
  assert.equal(result.invalid, 1, '本経路では postedAt 範囲外を弾く');
});

test('selectProposals(isFallback=false): 正常 item は通る', () => {
  const items = [makeItem({})];
  const result = selectProposals(items, emptyRecords, { ...emptyState }, topic, now, config, false);
  assert.equal(result.invalid, 0);
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].source, 'x', '本経路の source は x');
});

test('selectProposals(isFallback=false): 既定値 false と同じ挙動', () => {
  const items = [makeItem({ likes: undefined })];
  const result = selectProposals(items, emptyRecords, { ...emptyState }, topic, now, config);
  assert.equal(result.added.length, 0);
  assert.equal(result.invalid, 1, '引数省略時は本経路と同じく弾く');
});