import test from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { buildMobileSessionsUri, parseMobileArgs, planMobileSessionsLaunch, main } from './mobile-sessions.mjs';

test('mobile-sessions の引数は既定値と明示値を解釈する', () => {
  assert.deepEqual(parseMobileArgs([]), { count: 3, name: 'スマホ用セッション', recreate: false });
  assert.deepEqual(parseMobileArgs(['--count', '7', '--name', '携帯', '--recreate']), { count: 7, name: '携帯', recreate: true });
  assert.throws(() => parseMobileArgs(['--count', '11']), /1\.\.10/);
  assert.throws(() => parseMobileArgs(['--unknown']), /不明な引数/);
});

test('--recreate は mobile URI に recreate=1 を追加する', () => {
  assert.equal(buildMobileSessionsUri({ count: 3, name: 'スマホ用セッション', recreate: true }),
    `vscode://orgiast.next-session/mobile?count=3&name=${encodeURIComponent('スマホ用セッション')}&recreate=1`);
});

test('mobile URI は名前を URL エンコードする', () => {
  assert.equal(buildMobileSessionsUri({ count: 3, name: 'スマホ 用&' }), `vscode://orgiast.next-session/mobile?count=3&name=${encodeURIComponent('スマホ 用&')}`);
});

test('code.cmd は cmd.exe の一枚文字列で URI ごと引用する', () => {
  const uri = buildMobileSessionsUri({ count: 3, name: 'スマホ用セッション' });
  assert.deepEqual(planMobileSessionsLaunch({ codeCli: 'C:\\Code\\bin\\code.cmd', count: 3, name: 'スマホ用セッション' }), {
    command: 'cmd.exe',
    args: ['/c', `""C:\\Code\\bin\\code.cmd" --open-url "${uri}""`],
    windowsVerbatimArguments: true,
  });
});

test('--recreate reaches the actual code.cmd launch arguments', () => {
  const options = parseMobileArgs(['--count', '3', '--recreate']);
  const plan = planMobileSessionsLaunch({ codeCli: 'C:\\Code\\bin\\code.cmd', ...options });
  assert.match(plan.args[1], /&recreate=1/);
});


test('URI dispatch carries recreate and reports code.cmd failures', async () => {
  const calls = [];
  const code = await main(['--recreate'], {
    env: { VSCODE_CLI_PATH: 'C:\\Code\\bin\\code.cmd' }, exists: () => true, log: () => {},
    spawn: (...args) => {
      calls.push(args);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 7));
      return child;
    },
  });
  assert.equal(code, 7);
  assert.match(calls[0][1][1], /&recreate=1/);
});
