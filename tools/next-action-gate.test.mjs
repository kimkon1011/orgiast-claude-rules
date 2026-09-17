import assert from 'node:assert/strict';
import test from 'node:test';
import { judgeNextAction } from './next-action-gate.mjs';

const body = '調査と実装と検証が完了しました。'.repeat(15);
const footer = '次に kim がすること: なし\nこの後の自動進行: なし（完了）';

test('2行が末尾に揃っていればpass', () => {
  assert.equal(judgeNextAction(`${body}\n${footer}`).decision, 'pass');
});

test('1行目だけならblock', () => {
  assert.equal(judgeNextAction(`${body}\n次に kim がすること: なし`).decision, 'block');
});

test('2行とも無ければblock', () => {
  assert.equal(judgeNextAction(body).decision, 'block');
});

test('2行が本文途中にあればblock', () => {
  assert.equal(judgeNextAction(`${body}\n${footer}\n追加説明です。`).decision, 'block');
});

test('kimの作業が2件ならblock', () => {
  const result = judgeNextAction(`${body}\n次に kim がすること: 承認、送信\nこの後の自動進行: Codex が確認後すぐ結果をチャットで通知します`);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'NEXT-ACTION-MULTIPLE');
});

test('待ち状態と完了表記が矛盾すればblock', () => {
  const result = judgeNextAction(`${body} Codex の完了通知待ちです。\n${footer}`);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'AUTOPILOT-CONTRADICTION');
});

test('200文字未満の短い応答はpass', () => {
  assert.equal(judgeNextAction('承知しました。').decision, 'pass');
});

test('末尾が疑問符の質問応答はpass', () => {
  assert.equal(judgeNextAction(`${body}この方針で進めてもよいですか？`).decision, 'pass');
});

test('環境変数で無効化できる', () => {
  const previous = process.env.ORGIAST_NEXT_ACTION_GATE;
  try {
    process.env.ORGIAST_NEXT_ACTION_GATE = '0';
    assert.equal(judgeNextAction(body).decision, 'pass');
  } finally {
    if (previous === undefined) delete process.env.ORGIAST_NEXT_ACTION_GATE;
    else process.env.ORGIAST_NEXT_ACTION_GATE = previous;
  }
});
