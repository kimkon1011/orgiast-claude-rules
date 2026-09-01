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
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
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

    if (-not $git) {
        Write-NightlyLog 'git確認' 'error:gitが見つからない'
    } else {
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
                        Copy-Item -LiteralPath $repoBootstrap -Destination $selfPath -Force
                        Write-NightlyLog '自己更新' 'ok:自己更新(次回から新版)'
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

    $targetPath = if ([IO.Path]::IsPathRooted($Target)) { $Target } else { Join-Path $repo $Target }
    if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
        Stop-Nightly '対象確認' ("error:対象が見つからない " + $targetPath) 1
    }
    $targetPath = (Resolve-Path -LiteralPath $targetPath).Path

    $forwardArgs = @($TargetArguments)
    if ($forwardArgs.Count -gt 0 -and [string]$forwardArgs[0] -eq '--') {
        if ($forwardArgs.Count -eq 1) { $forwardArgs = @() } else { $forwardArgs = @($forwardArgs[1..($forwardArgs.Count - 1)]) }
    }

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
