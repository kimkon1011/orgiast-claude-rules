import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { addItem, listItems, answerItem } from './kim-inbox.mjs';
import { recordNaturalLanguageAnswers, revisionOf } from './lib/kim-inbox-relay-state.mjs';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-answers-'));
  fs.mkdirSync(path.join(home, '.claude'));
  const sessionId = 'test-session';
  const stateDir = path.join(home, '.claude/kim-inbox-relay');
  fs.mkdirSync(stateDir, { recursive: true });

  function deliverItems(items) {
    const dir = path.join(home, '.claude/kim-inbox');
    fs.mkdirSync(dir, { recursive: true });
    for (const item of items) {
      fs.writeFileSync(path.join(dir, item.id + '.json'), JSON.stringify(item));
    }
    const delivered = items.map((item, n) => ({
      id: item.id,
      number: n + 1,
      revision: revisionOf(item),
    }));
    const hash = crypto.createHash('sha256').update(sessionId).digest('hex');
    fs.writeFileSync(
      path.join(stateDir, hash + '.json'),
      JSON.stringify({ sessionId, lastDelivered: delivered }) + '\n',
    );
  }

  function makeItem(id, text) {
    return {
      id,
      kind: 'ask',
      text,
      createdAt: '2026-11-12T00:00:00.000Z',
      lastAt: '2026-11-12T00:00:00.000Z',
      status: 'open',
      shownSessions: [],
      shownCount: 0,
    };
  }

  return { home, sessionId, deliverItems, makeItem };
}

test('natural: single affirmative with one pending ask records as 可', () => {
  const f = fixture();
  const item = f.makeItem('ki-20261112000000-0001', '資料公開の承認');
  f.deliverItems([item]);
  const result = recordNaturalLanguageAnswers(f.home, f.sessionId, '良いですよ', { listItems, answerItem });
  assert.equal(result.answers.length, 1, 'should record 1 answer');
  assert.equal(result.hints.length, 0, 'no hints for confident match');
  const saved = listItems(f.home).find(i => i.id === item.id);
  assert.equal(saved.answer, '可');
});

test('natural: 大丈夫 records as 可', () => {
  const f = fixture();
  const item = f.makeItem('ki-20261112000000-0002', '確認依頼');
  f.deliverItems([item]);
  const result = recordNaturalLanguageAnswers(f.home, f.sessionId, '大丈夫', { listItems, answerItem });
  assert.equal(result.answers.length, 1);
  const saved = listItems(f.home).find(i => i.id === item.id);
  assert.equal(saved.answer, '可');
});

test('natural: 不要 records as 否認', () => {
  const f = fixture();
  const item = f.makeItem('ki-20261112000000-0003', '不要な作業');
  f.deliverItems([item]);
  const result = recordNaturalLanguageAnswers(f.home, f.sessionId, '不要', { listItems, answerItem });
  assert.equal(result.answers.length, 1);
  const saved = listItems(f.home).find(i => i.id === item.id);
  assert.equal(saved.answer, '否認');
});

test('natural: numbered items (1. 良い 2. OK) record both', () => {
  const f = fixture();
  const a = f.makeItem('ki-20261112000000-0010', '公開承認');
  const b = f.makeItem('ki-20261112000000-0011', '変更承認');
  f.deliverItems([a, b]);
  const result = recordNaturalLanguageAnswers(f.home, f.sessionId, '1. 良い\n2. OK', { listItems, answerItem });
  assert.equal(result.answers.length, 2, 'both items recorded');
  assert.equal(result.hints.length, 0);
  const savedA = listItems(f.home).find(i => i.id === a.id);
  const savedB = listItems(f.home).find(i => i.id === b.id);
  assert.equal(savedA.answer, '可');
  assert.equal(savedB.answer, '可');
});

test('natural: negative numbered item (保留) skips recording', () => {
  const f = fixture();
  const a = f.makeItem('ki-20261112000000-0020', '公開承認');
  f.deliverItems([a]);
  const result = recordNaturalLanguageAnswers(f.home, f.sessionId, '1. 保留', { listItems, answerItem });
  assert.equal(result.answers.length, 0, '保留 should not record');
  assert.equal(result.hints.length, 0);
});

test('natural: multiple pending (3) with vague reply returns hints', () => {
  const f = fixture();
  const items = [1, 2, 3].map(i => f.makeItem('ki-20261112000000-000' + i, '判断' + i));
  f.deliverItems(items);
  const result = recordNaturalLanguageAnswers(f.home, f.sessionId, 'OK', { listItems, answerItem });
  assert.equal(result.answers.length, 0, 'should not auto-record with low confidence');
  assert.ok(result.hints.length > 0, 'should return hints when ambiguous');
  assert.ok(result.hints[0].includes('記録します'), 'hint should mention recording intent');
});

test('natural: no delivery state returns empty', () => {
  const f = fixture();
  const result = recordNaturalLanguageAnswers(f.home, f.sessionId, '良いです', { listItems, answerItem });
  assert.equal(result.answers.length, 0);
  assert.equal(result.hints.length, 0);
});

test('natural: 進めて records as 可 with single pending', () => {
  const f = fixture();
  const item = f.makeItem('ki-20261112000000-0030', '進捗判断');
  f.deliverItems([item]);
  const result = recordNaturalLanguageAnswers(f.home, f.sessionId, '進めて', { listItems, answerItem });
  assert.equal(result.answers.length, 1);
  const saved = listItems(f.home).find(i => i.id === item.id);
  assert.equal(saved.answer, '可');
});

test('natural: irrelevant text does not match', () => {
  const f = fixture();
  const item = f.makeItem('ki-20261112000000-0040', '何かの判断');
  f.deliverItems([item]);
  const result = recordNaturalLanguageAnswers(f.home, f.sessionId, '今日の天気は？', { listItems, answerItem });
  assert.equal(result.answers.length, 0);
  assert.equal(result.hints.length, 0);
});