# nightly-batch.ps1 — DeepSeek off-peak時間帯にpendingジョブがあればバッチ実行する (Windows PowerShell 5.1)。
try {
    $utc = [DateTime]::UtcNow
    $minutes = $utc.Hour * 60 + $utc.Minute
    $offPeak = ($minutes -ge (16 * 60 + 30)) -or ($minutes -lt 30)
    if (-not $offPeak) { exit 0 }

    $repos = @(
        (Join-Path $HOME 'orgiast-claude-rules'),
        (Join-Path $HOME 'Downloads\orgiast-claude-rules')
    )
    $runner = $null
    $autoClose = $null
    foreach ($repo in $repos) {
        $candidate = Join-Path $repo 'tools\batch-run.mjs'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $runner = $candidate; break }
    }
    foreach ($repo in $repos) {
        $candidate = Join-Path $repo 'tools\session-auto-close.mjs'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $autoClose = $candidate; break }
    }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { exit 0 }

    if ($autoClose) {
        try {
            & $node.Source $autoClose --days 7 --max 40
            if ($LASTEXITCODE -ne 0) { Write-Warning ("nightly-batch: session-auto-close exited " + $LASTEXITCODE) }
        } catch {
            Write-Warning ("nightly-batch: session-auto-close: " + $_.Exception.Message)
        }
    }

    # LINEトーク履歴エクスポート(inbox の .txt)を先に取り込む。claude-mobile が無いPCでは静かにスキップする。
    $lineImport = Join-Path $HOME 'Downloads\claude-mobile\scripts\import-line-export.mjs'
    if (Test-Path -LiteralPath $lineImport -PathType Leaf) {
        try {
            & $node.Source $lineImport
            if ($LASTEXITCODE -ne 0) { Write-Warning ("nightly-batch: import-line-export exited " + $LASTEXITCODE) }
        } catch {
            Write-Warning ("nightly-batch: import-line-export: " + $_.Exception.Message)
        }
    }

    # LINEオープンチャットの取り込み分を選別・要約して作り置きを更新する。
    # batch-queue が空でも実行したいので、下の early exit より前に置くこと。
    $digest = $null
    foreach ($repo in $repos) {
        $candidate = Join-Path $repo 'tools\line-digest.mjs'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $digest = $candidate; break }
    }
    if ($digest) {
        try {
            & $node.Source $digest
            if ($LASTEXITCODE -ne 0) { Write-Warning ("nightly-batch: line-digest exited " + $LASTEXITCODE) }
        } catch {
            Write-Warning ("nightly-batch: line-digest: " + $_.Exception.Message)
        }
    }

    $pending = Join-Path $HOME '.claude\batch-queue\pending.jsonl'
    if (-not (Test-Path -LiteralPath $pending -PathType Leaf)) { exit 0 }
    if ((Get-Item -LiteralPath $pending).Length -eq 0) { exit 0 }
    if (-not $runner) { exit 0 }
    & $node.Source $runner
    if ($LASTEXITCODE -ne 0) { Write-Warning ("nightly-batch: batch-run exited " + $LASTEXITCODE) }
    exit 0
} catch {
    Write-Warning ("nightly-batch: " + $_.Exception.Message)
    exit 0
}
