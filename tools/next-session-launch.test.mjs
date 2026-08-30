import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  buildVscodeUri,
  launchNextSession,
  parseHandoffCwd,
  pickNewestExtensionBinary,
  pickNewestVersionDir,
  planLaunch,
  planVscodeLaunch,
  pickRoute,
  resolveClaudeBinary,
  resolveVscodeCli,
  resolveWt,
  sanitizeEnv,
  shouldLaunch,
} from './next-session-launch.mjs';

test('VSCode CLI は明示パス、ユーザーインストール、未検出の順で解決する', () => {
  const home = 'C:\\Users\\test';
  const explicit = 'D:\\VSCode\\bin\\code.cmd';
  assert.equal(resolveVscodeCli({ env: { VSCODE_CLI_PATH: explicit }, exists: (file) => file === explicit, homedir: home }), explicit);
  const local = path.join(home, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd');
  assert.equal(resolveVscodeCli({ env: {}, exists: (file) => file === local, homedir: () => home }), local);
  assert.equal(resolveVscodeCli({ env: {}, exists: () => false, homedir: home }), '');
});

test('Claude Code の open URI にプロンプトを URL エンコードする', () => {
  assert.equal(buildVscodeUri('/session-start'), 'vscode://Anthropic.claude-code/open?prompt=%2Fsession-start');
  assert.equal(buildVscodeUri('日本語 開始'), `vscode://Anthropic.claude-code/open?prompt=${encodeURIComponent('日本語 開始')}`);
  assert.equal(buildVscodeUri(''), 'vscode://Anthropic.claude-code/open');
});

test('VSCode 起動は code.cmd を cmd.exe /c 経由で実行する', () => {
  // .cmd は Windows の node から execFile できないので必ず cmd.exe /c を挟む。
  assert.deepEqual(planVscodeLaunch({ codeCli: 'C:\\Code\\bin\\code.cmd', cwd: 'C:\\work', prompt: '/session-start' }), [
    { label: 'open-session', command: 'cmd.exe', args: ['/c', 'C:\\Code\\bin\\code.cmd', '--open-url', 'vscode://Anthropic.claude-code/open?prompt=%2Fsession-start'] },
  ]);
  assert.deepEqual(planVscodeLaunch({ codeCli: 'C:\\Code\\bin\\code.cmd', cwd: 'C:\\work', prompt: '/session-start', openFolder: true })[0], {
    label: 'open-folder', command: 'cmd.exe', args: ['/c', 'C:\\Code\\bin\\code.cmd', '-n', 'C:\\work'],
  });
  assert.equal(planVscodeLaunch({ codeCli: '', cwd: 'C:\\work', prompt: '' }), null);
  assert.equal(planVscodeLaunch({ codeCli: 'C:\\Code\\bin\\code.cmd', cwd: '', prompt: '', openFolder: true }), null);
});

test('既定はターミナル経路で、VSCode は明示したときだけ選ぶ', () => {
  // VSCode の URI は新タブを開くだけでプロンプトを送信しないので、既定にすると手数ゼロにならない。
  assert.equal(pickRoute({ codeCli: 'code.cmd', flagTarget: undefined, env: {} }), 'terminal');
  assert.equal(pickRoute({ codeCli: '', flagTarget: undefined, env: {} }), 'terminal');
  assert.equal(pickRoute({ codeCli: 'code.cmd', flagTarget: 'terminal', env: {} }), 'terminal');
  assert.equal(pickRoute({ codeCli: 'code.cmd', flagTarget: 'vscode', env: {} }), 'vscode');
  assert.equal(pickRoute({ codeCli: 'code.cmd', flagTarget: undefined, env: { ORGIAST_NEXT_SESSION_TARGET: 'vscode' } }), 'vscode');
});

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

test('VSCode 経路は既定で URI だけを撃ち、既存ウィンドウを再読み込みしない', async () => {
  const codeCli = 'C:\\Code\\bin\\code.cmd';
  const waited = [];
  const { io, calls } = fakeIo({
    env: { VSCODE_CLI_PATH: codeCli },
    exists: (file) => file === codeCli,
    wait: async (ms) => waited.push(ms),
  });
  assert.equal(await launchNextSession(['--target', 'vscode'], io), 0);
  // `code.cmd <cwd>` を先に走らせると既存ウィンドウの拡張ホストが再起動し、URI ごと落ちる(2026-08-30 実測)。
  assert.equal(calls.spawn.length, 1);
  assert.equal(calls.spawn[0][1][2], '--open-url');
  assert.match(calls.spawn[0][1][3], /prompt=%2Fsession-start$/);
  assert.equal(calls.spawn[0][2].detached, false);
  assert.equal(calls.spawn[0][2].windowsHide, true);
  assert.deepEqual(waited, []);
  assert.match(calls.writes[0][1], /"lastRoute": "vscode"/);
});

test('--open-folder のときだけ新規ウィンドウ(-n)を先に開く', async () => {
  const codeCli = 'C:\\Code\\bin\\code.cmd';
  const waited = [];
  const { io, calls } = fakeIo({
    env: { VSCODE_CLI_PATH: codeCli },
    exists: (file) => file === codeCli,
    wait: async (ms) => waited.push(ms),
  });
  assert.equal(await launchNextSession(['--target', 'vscode', '--open-folder'], io), 0);
  assert.equal(calls.spawn.length, 2);
  // -n が無いと既存ウィンドウを再読み込みしてしまう。
  assert.deepEqual(calls.spawn[0][1], ['/c', codeCli, '-n', 'C:\\work']);
  assert.equal(calls.spawn[1][1][2], '--open-url');
  assert.deepEqual(waited, [2500]);
});

test('VSCode dry-run は route と手順だけを出して spawn しない', async () => {
  const codeCli = 'C:\\Code\\bin\\code.cmd';
  const { io, calls } = fakeIo({ env: { VSCODE_CLI_PATH: codeCli }, exists: (file) => file === codeCli });
  assert.equal(await launchNextSession(['--target', 'vscode', '--dry-run'], io), 0);
  assert.equal(calls.spawn.length, 0);
  const output = JSON.parse(calls.logs[0]);
  assert.equal(output.route, 'vscode');
  assert.equal(output.steps.length, 1);
  assert.equal(output.steps[0].label, 'open-session');
});

test('CLAUDE_HEADLESS は VSCode 経路も抑止する', async () => {
  const codeCli = 'C:\\Code\\bin\\code.cmd';
  const { io, calls } = fakeIo({ env: { VSCODE_CLI_PATH: codeCli, CLAUDE_HEADLESS: '1' }, exists: (file) => file === codeCli });
  assert.equal(await launchNextSession(['--target', 'vscode'], io), 0);
  assert.equal(calls.spawn.length, 0);
  assert.match(calls.logs[0], /スキップ/);
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
