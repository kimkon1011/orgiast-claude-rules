import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionWakeupEvidence } from './session-wakeup-evidence.mjs';

const at = iso => Date.parse(iso);
const created = '2026-11-04T00:00:00.000Z';
const now = at(created);
const use = (tools, timestamp = created) => JSON.stringify({ type: 'assistant', timestamp, message: { role: 'assistant', content: tools } });
const result = (id, content, extra = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] } });

const create = (input = { cron: '7 * * * *', recurring: true }, id = 'cron-call') =>
  use([{ type: 'tool_use', id, name: 'CronCreate', input }]);

test('recurring CronCreate が成功すれば cron:true', () => {
  const raw = `${create()}\n${result('cron-call', 'Scheduled recurring job cron-abc123')}`;
  assert.deepEqual(sessionWakeupEvidence(raw, now), { scheduled: false, background: false, cron: true });
});

test('CronDelete された job は cron に数えない', () => {
  for (const id of ['cron-abc123', 'cron-call']) {
    const raw = [
      create(),
      result('cron-call', 'Scheduled recurring job cron-abc123'),
      use([{ type: 'tool_use', id: 'del', name: 'CronDelete', input: { id } }]),
    ].join('\n');
    assert.equal(sessionWakeupEvidence(raw, now).cron, false, id);
  }
});

test('作成から7日を超えた cron は数えない', () => {
  const raw = `${create()}\n${result('cron-call', 'Scheduled recurring job cron-abc123')}`;
  assert.equal(sessionWakeupEvidence(raw, at('2026-11-10T23:59:00.000Z')).cron, true);
  assert.equal(sessionWakeupEvidence(raw, at('2026-11-11T00:01:00.000Z')).cron, false);
});

test('one-shot（recurring:false）は周期的な確認ではないので数えない', () => {
  for (const input of [{ cron: '7 * * * *', recurring: false }, { at: '2026-11-05T09:00:00Z', recurring: false }]) {
    const raw = `${create(input)}\n${result('cron-call', 'Scheduled one-shot task cron-once')}`;
    assert.equal(sessionWakeupEvidence(raw, now).cron, false, JSON.stringify(input));
  }
});

test('tool_result がエラーなら cron に数えない', () => {
  const raw = `${create()}\n${result('cron-call', 'failed to schedule', { is_error: true })}`;
  assert.equal(sessionWakeupEvidence(raw, now).cron, false);
});

test('tool_result 本文に job id が無ければ tool_use id で追跡する', () => {
  const raw = `${create()}\n${result('cron-call', 'ok')}\n${use([{ type: 'tool_use', id: 'del', name: 'CronDelete', input: { id: 'cron-call' } }])}`;
  assert.equal(sessionWakeupEvidence(raw, now).cron, false);
  assert.equal(sessionWakeupEvidence(`${create()}\n${result('cron-call', 'ok')}`, now).cron, true);
});

test('sidechain の CronCreate は証拠にしない', () => {
  const raw = JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: created, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'cron-call', name: 'CronCreate', input: { cron: '7 * * * *', recurring: true } }] } });
  assert.equal(sessionWakeupEvidence(`${raw}\n${result('cron-call', 'Scheduled recurring job cron-abc123')}`, now).cron, false);
});

test('既存の scheduled / background の判定は変えない', () => {
  const wakeup = JSON.stringify({ type: 'assistant', timestamp: created, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w', name: 'ScheduleWakeup', input: { delaySeconds: 3600 } }] } });
  assert.deepEqual(sessionWakeupEvidence(wakeup, now), { scheduled: true, background: false, cron: false });
  const background = use([{ type: 'tool_use', id: 'b', name: 'Monitor' }]);
  const value = sessionWakeupEvidence(background, now);
  assert.equal(value.background, true);
  assert.equal(value.cron, false);
});
