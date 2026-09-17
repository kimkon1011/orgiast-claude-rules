import assert from 'node:assert/strict';
import test from 'node:test';
import { judgeNextAction } from './next-action-gate.mjs';

const body = '調査と実装と検証が完了しました。'.repeat(15);
const twoLineFooter = '次に kim がすること: なし\nこの後の自動進行: なし（完了）';
const footer = `${twoLineFooter}\nこのセッション: もう削除してよい（残すものは無い）`;

test('3行が末尾に揃っていればpass', () => {
  assert.equal(judgeNextAction(`${body}\n${footer}`).decision, 'pass');
});

test('3行の各行間に空行1つまで許容する', () => {
  const spaced = '次に kim がすること: なし\n\nこの後の自動進行: なし（完了）\n\nこのセッション: もう削除してよい（残すものは無い）';
  assert.equal(judgeNextAction(`${body}\n${spaced}`).decision, 'pass');
});

test('前バージョンで正解だった2行だけならblock', () => {
  assert.equal(judgeNextAction(`${body}\n${twoLineFooter}`).decision, 'block');
});

test('1行目だけならblock', () => {
  assert.equal(judgeNextAction(`${body}\n次に kim がすること: なし`).decision, 'block');
});

test('3行とも無ければblock', () => {
  assert.equal(judgeNextAction(body).decision, 'block');
});

test('3行が本文途中にあればblock', () => {
  assert.equal(judgeNextAction(`${body}\n${footer}\n追加説明です。`).decision, 'block');
});

test('kimの作業が2件ならblock', () => {
  const result = judgeNextAction(`${body}\n次に kim がすること: 承認、送信\nこの後の自動進行: Codex が確認後すぐ結果をチャットで通知します\nこのセッション: まだ閉じない（結果待ち）`);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'NEXT-ACTION-MULTIPLE');
});

test('待ち状態と完了表記が矛盾すればblock', () => {
  const result = judgeNextAction(`${body} 完了通知待ちです。\n${footer}`);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'AUTOPILOT-CONTRADICTION');
});

test('このセッションの値が3分類のどれでもなければblock', () => {
  const result = judgeNextAction(`${body}\n${twoLineFooter}\nこのセッション: たぶん大丈夫`);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'SESSION-INVALID');
});

test('このセッションの値が空ならblock', () => {
  const result = judgeNextAction(`${body}\n${twoLineFooter}\nこのセッション:`);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'SESSION-EMPTY');
});

test('バックグラウンド実行中なのに閉じてよいならblock', () => {
  const text = `${body} Codex がバックグラウンドで実行中です。 /session-close 実行済み。\n次に kim がすること: なし\nこの後の自動進行: Codex が完了時にチャットで通知します\nこのセッション: 閉じてよい`;
  const result = judgeNextAction(text);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'SESSION-BACKGROUND-CONTRADICTION');
});

test('待ち語が無く、もう削除してよいならpass', () => {
  assert.equal(judgeNextAction(`${body}\n${footer}`).decision, 'pass');
});

test('待ち語があり、まだ閉じないならpass', () => {
  const text = `${body} 結果待ちです。\n次に kim がすること: なし\nこの後の自動進行: 処理完了時に Codex がチャットで通知します\nこのセッション: まだ閉じない（Codex の結果待ち）`;
  assert.equal(judgeNextAction(text).decision, 'pass');
});

test('session-close実行証拠なしで閉じてよいならblock', () => {
  const text = `${body}\n次に kim がすること: なし\nこの後の自動進行: なし（完了）\nこのセッション: 閉じてよい（/session-close 実行済み）`;
  const result = judgeNextAction(text);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'SESSION-CLOSE-NO-EVIDENCE');
});

test('会話にsession-close実行証拠があれば閉じてよいがpass', () => {
  const text = `${body}\n次に kim がすること: なし\nこの後の自動進行: なし（完了）\nこのセッション: 閉じてよい（/session-close 実行済み）`;
  const transcript = JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-name>/session-close</command-name>' } });
  assert.equal(judgeNextAction(text, transcript).decision, 'pass');
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
