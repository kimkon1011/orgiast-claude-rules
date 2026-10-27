import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const setup = path.join(toolsDir, 'setup.mjs');
const temp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const run = (args, env = {}) => spawnSync(process.execPath, [setup, ...args], { encoding: 'utf8', env: { ...process.env, ORGIAST_REPO: path.dirname(toolsDir), FLEET_BEACON: '0', ...env } });
const manifest = (items) => ({ version: 1, items });
const item = (id, type, spec, severity = 'required', extra = {}) => ({ id, type, severity, spec, description: id, ...extra });

test('empty HOME fails and file fixtures converge to success', () => {
  const home = temp('setup-home-');
  const mf = path.join(home, 'manifest.json');
  const items = [
    item('contains', 'file-contains', { path: 'a.txt', contains: 'needle' }),
    item('nonempty', 'file-nonempty', { path: 'b.txt' }),
    item('json', 'json-valid', { path: 'c.json', bom: false }),
  ];
  write(mf, JSON.stringify(manifest(items)));
  assert.equal(run(['--verify', '--home', home, '--manifest', mf]).status, 1);
  write(path.join(home, 'a.txt'), 'a needle b');
  write(path.join(home, 'b.txt'), 'x');
  write(path.join(home, 'c.json'), '{"ok":true}\n');
  assert.equal(run(['--verify', '--home', home, '--manifest', mf]).status, 0);
});

test('BOM-prefixed JSON is invalid', () => {
  const home = temp('setup-bom-');
  const mf = path.join(home, 'manifest.json');
  write(path.join(home, '.claude/settings.json'), '\uFEFF{}');
  write(mf, JSON.stringify(manifest([item('settings', 'json-valid', { path: '.claude/settings.json', bom: false })])));
  const result = run(['--home', home, '--manifest', mf]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^\[NG \] settings/m);
});

test('broken manifest fails without stack trace', () => {
  const home = temp('setup-broken-');
  const mf = path.join(home, 'broken.json');
  write(mf, '{broken');
  const result = run(['--home', home, '--manifest', mf]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^\[NG \] manifest:invalid/m);
  assert.doesNotMatch(result.stdout + result.stderr, /\n\s+at\s|SyntaxError:/);
});

test('converge repairs, rechecks, and is idempotent', () => {
  const home = temp('setup-converge-');
  const target = path.join(home, 'fixed.txt');
  const helper = path.join(home, 'repair.mjs');
  const mf = path.join(home, 'manifest.json');
  write(helper, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(target)}, 'ready');\n`);
  write(mf, JSON.stringify(manifest([item('fixed', 'file-contains', { path: 'fixed.txt', contains: 'ready' }, 'required', { repair: [helper] })])));
  const first = run(['--converge', '--json', '--home', home, '--manifest', mf]);
  assert.equal(first.status, 0);
  assert.deepEqual(JSON.parse(first.stdout).items[0], { id: 'fixed', severity: 'required', status: 'OK', checked: true, repaired: true });
  const before = fs.statSync(target).mtimeMs;
  const second = run(['--converge', '--json', '--home', home, '--manifest', mf]);
  assert.equal(second.status, 0);
  assert.equal(JSON.parse(second.stdout).items[0].status, 'OK');
  assert.equal(fs.statSync(target).mtimeMs, before);
});

test('manifest schema rejects duplicate ids and unknown enums', () => {
  const home = temp('setup-schema-');
  for (const [name, items] of [
    ['duplicate', [item('same', 'file-nonempty', { path: 'a' }), item('same', 'file-nonempty', { path: 'b' })]],
    ['type', [item('bad-type', 'unknown', { path: 'a' })]],
    ['severity', [item('bad-severity', 'file-nonempty', { path: 'a' }, 'unknown')]],
  ]) {
    const mf = path.join(home, `${name}.json`);
    write(mf, JSON.stringify(manifest(items)));
    const result = run(['--home', home, '--manifest', mf]);
    assert.equal(result.status, 1, name);
    assert.match(result.stdout, /manifest invalid/, name);
  }
});

test('win32: command type resolves .cmd shims (npm-installed CLIs like codex)', { skip: process.platform !== 'win32' }, () => {
  const home = temp('setup-cmdshim-');
  const name = `orgiast-shim-${process.pid}`;
  const dir = path.join(home, 'bin');
  write(path.join(dir, `${name}.cmd`), '@echo 1.2.3\r\n');
  const mf = path.join(home, 'manifest.json');
  write(mf, JSON.stringify(manifest([item(`cmd:${name}`, 'command', { command: name, versionRegex: '\\d+\\.\\d+\\.\\d+' })])));
  const result = spawnSync(process.execPath, [setup, '--json', '--home', home, '--manifest', mf], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir};${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).items[0].status, 'OK');
});

test('project manifest has unique known item types and severities', () => {
  const parsed = JSON.parse(fs.readFileSync(path.join(toolsDir, 'setup-manifest.json'), 'utf8'));
  const ids = parsed.items.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert(parsed.items.every((entry) => ['command', 'file-contains', 'file-nonempty', 'json-valid', 'scheduled-task'].includes(entry.type)));
  assert(parsed.items.every((entry) => ['required', 'optional', 'manual'].includes(entry.severity)));
  const outbound = parsed.items.find(entry => entry.id === 'settings:outbound-claim-evidence-gate');
  assert.deepEqual(outbound.spec, { path: '.claude/settings.json', hookEvent: 'PreToolUse', hookScript: 'outbound-claim-evidence-gate.mjs', hookArgs: '', async: false, timeout: 10 });
});

test('converge実経路がhook登録・旧通知削除・allow反映を行い再実行で不変', (t) => {
  const home = temp('setup-classifier-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const mf = path.join(home, 'manifest.json');
  write(mf, JSON.stringify(manifest([])));
  const file = path.join(home, '.claude', 'settings.json');
  write(file, JSON.stringify({ permissions: { allow: ['Bash(custom:*)'], deny: ['Bash(git push --force*)', 'Bash(git push -f*)'] }, hooks: { SessionStart: [{ hooks: [
    { command: 'node /old/ai-news-inject.mjs' }, { command: 'node /old/gtasks-pending-notice.mjs' }, { command: 'node custom.mjs' },
  ] }] } }));
  const args = ['--converge', '--json', '--home', home, '--manifest', mf];
  const first = run(args);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(settings.permissions.allow.includes('Bash(gh pr:*)'));
  assert(settings.permissions.allow.includes('Bash(custom:*)'));
  assert(settings.permissions.deny.includes('Bash(git push -f*)'));
  assert(settings.permissions.deny.includes('Bash(rm -rf *)'));
  assert(settings.permissions.deny.includes('Read(**/.env)'));
  assert.equal(settings.permissions.defaultMode, 'bypassPermissions');
  assert.equal(settings.language, 'japanese');
  const hooks = JSON.stringify(settings.hooks);
  assert.doesNotMatch(hooks, /ai-news-inject|gtasks-pending-notice/);
  assert.match(hooks, /custom\.mjs/);
  assert.match(hooks, /setup\.mjs.*--converge/);
  assert.equal(run(args).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), settings);
});

test('fleet mail scheduled task is skipped until its transport config exists', () => {
  const home = temp('setup-fleet-mail-');
  const mf = path.join(home, 'manifest.json');
  write(mf, JSON.stringify(manifest([item('task:fleet-mail', 'scheduled-task', { name: 'OrgiastFleetMail-test-missing', ifPresent: '.claude/fleet-sheet.env' }, 'optional')])));
  const first = run(['--json', '--home', home, '--manifest', mf]);
  assert.equal(JSON.parse(first.stdout).items[0].status, 'NOTICE');
  write(path.join(home, '.claude/fleet-sheet.env'), 'configured');
  const second = run(['--json', '--home', home, '--manifest', mf]);
  assert.equal(JSON.parse(second.stdout).items[0].status, 'NG');
  fs.rmSync(home, { recursive: true, force: true });
});

test('ifEnv 付き scheduled-task はフラグ未設定の PC で NOTICE になる', () => {
  const home = temp('setup-fleet-mail-guard-');
  const mf = path.join(home, 'manifest.json');
  const spec = { name: 'OrgiastFleetMailWatchdog-test-missing', ifPresent: '.claude/fleet-sheet.env', ifEnv: { path: '.claude/fleet-sheet.env', regex: '(?:^|\\r?\\n)\\s*FLEET_MAIL_WATCHDOG=1' } };
  write(mf, JSON.stringify(manifest([item('task:fleet-mail-watchdog', 'scheduled-task', spec, 'optional')])));
  // フラグが無い PC では登録側(.ps1)がタスクを作らないので、未登録でも NG にしない
  write(path.join(home, '.claude/fleet-sheet.env'), 'FLEET_SHEET_URL=x\n');
  assert.equal(JSON.parse(run(['--json', '--home', home, '--manifest', mf]).stdout).items[0].status, 'NOTICE');
  // フラグがある PC では登録を検査し、未登録なら NG
  write(path.join(home, '.claude/fleet-sheet.env'), 'FLEET_SHEET_URL=x\nFLEET_MAIL_WATCHDOG=1\n');
  assert.equal(JSON.parse(run(['--json', '--home', home, '--manifest', mf]).stdout).items[0].status, 'NG');
  fs.rmSync(home, { recursive: true, force: true });
});

test('async:false manifest accepts synchronous hooks and rejects async hooks', (t) => {
  const home = temp('setup-sync-hook-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const entry = JSON.parse(fs.readFileSync(path.join(toolsDir, 'setup-manifest.json'), 'utf8'))
    .items.find(entry => entry.id === 'settings:lane-health-SessionStart');
  assert.equal(entry.spec.async, false);
  const mf = path.join(home, 'manifest.json');
  for (const timeout of [undefined, 9]) {
    const spec = { ...entry.spec, ...(timeout === undefined ? {} : { timeout }) };
    write(mf, JSON.stringify(manifest([{ ...entry, spec }])));
    const hook = { type: 'command', command: `node "${path.join(toolsDir, spec.hookScript)}" --hook`, timeout: timeout ?? 5 };
    for (const [change, expected] of [[{}, 0], [{ async: false }, 0], [{ async: true }, 1], [{ async: null }, 1], [{ timeout: 3 }, 1], [{ command: hook.command.replace(' --hook', '') }, 1]]) {
      write(path.join(home, spec.path), JSON.stringify({ hooks: { [spec.hookEvent]: [{ hooks: [{ ...hook, ...change }] }] } }));
      const result = run(['--verify', '--home', home, '--manifest', mf]);
      assert.equal(result.status, expected, result.stdout + result.stderr);
    }
  }
});

test('manifest async default still requires async:true for both purge-sessions events', (t) => {
  const home = temp('setup-async-hook-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const entries = JSON.parse(fs.readFileSync(path.join(toolsDir, 'setup-manifest.json'), 'utf8'))
    .items.filter(entry => entry.id.startsWith('settings:purge-sessions-'));
  assert.equal(entries.length, 2);
  const mf = path.join(home, 'manifest.json');
  for (const entry of entries) {
    assert.equal(entry.spec.async, undefined);
    write(mf, JSON.stringify(manifest([entry])));
    const hook = { type: 'command', command: `node "${path.join(toolsDir, entry.spec.hookScript)}" --hook`, timeout: 5 };
    for (const [change, expected] of [[{}, 1], [{ async: false }, 1], [{ async: true }, 0], [{ async: true, timeout: 9 }, 1], [{ async: true, command: hook.command.replace(' --hook', '') }, 1]]) {
      write(path.join(home, entry.spec.path), JSON.stringify({ hooks: { [entry.spec.hookEvent]: [{ hooks: [{ ...hook, ...change }] }] } }));
      const result = run(['--verify', '--home', home, '--manifest', mf]);
      assert.equal(result.status, expected, entry.id + ': ' + result.stdout + result.stderr);
    }
  }
});

// --- fleet ビーコン送信（実 GAS には絶対に出ない。ローカル http サーバーか未到達ポートのみ） ---
const beaconEnv = (home, extra = {}) => ({ ...process.env, ORGIAST_REPO: path.dirname(toolsDir), FLEET_BEACON_ALLOW_MANIFEST: '1', ...extra });
const writeSheetEnv = (home, url) => write(path.join(home, '.claude', 'fleet-sheet.env'), `FLEET_SHEET_URL=${url}\nFLEET_SHEET_TOKEN=test-token\n`);
const beaconManifest = (home) => {
  const mf = path.join(home, 'manifest.json');
  write(mf, JSON.stringify(manifest([item('beacon-item', 'file-nonempty', { path: 'present.txt' })])));
  write(path.join(home, 'present.txt'), 'x');
  return mf;
};

test('beacon: --manifest converge does not send even when fleet-sheet.env exists', (t) => {
  const home = temp('setup-beacon-manifest-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const mf = beaconManifest(home);
  // 到達しない捨てポート。送れば接続失敗するが、そもそも送らないので exit 0 のまま。
  writeSheetEnv(home, 'http://127.0.0.1:1/exec');
  const env = { ...process.env, ORGIAST_REPO: path.dirname(toolsDir) };
  delete env.FLEET_BEACON_ALLOW_MANIFEST;
  const result = spawnSync(process.execPath, [setup, '--converge', '--home', home, '--manifest', mf], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /\[beacon\]/);
});

test('beacon: --no-beacon and FLEET_BEACON=0 suppress sending', (t) => {
  const home = temp('setup-beacon-off-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const mf = beaconManifest(home);
  writeSheetEnv(home, 'http://127.0.0.1:1/exec');
  const noBeacon = spawnSync(process.execPath, [setup, '--converge', '--no-beacon', '--home', home, '--manifest', mf], { encoding: 'utf8', env: beaconEnv(home) });
  assert.equal(noBeacon.status, 0, noBeacon.stdout + noBeacon.stderr);
  assert.doesNotMatch(noBeacon.stdout, /\[beacon\]/);
  const envOff = spawnSync(process.execPath, [setup, '--converge', '--home', home, '--manifest', mf], { encoding: 'utf8', env: beaconEnv(home, { FLEET_BEACON: '0' }) });
  assert.equal(envOff.status, 0, envOff.stdout + envOff.stderr);
  assert.doesNotMatch(envOff.stdout, /\[beacon\]/);
});

test('beacon: converge posts kind=fleet-beacon without secrets or absolute paths', async (t) => {
  const home = temp('setup-beacon-send-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const mf = beaconManifest(home);
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, beacon: { label: 'test', reportedAt: new Date().toISOString() } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  writeSheetEnv(home, `http://127.0.0.1:${server.address().port}/exec`);
  const child = spawn(process.execPath, [setup, '--converge', '--home', home, '--manifest', mf], { encoding: 'utf8', env: beaconEnv(home) });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, stdout);
  assert.equal(received.length, 1);
  const payload = received[0];
  assert.equal(payload.kind, 'fleet-beacon');
  assert.equal(payload.token, 'test-token');
  const { token, ...rest } = payload;
  const serialized = JSON.stringify(rest);
  assert.doesNotMatch(serialized, /test-token/); // token 以外に秘密を含まない
  assert.doesNotMatch(serialized, /[A-Za-z]:\\/); // home の絶対パスを含まない
  assert.ok(payload.steps.some((step) => step.id === 'beacon-item'));
  assert.match(stdout, /\[beacon\] sent/);
});

test('beacon: server 500 or unreachable keeps exit code unchanged', (t) => {
  const home = temp('setup-beacon-fail-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const mf = beaconManifest(home);
  writeSheetEnv(home, 'http://127.0.0.1:1/exec');
  const result = spawnSync(process.execPath, [setup, '--converge', '--home', home, '--manifest', mf], { encoding: 'utf8', env: beaconEnv(home) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\[beacon\] failed/);
});

test('E task:fleet-mail converge adds hub configuration even with the v2 migration already complete', t => {
  const home = temp('setup-fleet-hub-'); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  write(path.join(home, '.claude', 'fleet-sheet.env'), 'FLEET_SHEET_URL=fixture\nFLEET_SHEET_TOKEN=fixture\n');
  write(path.join(home, '.claude', 'cost-reporter.env'), 'REPORTER_LABEL=receiver-PC\n');
  write(path.join(home, '.claude', '.fleet-mail-v2-migrated'), 'already migrated');
  const standard = JSON.parse(fs.readFileSync(path.join(toolsDir, 'setup-manifest.json'), 'utf8'));
  const task = standard.items.find(i => i.id === 'task:fleet-mail');
  assert.equal(task.spec.hubMode, true);
  const mf = path.join(home, 'manifest.json'); write(mf, JSON.stringify(manifest([task])));
  const result = run(['--converge', '--json', '--home', home, '--manifest', mf]);
  assert.equal(result.status, 0);
  assert.match(fs.readFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'utf8'), /FLEET_HUB=kim-PC/);
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.hooks.Stop.some(g => g.hooks.some(h => h.command.includes('fleet-question-relay.mjs') && h.timeout === 5)));
});

test('playbook配布は未導入だけコピーしPCの追記を保持する', async t => {
  const { distributePlaybooks } = await import('./lib/playbook-distribution.mjs');
  const repo = temp('playbook-repo-'), home = temp('playbook-home-'); t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
  write(path.join(repo, 'playbooks', 'Example.md'), '実測');
  assert.equal(distributePlaybooks(repo, home), 1);
  const target = path.join(home, '.claude', 'playbooks', 'Example.md'); assert.equal(fs.readFileSync(target, 'utf8'), '実測');
  write(target, 'PCで追記した実測'); assert.equal(distributePlaybooks(repo, home), 0); assert.equal(fs.readFileSync(target, 'utf8'), 'PCで追記した実測');
  const mf = path.join(home, 'manifest.json'); write(mf, JSON.stringify(manifest([])));
  const result = run(['--converge', '--home', home, '--manifest', mf, '--json']); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).items.find(i => i.id === 'playbooks').status, 'OK');
});


test('inbox verifier accepts nightly runtime with old bootstrap main and still rejects a missing hook', t => {
  const home = temp('setup-inbox-anchor-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const entry = JSON.parse(fs.readFileSync(path.join(toolsDir, 'setup-manifest.json'), 'utf8')).items.find(x => x.id === 'hook:auto-progress-inbox');
  const mf = path.join(home, 'manifest.json');
  write(mf, JSON.stringify(manifest([entry])));
  write(path.join(home, 'orgiast-claude-rules/tools/setup.mjs'), '// old main');
  assert.equal(run(['--verify', '--home', home, '--manifest', mf]).status, 1);
  write(path.join(home, '.claude/nightly-repo/tools/auto-progress-inbox-hook.mjs'), fs.readFileSync(path.join(toolsDir, 'auto-progress-inbox-hook.mjs')));
  const result = run(['--verify', '--home', home, '--manifest', mf]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // The original PR only inspected the old main installation: reproduce its failure.
  write(mf, JSON.stringify(manifest([{ ...entry, spec: { paths: entry.spec.paths.filter(p => !p.startsWith('.claude/')) } }])));
  assert.equal(run(['--verify', '--home', home, '--manifest', mf]).status, 1);
});

test('verify-before-done manifest validates synchronous wrapped Stop registration', t => {
  const home = temp('setup-verify-done-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const entry = JSON.parse(fs.readFileSync(path.join(toolsDir, 'setup-manifest.json'), 'utf8')).items.find(e => e.id === 'settings:verify-before-done');
  const mf = path.join(home, 'manifest.json');
  write(mf, JSON.stringify(manifest([entry])));
  const hook = { type: 'command', command: `node "${path.join(toolsDir, 'gate-hook-runner.mjs')}" "${path.join(toolsDir, 'verify-before-done-detector.mjs')}"`, timeout: 15 };
  for (const [change, event, expected] of [[{}, 'Stop', 0], [{ async: true }, 'Stop', 1], [{ command: 'pwsh -File verify-before-done-detector.ps1' }, 'Stop', 1], [{}, 'SessionStart', 1]]) {
    write(path.join(home, '.claude/settings.json'), JSON.stringify({ hooks: { [event]: [{ hooks: [{ ...hook, ...change }] }] } }));
    const result = run(['--verify', '--home', home, '--manifest', mf]);
    assert.equal(result.status, expected, result.stdout + result.stderr);
  }
});

for (const [name, change, expected] of [
  ['existing action targets and recent run are OK', {}, 'OK'],
  ['missing mjs in Arguments is NG', { missing: true }, 'NG'],
  ['run older than maxRunAgeHours is NG', { age: 60 }, 'NG'],
  ['never run required task is NOTICE and verify succeeds', { lastRunTime: '' }, 'NOTICE'],
  ['pre-2000 last run is NOTICE', { lastRunTime: '1999-12-31T00:00:00Z' }, 'NOTICE'],
  ['unregistered fixture task is NG', { registered: false }, 'NG'],
  ['task absent from fixture is NG', { absent: true }, 'NG'],
  ['legacy spec only checks registration with fixture', { legacy: true, missing: true, age: 60 }, 'OK'],
]) {
  test(`scheduled-task: ${name}`, (t) => {
    const home = temp('setup-task-info-');
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const mf = path.join(home, 'manifest.json');
    const fixture = path.join(home, 'task-info.json');
    const wrapper = path.join(home, 'space dir', 'run-hidden.vbs');
    const script = path.join(home, 'space dir', 'stall-sweeper.mjs');
    write(wrapper, 'wrapper');
    if (!change.missing) write(script, 'script');
    const spec = { name: 'TestTask', ...(change.legacy ? {} : { requireActionTarget: true, maxRunAgeHours: 50 }) };
    write(mf, JSON.stringify(manifest([item('task:test', 'scheduled-task', spec)])));
    write(fixture, JSON.stringify(change.absent ? {} : { TestTask: {
      registered: change.registered ?? true,
      actions: [`wscript.exe //nologo "${wrapper}" "C:\\Program Files\\nodejs\\node.exe" "${script}" "--apply"`],
      lastRunTime: change.lastRunTime ?? new Date(Date.now() - (change.age ?? 1) * 3600000).toISOString(),
    } }));
    const result = run(['--verify', '--json', '--home', home, '--manifest', mf], { ORGIAST_SETUP_TASK_INFO_FIXTURE: fixture });
    assert.equal(result.status, expected === 'NG' ? 1 : 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).items[0].status, expected);
  });
}
