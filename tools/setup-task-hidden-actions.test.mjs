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
