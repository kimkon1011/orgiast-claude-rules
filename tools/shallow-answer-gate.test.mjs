import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateShallowAnswer } from './shallow-answer-gate.mjs';

function makeTranscript(tools) {
  const userEntry = { type: 'user', message: { role: 'user', content: '見積もりを探して' } };
  const assistantToolEntry = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: tools.map(t => ({ type: 'tool_use', name: t.name, input: t.input || {} }))
    }
  };
  return [JSON.stringify(userEntry), JSON.stringify(assistantToolEntry)].join('\n');
}

test('浅い主張なしは pass', () => {
  const result = evaluateShallowAnswer({ text: '見積もりがありました。10万円です。' });
  assert.equal(result.decision, 'pass');
});

test('浅い主張あり・浅いツールのみ（Glob）は block', () => {
  const raw = makeTranscript([{ name: 'Glob', input: { pattern: '*見積*' } }]);
  const result = evaluateShallowAnswer({ text: '件名検索しましたが、見積もりはありませんでした。', transcriptRaw: raw });
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'SHALLOW-ANSWER');
});

test('浅い主張あり・深いツール使用（read_file_content）は pass', () => {
  const raw = makeTranscript([{ name: 'read_file_content', input: { path: 'doc1.txt' } }]);
  const result = evaluateShallowAnswer({ text: '本文を確認しましたが、記載がありませんでした。', transcriptRaw: raw });
  assert.equal(result.decision, 'pass');
});

test('自分のコード・ビルドの否定は pass (own-code-negative-exempt)', () => {
  const raw = makeTranscript([{ name: 'Bash', input: { command: 'git status' } }]);
  const result = evaluateShallowAnswer({ text: 'ビルドエラーはありませんでした。テスト結果は0件の失敗です。', transcriptRaw: raw });
  assert.equal(result.decision, 'pass');
});

test('[DEPTH-OK] タグがあれば pass', () => {
  const raw = makeTranscript([{ name: 'Glob', input: { pattern: '*' } }]);
  const result = evaluateShallowAnswer({ text: '該当なし。[DEPTH-OK: 件名のみで確定可能のため]', transcriptRaw: raw });
  assert.equal(result.decision, 'pass');
});

test('Grep output_mode content は pass、files_with_matches は block', () => {
  const rawDeep = makeTranscript([{ name: 'Grep', input: { pattern: 'test', output_mode: 'content' } }]);
  const resDeep = evaluateShallowAnswer({ text: '検索しましたが、見つかりませんでした。', transcriptRaw: rawDeep });
  assert.equal(resDeep.decision, 'pass');

  const rawShallow = makeTranscript([{ name: 'Grep', input: { pattern: 'test', output_mode: 'files_with_matches' } }]);
  const resShallow = evaluateShallowAnswer({ text: '検索しましたが、見つかりませんでした。', transcriptRaw: rawShallow });
  assert.equal(resShallow.decision, 'block');
});

test('IMAP BODY[TEXT] は pass、SEARCH のみは block', () => {
  const rawDeep = makeTranscript([{ name: 'Bash', input: { command: 'curl imap ... FETCH 1 BODY[TEXT]' } }]);
  const resDeep = evaluateShallowAnswer({ text: 'メールを確認しましたが、存在しません。', transcriptRaw: rawDeep });
  assert.equal(resDeep.decision, 'pass');

  const rawShallow = makeTranscript([{ name: 'Bash', input: { command: 'curl imap ... SEARCH SUBJECT test' } }]);
  const resShallow = evaluateShallowAnswer({ text: 'メールを確認しましたが、存在しません。', transcriptRaw: rawShallow });
  assert.equal(resShallow.decision, 'block');
});

