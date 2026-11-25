import test from 'node:test';
import assert from 'node:assert/strict';
import { launchDetachedWin } from './fleet-mail.mjs';

test('launchDetachedWin は WMI(Win32_Process.Create) を非表示で呼び、空白パスを引用する', () => {
  const calls = [];
  launchDetachedWin('C:\\Program Files\\nodejs\\node.exe', ['C:\\Users\\a b\\runner.mjs', '--id', 'mail-1'], (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0 }; });
  assert.equal(calls[0].cmd, 'powershell.exe');
  const ps = calls[0].args.at(-1);
  assert.match(ps, /Win32_Process -MethodName Create/);
  assert.match(ps, /ShowWindow=\[uint16\]0/);
  assert.match(ps, /"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a b\\runner.mjs" --id mail-1/);
  assert.equal(calls[0].opts.windowsHide, true);
});
test('launchDetachedWin は WMI の失敗を例外にする', () => {
  assert.throws(() => launchDetachedWin('node', ['x'], () => ({ status: 9 })), /Win32_Process.Create failed/);
});
