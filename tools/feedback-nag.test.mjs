import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { formatNag, pendingItems, runNag } from './feedback-nag.mjs';

const HOME = path.join(path.sep, 'home', 'test');
const baseItem = { key: 'x', ts: '2026-09-01 09:00', kind: '要望', title: 'タイトル', status: 'new', note: '', source: 'パネル' };
const response = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
function harness(items) {
  const stdout = [], stderr = [], sends = [], fetches = [];
  const io = { read(file) { if (file.endsWith('booth-feedback.env')) return 'BOOTH_FEEDBACK_URL=https://example.test/exec\nBOOTH_FEEDBACK_TOKEN=secret\n'; throw new Error('ENOENT'); }, stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text), now: () => new Date(2026, 8, 6, 9, 0) };
  const fetchImpl = async (...args) => { fetches.push(args); return response({ ok: true, sheetUrl: 'https://sheet.test/edit', items }); };
  const sendDm = async (args) => sends.push(args);
  return { io, stdout, stderr, sends, fetches, fetchImpl, sendDm };
}

test('done 系4状態だけを除外する', () => {
  const statuses = ['done', '完了', '対応済', '却下', 'new'];
  assert.deepEqual(pendingItems(statuses.map((status) => ({ status }))).map((item) => item.status), ['new']);
});
test('メモありも返答済・未完了として残る', () => {
  const item = { ...baseItem, note: '一部実装済み' };
  assert.equal(pendingItems([item]).length, 1);
  assert.match(formatNag([item], ''), /返答済・未完了/);
});
test('0 件では DM を送らない', async () => {
  const h = harness([{ ...baseItem, status: 'done' }]);
  assert.equal(await runNag({ args: ['--json'], home: HOME, ...h }), 0);
  assert.equal(h.sends.length, 0);
  assert.deepEqual(JSON.parse(h.stdout[0]), { ok: true, count: 0, sent: false, items: [] });
});
test('15 件超で残件数を表示する', () => {
  const items = Array.from({ length: 17 }, (_, index) => ({ ...baseItem, key: String(index) }));
  const content = formatNag(items, 'https://sheet.test/edit', new Date(2026, 8, 6, 9, 0));
  assert.match(content, /ほか 2 件/);
  assert.equal((content.match(/^・/gm) || []).length, 15);
});
test('壊れた ts は経過不明として落とさない', () => {
  assert.match(formatNag([{ ...baseItem, ts: 'broken' }], ''), /経過不明/);
});
test('--dry-run は API 以外のネットワークを使わず本文を出す', async () => {
  const h = harness([baseItem]);
  assert.equal(await runNag({ args: ['--dry-run'], home: HOME, ...h }), 0);
  assert.equal(h.fetches.length, 1);
  assert.equal(h.sends.length, 0);
  assert.match(h.stdout[0], /未返答/);
});
