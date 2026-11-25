import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTaskActions, inspectTaskHiddenActions } from './setup-task-hidden-actions.mjs';
test('classifies active direct actions, excludes disabled and wscript actions', () => {
  assert.deepEqual(classifyTaskActions([
    { TaskName: 'OrgiastHidden', State: 'Ready', Actions: [{ Execute: 'C:\\Windows\\System32\\WSCRIPT.EXE' }] },
    { TaskName: 'OrgiastDisabled', State: 'Disabled', Actions: [{ Execute: 'cmd.exe' }] },
    ...['powershell.exe', 'pwsh.exe', 'cmd.exe', 'node.exe'].map(Execute => ({ TaskName: Execute, State: 'Running', Actions: [{ Execute: 'wscript.exe' }, { Execute }] })),
  ]), ['powershell.exe', 'pwsh.exe', 'cmd.exe', 'node.exe']);
  assert.deepEqual(classifyTaskActions([]), []);
});
test('inspection reports OK/NG/NOTICE with hidden encoded PowerShell', () => {
  const inspect = raw => inspectTaskHiddenActions({ platform: 'win32', run(file, args, opts) {
    assert.equal(file, 'powershell.exe'); assert.ok(args.includes('-EncodedCommand')); assert.equal(opts.windowsHide, true);
    return raw;
  } });
  assert.equal(inspect('[]').status, 'OK');
  assert.match(inspect('[{"TaskName":"OrgiastTest","State":"Ready","Actions":[{"Execute":"node.exe"}]}]').description, /窓が出る起動: OrgiastTest/);
  assert.equal(inspect('invalid').status, 'NOTICE');
  assert.equal(inspectTaskHiddenActions({ platform: 'win32', run() { throw Error(); } }).status, 'NOTICE');
});
test('all active console tasks including Claude, paths and exact exclusions', () => {
  const task = (TaskName, Execute, extra = {}) => ({ TaskName, TaskPath: '\\', State: 'Ready', Actions: [{ Execute }], ...extra });
  assert.deepEqual(classifyTaskActions([
    task('ClaudeGuard', 'powershell.exe'), task('Other', 'C:\\tools\\run.cmd'), task('Gui', 'notepad.exe'),
    task('Excluded', 'node.exe'), task('PathExcluded', 'bash.exe', { TaskPath: '\\Custom\\' }),
    task('System', 'cmd.exe', { TaskPath: '\\Microsoft\\Windows\\' }),
    task('Off', 'python.exe', { State: 1 }),
    task('Wrapped', 'cmd.exe', { Actions: [{ Execute: 'cmd.exe', Arguments: '//nologo "C:\\run-hidden.vbs" "node.exe"' }] }),
  ], { exclude: ['excluded # GUI', '\\custom\\pathexcluded', '# comment'] }), ['ClaudeGuard', 'Other']);
});

test('converge applies telemetry, repairs once and re-inspects with exclusions', () => {
  const calls = [];
  const pending = { tasks: [{ TaskName: 'ClaudeDirect', State: 'Ready', Actions: [{ Execute: 'node.exe' }] }], exclude: [] };
  const outputs = ['changed', JSON.stringify(pending), 'done wrapped=1 skipped=0', '{"tasks":[],"exclude":[]}'];
  const outcome = inspectTaskHiddenActions({ platform: 'win32', converge: true, run(file, args, options) {
    calls.push(args); assert.equal(options.windowsHide, true); return outputs.shift();
  } });
  assert.equal(outcome.status, 'OK'); assert.equal(outcome.repaired, true);
  assert.match(outcome.description, /GH_TELEMETRY=0 設定/);
  const telemetry = Buffer.from(calls[0].at(-1), 'base64').toString('utf16le');
  assert.match(telemetry, /GetEnvironmentVariable\('GH_TELEMETRY', 'User'\)/);
  assert.match(telemetry, /-eq '0'.*exit/);
  assert.match(telemetry, /SetEnvironmentVariable\('GH_TELEMETRY', '0', 'User'\)/);
  assert.match(telemetry, /SendMessageTimeout/);
  assert.match(calls[2].at(-1), /task-hide-guard\.ps1$/);
  assert.equal(outputs.length, 0);
});

test('already converged is unchanged; access denied remains NG after repair', () => {
  for (const blocked of [false, true]) {
    const raw = JSON.stringify({ tasks: blocked ? [{ TaskName: 'Admin', Actions: [{ Execute: 'cmd.exe' }] }] : [], exclude: [] });
    let calls = 0;
    const result = inspectTaskHiddenActions({ platform: 'win32', converge: true, run(file, args) {
      calls++; return calls === 1 ? 'unchanged' : args.includes('-File') ? 'SKIP Admin' : raw;
    } });
    assert.equal(result.status, blocked ? 'NG' : 'OK');
    assert.equal(result.repaired, false); assert.match(result.description, /変更なし/);
    assert.equal(calls, blocked ? 4 : 2);
  }
});

test('inspection respects file exclusions and reports repair failure', () => {
  const raw = JSON.stringify({ tasks: [{ TaskName: 'GUI', Actions: [{ Execute: 'cmd.exe' }] }], exclude: ['GUI'] });
  assert.equal(inspectTaskHiddenActions({ platform: 'win32', run: () => raw }).status, 'OK');
  let calls = 0;
  assert.equal(inspectTaskHiddenActions({ platform: 'win32', converge: true, run() {
    if (++calls === 1) return 'unchanged';
    if (calls === 2) return raw.replace('["GUI"]', '[]');
    throw Error('failed');
  } }).status, 'NOTICE');
});
