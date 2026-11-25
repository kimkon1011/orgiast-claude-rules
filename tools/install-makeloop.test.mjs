import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { installMakeloop, installedPlugins, PLUGIN } from './install-makeloop.mjs';
const good = { status: 0, stdout: '', stderr: '' };
// linux 固定の fixture なので期待パスも posix で組む。
const localClone = path.posix.join('/fixture', '.claude', 'makeloop-src');
const listed = '{"version":2,"plugins":{"makeloop@makeloop":[{"version":"0.12.0","scope":"user"}]}}';
function fixture(overrides = {}) {
  const calls = [], writes = [], files = { known: '{}', installed: '{"version":2,"plugins":{}}' };
  const options = { home: '/fixture', platform: 'linux', wsl: null, exists: p => p.includes('/.codex/plugins/cache/makeloop'), log: () => {},
    read: file => file.endsWith('known_marketplaces.json') ? files.known : file.endsWith('installed_plugins.json') ? files.installed : '',
    write: (...args) => writes.push(args),
    spawnImpl: (exe, args, opts) => { calls.push([exe, ...args]); calls.at(-1).opts = opts; if (args.join(' ') === `plugin install ${PLUGIN}`) files.installed = listed; return good; }, ...overrides };
  return { calls, writes, files, options };
}
test('installedPlugins reads the plugin key from installed_plugins.json', () => {
  assert.ok(installedPlugins(listed)); assert.equal(installedPlugins('{"version":2,"plugins":{}}'), null); assert.equal(installedPlugins('not json'), null); assert.equal(installedPlugins(''), null);
});
test('EBUSY staging error switches to local clone, then read-back via installed_plugins.json', () => {
  const f = fixture(); const normal = f.options.spawnImpl; let first = true;
  f.options.spawnImpl = (exe, args, opts) => {
    const r = normal(exe, args, opts);
    if (first && args.join(' ') === 'plugin marketplace add usedhonda/makeloop') { first = false; return { status: 1, stderr: 'EBUSY usedhonda-makeloop--clone' }; }
    return r;
  };
  const result = installMakeloop(f.options);
  assert.equal(result.claude, true); assert.equal(result.exitCode, 0);
  assert.ok(f.calls.some(c => c[0] === 'git' && c[1] === 'clone'));
  assert.ok(f.calls.some(c => c.join(' ') === `claude plugin marketplace add ${localClone}`));
  assert.equal(f.calls.filter(c => c.join(' ') === `claude plugin install ${PLUGIN}`).length, 1);
  assert.equal(f.calls.some(c => c.join(' ') === 'claude plugin list'), false, 'plugin list hangs without a TTY and must never be invoked');
  assert.ok(f.calls.every(c => c.opts.stdio[0] === 'ignore'), 'stdin is closed for every child');
});
test('known marketplace and installed caches skip additions', () => {
  const f = fixture(); f.files.known = '{"makeloop":{}}'; f.files.installed = listed;
  assert.equal(installMakeloop(f.options).exitCode, 0);
  assert.equal(f.calls.some(c => c.includes('add') || c.includes('install')), false);
  const marker = JSON.parse(f.writes[0][1]); assert.equal(marker.claude, true); assert.equal(marker.codex, true);
  assert.equal(f.writes[0][0], '/fixture/.claude/.makeloop-installed.json');
});
test('install that leaves installed_plugins.json unchanged is reported as a Claude failure', () => {
  const f = fixture(); f.files.known = '{"makeloop":{}}';
  f.options.spawnImpl = (exe, args) => { f.calls.push([exe, ...args]); return good; };
  const result = installMakeloop(f.options);
  assert.equal(result.claude, false); assert.equal(result.codex, true); assert.equal(result.exitCode, 0);
  assert.match(result.errors[0], /does not list makeloop@makeloop/);
});
test('win32 wraps claude/codex in cmd.exe and uses the Windows marker path', () => {
  const f = fixture({ platform: 'win32', home: 'C:\\Users\\x', exists: () => false });
  f.files.installed = listed; f.files.known = '{"makeloop":{}}';
  installMakeloop(f.options);
  // .cmd シム対策: 空白の無い引数は引用しない（引用すると codex が unexpected argument '"marketplace"' で落ちる）。
  assert.equal(f.calls[0][0], 'cmd.exe'); assert.equal(f.calls[0].at(-1), 'codex plugin marketplace add usedhonda/makeloop');
  assert.ok(f.calls.every(c => c.opts.stdio[0] === 'ignore'), 'stdin is closed for every child');
  assert.equal(f.writes[0][0], 'C:\\Users\\x\\.claude\\.makeloop-installed.json');
});
test('both hosts failing returns 1, marker represents actual failure', () => {
  const f = fixture({ exists: () => false, spawnImpl: () => ({ status: 1, stderr: 'missing executable' }) });
  const result = installMakeloop(f.options);
  assert.equal(result.exitCode, 1); assert.equal(result.claude, false); assert.equal(result.codex, false);
});
test('native codex is skipped once the WSL host already has the plugin', () => {
  const f = fixture({ platform: 'win32', home: 'C:\\Users\\x', wsl: { distro: 'Ubuntu', unixHome: '/home/x', home: '\\\\wsl$\\Ubuntu\\home\\x' },
    exists: p => p.startsWith('\\\\wsl$\\Ubuntu\\home\\x\\.codex\\plugins\\cache\\makeloop') });
  f.files.installed = listed; f.files.known = '{"makeloop":{}}';
  const result = installMakeloop(f.options);
  assert.equal(result.codex, true);
  assert.equal(f.calls.some(c => c[0] === 'cmd.exe' && /^codex /.test(c.at(-1))), false, 'no native codex call when WSL cache exists');
});
test('dry run invokes no processes and writes no marker', () => {
  const f = fixture(); assert.equal(installMakeloop({ ...f.options, dryRun: true }).exitCode, 0);
  assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
});
test('unrelated marketplace error never clones', () => {
  const f = fixture(); f.options.spawnImpl = (exe, args) => { f.calls.push([exe, ...args]); return { status: 1, stderr: 'network offline' }; };
  assert.equal(installMakeloop(f.options).claude, false);
  assert.equal(f.calls.some(c => c[0] === 'git'), false);
});
