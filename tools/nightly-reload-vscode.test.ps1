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

    $settings = Join-Path $root 'settings.json'
    '{"orgiast.nextSession.mobileTabs":4}' | Set-Content -LiteralPath $settings -Encoding utf8
    Assert ((Get-MobileTabsTarget $settings) -eq 4) 'settings.json の mobileTabs を目標値にする'
    Assert ((Get-MobileTabsTarget (Join-Path $root 'missing.json')) -eq 3) '設定が無ければ目標値は3'

    $script:mockCounts = [System.Collections.Generic.Queue[int]]::new()
    $script:mockCounts.Enqueue(1); $script:mockCounts.Enqueue(3)
    $script:logPath = Join-Path $root 'resume.log'
    $script:clock = [datetime]'2026-09-11T00:00:00Z'
    $sleep = { param($seconds) $script:clock = $script:clock.AddSeconds($seconds) }
    $now = { $script:clock }
    $resume = Wait-InteractiveResume 3 40 20 { $script:mockCounts.Dequeue() } $sleep $now
    Assert ($resume.Resumed -and $resume.Count -eq 3) 'interactive 数が目標に達すると復帰待機を終える'

    Assert ($resume -is [pscustomobject] -and $resume.Elapsed -eq 20) 'ログが結果オブジェクトへ混入しない'
    $failed = Wait-InteractiveResume 3 360 20 { 0 } $sleep $now
    Assert (-not $failed.Resumed -and $failed.Elapsed -eq 360) '6分で待機を打ち切る'
    $failed = Wait-InteractiveResume 3 25 20 { -1 } $sleep $now
    Assert (-not $failed.Resumed -and $failed.Elapsed -eq 25) '照会失敗と端数の待機を扱う'

    '{ // VSCode settings JSONC
      "orgiast.nextSession.mobileTabs": 0,
    }' | Set-Content -LiteralPath $settings -Encoding utf8
    Assert ((Get-MobileTabsTarget $settings) -eq 0) 'JSONC と無効設定を尊重する'

    function Invoke-ClaudeAgentsJson { return '[{"kind":"interactive"},{"kind":"background"}]' }
    Assert ((Get-InteractiveSessionCount 'mock') -eq 1) '照会関数をモックして interactive を数える'
    function Invoke-ClaudeAgentsJson { throw 'timeout' }
    Assert ((Get-InteractiveSessionCount 'mock') -eq -1) '照会例外は生存0件と区別する'

    # Exercise the orchestration without sleeping, launching VSCode or registering tasks.
    $script:waitCalls = @(); $script:recreates = 0; $script:secondResumes = $true
    function Wait-InteractiveResume($TargetCount, $TimeoutSeconds, $IntervalSeconds, $GetCount) {
        $script:waitCalls += $TimeoutSeconds
        return [pscustomobject]@{ Resumed = ($TimeoutSeconds -eq 120 -and $script:secondResumes); Count = 1; Elapsed = $TimeoutSeconds }
    }
    function Invoke-MobileRecreate($TargetCount) { $script:recreates++; Assert ($TargetCount -eq 3) '目標値を再作成へ渡す' }
    Confirm-InteractiveResume 3 'mock'
    Assert (($script:waitCalls -join ',') -eq '360,120' -and $script:recreates -eq 1) '6分後に1回再作成して2分待つ'
    Assert ((Get-Content $script:logPath -Tail 1) -match 'RESUMED:') '復帰成功をログに残す'
    $script:secondResumes = $false
    Confirm-InteractiveResume 3 'mock'
    Assert ((Get-Content $script:logPath -Tail 1) -match 'RESUME-FAIL:') '復帰失敗をログに残す'
    function Invoke-MobileRecreate($TargetCount) { throw 'launch failed' }
    Confirm-InteractiveResume 3 'mock'
    Assert ((Get-Content $script:logPath -Tail 1) -match 'RESUME-FAIL:') '再作成の起動失敗後にも最終判定する'
    $before = $script:waitCalls.Count
    Confirm-InteractiveResume 0 'mock'
    Assert ($script:waitCalls.Count -eq $before) 'mobileTabs=0 は再作成を実行しない'

    # Validate unsigned P/Invoke flags without calling the Windows power API.
    Add-Type 'public static class NightlyReloadPower { public static uint Last; public static uint SetThreadExecutionState(uint flags) { Last = flags; return 1; } }'
    Set-SleepSuppression $true
    Assert ([NightlyReloadPower]::Last -eq [uint32]2147483713) 'CONTINUOUS/SYSTEM_REQUIRED/AWAYMODE_REQUIRED を設定する'
    Set-SleepSuppression $false
    Assert ([NightlyReloadPower]::Last -eq [uint32]2147483648) 'CONTINUOUS だけで解除する'

    Write-Output 'PASS: nightly-reload-vscode tests (12 groups)'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
