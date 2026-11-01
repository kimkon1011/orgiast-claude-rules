import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeNextAction } from './next-action-gate.mjs';
const promise = '次のメッセージで仕上げます。';
const row = (type, content, extra = {}) => JSON.stringify({ type, message: { role: type, content }, ...extra });
const call = (name, input, id) => row('assistant', [{ type: 'tool_use', name, input, id }]);
const result = (id, is_error = false) => row('user', [{ type: 'tool_result', tool_use_id: id, content: is_error ? 'error' : 'registered', is_error }]);
const cron = call('CronCreate', { cron: '*/20 * * * *', prompt: '続きを進め進捗を報告' }, 'cron');
const check = call('Bash', { command: 'node tools/auto-progress.mjs --add-check --session test --check "node check.mjs"' }, 'check');
const evidence = [cron, result('cron'), check, result('check')];
const judge = (text = promise, rows = []) => judgeNextAction(text, rows.join('\n'));
test('短文・質問・headlessでも先送りを素通ししない', () => {
  const before = process.env.CLAUDE_HEADLESS;
  try {
    process.env.CLAUDE_HEADLESS = '1';
    for (const text of [promise, '次ターンで修正します。よいですか？', '次のメッセージで報告します。']) {
      assert.equal(judge(text).code, 'SELF-DEFERRAL-NO-WAKEUP');
    }
  } finally {
    if (before === undefined) delete process.env.CLAUDE_HEADLESS;
    else process.env.CLAUDE_HEADLESS = before;
  }
});
test('両方の同ターン成功が必要（失敗・未結果・前ターン・sidechainを除外）', () => {
  for (const rows of [[cron, result('cron')], [check, result('check')], [cron, check],
    [cron, result('cron', true), check, result('check')],
    [...evidence, row('user', '続けて')],
    evidence.map(line => JSON.stringify({ ...JSON.parse(line), isSidechain: true }))]) {
    assert.equal(judge(promise, rows).code, 'SELF-DEFERRAL-NO-WAKEUP');
  }
  // The existing footer checks still apply once registration evidence is present.
  assert.equal(judge(promise, evidence).code, 'NEXT-ACTION-FOOTER');
});
test('引用・コード例・完了報告・userの次の操作は対象外', () => {
  for (const text of ['「次のメッセージで仕上げます」と書くのを防ぎます。', '> 次のメッセージで仕上げます。',
    '```text\n次のメッセージで仕上げます。\n```', '仕上げました。', '次のメッセージで希望を教えてください。']) {
    assert.notEqual(judge(text).code, 'SELF-DEFERRAL-NO-WAKEUP');
  }
});
test('echoやdry-runの言及は登録証拠にしない', () => {
  for (const command of ['echo node tools/auto-progress.mjs --add-check', 'node tools/auto-progress.mjs --add-check --dry-run']) {
    assert.equal(judge(promise, [cron, result('cron'), call('Bash', { command }, 'check'), result('check')]).code, 'SELF-DEFERRAL-NO-WAKEUP');
  }
});
test('同ターンの両登録が成功し有効フッターがあれば通す', () => {
  const text = `${promise}\n次に kim がすること: なし\nこの後の自動進行: 登録した定期チェックで続きを進めて報告します\nこのセッション: まだ閉じない（作業中・2099-12-31 23:59 まで待つ）`;
  assert.equal(judge(text, evidence).decision, 'pass');
});
