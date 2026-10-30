import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { judge, claudeAccountEmail } from './mail-draft-account-gate.mjs';

test('全書き込み操作・番号付きコネクタ・draftId 付き送信も拒否し代替を示す', () => {
  for (const connector of ['Gmail', 'Gmail_2', 'Gmail_12']) {
    for (const action of ['create_draft', 'update_draft', 'send_message', 'reply', 'forward']) {
      const result = judge({ tool_name: `mcp__claude_ai_${connector}__${action}`, tool_input: { draftId: 'exists' } }, {});
      assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
      for (const text of ['seisaku-team@orgiast.jp', 'gmail-draft.mjs --to', 'gmail-search.mjs --user', '--send <draftId>']) assert.ok(result.hookSpecificOutput.permissionDecisionReason.includes(text));
    }
  }
});
test('読み取り・別ツール・緊急退避は通す', () => {
  for (const tool_name of ['mcp__claude_ai_Gmail__search', 'Bash', 'mcp__other__create_draft', '']) assert.equal(judge({ tool_name }, {}), null);
  assert.equal(judge({ tool_name: 'mcp__claude_ai_Gmail__reply' }, { ORGIAST_MAIL_ACCOUNT_GATE: 'off' }), null);
});
test('共有アカウントでログインした席は通し、個人アカウントは拒否する', () => {
  for (const account of ['seisaku-team@orgiast.jp', 'Seisaku-Team@orgiast.jp']) assert.equal(judge({ tool_name: 'mcp__claude_ai_Gmail__reply' }, {}, account), null);
  for (const account of ['kim@orgiast.jp', '']) assert.equal(judge({ tool_name: 'mcp__claude_ai_Gmail__reply' }, {}, account).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(claudeAccountEmail({ ORGIAST_CLAUDE_ACCOUNT_EMAIL: 'kim@orgiast.jp' }), 'kim@orgiast.jp');
});
test('stdin JSON の実行結果と空入力・破損入力', () => {
  const shared = spawnSync(process.execPath, ['tools/mail-draft-account-gate.mjs'], { input: JSON.stringify({ tool_name: 'mcp__claude_ai_Gmail__reply' }), encoding: 'utf8', env: { ...process.env, ORGIAST_MAIL_ACCOUNT_GATE: '', ORGIAST_CLAUDE_ACCOUNT_EMAIL: 'seisaku-team@orgiast.jp' } });
  assert.equal(shared.stdout, '');
  for (const input of ['', '{', JSON.stringify({ tool_name: 'mcp__claude_ai_Gmail__create_draft' })]) {
    const result = spawnSync(process.execPath, ['tools/mail-draft-account-gate.mjs'], { input, encoding: 'utf8', env: { ...process.env, ORGIAST_MAIL_ACCOUNT_GATE: '', ORGIAST_CLAUDE_ACCOUNT_EMAIL: 'kim@orgiast.jp' } });
    assert.equal(result.status, 0);
    if (input.length > 1) assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
    else assert.equal(result.stdout, '');
  }
});
