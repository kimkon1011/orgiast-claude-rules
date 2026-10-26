import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pool from './lib/mobile-state.cjs';
import {
  convergeMobileConfig, removeMobileTabsZero, ensureMobileRefreshDisabled, convergeMobileExtension, convergeMobileStandby,
  convergeRcNamePrefix, RC_NAME_PREFIX, readMobileRefreshConfig,
} from './mobile-standby.mjs';

const temp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name));
const cfg = (home) => path.join(home, '.claude', 'mobile-sessions.json');

test('既定の待機数は 3（fallback なし）', () => {
  assert.equal(pool.readConfig(temp('ms-default-'), {}), 3);
  assert.equal(pool.targetCount(), 3);
});

test('mobile-sessions.json: 無ければ作成、3 未満は引き上げ（他キー保持）、3 以上は不変・冪等', () => {
  const home = temp('ms-cfg-');
  assert.equal(convergeMobileConfig(home).changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg(home), 'utf8')), { count: 3 });
  assert.equal(convergeMobileConfig(home).changed, false);
  fs.writeFileSync(cfg(home), JSON.stringify({ count: 1, refreshMinutes: 30 }));
  assert.equal(convergeMobileConfig(home).changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg(home), 'utf8')), { count: 3, refreshMinutes: 30 });
  fs.writeFileSync(cfg(home), JSON.stringify({ count: 5 }));
  assert.equal(convergeMobileConfig(home).changed, false);
  assert.equal(JSON.parse(fs.readFileSync(cfg(home), 'utf8')).count, 5);
});

test('壊れた mobile-sessions.json は上書きしない', () => {
  const home = temp('ms-broken-');
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(cfg(home), '{broken');
  assert.equal(convergeMobileConfig(home).changed, false);
  assert.equal(fs.readFileSync(cfg(home), 'utf8'), '{broken');
});

// 回答待ちの値を「全PCへ配る」経路。リポジトリの tools/mobile-refresh.json が唯一の配布元。
test('mobile-refresh.json: 値があるときだけ refreshMinutes/refreshHours を配り、他キーを保持・冪等', () => {
  const repo = temp('ms-repo-');
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
  const home = temp('ms-refresh-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(cfg(home), JSON.stringify({ count: 3, note: 'keep' }));

  // ファイルが無ければ何も変えない（従来挙動）
  assert.equal(readMobileRefreshConfig(repo), null);
  assert.equal(convergeMobileConfig(home, 3, readMobileRefreshConfig(repo)).changed, false);

  fs.writeFileSync(path.join(repo, 'tools', 'mobile-refresh.json'), JSON.stringify({ minutes: 10, hours: '00-24' }));
  const desired = readMobileRefreshConfig(repo);
  assert.deepEqual(desired, { minutes: 10, hours: '00-24' });
  assert.equal(convergeMobileConfig(home, 3, desired).changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg(home), 'utf8')), { count: 3, note: 'keep', refreshMinutes: 10, refreshHours: '00-24' });
  // 2回目は書かない（冪等）
  assert.equal(convergeMobileConfig(home, 3, readMobileRefreshConfig(repo)).changed, false);
  // 値の変更だけでも反映される
  fs.writeFileSync(path.join(repo, 'tools', 'mobile-refresh.json'), JSON.stringify({ minutes: 30, hours: '06-24' }));
  assert.equal(convergeMobileConfig(home, 3, readMobileRefreshConfig(repo)).changed, true);
  const after = JSON.parse(fs.readFileSync(cfg(home), 'utf8'));
  assert.equal(after.refreshMinutes, 30);
  assert.equal(after.refreshHours, '06-24');
  assert.equal(after.note, 'keep');
});

test('mobile-refresh.json の不正値は配らない（壊れた値で全PCを書き換えない）', () => {
  const repo = temp('ms-repo-bad-');
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
  const file = path.join(repo, 'tools', 'mobile-refresh.json');
  fs.writeFileSync(file, JSON.stringify({ minutes: -1 }));
  assert.match(readMobileRefreshConfig(repo).error, /minutes/);
  fs.writeFileSync(file, JSON.stringify({ hours: '25-30' }));
  assert.match(readMobileRefreshConfig(repo).error, /hours/);
  fs.writeFileSync(file, '{broken');
  assert.match(readMobileRefreshConfig(repo).error, /解釈/);
});

test('VSCode settings の mobileTabs=0 を除去（JSON / JSONC 末尾カンマ）', () => {
  const dir = temp('ms-set-');
  const a = path.join(dir, 'a.json');
  fs.writeFileSync(a, JSON.stringify({ 'editor.x': 1, 'orgiast.nextSession.mobileTabs': 0 }, null, 4));
  assert.equal(removeMobileTabsZero(a).changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(a, 'utf8')), { 'editor.x': 1 });
  assert.equal(removeMobileTabsZero(a).changed, false);
  const b = path.join(dir, 'b.json');
  fs.writeFileSync(b, '{\n  // memo\n  "editor.x": 1,\n  "orgiast.nextSession.mobileTabs": 0\n}\n');
  assert.equal(removeMobileTabsZero(b).changed, true);
  assert.equal(fs.readFileSync(b, 'utf8').includes('mobileTabs'), false);
  assert.doesNotMatch(fs.readFileSync(b, 'utf8'), /1,\s*\}/);
  const c = path.join(dir, 'c.json');
  fs.writeFileSync(c, '{"orgiast.nextSession.mobileTabs": 2}');
  assert.equal(removeMobileTabsZero(c).changed, false);
  assert.equal(removeMobileTabsZero(path.join(dir, 'none.json')).changed, false);
});

function extFixture({ installed = '' } = {}) {
  const home = temp('ms-ext-');
  const repoRoot = temp('ms-repo-');
  const pkg = path.join(repoRoot, 'packages', 'vscode-next-session');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'orgiast-next-session-0.3.6.vsix'), 'a');
  fs.writeFileSync(path.join(pkg, 'orgiast-next-session-0.3.7.vsix'), 'b');
  if (installed) fs.mkdirSync(path.join(home, '.vscode', 'extensions', `orgiast.next-session-${installed}`), { recursive: true });
  const calls = [];
  const runCodeCli = (args) => { calls.push(args); return { code: 0, stdout: installed ? `orgiast.next-session@${installed}\n` : '', stderr: '' }; };
  const exists = (p) => p === 'X:\code.cmd';
  return { home, repoRoot, calls, runCodeCli, env: { VSCODE_CLI_PATH: 'X:\code.cmd' }, exists };
}

test('拡張: VSCode が無ければスキップ', () => {
  const f = extFixture();
  const r = convergeMobileExtension({ ...f, exists: () => false });
  assert.equal(r.status, 'skip');
  assert.equal(f.calls.length, 0);
});

test('拡張: 未導入なら最新 VSIX を --force 導入', () => {
  const f = extFixture();
  const r = convergeMobileExtension(f);
  assert.equal(r.status, 'installed');
  assert.equal(f.calls.at(-1)[0], '--install-extension');
  assert.match(f.calls.at(-1)[1], /orgiast-next-session-0\.3\.7\.vsix$/);
  assert.equal(f.calls.at(-1)[2], '--force');
});

test('拡張: 古ければ更新、最新なら CLI を呼ばない', () => {
  const old = extFixture({ installed: '0.3.6' });
  assert.equal(convergeMobileExtension(old).status, 'installed');
  const cur = extFixture({ installed: '0.3.7' });
  assert.equal(convergeMobileExtension(cur).status, 'ok');
  assert.equal(cur.calls.length, 0);
});

test('拡張: VSCode の痕跡(.vscode/extensions)があるのに code.cmd が無ければ skip ではなく ng（探索候補を理由に含む）', () => {
  const f = extFixture({ installed: '0.3.6' });
  const r = convergeMobileExtension({ ...f, env: { PATH: 'D:\\tools' }, exists: (p) => p.includes(`${path.sep}.vscode${path.sep}extensions`) && !p.endsWith('code.cmd'), regQuery: () => '' });
  assert.equal(r.status, 'ng');
  assert.match(r.note, /痕跡あり/);
  assert.match(r.note, /D:\\tools\\code\.cmd/);
  assert.equal(f.calls.length, 0);
});

test('拡張: Code/User(APPDATA)だけでも痕跡扱い、痕跡も CLI も無ければ従来どおり skip', () => {
  const f = extFixture();
  const appdata = 'Z:\\AppData';
  const withTrace = convergeMobileExtension({ ...f, env: { APPDATA: appdata }, exists: (p) => p === path.join(appdata, 'Code', 'User'), regQuery: () => '' });
  assert.equal(withTrace.status, 'ng');
  const none = convergeMobileExtension({ ...f, env: {}, exists: () => false, regQuery: () => '' });
  assert.equal(none.status, 'skip');
});

test('拡張: レジストリ(Uninstall)の InstallLocation から code.cmd を見つけて導入', () => {
  const f = extFixture();
  const regText = [
    'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{ABC}',
    '    DisplayName    REG_SZ    Microsoft Visual Studio Code',
    '    InstallLocation    REG_SZ    E:\\Dev\\VSCode',
    '',
  ].join('\r\n');
  const r = convergeMobileExtension({ ...f, env: {}, exists: (p) => p === 'E:\\Dev\\VSCode\\bin\\code.cmd', regQuery: (key) => (key.startsWith('HKLM\\Software\\Microsoft') ? regText : '') });
  assert.equal(r.status, 'installed');
});

test('resolveVscodeCli: PATH 上 / 実行中 Code.exe の隣 / 他ドライブを探索', async () => {
  const { resolveVscodeCli, parseUninstallInstallLocations } = await import('./next-session-launch.mjs');
  const base = { homedir: 'C:\\Users\\u', regQuery: () => '' };
  assert.equal(resolveVscodeCli({ ...base, env: { PATH: 'C:\\x;D:\\vs\\bin' }, exists: (p) => p === 'D:\\vs\\bin\\code.cmd' }), 'D:\\vs\\bin\\code.cmd');
  assert.equal(resolveVscodeCli({ ...base, env: { VSCODE_GIT_ASKPASS_NODE: 'F:\\VS\\Code.exe' }, exists: (p) => p === 'F:\\VS\\bin\\code.cmd' }), 'F:\\VS\\bin\\code.cmd');
  assert.equal(resolveVscodeCli({ ...base, env: {}, exists: (p) => p === 'D:\\Program Files\\Microsoft VS Code\\bin\\code.cmd' }), 'D:\\Program Files\\Microsoft VS Code\\bin\\code.cmd');
  assert.equal(resolveVscodeCli({ ...base, env: {}, exists: () => false }), '');
  assert.deepEqual(parseUninstallInstallLocations('HKEY_X\\a\r\n    DisplayName    REG_SZ    Other App\r\n    InstallLocation    REG_SZ    C:\\o\r\n'), []);
});

test('convergeMobileStandby: 痕跡ありで CLI 無し → result.ok=false かつ lines に NG が出る', () => {
  const f = extFixture({ installed: '0.3.6' });
  const settingsPath = path.join(f.home, 'settings.json');
  const run = convergeMobileStandby({ ...f, env: {}, exists: (p) => p.includes('extensions'), regQuery: () => '', settingsPath, rcPrefix: { platform: 'win32', readUserEnv: () => RC_NAME_PREFIX, writeUserEnv: () => {} } });
  assert.equal(run.ok, false);
  assert.ok(run.lines.some((l) => /拡張: NG/.test(l)));
});

test('拡張: 同梱 VSIX が無ければ ng', () => {
  const f = extFixture();
  fs.rmSync(path.join(f.repoRoot, 'packages'), { recursive: true });
  assert.equal(convergeMobileExtension(f).status, 'ng');
});

test('convergeMobileStandby は 3 ステップを通し冪等', () => {
  const f = extFixture();
  const settingsPath = path.join(f.home, 'settings.json');
  fs.writeFileSync(settingsPath, '{"orgiast.nextSession.mobileTabs":0}');
  // 実 powershell を呼ばないようスタブを注入（rcPrefix 自体の検証は別テスト）。
  const rcPrefix = { platform: 'win32', readUserEnv: () => RC_NAME_PREFIX, writeUserEnv: () => { throw new Error('呼ばれないはず'); } };
  const first = convergeMobileStandby({ ...f, settingsPath, rcPrefix });
  assert.equal(first.ok, true);
  assert.equal(first.config.changed, true);
  assert.equal(first.settings.changed, true);
  assert.equal(first.refreshSetting.changed, true);
  assert.ok(first.lines.some((line) => line.startsWith('[mobile-standby] VSCode refresh:')));
  assert.equal(first.extension.status, 'installed');
  fs.mkdirSync(path.join(f.home, '.vscode', 'extensions', 'orgiast.next-session-0.3.7'), { recursive: true });
  const second = convergeMobileStandby({ ...f, settingsPath, rcPrefix });
  assert.equal(second.config.changed, false);
  assert.equal(second.settings.changed, false);
  assert.equal(second.refreshSetting.changed, false);
  assert.equal(second.extension.status, 'ok');
});

test('RC セッション名接頭辞は "待機" 固定', () => {
  assert.equal(RC_NAME_PREFIX, '待機');
});

test('RC接頭辞: 既に同じ値なら write せず changed=false（冪等）', () => {
  const writes = [];
  const r = convergeRcNamePrefix({
    platform: 'win32',
    readUserEnv: () => RC_NAME_PREFIX,
    writeUserEnv: (...args) => { writes.push(args); },
  });
  assert.equal(r.changed, false);
  assert.equal(r.ok, true);
  assert.equal(writes.length, 0);
  assert.match(r.note, /既に "待機"/);
});

test('RC接頭辞: 未設定なら書き込み、changed=true、note に -> "待機"', () => {
  const writes = [];
  const r = convergeRcNamePrefix({
    platform: 'win32',
    readUserEnv: () => '',
    writeUserEnv: (...args) => { writes.push(args); },
  });
  assert.equal(r.changed, true);
  assert.equal(r.ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX');
  assert.equal(writes[0][1], RC_NAME_PREFIX);
  assert.match(r.note, /-> "待機"/);
  assert.match(r.note, /未設定/);
});

test('RC接頭辞: Windows 以外はスキップ（read/write を呼ばない）', () => {
  let touched = 0;
  const r = convergeRcNamePrefix({
    platform: 'linux',
    readUserEnv: () => { touched += 1; return ''; },
    writeUserEnv: () => { touched += 1; },
  });
  assert.equal(r.changed, false);
  assert.equal(r.ok, true);
  assert.equal(touched, 0);
  assert.match(r.note, /スキップ/);
});

test('RC接頭辞: 書き込み失敗は ok=false を返す（例外を投げない）', () => {
  const r = convergeRcNamePrefix({
    platform: 'win32',
    readUserEnv: () => '',
    writeUserEnv: () => { throw new Error('boom'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.changed, false);
  assert.match(r.note, /失敗/);
  assert.match(r.note, /boom/);
});

test('convergeMobileStandby: result.rcPrefix が入り、ok=false なら result.ok も false', () => {
  const f = extFixture();
  const settingsPath = path.join(f.home, 'settings.json');
  const okRun = convergeMobileStandby({ ...f, settingsPath, rcPrefix: { platform: 'win32', readUserEnv: () => RC_NAME_PREFIX, writeUserEnv: () => {} } });
  assert.equal(okRun.ok, true);
  assert.equal(okRun.rcPrefix.ok, true);
  assert.equal(okRun.rcPrefix.changed, false);
  assert.ok(okRun.lines.some((line) => line.startsWith('[mobile-standby] RC接頭辞:')));

  const ngRun = convergeMobileStandby({ ...f, settingsPath, rcPrefix: { platform: 'win32', readUserEnv: () => '', writeUserEnv: () => { throw new Error('denied'); } } });
  assert.equal(ngRun.rcPrefix.ok, false);
  assert.equal(ngRun.ok, false);
});

test('同梱 VSIX の最新版と package.json の版が一致する', () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'packages', 'vscode-next-session');
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  assert.ok(fs.existsSync(path.join(dir, `orgiast-next-session-${version}.vsix`)));
});

for (const [name, before, after] of [
  ['未設定→挿入', '{\n  "editor.x": 1\n}\n', '{\n  "orgiast.nextSession.mobileRefreshMinutes": 0,\n  "editor.x": 1\n}\n'],
  ['60→0', '{\n  "orgiast.nextSession.mobileRefreshMinutes": 60\n}\n', '{\n  "orgiast.nextSession.mobileRefreshMinutes": 0\n}\n'],
  ['JSONC・CRLF・コメント保持', '// { header\r\n{\r\n  /* "orgiast.nextSession.mobileRefreshMinutes": 99 */\r\n  "orgiast.nextSession.mobileRefreshMinutes": 60, // keep\r\n  "url": "https://example.test",\r\n}\r\n', '// { header\r\n{\r\n  /* "orgiast.nextSession.mobileRefreshMinutes": 99 */\r\n  "orgiast.nextSession.mobileRefreshMinutes": 0, // keep\r\n  "url": "https://example.test",\r\n}\r\n'],
  ['コメント内だけの設定は未設定', '{\n // "orgiast.nextSession.mobileRefreshMinutes": 60\n}\n', '{\n  "orgiast.nextSession.mobileRefreshMinutes": 0,\n // "orgiast.nextSession.mobileRefreshMinutes": 60\n}\n'],
]) {
  test(`VSCode refresh: ${name}、変更前バックアップと冪等性`, (t) => {
    const dir = temp('ms-norefresh-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, before);
    assert.equal(ensureMobileRefreshDisabled(file).changed, true);
    assert.equal(fs.readFileSync(file, 'utf8'), after);
    const backups = fs.readdirSync(dir).filter((name) => /\.bak-norefresh-\d{14}\.json$/.test(name));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), before);
    const write = t.mock.method(fs, 'writeFileSync', () => assert.fail('冪等時に書き込み'));
    assert.equal(ensureMobileRefreshDisabled(file).changed, false);
    assert.equal(write.mock.callCount(), 0);
    write.mock.restore();
  });
}

test('VSCode refresh: 既に0・ファイル無し・危険な形式は書かない', (t) => {
  const dir = temp('ms-norefresh-skip-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  assert.match(ensureMobileRefreshDisabled(file).note, /なし/);
  for (const raw of [
    '{"orgiast.nextSession.mobileRefreshMinutes":0}',
    '{"orgiast.nextSession.mobileRefreshMinutes":60}',
    '{broken',
    '[]',
    '{"nested":{"orgiast.nextSession.mobileRefreshMinutes":60}}',
    '{\n"orgiast.nextSession.mobileRefreshMinutes":0,\n"orgiast.nextSession.mobileRefreshMinutes":60\n}',
  ]) {
    fs.writeFileSync(file, raw);
    const write = t.mock.method(fs, 'writeFileSync', () => assert.fail('変更不要時に書き込み'));
    assert.equal(ensureMobileRefreshDisabled(file).changed, false);
    assert.equal(write.mock.callCount(), 0);
    write.mock.restore();
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
  }
});

test('convergeMobileStandby: refresh 設定の例外で ok=false', () => {
  const f = extFixture();
  const run = convergeMobileStandby({ ...f, settingsPath: f.home, rcPrefix: { platform: 'linux' } });
  assert.equal(run.ok, false);
  assert.ok(run.lines.some((line) => /VSCode refresh: 失敗/.test(line)));
});

test('disabled config remains byte identical and converge preserves/writes mobileTabs zero', () => {
  for (const settings of ['{\n "orgiast.nextSession.mobileTabs": 0\n}', '{\n // comment\n "editor.fontSize": 14,\n}']) {
    const home = temp('ms-disabled-');
    fs.mkdirSync(path.dirname(cfg(home)), { recursive: true });
    const raw = '{ "enabled": false, "count": 1, "refreshMinutes": 45, "other": "keep" }';
    fs.writeFileSync(cfg(home), raw);
    const settingsPath = path.join(home, 'settings.json'); fs.writeFileSync(settingsPath, settings);
    const result = convergeMobileStandby({ home, repoRoot: home, settingsPath, exists: () => false, readdir: () => [], rcPrefix: { platform: 'linux' } });
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(cfg(home), 'utf8'), raw);
    assert.match(fs.readFileSync(settingsPath, 'utf8'), /"orgiast.nextSession.mobileTabs": 0/);
    assert.ok(result.lines.includes('[mobile-standby] 無効（mobile-sessions.json enabled:false）'));
    assert.equal(pool.isMobileEnabled(home), false);
  }
});
test('disable/enable CLI round trip preserves config keys', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const home = temp('ms-cli-');
  fs.mkdirSync(path.dirname(cfg(home)), { recursive: true });
  fs.writeFileSync(cfg(home), '{"count":1,"custom":"keep"}');
  const run = arg => execFileSync(process.execPath, [fileURLToPath(new URL('./mobile-standby.mjs', import.meta.url)), arg], { env: { ...process.env, ORGIAST_HOME: home }, encoding: 'utf8' });
  assert.match(run('--disable'), /ユーザーが手で閉じてください/);
  const settings = path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'settings.json');
  assert.match(fs.readFileSync(settings, 'utf8'), /"orgiast.nextSession.mobileTabs": 0/);
  assert.equal(pool.isMobileEnabled(home), false);
  run('--enable');
  assert.equal(pool.isMobileEnabled(home), true);
  assert.doesNotMatch(fs.readFileSync(settings, 'utf8'), /mobileTabs/);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg(home))), { enabled: true, count: 1, custom: 'keep' });
});

test('disabled mobile-sessions direct entry never resolves CLI or spawns', async () => {
  const { main } = await import('./mobile-sessions.mjs');
  const home = temp('ms-direct-disabled-');
  fs.mkdirSync(path.dirname(cfg(home)), { recursive: true });
  fs.writeFileSync(cfg(home), '{"enabled":false,"count":1}');
  assert.equal(await main([], { homedir: home, env: {}, exists() { assert.fail(); }, spawn() { assert.fail(); } }), 0);
});
test('mobileTabs editing backs up JSONC and leaves ambiguous input unchanged', async () => {
  const { ensureMobileTabsDisabled } = await import('./mobile-standby.mjs');
  const home = temp('ms-safe-disable-');
  const settings = path.join(home, 'settings.json');
  const raw = '{\n // keep comment\n "orgiast.nextSession.mobileTabs": 3,\n}';
  fs.writeFileSync(settings, raw);
  assert.equal(ensureMobileTabsDisabled(settings).changed, true);
  const backup = fs.readdirSync(home).find(name => name.includes('.bak-nomobile-'));
  assert.equal(fs.readFileSync(path.join(home, backup), 'utf8'), raw);
  assert.match(fs.readFileSync(settings, 'utf8'), /keep comment/);
  fs.writeFileSync(settings, '{ broken');
  assert.equal(ensureMobileTabsDisabled(settings).changed, false);
  assert.equal(fs.readFileSync(settings, 'utf8'), '{ broken');
});
