import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateHandoffRegret } from './handoff-regret-gate.mjs';

const target = '~/.claude/settings.json';
const row = content => JSON.stringify({ message: { content } });
const handoff = row([{ type: 'text', text: `[手渡し判定]\nuser が ${target} を変更してください` }]);
const use = path => row([{ type: 'tool_use', id: 'tool-1', name: 'Edit', input: { file_path: path } }]);
const success = row([{ type: 'tool_result', tool_use_id: 'tool-1', content: 'updated' }]);

test('手渡し後に同じパスの操作成功・再発防止なしは block', () => {
  const result = evaluateHandoffRegret([handoff, use(target), success].join('\n'), '完了しました');
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /\[HANDOFF-REGRET\]/);
});
test('原因・対策・機械化の再発防止ブロックがあれば pass', () => {
  const finalText = '[再発防止]\n原因: 一括拒否から推定した\n対策: 最小操作を試す\n機械化: hook に追加した';
  assert.equal(evaluateHandoffRegret([handoff, use(target), success].join('\n'), finalText).decision, 'pass');
});
test('手渡しのみは pass', () => assert.equal(evaluateHandoffRegret(handoff, '手渡します').decision, 'pass'));
test('別パスの成功は pass', () => assert.equal(evaluateHandoffRegret([handoff, use('~/.claude/other.json'), success].join('\n'), '完了').decision, 'pass'));
test('引用された空白入り絶対パスは完全一致で検出する', () => {
  const spaced = 'C:\\Users\\kim\\My Project\\settings.json';
  const quotedHandoff = row([{ type: 'text', text: `[手渡し判定]\nuser が \`${spaced}\` を変更してください` }]);
  assert.equal(evaluateHandoffRegret([quotedHandoff, use(spaced), success].join('\n'), '完了').decision, 'block');
});
