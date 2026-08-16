# nightly-batch.ps1 — DeepSeek off-peak時間帯にpendingジョブがあればバッチ実行する (Windows PowerShell 5.1)。
& {
try {
    $utc = [DateTime]::UtcNow
    $minutes = $utc.Hour * 60 + $utc.Minute
    $offPeak = ($minutes -ge (16 * 60 + 30)) -or ($minutes -lt 30)
    if (-not $offPeak) { return }

    $pending = Join-Path $HOME '.claude\batch-queue\pending.jsonl'
    if (-not (Test-Path -LiteralPath $pending -PathType Leaf)) { return }
    if ((Get-Item -LiteralPath $pending).Length -eq 0) { return }

    $repos = @(
        (Join-Path $HOME 'orgiast-claude-rules'),
        (Join-Path $HOME 'Downloads\orgiast-claude-rules')
    )
    $runner = $null
    foreach ($repo in $repos) {
        $candidate = Join-Path $repo 'tools\batch-run.mjs'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $runner = $candidate; break }
    }
    if (-not $runner) { return }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return }
    & $node.Source $runner
    if ($LASTEXITCODE -ne 0) { Write-Warning ("nightly-batch: batch-run exited " + $LASTEXITCODE) }
} catch {
    Write-Warning ("nightly-batch: " + $_.Exception.Message)
}
}

# 毎朝の確認用にセッショントリアージを先行生成する。失敗は夜間バッチ全体に波及させない。
try {
    $repos = @(
        (Join-Path $HOME 'orgiast-claude-rules'),
        (Join-Path $HOME 'Downloads\orgiast-claude-rules')
    )
    $triage = $null
    foreach ($repo in $repos) {
        $candidate = Join-Path $repo 'tools\session-triage.mjs'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $triage = $candidate; break }
    }
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($triage -and $node) {
        $triageOutput = Join-Path $env:USERPROFILE '.claude\session-triage.md'
        & $node.Source $triage --llm --top 20 --md $triageOutput
        if ($LASTEXITCODE -ne 0) { Write-Warning ("nightly-batch: session-triage exited " + $LASTEXITCODE) }
    }
} catch {
    Write-Warning ("nightly-batch: session-triage: " + $_.Exception.Message)
}

exit 0
