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

    Write-Output 'PASS: nightly-reload-vscode tests (4 groups)'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
