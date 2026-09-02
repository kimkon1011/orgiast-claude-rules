# nightly-bootstrap.ps1 — nightly 専用リポを同期して対象を実行する (Windows PowerShell 5.1)
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Target,

    [Parameter()]
    [string]$Shell = 'powershell',

    [Parameter(ValueFromRemainingArguments = $true)]
    [object[]]$TargetArguments
)

$logDir = Join-Path $HOME '.claude\logs'
$logFile = Join-Path $logDir ("nightly-bootstrap-" + (Get-Date -Format 'yyyy-MM-dd') + '.log')
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Write-NightlyLog([string]$Step, [string]$Result) {
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' / ' + $Step + ' / ' + $Result
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 -ErrorAction Stop
            return
        } catch {
            if ($attempt -lt 9) {
                Start-Sleep -Milliseconds (50 + ($PID % 37) + ($attempt * 25))
            }
        }
    }

    try {
        $fallbackFile = Join-Path $logDir ("nightly-bootstrap-" + (Get-Date -Format 'yyyy-MM-dd') + '.' + $PID + '.log')
        Add-Content -LiteralPath $fallbackFile -Value $line -Encoding UTF8 -ErrorAction Stop
    } catch {
        try { [Console]::Error.WriteLine($line) } catch { }
    }
}

function Stop-Nightly([string]$Step, [string]$Result, [int]$Code) {
    Write-NightlyLog $Step $Result
    exit $Code
}

function Get-NightlyFileSha256([string]$Path) {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        return [System.BitConverter]::ToString($sha256.ComputeHash($bytes)).Replace('-', '')
    } finally {
        $sha256.Dispose()
    }
}

try {
    Write-NightlyLog 'nightly-bootstrap' 'ok:開始'

    $repo = if ($env:ORGIAST_NIGHTLY_REPO) {
        $env:ORGIAST_NIGHTLY_REPO
    } else {
        Join-Path $HOME '.claude\nightly-repo'
    }
    $repoUrl = 'https://github.com/kimkon1011/orgiast-claude-rules.git'
    $git = Get-Command git -ErrorAction SilentlyContinue
    $mutex = $null
    $mutexAcquired = $false
    $targetPath = $null

    try {
        $repoFullPath = [IO.Path]::GetFullPath($repo).ToUpperInvariant()
        $repoPathBytes = [Text.Encoding]::UTF8.GetBytes($repoFullPath)
        $repoPathSha = [BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash($repoPathBytes)).Replace('-', '')
        $mutexName = 'Global\OrgiastNightlyBootstrap-' + $repoPathSha.Substring(0, 24)
        $mutex = New-Object Threading.Mutex($false, $mutexName)
        $mutexTimeoutMs = 180000
        if ($env:ORGIAST_NIGHTLY_MUTEX_TIMEOUT_MS) {
            $parsedTimeout = 0
            if ([int]::TryParse($env:ORGIAST_NIGHTLY_MUTEX_TIMEOUT_MS, [ref]$parsedTimeout) -and $parsedTimeout -ge 0) {
                $mutexTimeoutMs = $parsedTimeout
            }
        }
        try {
            $mutexAcquired = $mutex.WaitOne($mutexTimeoutMs)
        } catch [Threading.AbandonedMutexException] {
            $mutexAcquired = $true
            Write-NightlyLog '排他制御' 'warn:放棄されたミューテックスを取得。続行'
        }

        if (-not $mutexAcquired) {
            Write-NightlyLog '排他制御' 'warn:他のタスクが同期中のためタイムアウト。既存版で続行'
        } elseif ($env:ORGIAST_NIGHTLY_MUTEX_HOLD_MS -and [int]$env:ORGIAST_NIGHTLY_MUTEX_HOLD_MS -gt 0) {
            Start-Sleep -Milliseconds ([int]$env:ORGIAST_NIGHTLY_MUTEX_HOLD_MS)
        }

        if ($mutexAcquired -and -not $git) {
            Write-NightlyLog 'git確認' 'error:gitが見つからない'
        } elseif ($mutexAcquired) {
          try {
            $gitDir = Join-Path $repo '.git'
            $repoSynced = $true
            if (-not (Test-Path -LiteralPath $gitDir -PathType Container)) {
                $canClone = $true
                if (Test-Path -LiteralPath $repo) {
                    $repoHasContents = $null -ne (Get-ChildItem -LiteralPath $repo -Force | Select-Object -First 1)
                    if ($repoHasContents) {
                        Write-NightlyLog 'リポ同期' ("error:リポではないディレクトリが既にある " + $repo)
                        $canClone = $false
                        $repoSynced = $false
                    }
                }
                if ($canClone) {
                    $repoParent = Split-Path -Parent $repo
                    if ($repoParent) { New-Item -ItemType Directory -Path $repoParent -Force | Out-Null }
                    & $git.Source clone --branch main -- $repoUrl $repo
                    if ($LASTEXITCODE -ne 0) { throw "git clone終了コード=$LASTEXITCODE" }
                }
            } else {
                & $git.Source -C $repo fetch origin main
                if ($LASTEXITCODE -ne 0) { throw "git fetch終了コード=$LASTEXITCODE" }
                & $git.Source -C $repo reset --hard origin/main
                if ($LASTEXITCODE -ne 0) { throw "git reset終了コード=$LASTEXITCODE" }
                & $git.Source -C $repo clean -qfd
                if ($LASTEXITCODE -ne 0) { throw "git clean終了コード=$LASTEXITCODE" }
            }

            if ($repoSynced) {
                $shortSha = (& $git.Source -C $repo rev-parse --short HEAD | Select-Object -Last 1)
                if ($LASTEXITCODE -ne 0 -or -not $shortSha) { throw '短縮SHAを取得できない' }
                Write-NightlyLog 'リポ同期' ("ok:origin/main " + $shortSha.Trim())
            }
        } catch {
            Write-NightlyLog 'リポ同期' ("warn:" + $_.Exception.Message + ' 既存版で続行')
          }
        }

        if ($mutexAcquired) {
          try {
            $repoBootstrap = Join-Path $repo 'tools\nightly-bootstrap.ps1'
            if ((Test-Path -LiteralPath $repoBootstrap -PathType Leaf) -and $PSCommandPath) {
            $selfPath = [IO.Path]::GetFullPath($PSCommandPath)
            $repoRoot = [IO.Path]::GetFullPath($repo).TrimEnd('\', '/')
            $selfInRepo = $selfPath.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
            if (-not $selfInRepo) {
                $installedPath = [IO.Path]::GetFullPath((Join-Path $HOME '.claude\tools\nightly-bootstrap.ps1'))
                $isInstalledPath = $selfPath.Equals($installedPath, [StringComparison]::OrdinalIgnoreCase)
                if ($isInstalledPath -and $env:ORGIAST_NIGHTLY_NO_SELF_UPDATE -ne '1') {
                    $repoHash = Get-NightlyFileSha256 $repoBootstrap
                    $selfHash = Get-NightlyFileSha256 $selfPath
                    if ($repoHash -ne $selfHash) {
                        $selfUpdateTemp = $selfPath + '.new-' + $PID
                        try {
                            Copy-Item -LiteralPath $repoBootstrap -Destination $selfUpdateTemp -Force
                            Move-Item -LiteralPath $selfUpdateTemp -Destination $selfPath -Force
                            Write-NightlyLog '自己更新' 'ok:自己更新(次回から新版)'
                        } catch {
                            Remove-Item -LiteralPath $selfUpdateTemp -Force -ErrorAction SilentlyContinue
                            throw
                        }
                    }
                } elseif ($isInstalledPath) {
                    Write-NightlyLog '自己更新' 'skip:自己更新(ORGIAST_NIGHTLY_NO_SELF_UPDATE=1のため)'
                } else {
                    Write-NightlyLog '自己更新' 'skip:自己更新(運用の設置先でないため)'
                }
            }
            }
          } catch {
            Write-NightlyLog '自己更新' ("warn:" + $_.Exception.Message)
          }
        }

        $targetCandidate = if ([IO.Path]::IsPathRooted($Target)) { $Target } else { Join-Path $repo $Target }
        if (-not (Test-Path -LiteralPath $targetCandidate -PathType Leaf)) {
            Start-Sleep -Seconds 1
        }
        if (-not (Test-Path -LiteralPath $targetCandidate -PathType Leaf)) {
            Stop-Nightly '対象確認' ("error:対象が見つからない " + $targetCandidate) 1
        }
        $targetPath = (Resolve-Path -LiteralPath $targetCandidate).Path
    } finally {
        if ($mutexAcquired -and $mutex) {
            try { $mutex.ReleaseMutex() } catch { }
        }
        if ($mutex) { $mutex.Dispose() }
    }

    $forwardArgs = @($TargetArguments)
    if ($forwardArgs.Count -gt 0 -and [string]$forwardArgs[0] -eq '--') {
        if ($forwardArgs.Count -eq 1) { $forwardArgs = @() } else { $forwardArgs = @($forwardArgs[1..($forwardArgs.Count - 1)]) }
    }

    try {
        $heartbeatScript = Join-Path $repo 'tools\lib\heartbeat.mjs'
        if (-not (Test-Path -LiteralPath $heartbeatScript -PathType Leaf)) { $heartbeatScript = Join-Path $HOME '.claude\tools\lib\heartbeat.mjs' }
        if (Test-Path -LiteralPath $heartbeatScript -PathType Leaf) {
            & node $heartbeatScript --job nightly-bootstrap --startedAt (Get-Date -Format 'o') 2>$null | Out-Null
        }
    } catch { }

    $extension = [IO.Path]::GetExtension($targetPath).ToLowerInvariant()
    if ($extension -eq '.ps1') {
        $shellCommand = $null
        if ([string]::IsNullOrEmpty($Shell) -or $Shell.Equals('powershell', [StringComparison]::OrdinalIgnoreCase)) {
            $shellCommand = 'powershell.exe'
        } elseif ($Shell.Equals('pwsh', [StringComparison]::OrdinalIgnoreCase)) {
            $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
            if ($pwsh) {
                $shellCommand = $pwsh.Source
            } else {
                Write-NightlyLog 'シェル確認' 'warn:pwshが見つからないためpowershellで実行'
                $shellCommand = 'powershell.exe'
            }
        } else {
            Stop-Nightly 'シェル確認' ("error:未知の-Shell " + $Shell) 1
        }
        & $shellCommand -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $targetPath @forwardArgs
        $targetExitCode = $LASTEXITCODE
    } elseif ($extension -eq '.mjs' -or $extension -eq '.js') {
        $node = Get-Command node -ErrorAction SilentlyContinue
        if (-not $node) { Stop-Nightly 'node確認' 'error:nodeが見つからない' 1 }
        & $node.Source $targetPath @forwardArgs
        $targetExitCode = $LASTEXITCODE
    } else {
        Stop-Nightly '対象確認' ("error:対応していない拡張子 " + $extension) 1
    }

    Write-NightlyLog '対象実行' ("ok:" + [IO.Path]::GetFileName($targetPath) + " 終了コード=" + $targetExitCode)
    exit $targetExitCode
} catch {
    try { Write-NightlyLog 'nightly-bootstrap' ("error:" + $_.Exception.Message) } catch { }
    exit 1
}
