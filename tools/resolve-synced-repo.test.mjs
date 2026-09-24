import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const helper = resolve('tools/resolve-synced-repo.ps1');
const toolsDir = dirname(helper);

// The helper only ever runs on Windows, so the PowerShell tests skip everywhere else
// (the Linux CI runner has no powershell.exe). The static checks always run.
const hasPowerShell = process.platform === 'win32' && (() => {
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0']);
  return !probe.error && probe.status === 0;
})();

function runHelper(expression, env = {}) {
  const command = `. '${helper}'\n$ErrorActionPreference = 'Stop'\n${expression}`;
  // Bypass mirrors how every register-*.ps1 is launched; without it a Restricted
  // machine refuses to dot-source the helper at all.
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command];
  const result = spawnSync('powershell.exe', args, {
    encoding: 'utf8',
    env: { ...process.env, ORGIAST_NIGHTLY_REPO: '', ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  // Windows PowerShell folds the warning stream into stdout once it is redirected, and
  // wraps it at the console width, so the resolved path is the last line and the warning
  // has to be matched with its line breaks flattened.
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const text = `${result.stdout}\n${result.stderr}`.replace(/\s+/g, ' ');
  return { out: lines[lines.length - 1] ?? '', lines, text };
}

function fakeSyncedRepo(name, files) {
  const root = mkdtempSync(join(tmpdir(), `synced-repo-${name}-`));
  for (const relative of files) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '# fixture\r\n', 'utf8');
  }
  return root;
}

test('resolves the synced repo when it carries the script the task runs', { skip: !hasPowerShell }, () => {
  const synced = fakeSyncedRepo('present', ['tools\\evening-digest.mjs']);
  const { out, text } = runHelper(
    "Resolve-RegisterRepoRoot -Fallback 'C:\\stale\\repo' -RequiredPaths @('tools\\evening-digest.mjs')",
    { ORGIAST_NIGHTLY_REPO: synced },
  );
  assert.equal(out.toLowerCase(), synced.toLowerCase());
  assert.doesNotMatch(text, /is missing|not found/);
});

test('falls back loudly when the synced repo lacks the script', { skip: !hasPowerShell }, () => {
  const synced = fakeSyncedRepo('missing', ['tools\\other.mjs']);
  const { out, text } = runHelper(
    "Resolve-RegisterRepoRoot -Fallback 'C:\\stale\\repo' -RequiredPaths @('tools\\evening-digest.mjs')",
    { ORGIAST_NIGHTLY_REPO: synced },
  );
  assert.equal(out, 'C:\\stale\\repo');
  assert.match(text, /is missing from the synced repo/);
});

test('falls back loudly when the synced repo is not there at all', { skip: !hasPowerShell }, () => {
  const { out, text } = runHelper(
    "Resolve-RegisterRepoRoot -Fallback 'C:\\stale\\repo'",
    { ORGIAST_NIGHTLY_REPO: join(tmpdir(), 'synced-repo-that-does-not-exist') },
  );
  assert.equal(out, 'C:\\stale\\repo');
  assert.match(text, /synced repo not found/);
});

test('defaults to the directory nightly-bootstrap actually syncs', { skip: !hasPowerShell }, () => {
  const { lines } = runHelper("Get-SyncedRepoRoot\nWrite-Output (Join-Path $HOME '.claude\\nightly-repo')");
  const [resolved, expected] = lines;
  assert.equal(resolved, expected.replace(/\\+$/, ''));
});

test('the tools-directory form points inside the synced repo', { skip: !hasPowerShell }, () => {
  const synced = fakeSyncedRepo('toolsdir', ['tools\\backup-claude-to-drive.ps1']);
  const { out } = runHelper(
    "Resolve-RegisterToolsDir -Fallback 'C:\\stale\\repo\\tools' -RequiredLeaves @('backup-claude-to-drive.ps1')",
    { ORGIAST_NIGHTLY_REPO: synced },
  );
  assert.equal(out.toLowerCase(), join(synced, 'tools').toLowerCase());
});

test('the tools-directory form keeps the caller path when it falls back', { skip: !hasPowerShell }, () => {
  const synced = fakeSyncedRepo('toolsdir-missing', ['tools\\other.ps1']);
  const { out, text } = runHelper(
    "Resolve-RegisterToolsDir -Fallback 'C:\\stale\\repo\\tools' -RequiredLeaves @('backup-claude-to-drive.ps1')",
    { ORGIAST_NIGHTLY_REPO: synced },
  );
  assert.equal(out, 'C:\\stale\\repo\\tools');
  assert.match(text, /is missing from the synced repo/);
});

// The static half: a new register script that forgets the helper reintroduces the
// 2026-09-16 failure (tasks pinned to a copy nobody syncs), and nothing at runtime
// would say so, so it has to fail here instead.
function registerScripts() {
  return readdirSync(toolsDir)
    .filter((name) => /^register-.*\.ps1$/.test(name))
    .map((name) => ({ name, source: readFileSync(join(toolsDir, name), 'utf8') }))
    .filter(({ source }) => /(?:Register|Set)-ScheduledTask/.test(source));
}

test('every register script resolves the repo through the helper', () => {
  const scripts = registerScripts();
  assert.ok(scripts.length >= 15, `expected the register scripts to be found, got ${scripts.length}`);
  for (const { name, source } of scripts) {
    assert.match(source, /resolve-synced-repo\.ps1/, `${name} does not source the resolver`);
    assert.match(source, /Resolve-Register(RepoRoot|ToolsDir)/, `${name} does not call the resolver`);
  }
});

test('no register script pins a task to its own tree', () => {
  for (const { name, source } of registerScripts()) {
    assert.doesNotMatch(source, /-WorkingDirectory \$PSScriptRoot\b/, `${name} pins the working directory to its own tree`);
    assert.doesNotMatch(
      source,
      /^\$repo = Split-Path -Parent (?:\(Split-Path -Parent )?\$(?:PSScriptRoot|MyInvocation)/m,
      `${name} derives the repo from its own location`,
    );
  }
});

test('the resolver stays ASCII-only and BOM-free for PowerShell 5.1', () => {
  const bytes = readFileSync(helper);
  assert.notEqual(bytes.slice(0, 3).toString('hex'), 'efbbbf', 'the resolver must not carry a UTF-8 BOM');
  const nonAscii = bytes.find((byte) => byte > 0x7f);
  assert.equal(nonAscii, undefined, 'the resolver must stay ASCII-only');
});
