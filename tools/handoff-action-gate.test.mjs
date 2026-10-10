import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateHandoffAction, evaluateHandoffActionFromRaw } from './handoff-action-gate.mjs';
import { findUnbackedExternalHandoff, scanExternalAccesses, scanExternalAccessesRecent } from './handoff-action-evidence.mjs';

function makeTranscript(toolUses = []) {
  const userEntry = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'Yahooメールを確認してください' },
  });
  if (!toolUses.length) return userEntry;
  const assistantEntry = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: toolUses.map(tool => ({
        type: 'tool_use',
        name: tool.name,
        input: tool.input || {},
      })),
    },
  });
  return `${userEntry}\n${assistantEntry}`;
}

test('1. tool_use が無い手渡し → block', () => {
  const text = 'Yahoo メールを見てください。IMAP に接続できません。認証情報がありません。';
  const raw = makeTranscript([]);
  const res = evaluateHandoffActionFromRaw({ text, transcriptRaw: raw });
  assert.equal(res.decision, 'block');
  assert.equal(res.code, 'HANDOFF-ACTION');
});

test('2. ローカルの Grep だけ → block', () => {
  const text = 'Yahoo メールを見てください。IMAP に接続できません。認証情報がありません。';
  const raw = makeTranscript([{ name: 'Grep', input: { pattern: 'yahoo' } }]);
  const res = evaluateHandoffAction({ text, raw });
  assert.equal(res.decision, 'block');
  assert.equal(res.code, 'HANDOFF-ACTION');
});

test('3. 実アクセスの tool_use あり (mcp) → pass', () => {
  const text = 'Yahoo メールを見てください。IMAP に接続できません。認証情報がありません。';
  const raw = makeTranscript([{ name: 'mcp__claude_ai_Gmail__search_threads', input: { q: 'yahoo' } }]);
  const res = evaluateHandoffAction({ text, raw });
  assert.equal(res.decision, 'pass');
});

test('3. 実アクセスの tool_use あり (Bash curl) → pass', () => {
  const text = 'Yahoo メールを見てください。IMAP に接続できません。認証情報がありません。';
  const raw = makeTranscript([{ name: 'Bash', input: { command: 'curl -v "https://imap.mail.yahoo.co.jp/"' } }]);
  const res = evaluateHandoffAction({ text, raw });
  assert.equal(res.decision, 'pass');
});

test('4. 逃がし弁あり → pass', () => {
  const text = 'Yahoo メールを見てください。IMAP に接続できません。 [HANDOFF-ACTION-OK: Yahoo IMAP に curl で接続し AUTHENTICATIONFAILED を確認]';
  const raw = makeTranscript([]);
  const res = evaluateHandoffAction({ text, raw });
  assert.equal(res.decision, 'pass');
});

test('5. ローカル作業の依頼は誤爆しない → pass', () => {
  const text = 'このコマンドを PowerShell に貼り付けて実行してください。';
  const raw = makeTranscript([]);
  const res = evaluateHandoffAction({ text, raw });
  assert.equal(res.decision, 'pass');
});

test('6. 外部の話だが手渡しでない → pass', () => {
  const text = 'Yahoo メールは IMAP で読めません。';
  const raw = makeTranscript([]);
  const res = evaluateHandoffAction({ text, raw });
  assert.equal(res.decision, 'pass');
});

test('scanExternalAccesses と scanExternalAccessesRecent のユニットテスト', () => {
  const raw = makeTranscript([
    { name: 'mcp__github__get_issue', input: { issue_number: 1 } },
    { name: 'Grep', input: { pattern: 'test' } },
  ]);
  const scan = scanExternalAccesses(raw);
  assert.equal(scan.external.length, 1);
  assert.equal(scan.external[0].target, 'github');
  assert.equal(scan.localOnly.length, 1);

  const recent = scanExternalAccessesRecent(raw);
  assert.equal(recent.external.length, 1);
});
