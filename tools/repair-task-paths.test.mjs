import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  root = realpathSync.native(mkdtempSync(join(process.platform === 'linux' && hasPowerShell ? process.cwd() : tmpdir(), 'repair-task-paths-')));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

// Builds a synced repo (optionally holding the script a task points at) plus a stale
// copy, then runs the repair in dry-run mode over a synthetic task snapshot.
function runPlan(name, { actions, presentTools = [], setup, inject = true }) {
  const dir = join(root, name);
  const synced = join(dir, 'nightly-repo');
  const stale = join(dir, 'orgiast-claude-rules');
  mkdirSync(join(synced, 'tools'), { recursive: true });
  mkdirSync(join(stale, 'tools'), { recursive: true });
  for (const tool of presentTools) writeFileSync(join(synced, 'tools', tool), '# fixture\n');

  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['init', '-q', synced]);
  if (!setup) execFileSync('git', ['init', '-q', stale]);
  const actualStale = setup ? setup(stale, dir) : stale;
  const syncedWin = toWindowsPath(synced);
  const staleWin = toWindowsPath(actualStale);
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
    `$env:ORGIAST_STALE_REPO_ROOTS = ${psQuote(inject ? staleWin : '')}`,
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


test('real git worktree origin is discovered without root injection', { skip: !hasPowerShell }, () => {
  const { result, plan, synced } = runPlan('worktree', {
    inject: false,
    presentTools: ['worker.mjs'],
    setup: (stale, dir) => {
      const worktree = join(dir, 'messenger-watch-wt');
      const launcher = join(dir, 'windows-worktree.ps1');
      const quote = value => `'${value.replaceAll("'", "''")}'`;
      const repo = quote(toWindowsPath(stale));
      writeFileSync(launcher, [
        `git init ${repo}`,
        `git -C ${repo} remote add origin https://github.com/kimkon1011/orgiast-claude-rules.git`,
        `git -C ${repo} -c user.name=Fixture -c user.email=fixture@example.com commit --allow-empty -m fixture`,
        `git -C ${repo} worktree add --detach ${quote(toWindowsPath(worktree))}`,
        'exit $LASTEXITCODE',
      ].join('\n'));
      execFileSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', toWindowsPath(launcher)]);
      return worktree;
    },
    actions: stale => [{ Execute: 'node.exe', Arguments: `"${stale}\\tools\\worker.mjs"`, WorkingDirectory: stale }],
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].NewWorkingDirectory, synced);
  assert.match(plan[0].NewArguments, /nightly-repo/);
});

test('injected auto-session root is reported and left unchanged', { skip: !hasPowerShell }, () => {
  const homeWin = execFileSync(powershell, ['-NoProfile', '-Command', '[Console]::Write($HOME)'], { encoding: 'utf8' }).trim();
  const { result, plan } = runPlan('pinned', {
    setup: () => process.platform === 'win32' ? `${homeWin}\\.claude\\auto-session-repo` : execFileSync('wslpath', ['-u', `${homeWin}\\.claude\\auto-session-repo`], { encoding: 'utf8' }).trim(),
    actions: stale => [{ Execute: 'node.exe', Arguments: `"${stale}\\tools\\auto-session-launcher.mjs"` }],
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(plan[0].Status, 'pinned:auto-session');
  assert.equal(plan[0].NewArguments, plan[0].OldArguments);
});

test('root prefix sibling is not rewritten', { skip: !hasPowerShell }, () => {
  const { result, plan } = runPlan('prefix-sibling', {
    actions: stale => [{ Execute: 'node.exe', Arguments: `"${stale}-other\\tools\\worker.mjs"` }],
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(plan.length, 0);
});

test('missing working directory prevents rewriting the entire action', { skip: !hasPowerShell }, () => {
  const { result, plan } = runPlan('missing-working-directory', {
    presentTools: ['worker.mjs'],
    actions: stale => [{ Execute: 'node.exe', Arguments: `"${stale}\\tools\\worker.mjs"`, WorkingDirectory: `${stale}\\absent` }],
  });
  assert.equal(result.status, 1);
  assert.equal(plan[0].Status, 'skipped-missing');
});
