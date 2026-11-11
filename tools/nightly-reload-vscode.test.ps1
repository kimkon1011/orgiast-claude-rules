$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'nightly-reload-vscode.ps1') -FunctionsOnly

function Assert($Condition, $Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
}

Assert ($script:ES_CONTINUOUS_SYSTEM_AWAYMODE_REQUIRED -is [uint32]) '実行継続・システム・AwayMode の定数は UInt32'
Assert ($script:ES_CONTINUOUS_SYSTEM_AWAYMODE_REQUIRED -eq 2147483713) '実行継続・システム・AwayMode の定数値'
Assert ($script:ES_CONTINUOUS -is [uint32]) '実行継続の定数は UInt32'
Assert ($script:ES_CONTINUOUS -eq 2147483648) '実行継続の定数値'
Write-Output 'PASS: execution state constants are UInt32 (2147483713 / 2147483648)'

$windowsPowerShell = Get-Command powershell.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($windowsPowerShell) {
    $scriptPath = Join-Path $PSScriptRoot 'nightly-reload-vscode.ps1'
    $escapedScriptPath = $scriptPath.Replace("'", "''")
    $command = @'
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
    throw 'Expected Windows PowerShell 5.1'
}
. '__SCRIPT_PATH__' -FunctionsOnly
function Write-Log($message) { throw $message }
try { Enable-SleepInhibition } finally { Disable-SleepInhibition }
Write-Output ('PASS: Windows PowerShell {0} sleep inhibition calls completed without warnings' -f $PSVersionTable.PSVersion)
'@
    $command = $command.Replace('__SCRIPT_PATH__', $escapedScriptPath)
    & $windowsPowerShell.Source -NoProfile -Command $command
    Assert ($LASTEXITCODE -eq 0) 'Windows PowerShell 5.1 実プロセスでスリープ抑止関数が例外なく通る'
} else {
    Write-Output 'SKIP: powershell.exe が無いため Windows PowerShell 5.1 実プロセステストを省略'
}

& {
    $warnings = [Collections.Generic.List[string]]::new()
    function Write-Log($message) { $warnings.Add($message) }
    function Initialize-WindowApi { throw 'simulated API failure' }
    Enable-SleepInhibition
    Disable-SleepInhibition
    Assert ($warnings.Count -eq 2) 'スリープ抑止の開始・解除の例外後も処理が継続する'
    foreach ($warning in $warnings) {
        Assert ($warning -eq 'WARN: スリープ抑止に失敗（simulated API failure）') '失敗理由を WARN として記録する'
    }
}
Write-Output 'PASS: sleep inhibition failures warn and continue (enable / disable)'

$ids = @(Get-InteractiveSessionIdsFromJson '[{"kind":"interactive","sessionId":"vscode-1"},{"kind":"background","sessionId":"batch-1"}]')
Assert ($ids.Count -eq 1 -and $ids[0] -eq 'vscode-1') 'interactive の sessionId だけを抽出する'

$root = Join-Path ([IO.Path]::GetTempPath()) ("nightly-reload-test-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $interactive = New-Item -ItemType File -Path (Join-Path $root 'vscode-1.jsonl')
    $background = New-Item -ItemType File -Path (Join-Path $root 'batch-1.jsonl')
    $interactive.LastWriteTime = Get-Date
    $background.LastWriteTime = Get-Date

    $busy = @(Get-BusySessionFiles $root (Get-Date).AddMinutes(-15) @('vscode-1') $true)
    Assert ($busy.Count -eq 1 -and $busy[0].BaseName -eq 'vscode-1') 'agents 成功時は VSCode 対話セッションだけ busy にする'
    $fallback = @(Get-BusySessionFiles $root (Get-Date).AddMinutes(-15) @() $false)
    Assert ($fallback.Count -eq 2) 'agents 失敗時は全 jsonl にフォールバックする'

    Assert (Test-ExtensionUpdatePending ([version]'0.3.2') ([version]'0.1.1')) 'ディスク版が新しければ更新待ち'
    Assert (-not (Test-ExtensionUpdatePending ([version]'0.3.2') ([version]'0.3.2'))) '同じ版なら更新待ちではない'

    $storage = Join-Path $root 'storage.json'
    @'
{"windowsState":{"openedWindows":[{"folder":"file:///C%3A/Work/One"},{"workspace":"file:///C%3A/Work/Two/test.code-workspace"}],"lastActiveWindow":{"folder":"file:///C%3A/Work/One"}}}
'@ | Set-Content -LiteralPath $storage -Encoding utf8
    $targets = @(Get-VSCodeRestoreTargets $storage)
    Assert ($targets.Count -eq 2) 'storage.json から重複なしで folder/workspace を抽出する'

    Write-Output 'PASS: nightly-reload-vscode tests (5 groups)'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

$now = [datetime]'2026-11-04T05:00:00'
Assert (-not (Get-RestartPolicy @() $now).Overdue) 'unknown process age does not force restart'
Assert (-not (Get-RestartPolicy @($now.AddHours(-72).AddSeconds(1)) $now).Overdue) 'before 72h respects busy'
Assert ((Get-RestartPolicy @($now.AddHours(-72)) $now).Overdue) '72h boundary bypasses busy'
Assert ((Get-RestartPolicy @($now.AddDays(-11), $now.AddHours(-1)) $now).Overdue) 'old main process survives new child process'
Assert (-not (Get-RestartPolicy @($now.AddMinutes(-20)) $now).Due) 'later nightly trigger does not restart again'
Assert ((Get-RestartPolicy @($now.AddDays(-1)) $now).Due) 'daily restart independent of extension updates'
Write-Output 'PASS: restart age policy (6 cases)'

# v2: Save-ReloadSnapshot / Restore-ReloadSnapshot smoke tests
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('snapshot-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
try {
    $snapFile = Join-Path $fixture 'reload-snapshot.json'
    $reloadScript = Join-Path $PSScriptRoot 'reload-snapshot.mjs'

    # Save-ReloadSnapshot: calls node reload-snapshot.mjs save and reads the written file
    & node.exe $reloadScript save $snapFile 2>$null | Out-Null
    Assert ($LASTEXITCODE -eq 0) "Save-ReloadSnapshot exit code 0, got: $LASTEXITCODE"
    $snapshot = Get-Content -LiteralPath $snapFile -Raw -Encoding utf8 | ConvertFrom-Json
    Assert ($snapshot.version -eq 1) "Snapshot version is 1, got: $($snapshot.version)"
    Assert ($null -ne $snapshot.at) 'Snapshot has at timestamp'
    Assert ($snapshot.sessions -is [array]) 'Snapshot sessions is an array'
    Write-Output ("PASS: Save-ReloadSnapshot wrote {0} sessions" -f @($snapshot.sessions).Count)

    # Restore-ReloadSnapshot: create a minimal snapshot with 0 sessions to test validation
    $minSnap = Join-Path $fixture 'min-snapshot.json'
    '{"version":1,"at":"2026-11-09T00:00:00.000Z","sessions":[]}' | Set-Content -LiteralPath $minSnap -Encoding utf8
    $restoreOutput = (& node.exe $reloadScript restore $minSnap 2>&1) -join "`n"
    $restoreResult = try { $restoreOutput | ConvertFrom-Json } catch { $null }
    Assert ($null -ne $restoreResult) 'Restore-ReloadSnapshot returns valid JSON'
    Assert (@($restoreResult.connected).Count -eq 0) 'Empty snapshot has 0 connected'
    Assert (@($restoreResult.failed).Count -eq 0) 'Empty snapshot has 0 failed'
    Write-Output 'PASS: Restore-ReloadSnapshot with empty snapshot returns valid JSON'

    # Dry-run: reload-snapshot.mjs save with --dry-run outputs count without writing
    $dryRunOutput = (& node.exe $reloadScript save "$fixture\dry.json" --dry-run 2>$null) -join "`n"
    Assert ($LASTEXITCODE -eq 0) "Dry-run exit code 0, got: $LASTEXITCODE"
    $dryResult = $dryRunOutput | ConvertFrom-Json
    Assert ($null -ne $dryResult.count) 'Dry-run output has count'
    Assert (-not (Test-Path "$fixture\dry.json")) 'Dry-run does not write file'
    Write-Output 'PASS: reload-snapshot.mjs save --dry-run correctly outputs count without writing'

    # Invalid snapshot: missing version field
    $badSnap = Join-Path $fixture 'bad.json'
    '{"sessions":[]}' | Set-Content -LiteralPath $badSnap -Encoding utf8
    $savedPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $badExit = 0
    try { & node.exe $reloadScript restore $badSnap 2>$null; $badExit = $LASTEXITCODE } catch { $badExit = 1 }
    $ErrorActionPreference = $savedPref
    Assert ($badExit -ne 0) 'Invalid snapshot must fail'
    Write-Output 'PASS: Invalid snapshot correctly rejected'
} finally {
    Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output 'PASS: v2 snapshot/restore smoke tests (4 groups)'