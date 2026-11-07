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
        id: tool.id,
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

const restoreRequest = '上書きして消してしまいました。私の側からは元に戻せません。お心当たりがあれば、もう一度フォームから送っていただけますか。';
const sheetWrite = { name: 'mcp__booth___debug_writeAndRead', input: { ssId: 'sheet', a1Cell: 'A1', formula: '="test"' } };

for (const prefix of ['', '> ', '&gt; ']) test(`復元不能＋再送依頼はSheets書き込みだけではblock（引用: ${prefix || 'なし'}）`, () => {
  const result = evaluateHandoffAction({ text: `${prefix}${restoreRequest}`, raw: makeTranscript([sheetWrite]) });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /Drive の版履歴 revisions／Forms API の回答／GitHub Actions＋DWD／制作アプリのコマンドキュー/);
});

for (const tool of [
  { name: 'Bash', input: { command: 'gh api user' } },
  { name: 'Bash', input: { command: 'curl https://sheets.googleapis.com/v4/spreadsheets/x' } },
  { name: 'Grep', input: { pattern: 'revisions.list' } },
  { name: 'Read', input: { file_path: 'versionHistory.md' } },
  { name: 'Bash', input: { command: 'echo forms.googleapis.com/v1/forms/x/responses' } },
]) test(`復元経路を試していないtool_useはblock: ${JSON.stringify(tool)}`, () => {
  assert.equal(evaluateHandoffAction({ text: restoreRequest, raw: makeTranscript([tool]) }).decision, 'block');
});

for (const tool of [
  { name: 'Bash', input: { command: 'curl https://forms.googleapis.com/v1/forms/x/responses' } },
  { name: 'PowerShell', input: { command: 'Invoke-RestMethod https://www.googleapis.com/drive/v3/files/x/revisions' } },
  { name: 'mcp__drive__revisions.list', input: { fileId: 'x' } },
  { name: 'Bash', input: { command: 'gh run view 123 --repo kimkon1011/aujust-sales-automation --log', workflow: 'auto-purchase-restore' } },
  { name: 'Bash', input: { command: 'node booth-cmd.mjs versionHistory x' } },
]) test(`当ターンの復元経路の試行はpass: ${JSON.stringify(tool)}`, () => {
  assert.equal(evaluateHandoffAction({ text: restoreRequest, raw: makeTranscript([tool]) }).decision, 'pass');
});

test('復元経路の結果は当ターンのtool_useに対応する出力だけを証拠にする', () => {
  const raw = makeTranscript([{ id: 'restore', name: 'Bash', input: { command: 'gh run view 123 --log' } }]);
  const result = id => JSON.stringify({ type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: id, content: 'auto-purchase-restore: revisions.list returned 403' },
  ] } });
  assert.equal(evaluateHandoffAction({ text: restoreRequest, raw: `${raw}\n${result('restore')}` }).decision, 'pass');
  assert.equal(evaluateHandoffAction({ text: restoreRequest, raw: `${raw}\n${result('unrelated')}` }).decision, 'block');
});

test('前ターン・sidechainの復元経路や本文の経路名だけではblock', () => {
  const old = makeTranscript([{ name: 'Bash', input: { command: 'curl https://forms.googleapis.com/v1/forms/x/responses' } }]);
  const current = makeTranscript([sheetWrite]);
  assert.equal(evaluateHandoffAction({ text: restoreRequest, raw: `${old}\n${current}` }).decision, 'block');
  const sidechain = JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [
    { type: 'tool_use', name: 'mcp__drive__revisions.list', input: {} },
  ] } });
  assert.equal(evaluateHandoffAction({ text: restoreRequest, raw: `${current}\n${sidechain}` }).decision, 'block');
  assert.equal(evaluateHandoffAction({ text: `${restoreRequest} revisions.list を試す予定です。`, raw: current }).decision, 'block');
});

test('RESTORE-TRIEDは10文字以上の理由があるときだけpass', () => {
  const raw = makeTranscript([sheetWrite]);
  assert.equal(evaluateHandoffAction({ text: `${restoreRequest} [RESTORE-TRIED: revisions.list は 403、Forms API も権限なしで失敗]`, raw }).decision, 'pass');
  for (const marker of ['[RESTORE-TRIED]', '[RESTORE-TRIED: 失敗]', '[HANDOFF-ACTION-OK: Sheets API へのアクセスは実施済み]']) {
    assert.equal(evaluateHandoffAction({ text: `${restoreRequest} ${marker}`, raw }).decision, 'block');
  }
});

for (const denial of ['復元できません', '元に戻せない', '戻せません', '戻すことはできません', 'Claude では元に戻せません']) {
  for (const request of ['もう一度フォームに入力していただけますか', '回答を再送してもらえますか', 'フォームに入力し直してください', '回答を送り直してください']) {
    test(`復元不能と再作業依頼の言い換えもblock: ${denial} / ${request}`, () => {
      assert.equal(evaluateHandoffAction({ text: `${denial}。\n> ${request}。`, raw: makeTranscript([sheetWrite]) }).decision, 'block');
    });
  }
}

test('通常の業務連絡・再作業依頼のない復元不能報告は厳格判定しない', () => {
  for (const text of ['フォームに回答を送っていただけますか。', '回答をもう一度フォームから送っていただけますか。', 'シートを元に戻せません。復元経路を調べます。']) {
    assert.equal(evaluateHandoffAction({ text, raw: makeTranscript() }).decision, 'pass');
  }
});
