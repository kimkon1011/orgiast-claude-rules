import test from 'node:test';
import assert from 'node:assert/strict';
import { accountOf, pickDistro, syncWslCodexAuth } from './lib/codex-wsl-auth-sync.mjs';

const auth = id => JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: id, id_token: 'x', refresh_token: 'y' }, last_refresh: '2026-10-10' });
function fakeWsl({ wslAuth = null, writeStatus = 0, list = 'Ubuntu\r\n' } = {}) {
  const calls = [];
  const spawnImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (args[0] === '-l') return { status: 0, stdout: list };
    if (String(args.at(-1)).startsWith('cat "$HOME')) return { status: 0, stdout: wslAuth ?? '' };
    return { status: writeStatus, stdout: '' };
  };
  return { calls, spawnImpl };
}

test('accountOf / pickDistro', () => {
  assert.equal(accountOf(auth('a1')).accountId, 'a1');
  assert.equal(accountOf('not json'), null);
  assert.equal(pickDistro('docker-desktop\r\nUbuntu\r\n'), 'Ubuntu');
  assert.equal(pickDistro(''), null);
});

test('WSL 側が別アカウントなら Windows 側に揃え、上限の待ちを消す', () => {
  const { calls, spawnImpl } = fakeWsl({ wslAuth: auth('old-acct') });
  let cleared = 0; const logs = [];
  const r = syncWslCodexAuth({ platform: 'win32', homeDir: 'C:/h', spawnImpl, readFile: () => auth('new-acct'), clearCooldown: () => { cleared++; }, log: m => logs.push(m) });
  assert.deepEqual([r.action, r.from, r.to], ['synced', 'old-acct', 'new-acct']);
  assert.equal(cleared, 1);
  const write = calls.find(c => /cat > /.test(String(c.args.at(-1))));
  assert.equal(write.opts.input, auth('new-acct'));
  assert.match(logs[0], /揃えました/);
});

test('WSL 側に無ければ書き込む / 同じなら何もしない', () => {
  assert.equal(syncWslCodexAuth({ platform: 'win32', spawnImpl: fakeWsl().spawnImpl, readFile: () => auth('a') }).action, 'synced');
  const same = fakeWsl({ wslAuth: auth('a') });
  assert.equal(syncWslCodexAuth({ platform: 'win32', spawnImpl: same.spawnImpl, readFile: () => auth('a') }).action, 'same');
  assert.ok(!same.calls.some(c => /cat > /.test(String(c.args.at(-1)))));
});

test('Windows 以外・Windows 側未ログイン・WSL 無しはスキップ', () => {
  assert.equal(syncWslCodexAuth({ platform: 'linux' }).action, 'skip');
  assert.equal(syncWslCodexAuth({ platform: 'win32', readFile: () => { throw new Error('ENOENT'); } }).reason, 'no-windows-auth');
  assert.equal(syncWslCodexAuth({ platform: 'win32', readFile: () => auth('a'), spawnImpl: () => ({ status: 1, stdout: '' }) }).reason, 'no-wsl');
});
