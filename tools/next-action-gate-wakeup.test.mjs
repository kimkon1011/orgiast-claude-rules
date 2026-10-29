import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeNextAction } from './next-action-gate.mjs';

delete process.env.CLAUDE_HEADLESS;
const now = Date.parse('2026-10-29T07:30:00Z');
const report = '作業を継続します。\n次に kim がすること: なし\nこの後の自動進行: 私が処理の結果を報告します\nこのセッション: まだ閉じない（作業中・2099-12-31 23:59 まで待つ）';
const row = (type, content, extra = {}) => JSON.stringify({ type, message: { role: type, content }, ...extra });
const call = (name, input, id = 'call') => row('assistant', [{ type: 'tool_use', name, input, id }], { timestamp: new Date(now).toISOString() });
const result = (data, extra = {}) => row('user', [{ type: 'tool_result', tool_use_id: 'call', content: 'started', ...extra }], { toolUseResult: data });
const next = row('user', '続けて');
const notification = (status, id = 'task-1') => row('user', `<task-notification><task-id>${id}</task-id><status>${status}</status></task-notification>`);
const judge = (...rows) => judgeNextAction(report, rows.join('\n'), { now });
const blocked = (...rows) => assert.equal(judge(...rows).code, 'AUTOPILOT-NO-SESSION-WAKEUP');

test('前ターンの将来起床を通常ターン・通知ターンでも認識する', () => {
  for (const turn of [next, notification('completed', 'other')]) {
    assert.equal(judge(call('ScheduleWakeup', { delaySeconds: 600 }), result({ scheduledFor: now + 600000 }), turn).decision, 'pass');
  }
});
test('未登録・期限切れ・最新呼出しが停止・失敗・不明なら差し戻す', () => {
  blocked(next);
  blocked(call('ScheduleWakeup', { delaySeconds: 0 }), next);
  blocked(call('ScheduleWakeup', { delaySeconds: 600 }), call('ScheduleWakeup', { stop: true }, 'stop'), next);
  blocked(call('ScheduleWakeup', { delaySeconds: 600 }), result({}, { is_error: true }), next);
  blocked(call('ScheduleWakeup', { delaySeconds: 600 }), call('ScheduleWakeup', {}, 'new'), next);
  blocked(call('ScheduleWakeup', { stop: true }), result({ scheduledFor: now + 600000 }), next);
});
test('実際のscheduledForはdelaySecondsより優先する', () => {
  blocked(call('ScheduleWakeup', { delaySeconds: 600 }), result({ scheduledFor: now - 1 }), next);
  assert.equal(judge(call('ScheduleWakeup', {}), result({ scheduledFor: now + 1 }), next).decision, 'pass');
});
for (const name of ['Monitor', 'Bash']) test(`${name}: 前ターンのタスクをIDで追跡し、終了後は差し戻す`, () => {
  const start = call(name, { run_in_background: true });
  const started = result({ taskId: 'task-1' });
  assert.equal(judge(start, started, next).decision, 'pass');
  assert.equal(judge(start, started, notification('completed', 'other')).decision, 'pass');
  assert.equal(judge(start, started, notification('running')).decision, 'pass');
  for (const status of ['completed', 'stopped', 'failed']) blocked(start, started, notification(status));
  blocked(start, started, call('TaskStop', { task_id: 'task-1' }, 'stop'), next);
  blocked(start, result({}, { is_error: true }), next);
});
test('sidechainとAPI blobを起床登録に数えない', () => {
  for (const extra of [{ isSidechain: true }, { type: 'api-request-blob' }]) {
    blocked(row('assistant', [{ type: 'tool_use', name: 'Monitor', id: 'fake' }], extra), next);
  }
});
test('複数タスクの片方だけが停止しても残った起床手段は有効', () => {
  const first = call('Bash', { run_in_background: true });
  const second = call('Monitor', {}, 'second');
  const secondResult = row('user', [{ type: 'tool_result', tool_use_id: 'second', content: 'started' }], { toolUseResult: { taskId: 'task-2' } });
  const rows = [first, result({ backgroundTaskId: 'task-1' }), second, secondResult, notification('completed')];
  assert.equal(judge(...rows, next).decision, 'pass');
  blocked(...rows, call('TaskStop', { task_id: 'task-2' }, 'stop'), next);
});
