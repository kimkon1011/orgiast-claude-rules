# nightly-batch.ps1 — DeepSeek off-peak時間帯にpendingジョブがあればバッチ実行する (Windows PowerShell 5.1)。
# wscript経由のhidden起動はコンソール無しでOEMコードページ(932)にフォールバックし、
# 子プロセスのUTF-8出力を文字化けさせる(実測: line-digest の日本語ステータス regex が常に不一致)。
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
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

    $repos = @()
    if ($PSScriptRoot) { $repos += (Split-Path -Parent $PSScriptRoot) }
    $repos += @(
        (Join-Path $HOME 'orgiast-claude-rules'),
        (Join-Path $HOME 'Downloads\orgiast-claude-rules')
    )
    $repos = @($repos | Select-Object -Unique)
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
    $interactionLoop = $null
    foreach ($repo in $repos) {
        $candidate = Join-Path $repo 'tools\interaction-loop.mjs'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $interactionLoop = $candidate; break }
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

    $memoryIndexCompact = $null
    foreach ($repo in $repos) {
        $candidate = Join-Path $repo 'tools\memory-index-compact.mjs'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $memoryIndexCompact = $candidate; break }
    }
    if ($memoryIndexCompact) {
        try {
            & $node.Source $memoryIndexCompact --move-hooks --apply --all-projects --min-bytes 20000
            if ($LASTEXITCODE -ne 0) { Write-Warning ("nightly-batch: memory-index-compact exited " + $LASTEXITCODE) }
        } catch {
            Write-Warning ("nightly-batch: memory-index-compact: " + $_.Exception.Message)
        }
    }

    $memoryIndexDomains = $null
    $memoryIndexSplit = $null
    $memoryIndexSplitVerify = $null
    foreach ($repo in $repos) {
        $candidate = Join-Path $repo 'tools\memory-index-domains.mjs'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $memoryIndexDomains = $candidate; break }
    }
    foreach ($repo in $repos) {
        $candidate = Join-Path $repo 'tools\memory-index-split.mjs'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $memoryIndexSplit = $candidate; break }
    }
    foreach ($repo in $repos) {
        $candidate = Join-Path $repo 'tools\memory-index-split-verify.mjs'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $memoryIndexSplitVerify = $candidate; break }
    }
    $v2MemoryDirs = @()
    $projectsDir = Join-Path $HOME '.claude\projects'
    if (Test-Path -LiteralPath $projectsDir -PathType Container) {
        $v2MemoryDirs = @(Get-ChildItem -LiteralPath $projectsDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $memoryDir = Join-Path $_.FullName 'memory'
            $memoryFile = Join-Path $memoryDir 'MEMORY.md'
            if (Test-Path -LiteralPath $memoryFile -PathType Leaf) {
                $firstLine = Get-Content -LiteralPath $memoryFile -TotalCount 1 -Encoding UTF8
                if ($firstLine -eq '<!-- MEMORY-INDEX v2 split -->') { $memoryDir }
            }
        })
    }

    if (-not $memoryIndexDomains -or -not $memoryIndexSplit) {
        Write-NightlyLog 'memory-index-split' 'skip:ファイルなし'
    } elseif ($v2MemoryDirs.Count -eq 0) {
        Write-NightlyLog 'memory-index-split' 'skip:v2索引なし'
    } else {
        $applied = 0
        $needsAttention = @()
        foreach ($memoryDir in $v2MemoryDirs) {
            $projectName = Split-Path -Leaf (Split-Path -Parent $memoryDir)
            $domainsTmp = [System.IO.Path]::GetTempFileName()
            $pinsTmp = [System.IO.Path]::GetTempFileName()
            try {
                $deriveOutput = @(& $node.Source $memoryIndexDomains --dir $memoryDir --out-domains $domainsTmp --out-pins $pinsTmp 2>&1)
                $deriveExit = $LASTEXITCODE
                if ($deriveExit -eq 0) {
                    $splitOutput = @(& $node.Source $memoryIndexSplit --dir $memoryDir --domains $domainsTmp --pins $pinsTmp --apply 2>&1)
                    if ($LASTEXITCODE -eq 0) { $applied++ } else {
                        $needsAttention += ($projectName + ':適用失敗')
                        Write-Warning ("nightly-batch: memory-index-split " + $projectName + ': ' + ($splitOutput -join ' / '))
                    }
                } elseif ($deriveExit -eq 1) {
                    $unclassified = @($deriveOutput | Where-Object { [string]$_ -match '^- ' }).Count
                    $needsAttention += ($projectName + ':' + $unclassified + '件未分類')
                    Write-Warning ("nightly-batch: memory-index-domains " + $projectName + ': ' + ($deriveOutput -join ' / '))
                } else {
                    $needsAttention += ($projectName + ':導出失敗')
                    Write-Warning ("nightly-batch: memory-index-domains " + $projectName + ': ' + ($deriveOutput -join ' / '))
                }
            } catch {
                $needsAttention += ($projectName + ':例外')
                Write-Warning ("nightly-batch: memory-index-split " + $projectName + ': ' + $_.Exception.Message)
            } finally {
                Remove-Item -LiteralPath $domainsTmp, $pinsTmp -Force -ErrorAction SilentlyContinue
            }
        }
        $splitResult = 'ok:' + $applied + '件適用'
        if ($needsAttention.Count -gt 0) { $splitResult += '/' + $needsAttention.Count + '件要手当(' + ($needsAttention -join ',') + ')' }
        Write-NightlyLog 'memory-index-split' $splitResult
    }

    if (-not $memoryIndexSplitVerify) {
        Write-NightlyLog 'memory-index-split-verify' 'skip:ファイルなし'
    } elseif ($v2MemoryDirs.Count -eq 0) {
        Write-NightlyLog 'memory-index-split-verify' 'skip:v2索引なし'
    } else {
        $verifyNg = @()
        foreach ($memoryDir in $v2MemoryDirs) {
            $projectName = Split-Path -Leaf (Split-Path -Parent $memoryDir)
            try {
                $verifyOutput = @(& $node.Source $memoryIndexSplitVerify --dir $memoryDir 2>&1)
                if ($LASTEXITCODE -ne 0) {
                    $verifyNg += $projectName
                    Write-Warning ("nightly-batch: memory-index-split-verify " + $projectName + ': ' + ($verifyOutput -join ' / '))
                }
            } catch {
                $verifyNg += $projectName
                Write-Warning ("nightly-batch: memory-index-split-verify " + $projectName + ': ' + $_.Exception.Message)
            }
        }
        if ($verifyNg.Count -gt 0) { Write-NightlyLog 'memory-index-split-verify' ('NG:' + ($verifyNg -join ',')) }
        else { Write-NightlyLog 'memory-index-split-verify' ('ok:' + $v2MemoryDirs.Count + '件') }
    }

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

    if ($interactionLoop) {
        try {
            $interactionOutput = @(& $node.Source $interactionLoop --digest)
            if ($LASTEXITCODE -ne 0) {
                $summary['interaction-loop'] = ("error:終了コード" + $LASTEXITCODE)
            } else {
                $interactionState = @($interactionOutput | Where-Object { $_ -eq 'skip:前回と差分なし' } | Select-Object -Last 1)
                $summary['interaction-loop'] = if ($interactionState.Count -gt 0) { [string]$interactionState[0] } else { 'ok' }
            }
            Write-NightlyLog 'interaction-loop' $summary['interaction-loop']
        } catch {
            $summary['interaction-loop'] = ("error:" + $_.Exception.Message)
            Write-NightlyLog 'interaction-loop' $summary['interaction-loop']
            Write-Warning ("nightly-batch: interaction-loop: " + $_.Exception.Message)
        }
    } else {
        $summary['interaction-loop'] = 'skip:ファイルなし'
        Write-NightlyLog 'interaction-loop' $summary['interaction-loop']
    }

    $interactionRollout = $null
    foreach ($repo in $repos) {
        $candidate = Join-Path $repo 'tools\interaction-rollout.mjs'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $interactionRollout = $candidate; break }
    }
    if ($interactionRollout) {
        try {
            $interactionRolloutOutput = @(& $node.Source $interactionRollout --watch)
            if ($LASTEXITCODE -ne 0) {
                $summary['interaction-rollout'] = ("error:終了コード" + $LASTEXITCODE)
            } else {
                $interactionRolloutState = @($interactionRolloutOutput | Where-Object { $_ -eq 'skip:前回と差分なし' } | Select-Object -Last 1)
                $summary['interaction-rollout'] = if ($interactionRolloutState.Count -gt 0) { [string]$interactionRolloutState[0] } else { 'ok' }
            }
            Write-NightlyLog 'interaction-rollout' $summary['interaction-rollout']
        } catch {
            $summary['interaction-rollout'] = ("error:" + $_.Exception.Message)
            Write-NightlyLog 'interaction-rollout' $summary['interaction-rollout']
            Write-Warning ("nightly-batch: interaction-rollout: " + $_.Exception.Message)
        }
    } else {
        $summary['interaction-rollout'] = 'skip:ファイルなし'
        Write-NightlyLog 'interaction-rollout' $summary['interaction-rollout']
    }

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

    $growiManual = $null
    foreach ($repo in $repos) {
        $candidate = Join-Path $repo 'tools\growi-manual.mjs'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $growiManual = $candidate; break }
    }
    if ($growiManual) {
        try {
            & $node.Source $growiManual sync
            if ($LASTEXITCODE -eq 2) { Write-NightlyLog 'growi-manual' 'skip:鍵なし' } elseif ($LASTEXITCODE -ne 0) { Write-NightlyLog 'growi-manual' ("error:終了コード" + $LASTEXITCODE) } else { Write-NightlyLog 'growi-manual' 'ok' }
        } catch {
            Write-NightlyLog 'growi-manual' ("error:" + $_.Exception.Message)
        }
    } else { Write-NightlyLog 'growi-manual' 'skip:ファイルなし' }

    $discordChannels = $null
    foreach ($repo in $repos) {
        $candidate = Join-Path $repo 'tools\discord-channel-ledger.mjs'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $discordChannels = $candidate; break }
    }
    $discordBotToken = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.claude\orgiast-discord-bot-token.txt'
    if (-not (Test-Path -LiteralPath $discordBotToken -PathType Leaf)) {
        Write-NightlyLog 'discord-channels' 'skip:トークンなし'
    } elseif ($discordChannels) {
        try {
            & $node.Source $discordChannels
            if ($LASTEXITCODE -ne 0) { Write-NightlyLog 'discord-channels' ("error:終了コード" + $LASTEXITCODE) } else { Write-NightlyLog 'discord-channels' 'ok' }
        } catch {
            Write-NightlyLog 'discord-channels' ("error:" + $_.Exception.Message)
        }
    } else { Write-NightlyLog 'discord-channels' 'skip:ファイルなし' }

    $webhookHealth = $null
    foreach ($repo in $repos) {
        $candidate = Join-Path $repo 'tools\webhook-health.mjs'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $webhookHealth = $candidate; break }
    }
    $fleetSheetEnv = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.claude\fleet-sheet.env'
    if (-not (Test-Path -LiteralPath $fleetSheetEnv -PathType Leaf)) {
        Write-NightlyLog 'webhook-health' 'skip:設定なし'
    } elseif ($webhookHealth) {
        try {
            & $node.Source $webhookHealth --post-sheet
            if ($LASTEXITCODE -ne 0) { Write-NightlyLog 'webhook-health' ("error:終了コード" + $LASTEXITCODE) } else { Write-NightlyLog 'webhook-health' 'ok' }
        } catch { Write-NightlyLog 'webhook-health' ("error:" + $_.Exception.Message) }
    } else { Write-NightlyLog 'webhook-health' 'skip:ファイルなし' }

    $webhookInventory = $null
    foreach ($repo in $repos) {
        $candidate = Join-Path $repo 'tools\discord-webhook-inventory.mjs'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $webhookInventory = $candidate; break }
    }
    if (-not (Test-Path -LiteralPath $discordBotToken -PathType Leaf)) {
        Write-NightlyLog 'webhook-inventory' 'skip:トークンなし'
    } elseif ($webhookInventory) {
        try {
            & $node.Source $webhookInventory
            if ($LASTEXITCODE -ne 0) { Write-NightlyLog 'webhook-inventory' ("error:終了コード" + $LASTEXITCODE) } else { Write-NightlyLog 'webhook-inventory' 'ok' }
        } catch { Write-NightlyLog 'webhook-inventory' ("error:" + $_.Exception.Message) }
    } else { Write-NightlyLog 'webhook-inventory' 'skip:ファイルなし' }

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

    $makimonoDrain = $null
    foreach ($repo in $repos) {
        $candidate = Join-Path $repo 'tools\makimono-publish.mjs'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $makimonoDrain = $candidate; break }
    }
    if ($makimonoDrain) {
        try {
            & $node.Source $makimonoDrain --drain-queue --notify
            if ($LASTEXITCODE -ne 0) { Write-NightlyLog 'makimono-drain' ("error:終了コード" + $LASTEXITCODE) } else { Write-NightlyLog 'makimono-drain' 'ok' }
        } catch {
            Write-NightlyLog 'makimono-drain' ("error:" + $_.Exception.Message)
            Write-Warning ("nightly-batch: makimono-drain: " + $_.Exception.Message)
        }
        try {
            & $node.Source $makimonoDrain --check --notify
            if ($LASTEXITCODE -ne 0) { Write-NightlyLog 'makimono-check' ("error:終了コード" + $LASTEXITCODE) } else { Write-NightlyLog 'makimono-check' 'ok' }
        } catch {
            Write-NightlyLog 'makimono-check' ("error:" + $_.Exception.Message)
            Write-Warning ("nightly-batch: makimono-check: " + $_.Exception.Message)
        }
    } else {
        Write-NightlyLog 'makimono-drain' 'error:ファイルなし'
        Write-NightlyLog 'makimono-check' 'error:ファイルなし'
    }

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
