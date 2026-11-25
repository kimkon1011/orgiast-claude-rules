import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatNotice, runPendingNotice } from './gtasks-pending-notice.mjs';

const NOW = new Date('2026-09-06T12:34:00.000Z');
const task = (id, title, notes, status = 'needsAction') => ({ id, title, notes, status });
const cache = (tasks, updatedAt = NOW.toISOString()) => ({ updatedAt, lists: [{ id: 'L', title: '仕事', tasks }] });

test('下書き・操作待ち・情報待ちへ分類し完了済みを除く', () => {
  const output = formatNotice(cache([
    task('d1', '送信する', '経過\n■ 下書き作成済み（未送信）: 見積回答 / 下書き: ~/.claude/gtasks-drafts/d1.md'),
    task('a1', '購入する', '■ kimの残り1操作: 決済する'),
    task('q1', '調査する', '■ 要確認: 対象年度を教えて'),
    task('x1', '完了', '■ 要確認: 出してはいけない', 'completed'),
  ]), { now: NOW });
  assert.match(output, /### 送信待ちの下書き（1件）[\s\S]*送信する.*見積回答/);
  assert.match(output, /### kim の操作が要る（1件）[\s\S]*購入する.*決済する/);
  assert.match(output, /### 情報待ち（1件）[\s\S]*調査する.*対象年度を教えて/);
  assert.doesNotMatch(output, /出してはいけない/);
});

test('該当0件なら空文字を返す', () => {
  assert.equal(formatNotice(cache([task('x', '通常', '通常メモ')])), '');
});

test('取得失敗時はローカルキャッシュへフォールバックし経過時間を表示する', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtasks-pending-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, 'cache.json');
  fs.writeFileSync(cacheFile, JSON.stringify({ savedAt: '2026-09-06T07:00:00.000Z', cache: cache([task('q', '確認', '■ 要確認: 色')]) }));
  const output = await runPendingNotice({ fetchCache: async () => { throw new Error('offline'); }, cacheFile, now: () => NOW, stdout: () => {} });
  assert.match(output, /\(5時間前の情報\)/);
  assert.match(output, /確認/);
});

test('取得失敗かつキャッシュ無しなら空出力で正常終了する', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtasks-pending-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lines = [];
  const output = await runPendingNotice({ fetchCache: async () => { throw new Error('offline'); }, cacheFile: path.join(dir, 'missing.json'), stdout: (line) => lines.push(line) });
  assert.equal(output, '');
  assert.deepEqual(lines, []);
});

test('12件を超えると残数を他N件にまとめる', () => {
  const tasks = Array.from({ length: 15 }, (_, index) => task(`q${index}`, `確認${index}`, `■ 要確認: 質問${index}`));
  const output = formatNotice(cache(tasks));
  assert.equal((output.match(/^- \*\*/gm) ?? []).length, 12);
  assert.match(output, /- 他3件$/);
});

test('12件を使い切った後の空カテゴリ見出しは出さない', () => {
  const drafts = Array.from({ length: 12 }, (_, index) => task(`d${index}`, `下書き${index}`, '■ 下書き作成済み: 要約'));
  const output = formatNotice(cache([...drafts, task('q', '確認', '■ 要確認: 質問')]));
  assert.doesNotMatch(output, /### 情報待ち/);
  assert.match(output, /- 他1件$/);
});

test('タイムアウト時は取得をabortしてキャッシュ無しなら無音になる', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtasks-pending-timeout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let aborted = false;
  const output = await runPendingNotice({
    fetchCache: (signal) => new Promise((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve(cache([])); })),
    cacheFile: path.join(dir, 'missing.json'), timeoutMs: 5, stdout: () => {},
  });
  assert.equal(aborted, true);
  assert.equal(output, '');
});

test('Drive取得成功時はローカルコピーを保存する', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtasks-pending-save-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, 'cache.json');
  const value = cache([task('a', '操作', '■ kimの残り1操作: 押す')]);
  await runPendingNotice({ fetchCache: async () => value, cacheFile, now: () => NOW, stdout: () => {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).cache, value);
});
