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
  const result = judgeNextAction(`${body} Codex の完了通知待ちです。\n${footer}`);
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

const closedText = `${body}\n${twoLineFooter}\nこのセッション: 閉じてよい（/session-close 実行済み）`;
const row = (role, content, extra = {}) => JSON.stringify({ type: role, message: { role, content }, ...extra });

test('本文でsession-close完了を明記すればpass', () => {
  for (const report of ['/session-close 実行済み。', '`/session-close` を実行しました。', '/session-close を完了しました。']) {
    assert.equal(judgeNextAction(`${report}\n${closedText}`).decision, 'pass', report);
  }
});

test('session-close予定・未実行・失敗は実行証拠にならない', () => {
  for (const report of ['/session-close 実行予定です。', '/session-close を実行していません。', '/session-close 実行に失敗しました。', '/session-close 完了待ちです。', '/session-close 実行済みではありません。']) {
    const text = `${report}\n${closedText.replace('なし（完了）', '私が手続き完了後にこの画面で報告します')}`;
    assert.equal(judgeNextAction(text).code, 'SESSION-CLOSE-NO-EVIDENCE', report);
  }
});

test('会話中の本文でsession-close完了を報告していればpass', () => {
  const transcript = row('assistant', [{ type: 'text', text: '/session-close を実行しました。' }]);
  assert.equal(judgeNextAction(closedText, transcript).decision, 'pass');
});

test('会話の例示・ツール引数・別セッション・末尾自己申告は証拠にしない', () => {
  const command = '<command-name>/session-close</command-name>';
  for (const transcript of [
    row('user', `実行例: ${command}`),
    row('assistant', command),
    row('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: `echo '${command}'` } }]),
    row('user', command, { isSidechain: true }),
    row('assistant', closedText),
    command,
  ]) assert.equal(judgeNextAction(closedText, transcript).code, 'SESSION-CLOSE-NO-EVIDENCE', transcript);
});

test('Skillの成功したsession-close呼び出しを会話から検出する', () => {
  const use = row('assistant', [{ type: 'tool_use', name: 'Skill', id: 'close-1', input: { skill: 'session-close' } }]);
  const result = row('user', [{ type: 'tool_result', tool_use_id: 'close-1', content: '完了しました' }]);
  assert.equal(judgeNextAction(closedText, `${use}\n${result}`).decision, 'pass');
  for (const transcript of [use, `${result}\n${use}`, `${use}\n${row('user', [{ type: 'tool_result', tool_use_id: 'other', content: '完了しました' }])}`, `${use}\n${row('user', [{ type: 'tool_result', tool_use_id: 'close-1', is_error: true, content: '失敗' }])}`, `${use}\n${row('user', [{ type: 'tool_result', tool_use_id: 'close-1', content: 'Permission denied' }])}`]) {
    assert.equal(judgeNextAction(closedText, transcript).code, 'SESSION-CLOSE-NO-EVIDENCE');
  }
});

test('3分類の句点・漢字・括弧の表記ゆれを許容する', () => {
  for (const state of ['閉じて良い。', '閉じていい(/session-close 実行済み)', 'まだ閉じない。', 'もう削除して良い（残すものは無い）。']) {
    const text = `/session-close を実行しました。\n${body}\n${twoLineFooter}\nこのセッション: ${state}`;
    assert.equal(judgeNextAction(text).decision, 'pass', state);
  }
});

test('3行の順序違い・2つ以上の空行・行間の説明をblock', () => {
  const lines = footer.split('\n');
  for (const invalid of [[lines[1], lines[0], lines[2]].join('\n'), lines.join('\n\n\n'), lines.join('\n説明です\n')]) {
    assert.equal(judgeNextAction(`${body}\n${invalid}`).code, 'NEXT-ACTION-FOOTER');
  }
  assert.equal(judgeNextAction(`${body}\r\n${lines.join('\r\n \t\r\n')}`).decision, 'pass');
});

test('指定された各バックグラウンド語と閉じる・削除の矛盾をblock', () => {
  for (const word of ['バックグラウンド', '実行中', '完了通知', 'Codex が', '走っている']) {
    for (const state of ['閉じてよい', 'もう削除してよい']) {
      const text = `${body} ${word}\n次に kim がすること: なし\nこの後の自動進行: 処理の完了時に私がこの画面で報告します\nこのセッション: ${state}`;
      assert.equal(judgeNextAction(text).code, 'SESSION-BACKGROUND-CONTRADICTION', `${word}: ${state}`);
    }
  }
});

test('200文字の境界と半角疑問符の除外を維持する', () => {
  assert.equal(judgeNextAction('あ'.repeat(199)).reason, 'short-response');
  assert.equal(judgeNextAction('あ'.repeat(200)).code, 'NEXT-ACTION-FOOTER');
  assert.equal(judgeNextAction(`${body}?`).reason, 'question');
});
