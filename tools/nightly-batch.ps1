# nightly-batch.ps1 — DeepSeek off-peak時間帯にpendingジョブがあればバッチ実行する (Windows PowerShell 5.1)。
$logDir = Join-Path $HOME '.claude\logs'
$logFile = Join-Path $logDir ("nightly-batch-" + (Get-Date -Format 'yyyy-MM-dd') + ".log")
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$summary = [ordered]@{}
function Write-NightlyLog([string]$Step, [string]$Result) {
    if ($Step -ne 'サマリ') { $summary[$Step] = $Result }
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " / " + $Step + " / " + $Result
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}
function Finish-Nightly([int]$Code) {
    $parts = @($summary.Keys | ForEach-Object { $_ + '=' + $summary[$_] })
    Write-NightlyLog 'サマリ' ("nightly-batch 完了: " + ($parts -join ', '))
    exit $Code
}

try {
    Write-NightlyLog 'nightly-batch' 'ok:開始'
    $utc = [DateTime]::UtcNow
    $minutes = $utc.Hour * 60 + $utc.Minute
    $offPeak = ($minutes -ge (16 * 60 + 30)) -or ($minutes -lt 30)
    if (-not $offPeak) { $summary['batch'] = 'skip:off-peak帯外'; Write-NightlyLog '時間帯判定' 'skip:off-peak帯外'; Finish-Nightly 0 }
    Write-NightlyLog '時間帯判定' 'ok:off-peak帯'

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
    if (-not $node) { $summary['node'] = 'error:nodeが見つからない'; Write-NightlyLog 'node確認' 'error:nodeが見つからない'; Finish-Nightly 1 }
    Write-NightlyLog 'node確認' 'ok'

    if ($autoClose) {
        try {
            & $node.Source $autoClose --days 7 --max 40
            if ($LASTEXITCODE -ne 0) { Write-NightlyLog 'session-auto-close' ("error:終了コード" + $LASTEXITCODE) } else { Write-NightlyLog 'session-auto-close' 'ok' }
        } catch {
            Write-NightlyLog 'session-auto-close' ("error:" + $_.Exception.Message)
            Write-Warning ("nightly-batch: session-auto-close: " + $_.Exception.Message)
        }
    } else { Write-NightlyLog 'session-auto-close' 'skip:ファイルなし' }

    # LINEトーク履歴エクスポート(inbox の .txt)を先に取り込む。claude-mobile が無いPCでは静かにスキップする。
    $lineImport = Join-Path $HOME 'Downloads\claude-mobile\scripts\import-line-export.mjs'
    if (Test-Path -LiteralPath $lineImport -PathType Leaf) {
        try {
            & $node.Source $lineImport
            if ($LASTEXITCODE -ne 0) { Write-NightlyLog 'import-line-export' ("error:終了コード" + $LASTEXITCODE); Write-Warning ("nightly-batch: import-line-export exited " + $LASTEXITCODE) } else { Write-NightlyLog 'import-line-export' 'ok' }
        } catch {
            Write-NightlyLog 'import-line-export' ("error:" + $_.Exception.Message)
            Write-Warning ("nightly-batch: import-line-export: " + $_.Exception.Message)
        }
    } else { Write-NightlyLog 'import-line-export' 'skip:ファイルなし' }

    $lineReminder = $null
    foreach ($repo in $repos) {
        $candidate = Join-Path $repo 'tools\line-export-reminder.mjs'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $lineReminder = $candidate; break }
    }
    if ($lineReminder) {
        try {
            & $node.Source $lineReminder
            if ($LASTEXITCODE -ne 0) { Write-NightlyLog 'line-export-reminder' ("error:終了コード" + $LASTEXITCODE); Write-Warning ("nightly-batch: line-export-reminder exited " + $LASTEXITCODE) } else { Write-NightlyLog 'line-export-reminder' 'ok' }
        } catch {
            Write-NightlyLog 'line-export-reminder' ("error:" + $_.Exception.Message)
            Write-Warning ("nightly-batch: line-export-reminder: " + $_.Exception.Message)
        }
    } else { Write-NightlyLog 'line-export-reminder' 'skip:ファイルなし' }

    # ルール遵守監査。失敗しても後続処理は必ず続ける。
    $ruleCompliance = $null
    foreach ($repo in $repos) {
        $candidate = Join-Path $repo 'tools\rule-compliance-loop.mjs'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $ruleCompliance = $candidate; break }
    }
    if ($ruleCompliance) {
        try {
            & $node.Source $ruleCompliance '--days' '7'
            if ($LASTEXITCODE -ne 0) { Write-NightlyLog 'rule-compliance-loop' ("error:終了コード" + $LASTEXITCODE + ' (警告・後続処理続行)') } else { Write-NightlyLog 'rule-compliance-loop' 'ok' }
        } catch { Write-NightlyLog 'rule-compliance-loop' ("error:" + $_.Exception.Message + ' (警告・後続処理続行)') }
    } else { Write-NightlyLog 'rule-compliance-loop' 'skip:ファイルなし' }

    # アプリ内フォームの報告(kim の DM に届いたもの)を GitHub Issue 化する。
    # 失敗しても既存の夜間処理を止めない。未 ack のものは次回そのまま再試行される。
    $feedbackToIssues = $null
    foreach ($repo in $repos) {
        $candidate = Join-Path $repo 'tools\feedback-to-issues.mjs'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $feedbackToIssues = $candidate; break }
    }
    if ($feedbackToIssues) {
        try {
            & $node.Source $feedbackToIssues
            if ($LASTEXITCODE -ne 0) { Write-NightlyLog 'feedback-to-issues' ("error:終了コード" + $LASTEXITCODE + ' (警告・後続処理続行)'); Write-Warning ("nightly-batch: feedback-to-issues exited " + $LASTEXITCODE) } else { Write-NightlyLog 'feedback-to-issues' 'ok' }
        } catch {
            Write-NightlyLog 'feedback-to-issues' ("error:" + $_.Exception.Message + ' (警告・後続処理続行)')
            Write-Warning ("nightly-batch: feedback-to-issues: " + $_.Exception.Message)
        }
    } else { Write-NightlyLog 'feedback-to-issues' 'skip:ファイルなし' }

    # LINEオープンチャットの取り込み分を選別・要約して作り置きを更新する。
    # batch-queue が空でも実行したいので、下の early exit より前に置くこと。
    $digest = $null
    foreach ($repo in $repos) {
        $candidate = Join-Path $repo 'tools\line-digest.mjs'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $digest = $candidate; break }
    }
    if ($digest) {
        try {
            $digestOutput = @(& $node.Source $digest)
            $digestExitCode = $LASTEXITCODE
            if ($digestExitCode -ne 0) {
                $digestResult = "error:終了コード$digestExitCode"
            } else {
                $digestResult = @($digestOutput | Where-Object { $_ -match '^(skip:入力ディレクトリなし|skip:新規メッセージなし|ok:\d+件処理)$' } | Select-Object -Last 1)
                if ($digestResult.Count -eq 0) { $digestResult = 'error:状態不明' } else { $digestResult = [string]$digestResult[0] }
            }
            $summary['line-digest'] = $digestResult
            Write-NightlyLog 'line-digest' $digestResult
        } catch {
            $summary['line-digest'] = ("error:" + $_.Exception.Message); Write-NightlyLog 'line-digest' $summary['line-digest']
            Write-Warning ("nightly-batch: line-digest: " + $_.Exception.Message)
        }
    } else { Write-NightlyLog 'line-digest' 'skip:ファイルなし' }

    $producer = $null
    foreach ($repo in $repos) {
        $candidate = Join-Path $repo 'tools\batch-producer.mjs'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $producer = $candidate; break }
    }
    if ($producer) {
        try {
            & $node.Source $producer
            if ($LASTEXITCODE -ne 0) { Write-NightlyLog 'batch-producer' ("error:終了コード" + $LASTEXITCODE + ' (警告・batch-run続行)') } else { Write-NightlyLog 'batch-producer' 'ok' }
        } catch { Write-NightlyLog 'batch-producer' ("error:" + $_.Exception.Message + ' (警告・batch-run続行)') }
    } else { Write-NightlyLog 'batch-producer' 'skip:ファイルなし' }

    if (-not $runner) { $summary['batch'] = 'error:batch-run.mjsが見つからない'; Write-NightlyLog 'batch-run確認' 'error:batch-run.mjsが見つからない'; Finish-Nightly 1 }
    $pending = Join-Path $HOME '.claude\batch-queue\pending.jsonl'
    if (-not (Test-Path -LiteralPath $pending -PathType Leaf) -or (Get-Item -LiteralPath $pending).Length -eq 0) {
        $summary['batch'] = '処理対象0件'; Write-NightlyLog 'batch-run' 'skip:処理対象0件'; Finish-Nightly 0
    }
    $before = @((Get-Content -LiteralPath $pending -Encoding UTF8) | Where-Object { $_.Trim() }).Count
    & $node.Source $runner
    if ($LASTEXITCODE -ne 0) { $summary['batch'] = "error:終了コード$LASTEXITCODE"; Write-NightlyLog 'batch-run' ("error:終了コード" + $LASTEXITCODE); Finish-Nightly 1 }
    $after = if (Test-Path -LiteralPath $pending -PathType Leaf) { @((Get-Content -LiteralPath $pending -Encoding UTF8) | Where-Object { $_.Trim() }).Count } else { 0 }
    $processed = [Math]::Max(0, $before - $after)
    $summary['batch'] = ($processed.ToString() + '件処理')
    Write-NightlyLog 'batch-run' ("ok:" + $processed + '件処理')
    Finish-Nightly 0
} catch {
    $summary['batch'] = ("error:" + $_.Exception.Message)
    Write-NightlyLog '例外' ("error:" + $_.Exception.Message)
    Write-Warning ("nightly-batch: " + $_.Exception.Message)
    Finish-Nightly 1
}
