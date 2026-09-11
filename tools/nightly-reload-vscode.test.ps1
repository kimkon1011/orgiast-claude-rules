$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'nightly-reload-vscode.ps1') -FunctionsOnly

function Assert($Condition, $Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
}

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

    Write-Output 'PASS: nightly-reload-vscode tests (7 groups)'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
