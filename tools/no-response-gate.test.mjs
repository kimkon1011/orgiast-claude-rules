import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateNoResponse } from './no-response-gate.mjs';
import { run } from './stop-gate-runner.mjs';

const user = content => ({ type: 'user', message: { content } });
const assistant = (content, stop_reason) => ({ type: 'assistant', message: { content, stop_reason } });
const toolResult = content => user([{ type: 'tool_result', content }]);
const noResponse = assistant('No response requested.', 'end_turn');
const interrupted = toolResult('Tool call interrupted: the session ended.');
const evaluate = (entries, options = {}) => evaluateNoResponse({
  transcriptRaw: entries.map(entry => JSON.stringify(entry)).join('\n'),
  ...options,
});

test('短い入力と大きな注入が同居しても block', () => {
  const input = 'B\n<system-reminder>' + '返事待ち一覧'.repeat(1000);
  const result = evaluate([user(input), noResponse]);
  assert.deepEqual(result, {
    decision: 'block',
    code: 'NO-RESPONSE',
    reason: '[NO-RESPONSE] kim の入力（B）に答えていません。依頼として扱い、作業を進めて応答してください',
  });
});

test('最新の assistant 応答が空なら、過去に応答があっても block', () => {
  assert.equal(evaluate([user('旧依頼'), assistant('旧回答'), user('進捗どう？'), assistant([])]).decision, 'block');
});

test('中断・拒否の tool_result 直後は通過', () => {
  assert.equal(evaluate([interrupted, noResponse]).decision, 'pass');
  assert.equal(evaluate([user('すすめて'), toolResult("The user doesn't want to take this action"), noResponse]).decision, 'pass');
});

test('中断後、同じターンに kim の入力があれば block', () => {
  const toolCall = assistant([{ type: 'tool_use', id: 'call' }], 'tool_use');
  assert.equal(evaluate([user('すすめて'), toolCall, interrupted, noResponse]).decision, 'block');
  assert.equal(evaluate([user('済んだ依頼'), assistant('完了しました', 'end_turn'), toolCall, interrupted, noResponse]).decision, 'pass');
});

test('task-notification 直後は通過', () => {
  assert.equal(evaluate([user('すすめて'), user('通知\n<task-notification>完了'), noResponse]).decision, 'pass');
});

test('別ゲートの Stop hook feedback 直後は block', () => {
  const feedback = { ...user('Stop hook feedback: next-action-gate'), isMeta: true };
  assert.equal(evaluate([feedback, noResponse], { stopHookActive: true }).decision, 'block');
});

test('同じターンの no-response-gate の再試行だけ通過', () => {
  const first = [user('すすめて'), noResponse];
  const feedback = user('Stop hook feedback:\n' + evaluate(first).reason);
  assert.equal(evaluate([...first, feedback, noResponse], { stopHookActive: true }).decision, 'pass');
  assert.equal(evaluate([...first, feedback, noResponse, user('次の依頼'), noResponse], { stopHookActive: true }).decision, 'block');
});

test('最新の通常応答と transcript 欠落は通過', () => {
  assert.equal(evaluate([user('旧依頼'), noResponse, user('次の依頼'), assistant('完了しました')]).decision, 'pass');
  assert.equal(evaluate([], { lastAssistantMessage: '' }).decision, 'pass');
});

test('assistant エントリ書き込み前は Stop イベントの応答を使用', () => {
  assert.equal(evaluate([user('進捗どう？')], { lastAssistantMessage: '' }).decision, 'block');
  assert.equal(evaluate([user('進捗どう？')], { lastAssistantMessage: '確認しました' }).decision, 'pass');
});

test('Stop runner は空応答を差し戻し、同じ理由での再試行を通す', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'no-response-stop-'));
  const oldHome = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = home;
  t.after(() => {
    if (oldHome === undefined) delete process.env.ORGIAST_HOME;
    else process.env.ORGIAST_HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const transcript = [user('進捗どう？'), assistant([])];
  const context = { assistantText: '', raw: transcript.map(entry => JSON.stringify(entry)).join('\n') };
  const options = { policyOptions: { home, hostname: 'kim-PC', notify: async () => ({ delivered: 'test' }) } };
  const input = { session_id: 'no-response-stop', last_assistant_message: '' };
  const first = await run(input, context, options);
  assert.equal(first.decision, 'block');
  assert.deepEqual(first.record.blockedBy, ['no-response-gate']);

  transcript.push(user('Stop hook feedback:\n' + first.reason), assistant([]));
  context.raw = transcript.map(entry => JSON.stringify(entry)).join('\n');
  const retry = await run({ ...input, stop_hook_active: true }, context, options);
  assert.equal(retry.decision, undefined);
});
