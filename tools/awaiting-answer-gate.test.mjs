import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { judge, detectAnswerPattern } from './awaiting-answer-gate.mjs';

function home(t) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'awaiting-answer-'));
  fs.mkdirSync(path.join(h, '.claude'));
  t.after(() => fs.rmSync(h, { force: true, recursive: true }));
  return h;
}

test('detectAnswerPattern は番号付き回答を検出する', () => {
  assert.equal(detectAnswerPattern('1 可'), true);
  assert.equal(detectAnswerPattern('2. 不要'), true);
  assert.equal(detectAnswerPattern('3) OK'), true);
  assert.equal(detectAnswerPattern('1．良い'), true);
  assert.equal(detectAnswerPattern('1. 進めて'), true);
});

test('detectAnswerPattern は単独の判断語を検出する', () => {
  assert.equal(detectAnswerPattern('送って'), true);
  assert.equal(detectAnswerPattern('不要'), true);
  assert.equal(detectAnswerPattern('保留'), true);
  assert.equal(detectAnswerPattern('完了'), true);
  assert.equal(detectAnswerPattern('OK'), true);
  assert.equal(detectAnswerPattern('可'), true);
  assert.equal(detectAnswerPattern('不可'), true);
  assert.equal(detectAnswerPattern('承認'), true);
  assert.equal(detectAnswerPattern('否認'), true);
  assert.equal(detectAnswerPattern('進めて'), true);
  assert.equal(detectAnswerPattern('良いですよ'), true);
  assert.equal(detectAnswerPattern('大丈夫'), true);
  assert.equal(detectAnswerPattern('全部OK'), true);
});

test('detectAnswerPattern はコードブロック内の語を検出しない', () => {
  assert.equal(detectAnswerPattern('```\n不要\n```'), false);
  assert.equal(detectAnswerPattern('`不要`'), false);
});

test('detectAnswerPattern は引用行内の語を検出しない', () => {
  assert.equal(detectAnswerPattern('> 不要'), false);
});

test('detectAnswerPattern は無関係な文章に反応しない', () => {
  assert.equal(detectAnswerPattern('今日はいい天気ですね'), false);
  assert.equal(detectAnswerPattern('この件について調査しました'), false);
  assert.equal(detectAnswerPattern('確認しました'), false);
});

test('judge は回答パターンが無ければ pass', () => {
  const h = home(test);
  assert.deepEqual(judge('今日はいい天気ですね', { home: h }), { decision: 'pass' });
});

test('judge は空文字で pass', () => {
  const h = home(test);
  assert.deepEqual(judge('', { home: h }), { decision: 'pass' });
  assert.deepEqual(judge('   ', { home: h }), { decision: 'pass' });
});

test('judge は回答パターンがあっても未回答項目が無ければ pass', () => {
  const h = home(test);
  assert.deepEqual(judge('1 可', { home: h }), { decision: 'pass' });
});

test('judge は回答パターンと未回答項目があれば block', () => {
  const h = home(test);
  // kim-inbox に未回答項目を作る
  const inboxDir = path.join(h, '.claude', 'kim-inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  const id = 'ki-20261023120000-aaaa';
  fs.writeFileSync(path.join(inboxDir, `${id}.json`), JSON.stringify({
    id, kind: 'ask', status: 'open', text: '確認してください', createdAt: new Date().toISOString(),
    shownSessions: [], shownCount: 0,
  }));
  const result = judge('1 可', { home: h });
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'AWAITING-ANSWER-UNRECORDED');
  assert.match(result.reason, /kim-inbox/);
});