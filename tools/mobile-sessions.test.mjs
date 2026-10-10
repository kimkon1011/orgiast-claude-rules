import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMobileSessionsUri, parseMobileArgs, planMobileSessionsLaunch } from './mobile-sessions.mjs';

test('mobile-sessions の引数は既定値と明示値を解釈する', () => {
  assert.deepEqual(parseMobileArgs([]), { count: 1, name: 'スマホ用セッション' });
  assert.deepEqual(parseMobileArgs(['--count', '7', '--name', '携帯']), { count: 7, name: '携帯' });
  assert.throws(() => parseMobileArgs(['--count', '11']), /1\.\.10/);
  assert.throws(() => parseMobileArgs(['--unknown']), /不明な引数/);
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from './mobile-sessions.mjs';
test('dry-run reports actual snapshot and never resolves CLI or spawns', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-dry-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'mobile-sessions-state.json'), JSON.stringify({ waiting: 1, updatedAt: Date.now() }));
  const output = [];
  assert.equal(await main(['--dry-run', '--count', '2'], { env: {}, homedir: home, log: (s) => output.push(s), exists() { assert.fail('CLI lookup'); }, spawn() { assert.fail('spawn'); } }), 0);
  assert.match(output[0], /現在の待機数: 1 \/ 目標: 2 \/ 起動する本数: 1/);
});
test('--refresh は URI に refresh=1 を付け、--count と併用できる。dry-run は最終リフレッシュを表示', async (t) => {
  assert.deepEqual(parseMobileArgs(['--refresh', '--count', '2']), { count: 2, name: 'スマホ用セッション', refresh: true });
  assert.equal(buildMobileSessionsUri({ count: 2, name: 'a', refresh: true }), 'vscode://orgiast.next-session/mobile?count=2&name=a&refresh=1');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-refresh-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const output = [];
  await main(['--dry-run'], { env: {}, homedir: home, log: (s) => output.push(s) });
  assert.match(output[1], /最終リフレッシュ: なし/);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'mobile-sessions-state.json'), JSON.stringify({ waiting: 1, updatedAt: Date.now(), lastRefreshAt: Date.UTC(2026, 9, 10, 1, 2, 3) }));
  const output2 = [];
  await main(['--dry-run'], { env: {}, homedir: home, log: (s) => output2.push(s) });
  assert.match(output2[1], /最終リフレッシュ: 2026-10-10T01:02:03/);
});
test('unknown snapshot is not reported as zero', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-unknown-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const output = [];
  assert.equal(await main(['--dry-run'], { env: { CI: '1' }, homedir: home, log: (s) => output.push(s) }), 0);
  assert.match(output[0], /現在の待機数: 不明/);
});
