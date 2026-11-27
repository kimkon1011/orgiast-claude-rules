# Deadline-check / visit-consolidation rule self-test (12_). ASCII only (Windows PowerShell 5.1).
# Refreshes the test files from GitHub main every run (no manual re-distribution), then runs the
# self-test against this PC's Claude Code. Sends nothing, pays nothing, writes only result files.
param([switch]$Monthly, [string]$Model = 'opus', [string]$Ref = 'main')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$base = Join-Path $env:USERPROFILE '.claude\deadline-visit-test'
$raw = 'https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/' + $Ref + '/'
$files = @('tools/deadline-visit-selftest-run.ps1','tools/deadline-visit-selftest.mjs','tools/is-entry.mjs','tools/claude-exe.mjs','tools/lib/deadline-gate.mjs','tools/lib/jp-business-days.mjs','tools/lib/windows-process.mjs','tests/deadline-visit/cases.json')
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
foreach ($f in $files) {
  $dst = Join-Path $base ($f -replace '/', '\')
  New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
  try { Invoke-WebRequest -UseBasicParsing -Uri ($raw + $f) -OutFile $dst } catch { if (-not (Test-Path $dst)) { throw } }
}
Set-Content -Path (Join-Path $base 'package.json') -Value '{"type":"module"}' -Encoding ASCII
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Where-Object Extension -eq '.exe' | Select-Object -First 1).Source
$args2 = @((Join-Path $base 'tools\deadline-visit-selftest.mjs'), 'run', '--model', $Model, '--pc', $env:COMPUTERNAME)
if ($Monthly) { $args2 += '--monthly' }
& $node @args2
exit $LASTEXITCODE
