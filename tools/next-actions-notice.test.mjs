import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runNextActionsNotice } from './next-actions-notice.mjs';

const NOW = new Date('2026-09-05T12:00:00.000Z');

function fixture(stamp, body = '') {
  return `前置き\n<!-- NEXT-ACTIONS:BEGIN -->\n## 明日の推奨アクション（${stamp}）\n\n${body}\n<!-- NEXT-ACTIONS:END -->\n後置き\n`;
}

function threeActions() {
  return [
    '1. 一件目 [PR#1]',
    '   - why: 表示してはいけない理由',
    '   - first_step: 最初の操作1',
    '2. 二件目 [TODO]',
    '   - why: 二つ目の理由',
    '   - first_step: 最初の操作2',
    '3. 三件目 [夜間ログ]',
    '   - why: 三つ目の理由',
    '   - first_step: 最初の操作3'
  ].join('\n');
}

function setup(content) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'next-actions-notice-'));
  if (content !== undefined) {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'next-actions.md'), content, 'utf8');
  }
  const stdout = [], stderr = [];
  const options = { home, now: NOW, log: (line) => stdout.push(String(line)), error: (line) => stderr.push(String(line)) };
  return { home, stdout, stderr, options };
}

test('ファイルが無ければ無音で終了する', () => {
  const ctx = setup();
  assert.doesNotThrow(() => runNextActionsNotice(ctx.options));
  assert.deepEqual(ctx.stdout, []);
  assert.deepEqual(ctx.stderr, []);
});

test('マーカーが無ければ無音になる', () => {
  const ctx = setup('# unrelated');
  runNextActionsNotice(ctx.options);
  assert.deepEqual(ctx.stdout, []);
  assert.deepEqual(ctx.stderr, []);
});

test('29時間前なら出力され、31時間前なら無音になる', () => {
  const fresh = setup(fixture('2026/9/4 16:00:00', threeActions()));
  const stale = setup(fixture('2026/9/4 04:00:00', threeActions()));
  assert.equal(runNextActionsNotice(fresh.options).fresh, true);
  assert.equal(fresh.stdout.length, 1);
  assert.equal(runNextActionsNotice(stale.options).fresh, false);
  assert.deepEqual(stale.stdout, []);
});

test('解釈できない生成日時は無音でstderrに1行出す', () => {
  const ctx = setup(fixture('昨日の夜', threeActions()));
  const result = runNextActionsNotice(ctx.options);
  assert.equal(result.fresh, false);
  assert.deepEqual(ctx.stdout, []);
  assert.equal(ctx.stderr.length, 1);
});

test('出力は8行以内でwhyを含まず、3件を各1行に畳む', () => {
  const ctx = setup(fixture('2026/9/5 16:50:48', threeActions()));
  runNextActionsNotice(ctx.options);
  const lines = ctx.stdout[0].split('\n');
  assert.ok(lines.length <= 8);
  assert.equal(lines.filter((line) => /^\d+\. /.test(line)).length, 3);
  assert.ok(lines.every((line) => !line.includes('why')));
  assert.match(lines[1], /^1\. 一件目 \[PR#1\] — 最初の操作1$/);
  assert.equal(lines.at(-1), '詳細: ~/.claude/next-actions.md');
});

test('壊れた本文でも例外を投げず終了する', () => {
  const ctx = setup(fixture('2026/9/5 16:50:48', '1. [壊れた本文]\n   - first_step:\n\ud800'));
  assert.doesNotThrow(() => runNextActionsNotice(ctx.options));
});

test('--jsonはfreshとactionsを返す', () => {
  const ctx = setup(fixture('2026/9/5 16:50:48', threeActions()));
  runNextActionsNotice({ ...ctx.options, args: ['--json'] });
  const value = JSON.parse(ctx.stdout[0]);
  assert.equal(value.fresh, true);
  assert.equal(value.generatedAt, '2026/9/5 16:50:48');
  assert.equal(value.actions.length, 3);
  assert.deepEqual(value.actions[0], { title: '一件目', source: 'PR#1', first_step: '最初の操作1' });
});

test('新しいopen-work.mdがあれば在庫1行を足し9行以内にする', () => {
  const ctx = setup(fixture('2026/9/5 16:50:48', threeActions()));
  const file = path.join(ctx.home, '.claude', 'open-work.md');
  fs.writeFileSync(file, 'ok:PR2 ブランチ4 タスク9(P1 3) TODO1 夜間異常0\n');
  fs.utimesSync(file, NOW, NOW);
  runNextActionsNotice(ctx.options);
  const lines = ctx.stdout[0].split('\n');
  assert.ok(lines.length <= 9);
  assert.equal(lines.filter((line) => line.startsWith('未処理の在庫:')).length, 1);
  assert.equal(lines.at(-1), '未処理の在庫: PR2件 / 取り残しブランチ4件 / P1タスク3件 → ~/.claude/open-work.md');
});

test('open-work.mdが古い・無い・サマリ不正なら在庫行を足さない', () => {
  const absent = setup(fixture('2026/9/5 16:50:48', threeActions()));
  runNextActionsNotice(absent.options);
  assert.doesNotMatch(absent.stdout[0], /未処理の在庫:/);

  for (const [name, content, ageHours] of [['stale', 'ok:PR1 ブランチ1 タスク1(P1 1) TODO1 夜間異常1', 31], ['broken', 'サマリなし', 0]]) {
    const ctx = setup(fixture('2026/9/5 16:50:48', threeActions()));
    const file = path.join(ctx.home, '.claude', 'open-work.md');
    fs.writeFileSync(file, content);
    const time = new Date(NOW.getTime() - ageHours * 60 * 60 * 1000);
    fs.utimesSync(file, time, time);
    runNextActionsNotice(ctx.options);
    assert.doesNotMatch(ctx.stdout[0], /未処理の在庫:/, name);
  }
});
