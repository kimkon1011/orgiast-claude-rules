import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NOW = Date.parse('2026-11-20T12:00:00Z');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ews-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('readAnswers returns empty array when no answers exist', async t => {
  const { readAnswers } = await import('./external-waiting-state.mjs');
  const home = fixture(t);
  assert.deepEqual(readAnswers(home), []);
});

test('readAnswers returns saved answers', async t => {
  const { readAnswers, saveAnswer, externalFile, writeJsonAtomic } = await import('./external-waiting-state.mjs');
  const home = fixture(t);
  fs.mkdirSync(path.join(home, '.claude', 'state'), { recursive: true });
  writeJsonAtomic(externalFile(home), { generatedAt: new Date(NOW).toISOString(), sources: {}, items: [{ id: 'ex:aaaaaaaaaaaa', kind: 'reply', mailbox: 'a@b.com', who: '佐藤様', subject: '確認', since: new Date(NOW - 3600000).toISOString(), threadId: 't1', lastMessageId: 'm1' }] });
  saveAnswer(home, 'ex:aaaaaaaaaaaa', '承知しました', NOW);
  const answers = readAnswers(home);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].answer, '承知しました');
  assert.equal(answers[0].id, 'ex:aaaaaaaaaaaa');
});

test('hasAnswer returns true/false correctly', async t => {
  const { hasAnswer, saveAnswer, externalFile, writeJsonAtomic } = await import('./external-waiting-state.mjs');
  const home = fixture(t);
  assert.equal(hasAnswer(home, 'ex:aaaaaaaaaaaa'), false);
  fs.mkdirSync(path.join(home, '.claude', 'state'), { recursive: true });
  writeJsonAtomic(externalFile(home), { generatedAt: new Date(NOW).toISOString(), sources: {}, items: [{ id: 'ex:aaaaaaaaaaaa', kind: 'reply', mailbox: 'a@b.com', who: '佐藤様', subject: '確認', since: new Date(NOW - 3600000).toISOString(), threadId: 't1', lastMessageId: 'm1' }] });
  saveAnswer(home, 'ex:aaaaaaaaaaaa', 'OK', NOW);
  assert.equal(hasAnswer(home, 'ex:aaaaaaaaaaaa'), true);
  assert.equal(hasAnswer(home, 'ex:bbbbbbbbbbbb'), false);
  assert.equal(hasAnswer(home, 'invalid'), false);
});

test('groupDrafts は同じ who の下書きをまとめ、最新だけ残す', async t => {
  const { groupDrafts } = await import('./external-waiting-state.mjs');
  const items = [
    { id: 'ex:a', kind: 'draft', who: '佐藤様', subject: '見積1', since: new Date(NOW - 7200000).toISOString() },
    { id: 'ex:b', kind: 'reply', who: '鈴木様', subject: '確認', since: new Date(NOW - 3600000).toISOString() },
    { id: 'ex:c', kind: 'draft', who: '佐藤様', subject: '見積2（最新）', since: new Date(NOW - 1800000).toISOString() },
    { id: 'ex:d', kind: 'draft', who: '田中様', subject: '依頼', since: new Date(NOW - 3600000).toISOString() },
  ];
  const { kept, replacedIds } = groupDrafts(items);
  assert.equal(kept.length, 3); // ex:b (reply), ex:c (newest draft for 佐藤様), ex:d (draft, 田中様 only one)
  assert.equal(replacedIds.length, 1); // ex:a (older draft for 佐藤様)
  assert.ok(kept.find(i => i.id === 'ex:c')); // newest draft kept
  assert.ok(kept.find(i => i.id === 'ex:b')); // non-draft kept
  assert.ok(!kept.find(i => i.id === 'ex:a')); // old draft removed
});

test('groupDrafts は単一の下書きをそのまま残す', async t => {
  const { groupDrafts } = await import('./external-waiting-state.mjs');
  const items = [
    { id: 'ex:a', kind: 'draft', who: '佐藤様', subject: '見積', since: new Date(NOW - 3600000).toISOString() },
    { id: 'ex:b', kind: 'reply', who: '鈴木様', subject: '確認', since: new Date(NOW - 3600000).toISOString() },
  ];
  const { kept, replacedIds } = groupDrafts(items);
  assert.equal(kept.length, 2);
  assert.equal(replacedIds.length, 0);
});

test('markAnsweredActionDone は回答ファイルに actionDone フラグを追加する', async t => {
  const { markAnsweredActionDone, saveAnswer, readAnswers, externalFile, writeJsonAtomic } = await import('./external-waiting-state.mjs');
  const home = fixture(t);
  fs.mkdirSync(path.join(home, '.claude', 'state'), { recursive: true });
  writeJsonAtomic(externalFile(home), { generatedAt: new Date(NOW).toISOString(), sources: {}, items: [{ id: 'ex:aaaaaaaaaaaa', kind: 'reply', mailbox: 'a@b.com', who: '佐藤様', subject: '確認', since: new Date(NOW - 3600000).toISOString(), threadId: 't1', lastMessageId: 'm1' }] });
  saveAnswer(home, 'ex:aaaaaaaaaaaa', '承知しました', NOW);
  markAnsweredActionDone(home, 'ex:aaaaaaaaaaaa');
  const answers = readAnswers(home);
  assert.equal(answers[0].actionDone, true);
  assert.ok(answers[0].actionDoneAt);
});