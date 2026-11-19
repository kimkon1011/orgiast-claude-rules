import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('non-elevated task registration control flow (Windows PowerShell 5.1 mocks)', { skip: process.platform !== 'win32' }, () => {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./secretary-uptime-registration.test.ps1', import.meta.url))], { windowsHide: true, timeout: 60000, stdio: 'pipe' });
});

test('secretary restart matches observed Windows command lines and checks listener ownership', { skip: process.platform !== 'win32' }, () => {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./secretary-server-process.test.ps1', import.meta.url))], { windowsHide: true, timeout: 60000, stdio: 'pipe' });
});

test('legacy and watchdog gateway starts cannot both bind the same wildcard address', async t => {
  const { createServer } = await import('node:net');
  const winner = createServer();
  await new Promise((resolve, reject) => { winner.once('error', reject); winner.listen(0, '0.0.0.0', resolve); });
  t.after(() => new Promise(resolve => winner.close(resolve)));
  const loser = createServer();
  const error = await new Promise(resolve => {
    loser.once('error', resolve);
    loser.listen(winner.address().port, '0.0.0.0', () => { loser.close(); resolve(new Error('duplicate listener admitted')); });
  });
  assert.equal(error.code, 'EADDRINUSE');
  assert.equal(winner.listening, true);
});

test('秘書アプリの管理下の再起動は本番ビルドを next start で起動する', () => {
  const restart = readFileSync(new URL('./secretary-restart.ps1', import.meta.url), 'utf8');
  assert.match(restart, /\$env:NODE_ENV\s*=\s*'production'/);
  assert.match(restart, /SECRETARY_NEXT_DIST_DIR\s*=\s*\$dist/);
  const launch = restart.match(/^[^\r\n]*Start-Process -FilePath \$node[^\r\n]*$/m)?.[0];
  assert.ok(launch);
  assert.match(launch, /-ArgumentList @\(\([^\r\n]*? -f \$next\),\s*'start',/);
  assert.match(launch, /-WorkingDirectory \$serverDir\b/);
});
