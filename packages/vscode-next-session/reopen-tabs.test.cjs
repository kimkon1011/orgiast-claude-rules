const test = require('node:test');
const assert = require('node:assert/strict');
const { findSessionTabs, reopenSession } = require('./reopen-tabs.cjs');
const id = '8f6d41ac-1111-2222-3333-123456789abc';
const tab = label => ({ label, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } });
const saved = (title, sessionId = id) => ({ title, sessionId, isClaude: true });

test('実機形式の共通 viewType と sessionID を一意なタイトルで照合する', () => {
  const target = tab('復旧対象');
  const other = tab('別の仕事');
  assert.deepEqual(findSessionTabs([target, other], id, [saved('復旧対象'), saved('別の仕事', 'other')]), [target]);
});

test('短縮ID・重複タイトル・空タブ・他拡張・古いタイトルからは閉じない', () => {
  const first = tab('重複');
  assert.deepEqual(findSessionTabs([tab(id.slice(0, 8)), first, tab('重複'), tab('Claude Code'),
    { label: id, input: { viewType: 'other' } }], id, [saved('重複'), saved('Claude Code')]), []);
  assert.deepEqual(findSessionTabs([tab('重複')], id, [saved('重複'), saved('重複', 'other')]), []);
  assert.deepEqual(findSessionTabs([tab('変更後')], id, [saved('変更前')]), []);
});

test('対象の close 完了後だけ open、対象なしなら open のみ', async () => {
  const events = [];
  await reopenSession({ sessionId: id, tabs: () => [tab(id)], close: async () => { events.push('closed'); return true; },
    open: async uri => { events.push(uri); return true; } });
  assert.deepEqual(events, ['closed', `vscode://anthropic.claude-code/open?session=${id}`]);
  await reopenSession({ sessionId: id, tabs: () => [], close: () => assert.fail(), open: async () => true });
});

test('close キャンセル・例外では open せず、open 失敗もエラーにする', async () => {
  for (const close of [async () => false, async () => { throw Error('close failed'); }]) {
    await assert.rejects(reopenSession({ sessionId: id, tabs: () => [tab(id)], close, open: () => assert.fail() }));
  }
  await assert.rejects(reopenSession({ sessionId: id, tabs: () => [], open: async () => false }));
});
