import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main, POLL_HARD_DEADLINE_EXIT } from './fleet-mail.mjs';
import { reapStalePolls, POLL_REAP_AFTER_MS } from './lib/fleet-poll-reaper.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-lifecycle-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  return home;
}

for (const mode of ['completed', 'hung-fetch', 'failed-logging']) {
  test(`poll CLI exits with live handles: ${mode}`, t => {
    const home = fixture(t), dir = path.join(home, '.claude');
    if (mode !== 'completed') {
      fs.writeFileSync(path.join(dir, 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.invalid\nFLEET_SHEET_TOKEN=test\n');
      fs.writeFileSync(path.join(dir, 'cost-reporter.env'), 'REPORTER_LABEL=kim-PC\n');
    }
    const preload = path.join(home, 'preload.mjs');
    fs.writeFileSync(preload, `
      import fs from 'node:fs';
      const original = globalThis.setTimeout;
      globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms === 15 * 60_000 ? 300 : ms, ...args);
      globalThis.fetch = () => new Promise(() => {});
      setInterval(() => {}, 1000);
      ${mode === 'failed-logging' ? `
        const append = fs.appendFileSync;
        fs.appendFileSync = (file, ...args) => {
          if (String(file).endsWith('fleet-mail-poll-timing.jsonl')) throw new Error('disk failure');
          return append(file, ...args);
        };
        console.error = () => { throw new Error('stderr failure'); };
      ` : ''}
    `);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href,
      fileURLToPath(new URL('./fleet-mail.mjs', import.meta.url)), '--poll', '--no-exec'], {
      env: { ...process.env, ORGIAST_HOME: home, FLEET_NO_SELF_HEAL: '1' }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, mode === 'completed' ? 0 : POLL_HARD_DEADLINE_EXIT, result.stderr);
    assert.equal(fs.existsSync(path.join(dir, 'fleet-mail.lock')), false);
    if (mode === 'hung-fetch') {
      const lines = fs.readFileSync(path.join(dir, 'fleet-mail-poll-timing.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(lines.at(-1).outcome, mode === 'completed' ? 'unconfigured' : 'hard-deadline');
      if (mode === 'hung-fetch') assert.equal(lines.at(-1).stuckIn, 'mail-poll');
    }
  });
}

test('poll recovers before lock acquisition and dry-run never recovers', async t => {
  const home = fixture(t);
  fs.writeFileSync(path.join(home, '.claude/fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.invalid\nFLEET_SHEET_TOKEN=test\n');
  let called = 0;
  const deps = { home, stdout() {}, stderr() {}, reapStalePolls: async () => { called++; },
    label: 'test', request: async () => ({ messages: [] }), dailySelfHeal: async () => {}, autoRunFixNow: async () => {},
    dailyLaneHealth: async () => {}, dailyRuleCompliance: async () => {}, notifyArrival: async () => false };
  await main(['--poll', '--dry-run'], deps);
  assert.equal(called, 0);
  await main(['--poll'], deps);
  assert.equal(called, 1);
});

test('reaper bounds its Windows helper and reports failures without raw command output', async t => {
  const home = fixture(t), script = path.join(home, '.claude', 'nightly-repo', 'tools', 'fleet-mail.mjs');
  fs.mkdirSync(path.dirname(script), { recursive: true }); fs.writeFileSync(script, '');
  const errors = [], calls = [];
  const deps = { home, platform: 'win32', stderr: x => errors.push(x), execFileImpl: async (...args) => { calls.push(args); return { stdout: '2\r\n' }; } };
  assert.equal(await reapStalePolls(deps), 2);
  const [exe, args, options] = calls[0];
  assert.equal(exe, 'powershell.exe');
  assert.equal(args[args.indexOf('-PollScript') + 1], script);
  assert.equal(args[args.indexOf('-CallerPid') + 1], String(process.pid));
  assert.equal(args[args.indexOf('-MaxAgeMs') + 1], String(POLL_REAP_AFTER_MS));
  assert.equal(args[args.indexOf('-LogFile') + 1], path.join(home, '.claude', 'logs', 'fleet-mail.log'));
  assert.equal(fs.existsSync(path.join(home, '.claude', 'logs')), true);
  assert.equal(options.timeout, 15_000);
  assert.equal(await reapStalePolls({ ...deps, execFileImpl: async () => { throw Error('secret command'); } }), 0);
  assert.deepEqual(errors, ['fleet-mail: stale poll recovery failed=1']);
  assert.equal(await reapStalePolls({ ...deps, platform: 'linux', execFileImpl: () => assert.fail('spawn') }), 0);
});

test('Windows reaper only kills exact stale poll identities, rechecks races, and logs each kill', { skip: process.platform !== 'win32' }, t => {
  const home = fixture(t), node = 'C:\\Program Files\\nodejs\\node.exe';
  const script = 'C:\\Users\\receiver\\.claude\\nightly-repo\\tools\\fleet-mail.mjs';
  const old = new Date(Date.now() - 19 * 60_000).toISOString();
  const command = `"${node}" ${script} --poll`;
  const row = (ProcessId, patch = {}) => ({ ProcessId, ExecutablePath: node, CommandLine: command, CreationDate: old, ...patch });
  const rows = [row(101), row(102, { CommandLine: `"${node}" "${script.toUpperCase()}"\t--poll ` }),
    row(42), row(103, { CreationDate: new Date().toISOString() }),
    row(104, { CreationDate: new Date(Date.now() + 60_000).toISOString() }), row(105, { CreationDate: null }),
    ...[' --no-exec', ' --dry-run', ' --json', ' --send', ' extra', '\n'].map((suffix, n) => row(110 + n, { CommandLine: command + suffix })),
    row(120, { CommandLine: command.replace('--poll', '--polling') }),
    row(121, { CommandLine: command.replace('nightly-repo', 'other-repo') }),
    row(122, { CommandLine: command.replace('fleet-mail.mjs', 'fleet-mail.mjs.bak') }),
    row(123, { CommandLine: `"${node}" -e "${script} --poll"` }),
    row(124, { CommandLine: `"${node}" tools\\fleet-mail.mjs --poll` }),
    row(125, { ExecutablePath: 'C:\\other\\node.exe' }),
    row(126, { CommandLine: command.replace('fleet-mail.mjs', 'fleet-mail-watchdog.mjs') }),
    row(130), row(131), row(132), row(133), row(134),
  ];
  const input = path.join(home, 'processes.json'), wrapper = path.join(home, 'reaper-test.ps1'), log = path.join(home, 'fleet-mail.log');
  fs.writeFileSync(input, JSON.stringify(rows));
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  fs.writeFileSync(wrapper, `
    $rows = Get-Content -LiteralPath ${quote(input)} -Raw | ConvertFrom-Json
    foreach ($r in $rows) { if ($null -ne $r.CreationDate) { $r.CreationDate = [DateTime]::Parse($r.CreationDate).ToUniversalTime() } }
    function Get-CimInstance($ClassName, $Filter) {
      if ($Filter -eq "Name = 'node.exe'") { return $rows }
      $id = [int]($Filter -replace 'ProcessId = ', '')
      $found = $rows | Where-Object ProcessId -eq $id
      if ($id -eq 130) { $found.CommandLine += ' --dry-run' }
      if ($id -eq 131) { return $null }
      if ($id -eq 132) { return [pscustomobject]@{ ProcessId=132; ExecutablePath=$found.ExecutablePath; CommandLine=$found.CommandLine; CreationDate=[DateTime]::UtcNow } }
      return $found
    }
    function Get-Process($Id) {
      if ($Id -eq 134) { throw 'access denied' }
      $found = $rows | Where-Object ProcessId -eq $Id
      $start = if ($Id -eq 133) { [DateTime]::UtcNow } else { $found.CreationDate }
      $p = [pscustomobject]@{ Id=$Id; Handle=1; StartTime=$start }
      $p | Add-Member ScriptMethod Kill { [IO.File]::AppendAllText(${quote(path.join(home, 'kills.txt'))}, [string]$this.Id + ','); if ($this.Id -notin @(101,102)) { throw 'unexpected kill' } }
      $p | Add-Member ScriptMethod WaitForExit { param($ms) return $true }
      $p | Add-Member ScriptMethod Dispose { }
      return $p
    }
    # The scheduled-task wrapper holds the primary log open for redirected output.
    $logHandle = [IO.File]::Open(${quote(log)}, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    try {
      & ${quote(fileURLToPath(new URL('./lib/fleet-poll-reaper.ps1', import.meta.url)))} -PollScript ${quote(script)} -NodeExe ${quote(node)} -CallerPid 42 -MaxAgeMs ${POLL_REAP_AFTER_MS} -LogFile ${quote(log)}
    } finally { $logHandle.Dispose() }
    foreach ($e in $Error) { [Console]::Error.WriteLine($e.Exception.Message) }
  `);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '2', result.stderr);
  assert.equal(fs.readFileSync(path.join(home, 'kills.txt'), 'utf8'), '101,102,');
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /stale-poll-reaped pid=101 startedAt=/);
  assert.match(lines[1], /stale-poll-reaped pid=102 startedAt=/);
  assert.doesNotMatch(lines.join('\n'), /CommandLine|receiver/);
});
