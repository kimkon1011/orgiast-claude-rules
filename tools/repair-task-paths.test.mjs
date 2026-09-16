import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const script = resolve('tools/repair-task-paths.ps1');
const powershell = process.platform === 'win32'
  ? 'powershell.exe'
  : '/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe';
const hasPowerShell = (() => {
  const probe = spawnSync(powershell, ['-NoProfile', '-Command', 'exit 0']);
  return !probe.error && probe.status === 0;
})();
let root;

function toWindowsPath(path) {
  if (process.platform === 'win32') return path;
  return execFileSync('wslpath', ['-w', path], { encoding: 'utf8' }).trim();
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'repair-task-paths-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

// Builds a synced repo (optionally holding the script a task points at) plus a stale
// copy, then runs the repair in dry-run mode over a synthetic task snapshot.
function runPlan(name, { actions, presentTools = [] }) {
  const dir = join(root, name);
  const synced = join(dir, 'nightly-repo');
  const stale = join(dir, 'orgiast-claude-rules');
  mkdirSync(join(synced, 'tools'), { recursive: true });
  mkdirSync(join(stale, 'tools'), { recursive: true });
  for (const tool of presentTools) writeFileSync(join(synced, 'tools', tool), '# fixture\n');

  const syncedWin = toWindowsPath(synced);
  const staleWin = toWindowsPath(stale);
  const inputPath = join(dir, 'tasks.json');
  const outPath = join(dir, 'plan.json');
  writeFileSync(inputPath, JSON.stringify([{
    TaskName: 'OrgiastFixture',
    Actions: actions(staleWin, syncedWin),
  }]), 'utf8');

  const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const launcher = join(dir, 'invoke.ps1');
  writeFileSync(launcher, [
    `$env:ORGIAST_NIGHTLY_REPO = ${psQuote(syncedWin)}`,
    `$env:ORGIAST_STALE_REPO_ROOTS = ${psQuote(staleWin)}`,
    `& ${psQuote(toWindowsPath(script))} -InputJson ${psQuote(toWindowsPath(inputPath))} -OutJson ${psQuote(toWindowsPath(outPath))}`,
    'exit $LASTEXITCODE',
  ].join('\n'), 'utf8');

  const result = spawnSync(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', toWindowsPath(launcher),
  ], { encoding: 'utf8' });

  const raw = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
  assert.ok(raw, `plan.json was not written: ${result.stdout}${result.stderr}`);
  const plan = JSON.parse(raw);
  return { result, plan: plan === null ? [] : [].concat(plan), synced: syncedWin, stale: staleWin };
}

test('stale repo root in Arguments is rewritten to the synced repo', { skip: !hasPowerShell }, () => {
  const { result, plan, synced } = runPlan('rewrite-arguments', {
    presentTools: ['tetsuko-growth-loop.mjs'],
    actions: (stale) => [{
      Execute: String.raw`C:\WINDOWS\System32\wscript.exe`,
      Arguments: String.raw`//nologo "${stale}\tools\tetsuko-growth-loop.mjs"`,
    }],
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].Status, 'planned');
  assert.equal(plan[0].NewArguments, String.raw`//nologo "${synced}\tools\tetsuko-growth-loop.mjs"`);
});

test('stale repo root in Execute is rewritten too', { skip: !hasPowerShell }, () => {
  const { result, plan, synced } = runPlan('rewrite-execute', {
    presentTools: ['night-watchdog.mjs'],
    actions: (stale) => [{
      Execute: String.raw`${stale}\tools\night-watchdog.mjs`,
      Arguments: '',
    }],
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(plan[0].NewExecute, String.raw`${synced}\tools\night-watchdog.mjs`);
});

test('rewrite is skipped and reported when the script is absent from the synced repo', { skip: !hasPowerShell }, () => {
  const { result, plan } = runPlan('missing-target', {
    presentTools: [],
    actions: (stale) => [{
      Execute: String.raw`C:\Program Files\nodejs\node.exe`,
      Arguments: String.raw`"${stale}\tools\night-watchdog.mjs"`,
    }],
  });
  assert.equal(result.status, 1, 'a missing target must fail the run');
  assert.equal(plan[0].Status, 'skipped-missing');
  assert.match(result.stdout, /night-watchdog\.mjs/);
});

test('actions already pointing at the synced repo produce no changes', { skip: !hasPowerShell }, () => {
  const { result, plan } = runPlan('already-synced', {
    presentTools: ['fleet-agent.mjs'],
    actions: (_stale, synced) => [{
      Execute: String.raw`C:\Program Files\nodejs\node.exe`,
      Arguments: String.raw`"${synced}\tools\fleet-agent.mjs"`,
    }],
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(plan.length, 0);
  assert.match(result.stdout, /ok:dry-run/);
});
