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
    # WARN must fail this smoke test; otherwise catch blocks hide argument conversion regressions.
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

# Keep mocks scoped so later tests still use the real functions.
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

    $script:testLog = @()
    function Write-Log($message) { $script:testLog += $message }
    function Start-Sleep { param([int]$Seconds) }

    $script:counts = @(1, 2)
    $script:countIndex = 0
    function Get-InteractiveSessionCount {
        $value = $script:counts[[Math]::Min($script:countIndex, $script:counts.Count - 1)]
        $script:countIndex++
        return $value
    }
    $result = Wait-InteractiveSessions 2 60 20
    Assert ($result -eq 2) '目標到達時は件数を返す'
    Assert (@($script:testLog | Where-Object { $_ -like 'RESUMED:*' }).Count -eq 1) '目標到達時は RESUMED を出す'

    $script:testLog = @()
    $script:restartCount = 0
    function Get-InteractiveSessionCount { return 0 }
    function Invoke-VSCodeRestart { param($CodeCli, [string[]]$RestoreTargets); $script:restartCount++; return $true }
    $result = Confirm-VSCodeResume 1 'code.cmd' @()
    Assert ($script:restartCount -eq 1) '0 件が続く場合も再起動は 1 回だけ'
    $retryIndex = [array]::IndexOf($script:testLog, 'RESUME-RETRY: 起動失敗を検知、再起動を 1 回やり直す')
    $failIndex = [array]::IndexOf($script:testLog, 'RESUME-FAIL: interactive 0 件')
    Assert ($retryIndex -ge 0 -and $failIndex -gt $retryIndex) 'RESUME-RETRY の後に RESUME-FAIL を出す'

    $script:testLog = @()
    $script:countCalls = 0
    function Get-InteractiveSessionCount { $script:countCalls++; if ($script:countCalls -eq 3) { return 2 }; return 0 }
    $result = Wait-InteractiveSessions 2 360 20
    Assert ($result -eq 2 -and $script:countCalls -eq 3) '途中で目標到達したら監視を打ち切る'

    Write-Output 'PASS: nightly-reload-vscode tests (10 groups)'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
