import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEmptyOutput, cheapFirstFailureReason, buildUsageRow } from '../tools/codex-do.mjs';

test('classifyEmptyOutput: 終了コード 0 かつ stdout 空 → empty_output', () => {
  const reason = classifyEmptyOutput('', '', 0);
  assert.equal(reason, 'empty_output');
});

test('classifyEmptyOutput: stderr に認証失効文言 → auth_expired', () => {
  const reasons = [
    classifyEmptyOutput('', '401 Unauthorized', 1),
    classifyEmptyOutput('', 'Missing bearer or basic authentication', 1),
    classifyEmptyOutput('', 'Please run codex login', 1),
    classifyEmptyOutput('', 'Failed to refresh token', 1),
    classifyEmptyOutput('', 'not logged in', 1),
    classifyEmptyOutput('', 'invalid_api_key', 1),
    classifyEmptyOutput('', 'or basic authentication in header', 1),
  ];
  for (const r of reasons) {
    assert.equal(r, 'auth_expired', `expected auth_expired for: ${r}`);
  }
});

test('classifyEmptyOutput: stderr に usage limit を示す文言 → usage_limit', () => {
  const reasons = [
    classifyEmptyOutput('', "You've hit your usage limit", 1),
    classifyEmptyOutput('', "You\u2019ve hit your usage limit", 1),
    classifyEmptyOutput('', "Usage limit reached", 1),
    classifyEmptyOutput('', "your usage limit. Upgrade to Pro", 1),
    classifyEmptyOutput('', "Upgrade to Pro (https://chatgpt.com", 1),
    classifyEmptyOutput('', "Rate limit reached", 1),
  ];
  for (const r of reasons) {
    assert.equal(r, 'usage_limit', `expected usage_limit for: ${r}`);
  }
});

test('classifyEmptyOutput: WSL 起動失敗を示す文言/終了コード → launch_failed', () => {
  const reasons = [
    classifyEmptyOutput('', 'WSL ディストリが見つかりません', 1),
    classifyEmptyOutput('', 'failed to connect to websocket', 1),
    classifyEmptyOutput('', 'ENOENT', 1),
    classifyEmptyOutput('', 'command not found', 1),
  ];
  for (const r of reasons) {
    assert.equal(r, 'launch_failed', `expected launch_failed for: ${r}`);
  }
});

test('classifyEmptyOutput: ChatGPT アカウント不整合 → auth_expired', () => {
  assert.equal(
    classifyEmptyOutput('', 'is not supported when using codex with a chatgpt account', 1),
    'auth_expired'
  );
});

test('classifyEmptyOutput: 既知パターンに該当しない → empty_output', () => {
  assert.equal(classifyEmptyOutput('', 'generic error', 1), 'empty_output');
  assert.equal(classifyEmptyOutput('', '', 1), 'empty_output');
  assert.equal(classifyEmptyOutput('', 'random stuff', 0), 'empty_output');
});

test('cheapFirstFailureReason: empty_output を分類して返す', () => {
  // hook_blocked は変更しない
  const hookBlocked = cheapFirstFailureReason({
    kind: 'implement',
    result: { output: '', stderr: 'Hook blocked by policy', status: 1 },
    treeChanged: false,
  });
  assert.equal(hookBlocked, 'hook_blocked');

  // 認証失敗は auth_expired に分類される
  const authFailed = cheapFirstFailureReason({
    kind: 'implement',
    result: { output: '', stderr: '401 Unauthorized', status: 1 },
    treeChanged: false,
  });
  assert.equal(authFailed, 'auth_expired');

  // usage limit は usage_limit に分類される
  const usageLimit = cheapFirstFailureReason({
    kind: 'implement',
    result: { output: '', stderr: "You've hit your usage limit. Upgrade to Pro", status: 1 },
    treeChanged: false,
  });
  assert.equal(usageLimit, 'usage_limit');

  // 起動失敗は launch_failed に分類される
  const launchFailed = cheapFirstFailureReason({
    kind: 'implement',
    result: { output: '', stderr: 'ENOENT: command not found', status: 1 },
    treeChanged: false,
  });
  assert.equal(launchFailed, 'launch_failed');

  // 該当なしは empty_output のまま
  const empty = cheapFirstFailureReason({
    kind: 'implement',
    result: { output: '', stderr: '', status: 1 },
    treeChanged: false,
  });
  assert.equal(empty, 'empty_output');
});

test('buildUsageRow: reason に分類結果が反映される', () => {
  const row = buildUsageRow({
    result: { output: '', stderr: '401 Unauthorized', status: 1, outputChars: 0 },
    model: 'cheap-code:deepseek/deepseek-chat',
    seconds: 5,
    provider: 'fallback',
    reason: 'auth_expired',
  });
  assert.equal(row.reason, 'auth_expired');
  assert.equal(row.fastFail, true);
});

console.log('All codex-empty-output-classify tests passed!');
