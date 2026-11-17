import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// We test the logic directly without importing the full kim-inbox / kim-awaiting modules
// to avoid circular dependency and heavy setup. Instead we test recordNaturalLanguageAnswers
// with a mock respond function and mock awaitingItems.

import { recordNaturalLanguageAnswers, revisionOf } from './lib/kim-inbox-relay-state.mjs';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-awaiting-'));
  fs.mkdirSync(path.join(home, '.claude'));
  const sessionId = 'test-session';
  const stateDir = path.join(home, '.claude/kim-inbox-relay');
  fs.mkdirSync(stateDir, { recursive: true });

  // Mock listItems returns empty (no ki-* items for these tests)
  const listItems = () => [];

  // Mock answerItem records on the item
  const answers = [];
  const answerItem = (h, id, answer, sid) => {
    answers.push({ id, answer, sessionId: sid });
    return { id, answer };
  };

  // Mock respond records the call
  const responds = [];
  const respond = (id, { home: h, bodyFile, skip, reason } = {}) => {
    const body = bodyFile ? fs.readFileSync(bodyFile, 'utf8').trim() : '';
    responds.push({ id, body, skip, reason });
    return 0;
  };

  return { home, sessionId, listItems, answerItem, answers, respond, responds,
    makeRelayState(items) {
      const hash = crypto.createHash('sha256').update(sessionId).digest('hex');
      const dir = path.join(stateDir, hash + '.json');
      if (items) {
        const delivered = items.map((item, n) => ({
          id: item.id, number: n + 1, revision: revisionOf(item),
        }));
        fs.writeFileSync(dir, JSON.stringify({ sessionId, lastDelivered: delivered }) + '\n');
      } else {
        // No relay state
        try { fs.unlinkSync(dir); } catch {}
      }
    },
  };
}

// --- ap: items ---

test('ap: single item + "進めて" records via respond', () => {
  const f = fixture();
  f.makeRelayState(null); // no ki-* items
  const awaitingItems = [
    { id: 'ap:abc123', title: 'aujust バッチ3 PR', ask: 'マージしてよいか判断する' },
  ];
  const result = recordNaturalLanguageAnswers(f.home, f.sessionId, '進めて', {
    listItems: f.listItems, answerItem: f.answerItem, respond: f.respond, awaitingItems,
  });
  assert.equal(result.answers.length, 1);
  assert.equal(result.hints.length, 0);
  assert.equal(f.responds.length, 1);
  assert.equal(f.responds[0].id, 'ap:abc123');
  assert.equal(f.responds[0].body, '可');
});

test('ap: single item + "不要" records via respond as 否認', () => {
  const f = fixture();
  f.makeRelayState(null);
  const awaitingItems = [
    { id: 'ap:def456', title: '請求書自動化', ask: '進めてよいか判断する' },
  ];
  const result = recordNaturalLanguageAnswers(f.home, f.sessionId, '不要', {
    listItems: f.listItems, answerItem: f.answerItem, respond: f.respond, awaitingItems,
  });
  assert.equal(result.answers.length, 1);
  assert.equal(f.responds.length, 1);
  assert.equal(f.responds[0].id, 'ap:def456');
  assert.equal(f.responds[0].body, '否認');
});

test('ap: single item + "良いですよ" records via respond', () => {
  const f = fixture();
  f.makeRelayState(null);
  const awaitingItems = [
    { id: 'ap:ghi789', title: '新機能リリース承認', ask: 'リリースしてよいか' },
  ];
  const result = recordNaturalLanguageAnswers(f.home, f.sessionId, '良いですよ', {
    listItems: f.listItems, answerItem: f.answerItem, respond: f.respond, awaitingItems,
  });
  assert.equal(result.answers.length, 1);
  assert.equal(f.responds.length, 1);
  assert.equal(f.responds[0].id, 'ap:ghi789');
  assert.equal(f.responds[0].body, '可');
});

// --- fm: items ---

test('fm: single item + "OK" records via respond', () => {
  const f = fixture();
  f.makeRelayState(null);
  const awaitingItems = [
    { id: 'fm:mail-abc123', title: '田中さんからの質問', ask: '返信内容を決める' },
  ];
  const result = recordNaturalLanguageAnswers(f.home, f.sessionId, 'OK', {
    listItems: f.listItems, answerItem: f.answerItem, respond: f.respond, awaitingItems,
  });
  assert.equal(result.answers.length, 1);
  assert.equal(f.responds.length, 1);
  assert.equal(f.responds[0].id, 'fm:mail-abc123');
  assert.equal(f.responds[0].body, '可');
});

// --- "全部OK" for multiple items ---

test('"全部OK" records for all awaiting ap/fm items', () => {
  const f = fixture();
  f.makeRelayState(null);
  const awaitingItems = [
    { id: 'ap:aaa111', title: 'バッチ3 PR', ask: 'マージ判断' },
    { id: 'fm:mail-bbb222', title: '佐藤さん見積確認', ask: '内容確認' },
  ];
  const result = recordNaturalLanguageAnswers(f.home, f.sessionId, '全部OK', {
    listItems: f.listItems, answerItem: f.answerItem, respond: f.respond, awaitingItems,
  });
  assert.equal(result.answers.length, 2);
  assert.equal(f.responds.length, 2);
  assert.equal(f.responds[0].id, 'ap:aaa111');
  assert.equal(f.responds[1].id, 'fm:mail-bbb222');
});

test('"両方進めて" records for 2 items', () => {
  const f = fixture();
  f.makeRelayState(null);
  const awaitingItems = [
    { id: 'ap:ccc333', title: 'PRマージ', ask: 'マージ判断' },
    { id: 'ap:ddd444', title: 'デプロイ', ask: '進めてよいか' },
  ];
  const result = recordNaturalLanguageAnswers(f.home, f.sessionId, '両方進めて', {
    listItems: f.listItems, answerItem: f.answerItem, respond: f.respond, awaitingItems,
  });
  assert.equal(result.answers.length, 2);
  assert.equal(f.responds.length, 2);
});

// --- Content match by title words ---

test('content match by title word', () => {
  const f = fixture();
  f.makeRelayState(null);
  const awaitingItems = [
    { id: 'ap:eee555', title: 'aujust バッチ3 PR', ask: 'マージしてよいか' },
    { id: 'ap:fff666', title: '請求書自動化', ask: '進めてよいか' },
  ];
  const result = recordNaturalLanguageAnswers(f.home, f.sessionId, 'aujust マージしてよい', {
    listItems: f.listItems, answerItem: f.answerItem, respond: f.respond, awaitingItems,
  });
  assert.equal(result.answers.length, 1);
  assert.equal(f.responds.length, 1);
  assert.equal(f.responds[0].id, 'ap:eee555');
});

// --- ex: items are not recorded (only saved via respond, no send) ---

test('ex: item is handled via respond (saveAnswer path)', () => {
  const f = fixture();
  f.makeRelayState(null);
  const awaitingItems = [
    { id: 'ex:monitor', title: '社外返信の監視', ask: '確認' },
  ];
  const result = recordNaturalLanguageAnswers(f.home, f.sessionId, '進めて', {
    listItems: f.listItems, answerItem: f.answerItem, respond: f.respond, awaitingItems,
  });
  // ex: items are skipped by pattern 4 (only ap:/fm: matched), but respond is available
  // ex: items are NOT in awaitingApFm, so they're not recorded
  assert.equal(result.answers.length, 0);
  assert.equal(f.responds.length, 0);
});

// --- Low confidence: multiple items + vague reply → hints ---

test('multiple awaiting items + vague reply returns hints', () => {
  const f = fixture();
  f.makeRelayState(null);
  const awaitingItems = [
    { id: 'ap:ggg777', title: 'PRマージ承認', ask: '判断' },
    { id: 'ap:hhh888', title: 'デプロイ判断', ask: '進めてよいか' },
  ];
  const result = recordNaturalLanguageAnswers(f.home, f.sessionId, 'OK', {
    listItems: f.listItems, answerItem: f.answerItem, respond: f.respond, awaitingItems,
  });
  assert.equal(result.answers.length, 0);
  assert.ok(result.hints.length > 0);
  assert.ok(result.hints[0].includes('記録します'));
  assert.equal(f.responds.length, 0); // not recorded
});

// --- No matching when respond is not provided ---

test('no respond function skips awaiting handling', () => {
  const f = fixture();
  f.makeRelayState(null);
  const awaitingItems = [
    { id: 'ap:iii999', title: 'テスト項目', ask: '判断' },
  ];
  const result = recordNaturalLanguageAnswers(f.home, f.sessionId, '進めて', {
    listItems: f.listItems, answerItem: f.answerItem, awaitingItems,
    // no respond
  });
  assert.equal(result.answers.length, 0);
  assert.equal(result.hints.length, 0);
});

// --- No awaiting items passed → normal behavior ---

test('no awaitingItems uses existing ki-* path', () => {
  const f = fixture();
  f.makeRelayState([]); // no delivered items
  const result = recordNaturalLanguageAnswers(f.home, f.sessionId, '進めて', {
    listItems: f.listItems, answerItem: f.answerItem,
    // no awaitingItems
  });
  assert.equal(result.answers.length, 0);
  assert.equal(result.hints.length, 0);
});

// --- Single awaiting item + single ki-* item: ki-* takes priority ---

test('single ki-* item takes priority over single awaiting item', () => {
  const f = fixture();
  const kimItem = {
    id: 'ki-20261112000000-0001',
    kind: 'ask',
    text: '資料公開の承認',
    status: 'open',
    revision: 'v1',
    createdAt: '2026-11-12T00:00:00.000Z',
    lastAt: '2026-11-12T00:00:00.000Z',
    shownSessions: [],
    shownCount: 0,
  };
  f.makeRelayState([kimItem]);
  // Write the item to the kim-inbox dir so listItems can find it
  const inboxDir = path.join(f.home, '.claude/kim-inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(path.join(inboxDir, kimItem.id + '.json'), JSON.stringify(kimItem));

  const awaitingItems = [
    { id: 'ap:jjj000', title: '別の項目', ask: '判断' },
  ];

  // We need a real listItems that finds the ki-* item
  // For this test, use a simple mock that returns the kimItem
  const mockListItems = () => [kimItem];

  const result = recordNaturalLanguageAnswers(f.home, f.sessionId, '良いですよ', {
    listItems: mockListItems, answerItem: f.answerItem, respond: f.respond, awaitingItems,
  });
  // ki-* item gets recorded, awaiting item does not
  assert.equal(f.responds.length, 0);
  // The ki-* item's answer is recorded via answerItem
  assert.ok(f.answers.length > 0 || result.answers.length > 0);
});

// --- cleanup temp dir after each test ---
test('cleanup temp files', () => {
  // no-op: tmp dirs are cleaned up by OS
});