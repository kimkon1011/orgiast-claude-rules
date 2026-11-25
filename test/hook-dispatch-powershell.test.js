import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { dispatch, looksLikePowerShell } from '../tools/hook-dispatch.mjs';

test('looksLikePowerShell correctly identifies PowerShell fragments', () => {
  // Should identify PowerShell fragments
  assert.equal(looksLikePowerShell('$OutputEncoding = [Console]::OutputEncoding; node x.mjs'), true);
  assert.equal(looksLikePowerShell('$env:FOO = "1"; node x.mjs'), true);
  assert.equal(looksLikePowerShell('[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding'), true);
  assert.equal(looksLikePowerShell('Get-ChildItem | Set-Content -Path test.txt'), true);
  assert.equal(looksLikePowerShell('node x.mjs --Set-flag'), false);
  assert.equal(looksLikePowerShell('Start-Process -FilePath "node" -ArgumentList "x.mjs"'), true); // This is a PowerShell cmdlet

  // Should not identify regular commands
  assert.equal(looksLikePowerShell('node tools/x.mjs --flag'), false);
  assert.equal(looksLikePowerShell('bash -lc "echo hi"'), false);
  assert.equal(looksLikePowerShell('echo "hello world"'), false);

  // Should identify traditional PowerShell commands
  assert.equal(looksLikePowerShell('pwsh -NoProfile -File x.ps1'), true);

  // Edge cases
  assert.equal(looksLikePowerShell(''), false);
  assert.equal(looksLikePowerShell(null), false);
  assert.equal(looksLikePowerShell(undefined), false);
  assert.equal(looksLikePowerShell(123), false);
  
  // Additional test cases for edge scenarios
  assert.equal(looksLikePowerShell('  $env:VAR = "value"  '), true); // Trimmed whitespace
  assert.equal(looksLikePowerShell('$OutputEncoding=[Console]::OutputEncoding'), true); // No spaces around =
  assert.equal(looksLikePowerShell('Set-Item -Path "HKCU:\\Software\\Test" -Value "TestValue"'), true); // Another cmdlet
  assert.equal(looksLikePowerShell('New-Item -ItemType Directory -Name "TestDir"'), true); // Another cmdlet
  assert.equal(looksLikePowerShell('-ExecutionPolicy Bypass'), true); // Execution policy flag
});

test('PowerShell fragments pass when no PowerShell executable is available', async () => {
  const result = await dispatch('PreToolUse', JSON.stringify({ tool_name: 'Shell' }), {
    overloaded: false,
    env: { PATH: '' },
    manifest: {
      events: {
        PreToolUse: [{
          name: 'powershell-fragment',
          command: '$OutputEncoding = [Console]::OutputEncoding; node x.mjs',
          wait: true,
          timeout: 1,
        }],
      },
      legacyDuplicatesRemoved: {},
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.results[0].status, 0);
  assert.equal(result.results[0].skipped, 'powershell-unavailable');
});
