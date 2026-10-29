import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLaneRepair } from './lib/lane-repair-detector.mjs';
import { detectSessions } from './rule-detectors.mjs';
import { faultId } from './lib/lane-repair-state.mjs';
const at = '2026-10-29T00:00:00Z';
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const tool = (id, command) => use(id, 'Bash', { command });
const result = (id, content, is_error = false) => ({ type: 'tool_result', tool_use_id: id, content, is_error });
const prose = text => ({ type: 'text', text });
const edit = use('edit', 'Edit', { file_path: 'src/app.mjs' });
const write = use('write', 'Write', { file_path: 'src/app.mjs' });
const fail = (output = 'HTTP 500 internal error', command = 'node tools/llm-ask.mjs --provider deepseek ping') => [tool('ask', command), result('ask', output)];
const state = { alive: false, reason: 'real_fail_rate', error: 'HTTP 500 (9)' };
const health = JSON.stringify({ lanes: { deepseek: state } });
const log = { ts: at, lane: 'deepseek', tried: 'key and direct API checked', result: 'unfixable', faultId: faultId('deepseek', state) };
const logged = (row = log) => [tool('repair', 'node tools/lane-repair-log.mjs --lane deepseek --tried check --result unfixable'), result('repair', JSON.stringify(row))];
const session = blocks => ({ sessionId: 'fixture', events: blocks.map((block, i) => ({ ts: new Date(Date.parse(at) + 1000 * i).toISOString(), event: { type: block.type === 'tool_result' ? 'user' : 'assistant', message: { role: block.type === 'tool_result' ? 'user' : 'assistant', content: [block] } } })) });
const samples = [
  ['500 then Edit', true, [...fail(), edit]],
  ['401 then Write', true, [...fail('HTTP 401 unauthorized'), write]],
  ['codex spawn failure', true, [...fail('spawn codex ENOENT', 'node tools/codex-do.mjs task'), edit]],
  ['codex nonzero exit', true, [...fail('exit code: 1', 'node tools/codex-do.mjs task'), edit]],
  ['observed health then Edit', true, [use('health', 'Read', { file_path: '/x/lane-health.json' }), result('health', health), edit]],
  ['doctor health then Write', true, [tool('health', 'node tools/lane-doctor.mjs --json'), result('health', health), write]],
  ['fallback call without marker', true, [...fail(), tool('other', 'node tools/llm-ask.mjs --provider groq ping')]],
  ['fallback prose without marker', true, [...fail(), prose('代替のレーンへ回します。')]],
  ['failed logging command', true, [...fail(), tool('repair', 'node tools/lane-repair-log.mjs --lane deepseek'), result('repair', 'failed', true), edit]],
  ['wrong lane record', true, [...fail(), ...logged({ ...log, lane: 'groq' }), edit]],
  ['expired record', true, [...fail(), ...logged({ ...log, ts: '2026-10-28T00:00:00Z' }), edit]],
  ['wrong fault record', true, [use('health', 'Read', { file_path: '/x/lane-health.json' }), result('health', health), ...logged({ ...log, faultId: 'wrong' }), edit]],
  ['healthy call then Edit', false, [tool('ask', 'node tools/llm-ask.mjs --provider deepseek ping'), result('ask', 'OK'), edit]],
  ['quota then Edit', false, [...fail('HTTP 429 usage_limit resets tomorrow'), edit]],
  ['source quoting failure', false, [use('read', 'Read', { file_path: 'test.mjs' }), result('read', 'HTTP 500'), edit]],
  ['test output', false, [tool('test', 'node --test'), result('test', 'ok 1 - HTTP 500 error'), edit]],
  ['repair logged before Edit', false, [...fail(), ...logged(), edit]],
  ['fixed logged before Write', false, [...fail(), ...logged({ ...log, result: 'fixed' }), write]],
  ['repair marker permits alternative', false, [...fail(), prose('[LANE-REPAIR] deepseek: 修復不可 試行: checked key; 代替へ回します。')]],
  ['doctor says healthy', false, [...fail(), tool('health', 'node tools/lane-doctor.mjs --json'), result('health', JSON.stringify({ lanes: { deepseek: { alive: true, reason: 'probe_ok' } } })), edit]],
  ['Bash reading source cannot introduce failure', false, [tool('source', 'cat tools/llm-ask.mjs'), result('source', 'HTTP 500'), edit]],
  ['pretty numbered health', true, [use('health', 'Read', { file_path: '/x/lane-health.json' }), result('health', JSON.stringify({ lanes: { deepseek: state } }, null, 2).split('\n').map((line, i) => `${i + 1}→${line}`).join('\n')), edit]],
  ['repair marker before alternative tool', false, [...fail(), prose('[LANE-REPAIR] deepseek: 修復不可 試行: key checked'), tool('other', 'node tools/llm-ask.mjs --provider groq ping')]],
  ['marker never replaces record for implementation', true, [...fail(), prose('[LANE-REPAIR] deepseek: 修復不可 試行: key checked'), edit]],
  ['no continuation', false, fail()],
  ['log without tried', true, [...fail(), ...logged({ ...log, tried: '' }), edit]],
  ['future repair', true, [...fail(), ...logged({ ...log, ts: '2026-10-30T00:00:00Z' }), edit]],
  ['read-only diagnosis', false, [...fail(), use('read', 'Read', { file_path: 'tools/llm-ask.mjs' })]],
];
let tp = 0, fp = 0, tn = 0, fn = 0;
for (const [name, expected, blocks] of samples) {
  const actual = detectLaneRepair(session(blocks)).observations.length > 0;
  if (expected && actual) tp++; else if (!expected && actual) fp++; else if (!expected && !actual) tn++; else fn++;
  test(name, () => assert.equal(actual, expected));
}
test('measured precision, recall and registry integration', () => {
  const precision = tp / (tp + fp);
  console.log(JSON.stringify({ fixtureCount: samples.length, truePositives: tp, falsePositives: fp, trueNegatives: tn, falseNegatives: fn, precision, recall: tp / (tp + fn) }));
  assert.ok(precision >= .9); assert.equal(fn, 0);
  const registry = { rules: [{ id: 'repair-failed-lane-first' }] };
  // No unrelated detectors fire in this transcript.
  const detected = detectSessions([session([...fail(), edit])], registry, {});
  assert.equal(detected['repair-failed-lane-first'].violation, 1);
});
test('persisted repair ledger grants same fault exemption within six hours', () => {
  assert.equal(detectLaneRepair(session([use('health', 'Read', { file_path: '/x/lane-health.json' }), result('health', health), edit]), [log]).observations.length, 0);
});
