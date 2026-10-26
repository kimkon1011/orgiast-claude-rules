import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMergeHandoff } from './merge-handoff-gate.mjs';

const bash = command => ({ type: 'tool_use', name: 'Bash', input: { command } });
const query = bash('gh pr view 1024 -R kimkon1011/orgiast-claude-rules --json state,mergedAt');
const tryMerge = bash('gh pr merge 1024 -R kimkon1011/orgiast-claude-rules --squash');

const blocked = [
  '次に kim がすること: PR #1024 をマージする',
  '金さん、PR #1024 のマージをお願いします。',
  'https://github.com/kimkon1011/orgiast-claude-rules/pull/1024 をマージしてください。',
  '- 次に kim がすること: #812 を merge する',
];
for (const text of blocked) test(`block: ${text}`, () => {
  const result = evaluateMergeHandoff(text, []);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'MERGE-HANDOFF');
  assert.match(result.reason, /gh pr view/);
});

test('照会だけでマージ試行が無ければ block', () => {
  assert.equal(evaluateMergeHandoff('次に kim がすること: PR #1024 をマージする', [query]).decision, 'block');
});

test('DM でのマージ依頼も block', () => {
  const dm = { type: 'tool_use', name: 'mcp__claude_ai_Discord__send_dm', input: { user_id: '1', content: 'PR #1024 のマージをお願いします。' } };
  assert.equal(evaluateMergeHandoff('依頼を送りました。', [dm]).decision, 'block');
});

test('fleet-mail でのマージ依頼も block', () => {
  const fm = bash('node tools/fleet-mail.mjs --send --to kim-PC --kind note --body-file x.md --why "PR #1024 マージ依頼をお願いします"');
  assert.equal(evaluateMergeHandoff('送りました。', [fm]).decision, 'block');
});

const passed = [
  ['照会と試行の記録あり', '次に kim がすること: PR #1024 をマージする（gh pr merge は push:false で失敗）', [query, tryMerge]],
  ['automerge ラベル付与も試行', '次に kim がすること: PR #1024 をマージする', [query, bash('gh pr edit 1024 --add-label automerge')]],
  ['既にマージ済みの報告', 'PR #1024 は既にマージ済みです。', []],
  ['自動マージ待ちは依頼ではない', 'この後の自動進行: PR #1024 は automerge ラベルで自動マージされる', []],
  ['依頼語なし', 'PR #1024 をマージしました。', []],
  ['例外理由', '次に kim がすること: PR #9 をマージする [MERGE-HANDOFF-OK: 本番DB移行を伴うので kim の承認が必要]', []],
  ['表の行', '| PR | マージ | お願い |', []],
  ['引用', '> PR #1024 のマージをお願いします。', []],
  ['コードブロック', '```\n次に kim がすること: PR #1 をマージする\n```', []],
  ['PR 以外のマージ', 'シートの結合（マージ）をお願いします。', []],
  ['過去の経緯', '原因：PR #864 のマージは、拒否を確かめたうえで kim さんにお願いしました。', []],
  ['経過の説明', '最後に、kim さんへの PR マージ依頼が届いているかを読み戻します。', []],
];
for (const [name, text, uses] of passed) test(`pass: ${name}`, () => {
  assert.equal(evaluateMergeHandoff(text, uses).decision, 'pass');
});

test('環境変数0で停止', t => {
  const prev = process.env.ORGIAST_MERGE_HANDOFF_GATE;
  t.after(() => { if (prev === undefined) delete process.env.ORGIAST_MERGE_HANDOFF_GATE; else process.env.ORGIAST_MERGE_HANDOFF_GATE = prev; });
  process.env.ORGIAST_MERGE_HANDOFF_GATE = '0';
  assert.equal(evaluateMergeHandoff('次に kim がすること: PR #1 をマージする').decision, 'pass');
});
