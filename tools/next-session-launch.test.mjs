import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  launchNextSession,
  parseHandoffCwd,
  pickNewestExtensionBinary,
  pickNewestVersionDir,
  planLaunch,
  resolveClaudeBinary,
  resolveWt,
  sanitizeEnv,
  shouldLaunch,
} from './next-session-launch.mjs';

test('引き継ぎコメントから Windows cwd を取り出す', () => {
  const text = '<!-- 前セッション: abc / 更新: 2026-08-28 / cwd: c:\\Users\\uers\\Downloads\\作業 -->\n本文';
  assert.equal(parseHandoffCwd(text), 'c:\\Users\\uers\\Downloads\\作業');
  assert.equal(parseHandoffCwd('コメントなし'), '');
});

test('VSCode 拡張バージョンを辞書順ではなく数値で比較する', () => {
  const names = ['anthropic.claude-code-2.1.99-win32-x64', 'anthropic.claude-code-2.1.250-win32-x64', 'foo'];
  assert.equal(pickNewestExtensionBinary(names), 'anthropic.claude-code-2.1.250-win32-x64');
});

test('インストール版 claude-code のバージョンディレクトリから最新を選ぶ', () => {
  assert.equal(pickNewestVersionDir(['2.1.99', '2.1.246', 'latest']), '2.1.246');
  assert.equal(pickNewestVersionDir(['latest']), '');
  const home = '/home/test';
  const expected = path.join(home, 'AppData', 'Roaming', 'Claude', 'claude-code', '2.1.246', 'claude.exe');
  assert.equal(resolveClaudeBinary({
    env: {},
    exists: (file) => file === expected,
    readdir: (dir) => (dir.includes('claude-code') ? ['2.1.99', '2.1.246'] : []),
    homedir: home,
  }), expected);
});

test('CLAUDE_CLI_PATH を最優先し、無ければ VSCode 拡張へ落ちる', () => {
  const home = '/home/test';
  const explicit = '/custom/claude.exe';
  assert.equal(resolveClaudeBinary({ env: { CLAUDE_CLI_PATH: explicit }, exists: (file) => file === explicit, readdir: () => [], homedir: home }), explicit);

  const newest = 'anthropic.claude-code-2.1.250-win32-x64';
  const expected = path.join(home, '.vscode', 'extensions', newest, 'resources', 'native-binary', 'claude.exe');
  assert.equal(resolveClaudeBinary({
    env: {},
    exists: (file) => file === expected,
    readdir: () => ['anthropic.claude-code-2.1.99-win32-x64', newest],
    homedir: () => home,
  }), expected);
});

test('Windows Terminal と cmd.exe の起動 argv を組み立てる', () => {
  assert.deepEqual(planLaunch({ claudeBin: 'claude.exe', cwd: 'C:\\work', prompt: '/session-start', wt: 'wt.exe' }), {
    command: 'wt.exe', args: ['-w', 'new-window', '-d', 'C:\\work', 'claude.exe', '/session-start'], cwd: 'C:\\work', detached: true,
  });
  assert.deepEqual(planLaunch({ claudeBin: 'claude.exe', cwd: 'C:\\work', prompt: 'go', wt: '' }), {
    command: 'cmd.exe', args: ['/c', 'start', '', '/D', 'C:\\work', 'claude.exe', 'go'], cwd: 'C:\\work', detached: true,
  });
  assert.equal(planLaunch({ claudeBin: '', cwd: 'C:\\work', prompt: 'go', wt: '' }), null);
});

test('起動抑止と force の安全境界を判定する', () => {
  const now = Date.parse('2026-08-28T00:02:00.000Z');
  assert.equal(shouldLaunch({ state: { enabled: false }, now, env: {}, force: false }).ok, false);
  assert.equal(shouldLaunch({ state: {}, now, env: { ORGIAST_NO_AUTO_NEXT_SESSION: '1' }, force: false }).ok, false);
  assert.equal(shouldLaunch({ state: {}, now, env: { CLAUDE_HEADLESS: '1' }, force: false }).ok, false);
  assert.equal(shouldLaunch({ state: { lastLaunchAt: '2026-08-28T00:01:00.001Z' }, now, env: {}, force: false }).ok, false);
  assert.deepEqual(shouldLaunch({ state: { lastLaunchAt: '2026-08-28T00:01:00.001Z' }, now, env: {}, force: true }), { ok: true });
  assert.equal(shouldLaunch({ state: {}, now, env: { CI: '1' }, force: true }).ok, false);
});

function fakeIo(overrides = {}) {
  const home = '/fake/home';
  const claude = '/fake/claude.exe';
  const calls = { spawn: [], writes: [], renames: [], logs: [], unref: 0 };
  return {
    calls,
    io: {
      env: { CLAUDE_CLI_PATH: claude },
      homedir: () => home,
      exists: (file) => file === claude,
      readdir: () => [],
      readFile: async (file) => {
        if (file.endsWith('next-session.md')) return '<!-- 前セッション: abc / 更新: 2026-08-28 / cwd: C:\\work -->';
        throw new Error('ENOENT');
      },
      writeFile: async (...args) => calls.writes.push(args),
      rename: async (...args) => calls.renames.push(args),
      spawn: (...args) => {
        calls.spawn.push(args);
        return { unref: () => { calls.unref += 1; } };
      },
      log: (message) => calls.logs.push(message),
      ...overrides,
    },
  };
}

test('起動成功時に detached spawn し state を tmp から原子的に更新する', async () => {
  const { io, calls } = fakeIo();
  assert.equal(await launchNextSession([], io), 0);
  assert.equal(calls.spawn.length, 1);
  const options = calls.spawn[0][2];
  assert.equal(options.cwd, 'C:\\work');
  assert.equal(options.detached, true);
  assert.equal(options.stdio, 'ignore');
  assert.equal(options.windowsHide, false);
  // 親セッションの CLAUDE* を継承させない(継承すると新セッションが今のセッションの子になる)。
  assert.deepEqual(options.env, { CLAUDE_CLI_PATH: '/fake/claude.exe' });
  assert.equal(calls.unref, 1);
  assert.match(calls.writes[0][0], /next-session-launch\.json\.tmp-/);
  assert.match(calls.writes[0][1], /"lastLaunchAt"/);
  assert.match(calls.writes[0][1], /"lastCwd": "C:\\\\work"/);
  assert.match(calls.renames[0][1], /next-session-launch\.json$/);
});

test('dry-run は plan だけを出して spawn しない', async () => {
  const { io, calls } = fakeIo();
  assert.equal(await launchNextSession(['--dry-run'], io), 0);
  assert.equal(calls.spawn.length, 0);
  assert.equal(calls.writes.length, 0);
  assert.equal(JSON.parse(calls.logs[0]).cwd, 'C:\\work');
});

test('抑止時は spawn せず常に exit 0', async () => {
  const { io, calls } = fakeIo({ env: { CLAUDE_CLI_PATH: '/fake/claude.exe', CI: '1' } });
  assert.equal(await launchNextSession([], io), 0);
  assert.equal(calls.spawn.length, 0);
  assert.match(calls.logs[0], /スキップ/);
});

test('wt.exe は existsSync ではなく readdir で見つける', () => {
  const home = '/home/test';
  const dir = path.join(home, 'AppData', 'Local', 'Microsoft', 'WindowsApps');
  // WindowsApps の実行エイリアスは statSync が EACCES なので exists では絶対に見つからない。
  assert.equal(resolveWt({ env: {}, readdir: () => ['wt.exe', 'python.exe'], homedir: home }), path.join(dir, 'wt.exe'));
  assert.equal(resolveWt({ env: {}, readdir: () => ['python.exe'], homedir: home }), '');
  assert.equal(resolveWt({ env: {}, readdir: () => { throw new Error('EACCES'); }, homedir: home }), '');
  assert.equal(resolveWt({ env: { WT_PATH: '/x/wt.exe' }, readdir: () => [], homedir: home }), '/x/wt.exe');
  // --wt '' を明示したら wt を使わない(conhost に落とす)指定として尊重する。
  assert.equal(resolveWt({ env: { WT_PATH: '/x/wt.exe' }, readdir: () => [], homedir: home, flagWt: '' }), '');
});

test('親セッションの CLAUDE* 環境変数を新セッションへ渡さない', () => {
  const clean = sanitizeEnv({
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'keep',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'abc',
    CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\x',
    CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
    CLAUDE_PID: '1234',
    CLAUDE_EFFORT: 'high',
    CLAUDE_CLI_PATH: '/keep/claude.exe',
    CLAUDE_CONFIG_DIR: '/keep/config',
  });
  assert.deepEqual(clean, {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'keep',
    CLAUDE_CLI_PATH: '/keep/claude.exe',
    CLAUDE_CONFIG_DIR: '/keep/config',
  });
});
