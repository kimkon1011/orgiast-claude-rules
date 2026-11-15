import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('./bootstrap.ps1', import.meta.url), 'utf8');
test('standalone bootstrap remains ASCII for Windows PowerShell 5.1', () => {
  assert.match(source, /^[\x00-\x7f]*$/);
});

for (const status of [0, 23]) {
  test(`PS5.1 bootstrap preserves stderr and setup exit ${status} through Tee-Object`, {
    skip: process.platform !== 'win32',
  }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'bootstrap space & fixture '));
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    try {
      mkdirSync(join(dir, 'tools'));
      // Exercise a quoted executable path as well as a repository path with spaces.
      const node = join(dir, 'node.exe');
      copyFileSync(process.execPath, node);
      writeFileSync(join(dir, 'tools', 'setup.mjs'), `console.log('setup-stdout'); console.error('setup-stderr'); process.exitCode = ${status};`);
      const block = source.slice(source.indexOf('if (Have node) {'));
      const child = join(dir, 'child.ps1');
      writeFileSync(child, `$ErrorActionPreference = 'Stop'\nfunction Have { $true }\n$Repo = ${quote(dir)}\nfunction Get-Command { [pscustomobject]@{ Extension = '.exe'; Source = ${quote(node)} } }\n${block}`);
      const log = join(dir, 'bootstrap.log');
      const launcher = join(dir, 'launcher.ps1');
      writeFileSync(launcher, `$ErrorActionPreference = 'Stop'\n& powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${quote(child)} *>&1 | Tee-Object -FilePath ${quote(log)}\nexit $LASTEXITCODE\n`);
      const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher], { encoding: 'utf8', timeout: 30000 });
      assert.ifError(result.error);
      assert.equal(result.status, status, result.stdout + result.stderr);
      const output = readFileSync(log, 'utf16le');
      assert.match(output, /setup-stdout/);
      assert.match(output, /setup-stderr/);
      assert.equal(output.includes('[ORGIAST-BOOTSTRAP-COMPLETE]'), status === 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
