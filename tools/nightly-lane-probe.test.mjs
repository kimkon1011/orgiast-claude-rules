import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const source = fs.readFileSync(new URL('./nightly-batch.ps1', import.meta.url), 'utf8');
const start = source.indexOf('    $laneDoctor = $null');
const end = source.indexOf('    $delegationHealth = $null', start);
const block = source.slice(start, end);
const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.WSL_DISTRO_NAME ? 'powershell.exe' : 'pwsh';
const available = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']).status === 0;

test('daily nightly batch probes before delegation health and empty queue exit', () => {
  assert.ok(start > 0 && end > start);
  assert.ok(end < source.indexOf("$pending = Join-Path"));
  const schedule = fs.readFileSync(new URL('./apply-nightly-schedule.ps1', import.meta.url), 'utf8');
  assert.match(schedule, /Name = 'OrgiastNightlyBatch'; Kind = 'Daily'; At = '03:00'/);
});

for (const scenario of ['success', 'failure', 'throw', 'missing']) {
  test(`nightly probe ${scenario} preserves subsequent work and reports outcome`, { skip: !available }, () => {
    // Run only the production probe block with fake filesystem and node commands.
    // Never execute the full nightly job or touch the real home/settings.
    const script = `
$ErrorActionPreference = 'Stop'
$script:events = [System.Collections.Generic.List[object]]::new()
$repos = @('repo')
$node = @{ Source = 'Invoke-FakeNode' }
function Join-Path($Path, $ChildPath) { "$Path/$ChildPath" }
function Test-Path { return $${scenario !== 'missing'} }
function Invoke-FakeNode {
  $script:events.Add(@{ kind = 'invoke'; args = @($args) })
  ${scenario === 'throw' ? "throw 'probe launch failed'" : `$global:LASTEXITCODE = ${scenario === 'failure' ? 7 : 0}; 'probe-output'`}
}
function Write-NightlyStepResult($Step, $Code, $Output, $Note) { $script:events.Add(@{kind='result';code=$Code;output=@($Output);step=$Step}) }
function Format-NightlyDetail($Output) { "$Output" }
function Write-NightlyLog($Step, $Result) { $script:events.Add(@{kind='log';step=$Step;result=$Result}) }
${block}
$script:events.Add(@{kind='continued'})
ConvertTo-Json -InputObject @($script:events.ToArray()) -Depth 5 -Compress
`;
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const events = JSON.parse(result.stdout.trim());
    assert.equal(events.at(-1).kind, 'continued');
    const invocation = events.find(e => e.kind === 'invoke');
    if (scenario === 'missing') assert.equal(invocation, undefined);
    else assert.deepEqual(invocation.args, ['repo/tools\\lane-doctor.mjs', '--probe']);
    if (scenario === 'success' || scenario === 'failure') {
      const report = events.find(e => e.kind === 'result');
      assert.equal(report.code, scenario === 'success' ? 0 : 7);
      assert.deepEqual(report.output, ['probe-output']);
    } else assert.match(events.find(e => e.kind === 'log').result, scenario === 'throw' ? /probe launch failed/ : /skip:/);
  });
}
