import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge } from './staff-ask-selfcheck-gate.mjs';

const body = '求人4件（Airワーク・engage・ジモティー・求人ボックス）に応募やメッセージは来ていますか？ 求人ボックスの審査は通りましたか？';
const input = { content: body };
const tool = 'mcp__claude_ai_Discord__send_message';

test('無関係な Gmail 検索だけでは社員への求人状況質問を通さない', () => {
  const evidence = { names: new Set(['mcp__claude_ai_Gmail__search_threads']), inputs: '{"query":"from:kohno@kuroda-dc.jp newer_than:2d"}' };
  const result = judge(tool, input, evidence);
  assert.ok(result);
  assert.ok(result.sources.some(source => source.key === '求人応募'));
});

test('saiyo 宛て応募メールを関連検索済みなら通す', () => {
  const evidence = { names: new Set(['mcp__claude_ai_Gmail__search_threads']), inputs: '{"query":"to:saiyo@orgiast.jp newer_than:4d 応募"}' };
  assert.equal(judge(tool, input, evidence), null);
});

test('電話した結果の報告依頼は人にしか分からないため通す', () => {
  assert.equal(judge(tool, { content: '電話した人ごとに「つながった／不在」「受けられる／無理」を書いてください' }, { names: new Set(), inputs: '' }), null);
});

test('質問のない実行指示だけなら通す', () => {
  assert.equal(judge(tool, { content: '今すぐ SMS を送ってください' }, { names: new Set(), inputs: '' }), null);
});
