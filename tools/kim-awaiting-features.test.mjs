import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NOW = Date.parse('2026-11-20T12:00:00Z');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kaw-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function writeExternal(home, items, extra = {}) {
  const dir = path.join(home, '.claude', 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'external-waiting.json'), JSON.stringify({
    generatedAt: new Date(NOW - 3600000).toISOString(),
    sources: {}, items, ...extra
  }));
}

test('external 回答済み項目は answered フラグと ✅ 表記になる', async t => {
  const { collectAwaiting } = await import('./kim-awaiting.mjs');
  const home = fixture(t);

  const items = [
    { id: 'ex:aaaaaaaaaaaa', kind: 'reply', mailbox: 'a@b.com', who: '佐藤様', subject: '確認', since: new Date(NOW - 7200000).toISOString(), threadId: 't1', lastMessageId: 'm1', ask: '承諾しますか？' },
    { id: 'ex:bbbbbbbbbbbb', kind: 'reply', mailbox: 'b@b.com', who: '鈴木様', subject: '依頼', since: new Date(NOW - 3600000).toISOString(), threadId: 't2', lastMessageId: 'm2', ask: '日程を返事する' },
  ];
  writeExternal(home, items);
  // Create answer file for ex:aaaaaaaaaaaa
  const ansDir = path.join(home, '.claude', 'state', 'external-waiting-answers');
  fs.mkdirSync(ansDir, { recursive: true });
  fs.writeFileSync(path.join(ansDir, 'aaaaaaaaaaaa.json'), JSON.stringify({
    id: 'ex:aaaaaaaaaaaa', answer: '承諾します', at: new Date(NOW).toISOString(),
    mailbox: 'a@b.com', threadId: 't1', subject: '確認', who: '佐藤様'
  }));

  const collected = collectAwaiting({ home, now: NOW });
  const answered = collected.find(i => i.id === 'ex:aaaaaaaaaaaa');
  const unanswered = collected.find(i => i.id === 'ex:bbbbbbbbbbbb');

  assert.ok(answered);
  assert.equal(answered.answered, true);
  assert.match(answered.title, /✅.*回答済み/);
  assert.match(answered.ask, /回答済み/);

  assert.ok(unanswered);
  assert.equal(unanswered.answered, undefined);
  assert.doesNotMatch(unanswered.title, /✅/);
});

test('collectExternal は同じ who の下書きを1件にまとめる', async t => {
  const { collectAwaiting } = await import('./kim-awaiting.mjs');
  const home = fixture(t);

  writeExternal(home, [
    { id: 'ex:aaaaaaaaaaaa', kind: 'draft', who: '佐藤様', subject: '見積v1', since: new Date(NOW - 7200000).toISOString(), mailbox: 'a@b.com', threadId: 't1', lastMessageId: 'm1' },
    { id: 'ex:bbbbbbbbbbbb', kind: 'draft', who: '佐藤様', subject: '見積v2（最新）', since: new Date(NOW - 1800000).toISOString(), mailbox: 'a@b.com', threadId: 't1', lastMessageId: 'm2' },
    { id: 'ex:cccccccccccc', kind: 'reply', who: '鈴木様', subject: '確認', since: new Date(NOW - 3600000).toISOString(), mailbox: 'b@b.com', threadId: 't2', lastMessageId: 'm3' },
  ]);

  const items = collectAwaiting({ home, now: NOW });
  const satoItems = items.filter(i => i.title.includes('佐藤様'));
  assert.equal(satoItems.length, 1, '佐藤様の下書きは1件だけ');
  assert.ok(satoItems[0].title.includes('見積v2'));
});

test('respondAll で複数の ex: をまとめて回答できる', async t => {
  const { respondAll } = await import('./kim-awaiting.mjs');
  const home = fixture(t);

  const items = [
    { id: 'ex:aaaaaaaaaaaa', kind: 'reply', mailbox: 'a@b.com', who: '佐藤様', subject: '確認', since: new Date(NOW - 7200000).toISOString(), threadId: 't1', lastMessageId: 'm1' },
    { id: 'ex:bbbbbbbbbbbb', kind: 'reply', mailbox: 'b@b.com', who: '鈴木様', subject: '依頼', since: new Date(NOW - 3600000).toISOString(), threadId: 't2', lastMessageId: 'm2' },
  ];
  writeExternal(home, items);

  const bodyFile = path.join(home, 'answer.txt');
  fs.writeFileSync(bodyFile, '承諾しました。進めてください。');

  const result = respondAll({ home, bodyFile, ids: ['ex:aaaaaaaaaaaa', 'ex:bbbbbbbbbbbb'], now: NOW });
  assert.equal(result, 0);

  const { readAnswers } = await import('./lib/external-waiting-state.mjs');
  const answers = readAnswers(home);
  assert.equal(answers.length, 2);
  assert.equal(answers[0].answer, '承諾しました。進めてください。');
});

test('respondAll は存在しない ID を含むと全体失敗', async t => {
  const { respondAll } = await import('./kim-awaiting.mjs');
  const home = fixture(t);

  writeExternal(home, [
    { id: 'ex:aaaaaaaaaaaa', kind: 'reply', mailbox: 'a@b.com', who: '佐藤様', subject: '確認', since: new Date(NOW - 7200000).toISOString(), threadId: 't1', lastMessageId: 'm1' },
  ]);

  const bodyFile = path.join(home, 'answer.txt');
  fs.writeFileSync(bodyFile, '承諾しました。');

  const result = respondAll({ home, bodyFile, ids: ['ex:aaaaaaaaaaaa', 'ex:doesnotexist'], now: NOW });
  assert.equal(result, 1, '存在しないIDで失敗する');
});

test('回答ゲートは返答パターンに反応する', async t => {
  const { evaluateAnswerRecording } = await import('./kim-answer-recording-gate.mjs');
  const home = fixture(t);

  // No pending items → pass
  assert.equal(evaluateAnswerRecording('', { home }).decision, 'pass');
  assert.equal(evaluateAnswerRecording('普通の会話です', { home }).decision, 'pass');

  // Has answer-like text but no pending items → still pass (no items to match)
  assert.equal(evaluateAnswerRecording('1. 可\n2. OK', { home }).decision, 'pass');
});

test('ゲートは通常の会話には反応しない', async t => {
  const { evaluateAnswerRecording } = await import('./kim-answer-recording-gate.mjs');
  const home = fixture(t);
  assert.equal(evaluateAnswerRecording('今日の天気は？', { home }).decision, 'pass');
  assert.equal(evaluateAnswerRecording('この資料を確認してください', { home }).decision, 'pass');
});