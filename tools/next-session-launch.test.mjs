import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  accountConfigPath,
  accountLabel,
  applyTrust,
  buildVscodeUri,
  hasUnsentVscodeTab,
  childEnv,
  KEPT_CLAUDE_ENV,
  launchNextSession,
  parseHandoffCwd,
  pickAccountEmail,
  pickNewestExtensionBinary,
  pickNewestVersionDir,
  planLaunch,
  planVscodeLaunch,
  pickRoute,
  resolveClaudeBinary,
  resolveConfigDir,
  resolveVscodeCli,
  resolveWt,
  sanitizeEnv,
  shouldLaunch,
  trustKeyVariants,
} from './next-session-launch.mjs';

test('config dir は state、env、既定の順で解決し state の ~ を展開する', () => {
  const home = 'C:\\Users\\test';
  assert.deepEqual(resolveConfigDir({ state: { configDir: '~/claude-work' }, env: { CLAUDE_CONFIG_DIR: 'D:\\env' }, home }), {
    configDir: path.join(home, 'claude-work'), source: 'state',
  });
  assert.deepEqual(resolveConfigDir({ state: { configDir: '~\\claude-work' }, env: {}, home }), {
    configDir: path.join(home, 'claude-work'), source: 'state',
  });
  assert.deepEqual(resolveConfigDir({ state: { configDir: '~' }, env: {}, home }), { configDir: home, source: 'state' });
  assert.deepEqual(resolveConfigDir({ state: {}, env: { CLAUDE_CONFIG_DIR: 'D:\\env' }, home }), { configDir: 'D:\\env', source: 'env' });
  assert.deepEqual(resolveConfigDir({ state: {}, env: {}, home }), { configDir: path.join(home, '.claude'), source: 'default' });
});

test('アカウント設定パスは既定 config dir だけ home 直下になる', () => {
  const home = path.resolve('/fake/Home');
  assert.equal(accountConfigPath(path.join(home, '.claude'), home), path.join(home, '.claude.json'));
  assert.equal(accountConfigPath(path.join(home, 'work-config'), home), path.join(home, 'work-config', '.claude.json'));
  const variant = path.join(home.toUpperCase(), '.CLAUDE').replaceAll(path.sep, path.sep === '/' ? '\\' : '/');
  if (process.platform === 'win32') assert.equal(accountConfigPath(variant, home), path.join(home, '.claude.json'));
});

test('アカウントメールは有効な非空文字列だけを採用する', () => {
  assert.equal(pickAccountEmail({ oauthAccount: { emailAddress: ' kim@orgiast.jp ' } }), 'kim@orgiast.jp');
  for (const config of [{}, null, [], { oauthAccount: null }, { oauthAccount: { emailAddress: '' } }]) {
    assert.equal(pickAccountEmail(config), '');
  }
});

test('child env は state の config dir だけ上書きし、他の CLAUDE 変数を落とす', () => {
  const env = { PATH: '/bin', CLAUDE_CONFIG_DIR: '/env', CLAUDE_CODE_SESSION_ID: 'secret' };
  assert.deepEqual(childEnv({ env, configDir: '/state', source: 'state' }), { PATH: '/bin', CLAUDE_CONFIG_DIR: '/state' });
  assert.deepEqual(childEnv({ env, configDir: '/env', source: 'env' }), { PATH: '/bin', CLAUDE_CONFIG_DIR: '/env' });
  assert.deepEqual(childEnv({ env: { PATH: '/bin', CLAUDE_CODE_SESSION_ID: 'secret' }, configDir: '/default', source: 'default' }), { PATH: '/bin' });
  assert.equal(KEPT_CLAUDE_ENV.has('CLAUDE_CONFIG_DIR'), true);
});

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

test('既定は VSCode 経路で、ターミナルは明示したときだけ選ぶ', () => {
  // ターミナル経路は別ウィンドウの CLI セッションになり VSCode 側の作業とぶつかる(2026-08-30 kim 指示)。
  // VSCode CLI が無い機体だけターミナルへフォールバックする。
  assert.equal(pickRoute({ codeCli: 'code.cmd', flagTarget: undefined, env: {} }), 'vscode');
  // CLI が見つからなくてもターミナルへは落とさない(何も起動せずスキップする)
  assert.equal(pickRoute({ codeCli: '', flagTarget: undefined, env: {} }), 'vscode');
  assert.equal(pickRoute({ codeCli: '', flagTarget: 'terminal', env: {} }), 'terminal');
  assert.equal(pickRoute({ codeCli: 'code.cmd', flagTarget: undefined, env: { ORGIAST_NEXT_SESSION_TARGET: 'terminal' } }), 'terminal');
  assert.equal(pickRoute({ codeCli: 'code.cmd', flagTarget: 'terminal', env: {} }), 'terminal');
  assert.equal(pickRoute({ codeCli: 'code.cmd', flagTarget: 'vscode', env: {} }), 'vscode');
  assert.equal(pickRoute({ codeCli: 'code.cmd', flagTarget: undefined, env: { ORGIAST_NEXT_SESSION_TARGET: 'vscode' } }), 'vscode');
});

test('inline は target と旧 mode の各経路で選べ、明示 target の優先順位が最も高い', () => {
  assert.equal(pickRoute({ codeCli: '', flagTarget: 'inline', env: {}, state: {} }), 'inline');
  assert.equal(pickRoute({ codeCli: '', env: { ORGIAST_NEXT_SESSION_TARGET: 'inline' }, state: {} }), 'inline');
  assert.equal(pickRoute({ codeCli: '', env: { ORGIAST_NEXT_SESSION_MODE: 'inline' }, state: {} }), 'inline');
  assert.equal(pickRoute({ codeCli: '', env: {}, state: { mode: 'inline' } }), 'inline');
  assert.equal(pickRoute({ codeCli: '', env: {}, state: { target: 'inline' } }), 'inline');
  assert.equal(pickRoute({ codeCli: '', flagTarget: 'vscode', env: { ORGIAST_NEXT_SESSION_TARGET: 'inline' }, state: { target: 'inline' } }), 'vscode');
  assert.equal(pickRoute({ codeCli: '', env: {}, state: {} }), 'vscode');
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

test('未送信の VSCode タブを注入した prompt の送信有無から判定する', () => {
  const now = Date.parse('2026-08-31T12:00:00.000Z');
  const recentLaunch = '2026-08-31T10:00:00.000Z';
  assert.equal(hasUnsentVscodeTab({ state: { lastRoute: 'terminal', lastLaunchAt: recentLaunch }, now, promptConsumed: false }), false);
  assert.equal(hasUnsentVscodeTab({ state: { lastRoute: 'vscode', lastLaunchAt: '2026-08-31T05:59:59.999Z' }, now, promptConsumed: false }), false);
  assert.equal(hasUnsentVscodeTab({ state: { lastRoute: 'vscode', lastLaunchAt: recentLaunch }, now, promptConsumed: false }), true);
  assert.equal(hasUnsentVscodeTab({ state: { lastRoute: 'vscode', lastLaunchAt: recentLaunch }, now, promptConsumed: true }), false);
  assert.equal(hasUnsentVscodeTab({ state: { lastRoute: 'vscode', lastLaunchAt: recentLaunch }, now, promptConsumed: null }), false);
});

test('未送信タブは通常起動を抑止し、force なら起動する', () => {
  const args = { state: {}, now: 0, env: {}, pendingTab: true };
  const blocked = shouldLaunch({ ...args, force: false });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /未送信/);
  assert.deepEqual(shouldLaunch({ ...args, force: true }), { ok: true });
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
        if (file.endsWith('.claude.json')) return '{}';
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

test('--set-target は他の state を保持し、不正値では何も書かない', async () => {
  const initial = { enabled: false, lastLaunchAt: '2026-08-28T00:00:00.000Z', lastCwd: 'D:\\keep' };
  const configured = fakeIo({
    readFile: async (file) => {
      if (file.endsWith('next-session-launch.json')) return JSON.stringify(initial);
      throw new Error('ENOENT');
    },
  });
  assert.equal(await launchNextSession(['--set-target', 'inline'], configured.io), 0);
  assert.equal(configured.calls.spawn.length, 0);
  const saved = JSON.parse(configured.calls.writes[0][1]);
  assert.deepEqual(saved, { ...initial, target: 'inline' });
  assert.match(configured.calls.logs.join('\n'), /停止中です。--enable が必要/);

  const invalid = fakeIo();
  assert.equal(await launchNextSession(['--set-target', 'invalid'], invalid.io), 2);
  assert.equal(invalid.calls.writes.length, 0);
  assert.equal(invalid.calls.renames.length, 0);
});

test('inline は spawn せず予約し、lastRoute を inline で保存する', async () => {
  const armed = [];
  const { io, calls } = fakeIo({ armToFile: (value) => { armed.push(value); return true; } });
  assert.equal(await launchNextSession(['--target', 'inline', '--session', 'closing-sid'], io), 0);
  assert.equal(calls.spawn.length, 0);
  assert.deepEqual(armed, [{ home: '/fake/home', sessionId: 'closing-sid', cwd: 'C:\\work' }]);
  const saved = JSON.parse(calls.writes.find(([file]) => file.includes('next-session-launch.json.tmp-'))[1]);
  assert.equal(saved.lastRoute, 'inline');
  assert.match(calls.logs.join('\n'), /予約しました\(inline\)/);
});

test('inline は前回 VSCode タブが未送信でも予約できる', async () => {
  let armed = 0;
  const base = pendingTabIo('{"type":"user","message":{"role":"user","content":"別の依頼"}}');
  base.io.armToFile = () => { armed += 1; return true; };
  assert.equal(await launchNextSession(['--target', 'inline', '--session', 'closing-sid'], base.io), 0);
  assert.equal(armed, 1);
  assert.equal(base.calls.spawn.length, 0);
  assert.equal(JSON.parse(base.calls.writes.find(([file]) => file.includes('next-session-launch.json.tmp-'))[1]).lastRoute, 'inline');
});

test('inline dry-run は spawn も予約も state 更新もしない', async () => {
  let armed = 0;
  const { io, calls } = fakeIo({ armToFile: () => { armed += 1; return true; } });
  assert.equal(await launchNextSession(['--target', 'inline', '--dry-run', '--session', 'probe'], io), 0);
  assert.equal(calls.spawn.length, 0);
  assert.equal(calls.writes.length, 0);
  assert.equal(armed, 0);
  assert.deepEqual(JSON.parse(calls.logs[0]), { route: 'inline', cwd: 'C:\\work', sessionId: 'probe' });
});

test('起動成功時に detached spawn し state を tmp から原子的に更新する', async () => {
  const { io, calls } = fakeIo();
  assert.equal(await launchNextSession(['--target', 'terminal'], io), 0);
  assert.equal(calls.spawn.length, 1);
  const options = calls.spawn[0][2];
  assert.equal(options.cwd, 'C:\\work');
  assert.equal(options.detached, true);
  assert.equal(options.stdio, 'ignore');
  assert.equal(options.windowsHide, false);
  // 親セッションの CLAUDE* を継承させない(継承すると新セッションが今のセッションの子になる)。
  assert.deepEqual(options.env, { CLAUDE_CLI_PATH: '/fake/claude.exe' });
  assert.equal(calls.unref, 1);
  const stateWrite = calls.writes.find(([file]) => file.includes('next-session-launch.json.tmp-'));
  const stateRename = calls.renames.find(([, file]) => file.endsWith('next-session-launch.json'));
  assert.match(stateWrite[1], /"lastLaunchAt"/);
  assert.match(stateWrite[1], /"lastCwd": "C:\\\\work"/);
  assert.equal(JSON.parse(stateWrite[1]).lastPrompt, '/session-start');
  assert.ok(stateRename);
});

function pendingTabIo(firstUserLine, readHeadOverride) {
  const codeCli = 'C:\\Code\\bin\\code.cmd';
  const lastLaunchAt = '2026-08-31T10:00:00.000Z';
  const lastLaunch = Date.parse(lastLaunchAt);
  return fakeIo({
    env: { VSCODE_CLI_PATH: codeCli },
    exists: (file) => file === codeCli,
    now: Date.parse('2026-08-31T10:03:00.000Z'),
    readdir: (dir) => (dir.includes('projects') ? ['candidate.jsonl'] : []),
    stat: () => ({ birthtimeMs: lastLaunch + 1 }),
    readHead: readHeadOverride ?? (() => `${firstUserLine}\n{"type":"assistant"}`),
    readFile: async (file) => {
      if (file.endsWith('next-session-launch.json')) return JSON.stringify({
        enabled: true,
        lastRoute: 'vscode',
        lastLaunchAt,
        lastCwd: 'C:\\work',
        lastPrompt: '/session-start',
      });
      if (file.endsWith('next-session.md')) return '<!-- cwd: C:\\work -->';
      if (file.endsWith('.claude.json')) return '{}';
      throw new Error('ENOENT');
    },
  });
}

test('他人の新しい transcript では未送信タブの抑止を解除しない', async () => {
  const { io, calls } = pendingTabIo('{"type":"user","message":{"role":"user","content":"別の依頼"}}');
  assert.equal(await launchNextSession(['--target', 'vscode'], io), 0);
  assert.equal(calls.spawn.length, 0);
  assert.match(calls.logs[0], /未送信/);
});

test('最初の user メッセージに注入 prompt があれば起動する', async () => {
  const { io, calls } = pendingTabIo('{"type":"user","message":{"role":"user","content":"<command-message>session-start</command-message>\\n<command-name>/session-start</command-name>"}}');
  assert.equal(await launchNextSession(['--target', 'vscode'], io), 0);
  assert.equal(calls.spawn.length, 1);
});

// hook の添付レコードが "type":"user" で先に並ぶ transcript でも、本物の user 入力を掴めること。
// role まで見ないとここで取り違えて「未送信」と誤判定し、開くべきタブを永久に開かなくなる。
test('hook の添付レコードが先にあっても本物の user 入力を見る', async () => {
  const { io, calls } = pendingTabIo('', () => [
    '{"parentUuid":null,"attachment":{"type":"hook_success"},"type":"user"}',
    '{"type":"user","message":{"role":"user","content":"<command-name>/session-start</command-name>"}}',
  ].join('\n'));
  assert.equal(await launchNextSession(['--target', 'vscode'], io), 0);
  assert.equal(calls.spawn.length, 1);
});

test('transcript の先頭読み取り失敗時は fail-open で起動する', async () => {
  const { io, calls } = pendingTabIo('', () => { throw new Error('EACCES'); });
  assert.equal(await launchNextSession(['--target', 'vscode'], io), 0);
  assert.equal(calls.spawn.length, 1);
});

// bucket が無い(=その cwd で一度もセッションが始まっていない)のは「未送信」の積極的な証拠。
// ここを fail-open にすると、新しい cwd に開いたタブでは抑止が永久に効かない(2026-08-31 実測)。
test('transcript bucket が無い(ENOENT)ときは未送信として抑止する', async () => {
  const { io, calls } = pendingTabIo('');
  io.readdir = (dir) => {
    if (!dir.includes('projects')) return [];
    const error = new Error('ENOENT: no such file or directory');
    error.code = 'ENOENT';
    throw error;
  };
  assert.equal(await launchNextSession(['--target', 'vscode'], io), 0);
  assert.equal(calls.spawn.length, 0);
  assert.match(calls.logs[0], /未送信/);
});

test('ENOENT 以外の readdir 失敗は fail-open で起動する', async () => {
  const { io, calls } = pendingTabIo('');
  io.readdir = (dir) => {
    if (!dir.includes('projects')) return [];
    const error = new Error('EACCES: permission denied');
    error.code = 'EACCES';
    throw error;
  };
  assert.equal(await launchNextSession(['--target', 'vscode'], io), 0);
  assert.equal(calls.spawn.length, 1);
});

test('dry-run は plan だけを出して spawn しない', async () => {
  const { io, calls } = fakeIo();
  assert.equal(await launchNextSession(['--target', 'terminal', '--dry-run'], io), 0);
  assert.equal(calls.spawn.length, 0);
  assert.equal(calls.writes.length, 0);
  const output = JSON.parse(calls.logs[0]);
  assert.equal(output.cwd, 'C:\\work');
  assert.equal(output.account, '');
  assert.equal(output.configDir, path.join('/fake/home', '.claude'));
  assert.equal(output.configDirSource, 'default');
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
  const successLog = calls.logs.join('\n');
  assert.match(successLog, /タブバーの一番右端/);
  assert.match(successLog, /Enter 1回で開始/);
  assert.match(successLog, /cwd   : C:\\work/);
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
  assert.equal(output.account, '');
  assert.equal(output.configDir, path.join('/fake/home', '.claude'));
  assert.equal(output.configDirSource, 'default');
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

test('trustKeyVariants はスラッシュ両表記を重複なく返す', () => {
  assert.deepEqual(trustKeyVariants('c:/a/b'), ['c:/a/b', 'c:\\a\\b']);
  assert.deepEqual(trustKeyVariants('c:\\a\\b'), ['c:\\a\\b', 'c:/a/b']);
  assert.deepEqual(trustKeyVariants(''), []);
});

test('applyTrust は元設定を破壊せず、既存フィールドを保って両表記を登録する', () => {
  const original = {
    theme: 'dark',
    projects: {
      'c:/a/b': { allowedTools: ['Read'], hasTrustDialogAccepted: false },
    },
  };
  const before = structuredClone(original);
  const result = applyTrust(original, 'c:/a/b');

  assert.equal(result.changed, true);
  assert.deepEqual(original, before);
  assert.deepEqual(result.config.projects['c:/a/b'], {
    allowedTools: ['Read'],
    hasTrustDialogAccepted: true,
  });
  assert.deepEqual(result.config.projects['c:\\a\\b'], { hasTrustDialogAccepted: true });
  assert.equal(result.config.theme, 'dark');

  const alreadyTrusted = applyTrust(result.config, 'c:/a/b');
  assert.equal(alreadyTrusted.changed, false);
  assert.equal(alreadyTrusted.config, result.config);
});

test('ターミナル経路はフォルダ信頼を tmp から原子的に登録してから起動する', async () => {
  const { io, calls } = fakeIo();
  assert.equal(await launchNextSession(['--target', 'terminal'], io), 0);

  const trustWriteIndex = calls.writes.findIndex(([file]) => file.includes('.claude.json.tmp-'));
  const trustRenameIndex = calls.renames.findIndex(([, file]) => file.endsWith('.claude.json'));
  assert.notEqual(trustWriteIndex, -1);
  assert.notEqual(trustRenameIndex, -1);
  const trustConfig = JSON.parse(calls.writes[trustWriteIndex][1]);
  assert.equal(trustConfig.projects['C:\\work'].hasTrustDialogAccepted, true);
  assert.equal(trustConfig.projects['C:/work'].hasTrustDialogAccepted, true);
  assert.match(calls.logs.join('\n'), /フォルダ信頼を事前登録しました: C:\\work/);
  assert.equal(calls.spawn.length, 1);
});

test('フォルダ信頼が両表記で登録済みなら .claude.json を書き込まない', async () => {
  const { io, calls } = fakeIo({
    readFile: async (file) => {
      if (file.endsWith('next-session.md')) return '<!-- cwd: C:\\work -->';
      if (file.endsWith('.claude.json')) return JSON.stringify({
        projects: {
          'C:\\work': { hasTrustDialogAccepted: true },
          'C:/work': { hasTrustDialogAccepted: true },
        },
      });
      throw new Error('ENOENT');
    },
  });
  assert.equal(await launchNextSession(['--target', 'terminal'], io), 0);
  assert.equal(calls.writes.some(([file]) => file.includes('.claude.json')), false);
  assert.equal(calls.spawn.length, 1);
});

test('ORGIAST_NO_AUTO_TRUST=1 は信頼設定だけを飛ばして起動する', async () => {
  const { io, calls } = fakeIo({
    env: { CLAUDE_CLI_PATH: '/fake/claude.exe', ORGIAST_NO_AUTO_TRUST: '1' },
  });
  assert.equal(await launchNextSession(['--target', 'terminal'], io), 0);
  assert.equal(calls.writes.some(([file]) => file.includes('.claude.json')), false);
  assert.equal(calls.spawn.length, 1);
});

test('~/.claude.json が読めない/壊れている時は絶対に書き戻さない', async () => {
  // {} を土台に書き戻すと oauthAccount や他プロジェクトの設定ごと消える。
  for (const broken of ['{ こわれている', '']) {
    const { io, calls } = fakeIo({
      readFile: async (file) => {
        if (file.endsWith('next-session.md')) return '<!-- 前セッション: abc / 更新: 2026-08-28 / cwd: C:\\work -->';
        if (file.endsWith('.claude.json')) return broken;
        throw new Error('ENOENT');
      },
    });
    assert.equal(await launchNextSession(['--target', 'terminal'], io), 0);
    assert.equal(calls.writes.some(([file]) => file.includes('.claude.json')), false);
    // 信頼登録に失敗しても起動そのものは止めない。
    assert.equal(calls.spawn.length, 1);
  }
});

test('VSCode 経路はアカウント確認で .claude.json を読むが書き込まない', async () => {
  const codeCli = 'C:\\Code\\bin\\code.cmd';
  const reads = [];
  const base = fakeIo();
  const originalReadFile = base.io.readFile;
  base.io.env = { VSCODE_CLI_PATH: codeCli };
  base.io.exists = (file) => file === codeCli;
  base.io.readFile = async (file, ...args) => {
    reads.push(file);
    return originalReadFile(file, ...args);
  };

  assert.equal(await launchNextSession(['--target', 'vscode'], base.io), 0);
  assert.equal(reads.some((file) => file.endsWith('.claude.json')), true);
  assert.equal(base.calls.writes.some(([file]) => file.includes('.claude.json')), false);
});

test('VSCode CLI が見つからない時はターミナルへ落とさず何も起動しない', async () => {
  // 既定でターミナルへフォールバックしていた頃は「コードは VSCode 既定なのにターミナルが開く」が
  // 再発し、原因が codeCli 解決の失敗だと気付けなかった(2026-08-30)。落とさずスキップする。
  const { io, calls } = fakeIo();
  io.exists = () => false;
  io.env = {};
  assert.equal(await launchNextSession([], io), 0);
  assert.equal(calls.spawn.length, 0);
});

test('取得したアカウントを成功ログと state に記録する', async () => {
  const { io, calls } = fakeIo({
    readFile: async (file) => {
      if (file.endsWith('next-session.md')) return '<!-- cwd: C:\\work -->';
      if (file.endsWith('.claude.json')) return JSON.stringify({ oauthAccount: { emailAddress: 'kim@orgiast.jp' } });
      throw new Error('ENOENT');
    },
  });
  assert.equal(await launchNextSession(['--target', 'terminal'], io), 0);
  assert.match(calls.logs.at(-1), /\/ account=kim@orgiast\.jp$/);
  const stateWrite = calls.writes.find(([file]) => file.includes('next-session-launch.json.tmp-'));
  assert.equal(JSON.parse(stateWrite[1]).lastAccount, 'kim@orgiast.jp');
  assert.equal(JSON.parse(stateWrite[1]).lastConfigDir, path.join('/fake/home', '.claude'));
});

test('アカウント不明でも起動を止めず候補パスをログに出す', async () => {
  const { io, calls } = fakeIo();
  assert.equal(await launchNextSession(['--target', 'terminal'], io), 0);
  assert.equal(calls.spawn.length, 1);
  assert.match(calls.logs.at(-1), /account=不明\(.+\.claude\.json\)$/);
});

test('state.configDir は子プロセスの CLAUDE_CONFIG_DIR を上書きする', async () => {
  const configDir = '/fake/account-config';
  const { io, calls } = fakeIo({
    readFile: async (file) => {
      if (file.endsWith('next-session-launch.json')) return JSON.stringify({ configDir });
      if (file.endsWith('next-session.md')) return '<!-- cwd: C:\\work -->';
      if (file.endsWith('.claude.json')) return '{}';
      throw new Error('ENOENT');
    },
  });
  assert.equal(await launchNextSession(['--target', 'terminal'], io), 0);
  assert.equal(calls.spawn[0][2].env.CLAUDE_CONFIG_DIR, configDir);
});


test('vscode 経路のアカウントは断定せず参考値として出す', () => {
  // 拡張のログインは外から選べないので、config dir から読んだ値を確定として書くと嘘になる。
  const accountPath = '/fake/home/.claude.json';
  assert.equal(accountLabel({ account: 'kim@orgiast.jp', route: 'terminal', accountPath }), 'kim@orgiast.jp');
  assert.equal(
    accountLabel({ account: 'kim@orgiast.jp', route: 'vscode', accountPath }),
    'kim@orgiast.jp(参考: 実際は VSCode ウィンドウのログイン)',
  );
  assert.equal(accountLabel({ account: '', route: 'terminal', accountPath }), `不明(${accountPath})`);
});

test('vscode 経路で state.configDir が指定されていたら効かないことを警告する', async () => {
  const codeCli = 'C:/Code/bin/code.cmd';
  const base = fakeIo();
  const io = {
    ...base.io,
    env: { VSCODE_CLI_PATH: codeCli },
    exists: (file) => file === codeCli,
    readFile: async (file) => {
      if (file.endsWith('next-session-launch.json')) return JSON.stringify({ enabled: true, configDir: 'D:/team-config' });
      if (file.endsWith('next-session.md')) return '<!-- cwd: C:/work -->';
      if (file.endsWith('.claude.json')) return JSON.stringify({ oauthAccount: { emailAddress: 'kim@orgiast.jp' } });
      throw new Error('ENOENT');
    },
  };
  assert.equal(await launchNextSession(['--target', 'vscode'], io), 0);
  assert.ok(base.calls.logs.some((line) => line.includes('VSCode 拡張経路では効きません')));
  assert.ok(base.calls.logs.at(-1).endsWith('account: kim@orgiast.jp(参考: 実際は VSCode ウィンドウのログイン)'));
});
