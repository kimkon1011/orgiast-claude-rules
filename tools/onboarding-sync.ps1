# onboarding-sync.ps1
# オージャスト共通ルール(ONBOARDING)の自動更新スクリプト。
# Claude Code の SessionStart hook から呼ばれ、GitHub 配布正本の最新版を
# 各メンバーの ~/.claude/CLAUDE.md に自動反映する(1日1回まで、失敗は静かに無視)。

param(
    [string]$TargetPath = '',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$SyncHome    = if ($env:ORGIAST_HOME) { $env:ORGIAST_HOME } elseif ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }
if (-not $TargetPath) { $TargetPath = Join-Path $SyncHome '.claude\CLAUDE.md' }
$RawUrl      = if ($env:ORGIAST_ONBOARDING_URL) { $env:ORGIAST_ONBOARDING_URL } else { 'https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/ONBOARDING.md' }
$StatePath   = Join-Path $SyncHome '.claude\.onboarding-sync-state.json'
$LogPath     = Join-Path $SyncHome '.claude\hooks\onboarding-sync.log'
$RulesPath   = Join-Path $SyncHome '.claude\orgiast-onboarding.md'
$OldRulesPath = Join-Path $SyncHome '.claude\rules\orgiast-onboarding.md'
$BeginMarkerPrefix = '<!-- BEGIN: オージャスト共通ルール'
$EndMarker         = '<!-- END: オージャスト共通ルール -->'
$GuardHours  = 20

function Write-SyncLog {
    param([string]$Message)
    try {
        $logDir = Split-Path -Parent $LogPath
        if (-not (Test-Path -LiteralPath $logDir)) {
            New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        }
        $line = "{0}`t{1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
        if (Test-Path -LiteralPath $LogPath) {
            $existing = Get-Content -LiteralPath $LogPath -Raw -Encoding UTF8
            # 10KB を超えたら先頭を捨てて末尾側を残す(直近の履歴を優先)
            if ($existing.Length -gt 10240) {
                $existing = $existing.Substring($existing.Length - 8192)
            }
            $content = $existing.TrimEnd("`r", "`n") + "`r`n" + $line
        } else {
            $content = $line
        }
        Set-Content -LiteralPath $LogPath -Value $content -Encoding UTF8 -NoNewline
    } catch {
        # ログ書き込み失敗はサイレントに無視(hookを壊さない)
    }
}

function Get-SyncState {
    if (Test-Path -LiteralPath $StatePath) {
        try {
            $raw = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8
            return $raw | ConvertFrom-Json
        } catch {
            return $null
        }
    }
    return $null
}

function Save-SyncState {
    param([string]$Hash, [datetime]$CheckedAt)
    try {
        $stateDir = Split-Path -Parent $StatePath
        if (-not (Test-Path -LiteralPath $stateDir)) {
            New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
        }
        $obj = [ordered]@{
            lastCheck = $CheckedAt.ToString('o')
            hash      = $Hash
        }
        ($obj | ConvertTo-Json) | Set-Content -LiteralPath $StatePath -Encoding UTF8
    } catch {
        # state 保存失敗もサイレントに無視
    }
}

function Get-Sha256Hex {
    param([string]$Text)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        $hashBytes = $sha256.ComputeHash($bytes)
        return -join ($hashBytes | ForEach-Object { $_.ToString('x2') })
    } finally {
        $sha256.Dispose()
    }
}

function New-OnboardingIndex {
    param([string]$Body)
    $result = [System.Collections.Generic.List[string]]::new()
    $result.Add('全文は ~/.claude/orgiast-onboarding.md（および https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/ONBOARDING.md ）。このファイルは自動ロードされない。判断に迷ったら Read ツールで該当節を読むこと')
    $lines = $Body -split "`r`n|`n"
    for ($i = 0; $i -lt $lines.Length; $i++) {
        $line = $lines[$i]
        if ($line -match '^#{1,3}(?:\s|$)') {
            $result.Add($line)
            for ($j = $i + 1; $j -lt $lines.Length -and $lines[$j] -notmatch '^#{1,3}(?:\s|$)'; $j++) {
                $candidate = $lines[$j].Trim()
                if (-not $candidate) { continue }
                $period = $candidate.IndexOf('。')
                $result.Add($(if ($period -ge 0) { $candidate.Substring(0, $period + 1) } else { $candidate }))
                break
            }
        }
        if ($line -match '^(?:🔴|🛑|⚙️|🔁|\*\*🔴)' -and $result[$result.Count - 1] -ne $line) { $result.Add($line) }
    }
    return $result -join "`n"
}

function Update-TargetFile {
    param([string]$NewBody, [string]$TodayLabel)

    $newBlock = "$BeginMarkerPrefix (自動同期 $TodayLabel) -->`r`n$NewBody`r`n$EndMarker"

    if (Test-Path -LiteralPath $TargetPath) {
        # 書き換え前に必ずバックアップ
        $backupPath = "{0}.bak.{1}-onboarding-index" -f $TargetPath, (Get-Date -Format 'yyyy-MM-dd')
        Copy-Item -LiteralPath $TargetPath -Destination $backupPath -Force

        $current = Get-Content -LiteralPath $TargetPath -Raw -Encoding UTF8
        # Multiline の行完全一致だけを対象にし、前後は Substring で一切変換しない。
        $beginMatch = [regex]::Match($current, '(?m)^<!-- BEGIN: オージャスト共通ルール \(自動同期 \d{4}-\d{2}-\d{2}\) -->\r?$')
        if ($beginMatch.Success) {
            $endRegex = [regex]::new('(?m)^<!-- END: オージャスト共通ルール -->\r?$')
            $endMatch = $endRegex.Match($current, $beginMatch.Index + $beginMatch.Length)
            if ($endMatch.Success -and $endMatch.Index -gt $beginMatch.Index) {
                $updated = $current.Substring(0, $beginMatch.Index) + $newBlock + $current.Substring($endMatch.Index + $endMatch.Length)
            } else {
                $updated = $current.TrimEnd("`r", "`n") + "`r`n`r`n" + $newBlock
            }
        } else {
            # マーカーが無い、または対応する END が見当たらない -> 安全側で末尾追記に倒す
            $updated = $current.TrimEnd("`r", "`n") + "`r`n`r`n" + $newBlock
        }
    } else {
        # 新規作成
        $targetDir = Split-Path -Parent $TargetPath
        if (-not (Test-Path -LiteralPath $targetDir)) {
            New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        }
        $updated = $newBlock
    }

    # UTF-8 (BOM無し) で書き込む
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($TargetPath, $updated, $utf8NoBom)
}

function Main {
    $now = Get-Date

    # 旧 rules/ 配下の全文は全リクエストで自動ロードされるため、日次ガードより前に自己修復する。
    # 削除でなく移動にするのは、次の同期まで全文がローカルから消える窓を作らないため。
    try {
        if (Test-Path -LiteralPath $OldRulesPath) {
            if (Test-Path -LiteralPath $RulesPath) {
                Remove-Item -LiteralPath $OldRulesPath -Force
            } else {
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $RulesPath) | Out-Null
                Move-Item -LiteralPath $OldRulesPath -Destination $RulesPath -Force
            }
        }
    } catch {}

    # 1. 日次ガード: 前回チェックから20時間未満なら -Force が無い限りサイレントに終了
    if (-not $Force) {
        $state = Get-SyncState
        if ($state -and $state.lastCheck) {
            try {
                $lastCheck = [datetime]::Parse($state.lastCheck, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
                if (($now - $lastCheck).TotalHours -lt $GuardHours) {
                    return
                }
            } catch {
                # lastCheck のパースに失敗したら継続扱い(次のチェックへ進む)
            }
        }
    }

    # 2. 最新 ONBOARDING.md を取得(失敗時はサイレントに終了、オフライン時にセッションを妨げない)
    $bodyBytes = $null
    try {
        $client = [System.Net.Http.HttpClient]::new()
        $client.Timeout = [TimeSpan]::FromSeconds(15)
        try { $bodyBytes = $client.GetByteArrayAsync($RawUrl).GetAwaiter().GetResult() } finally { $client.Dispose() }
    } catch {
        # Windows PowerShell 5.1 は System.Net.Http が既定でロードされておらず [HttpClient] を解決できない。
        # hook は pwsh が無いPCでは powershell(5.1) で起動されるため、そのPCではルール同期だけが
        # 静かに止まっていた(2026-08-25 実測: "fetch failed: Unable to find type [System.Net.Http.HttpClient]")。
        try {
            try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
            $bodyBytes = (Invoke-WebRequest -Uri $RawUrl -UseBasicParsing -TimeoutSec 15).RawContentStream.ToArray()
        } catch {
            Write-SyncLog "fetch failed: $($_.Exception.Message)"
            return
        }
    }

    if (-not $bodyBytes -or $bodyBytes.Length -eq 0) {
        Write-SyncLog 'fetch returned empty body, skip'
        return
    }

    # 改行を LF に正規化してからハッシュ計算(取得経路による改行差でハッシュが揺れないように)
    $body = [System.Text.Encoding]::UTF8.GetString($bodyBytes)
    $normalizedBody = $body -replace "`r`n", "`n"
    $hash = Get-Sha256Hex -Text $normalizedBody

    # 3. CLAUDE.md の索引と全文ファイルを更新
    try {
        $todayLabel = $now.ToString('yyyy-MM-dd')
        $rulesDir = Split-Path -Parent $RulesPath
        if (-not (Test-Path -LiteralPath $rulesDir)) { New-Item -ItemType Directory -Path $rulesDir -Force | Out-Null }
        [System.IO.File]::WriteAllBytes($RulesPath, $bodyBytes)
        $blockBody = New-OnboardingIndex -Body $body
        Update-TargetFile -NewBody $blockBody -TodayLabel $todayLabel
        Save-SyncState -Hash $hash -CheckedAt $now

        $shortHash = $hash.Substring(0, 8)
        $message = "[onboarding-sync] updated CLAUDE.md (hash $shortHash)"
        Write-Output $message
        Write-SyncLog "updated (hash $shortHash)"
    } catch {
        Write-SyncLog "update failed: $($_.Exception.Message)"
        return
    }
}

try {
    Main
} catch {
    # main の想定外エラーも全て握って exit 0 (hook がセッションを壊さないことを最優先)
    Write-SyncLog "unexpected error: $($_.Exception.Message)"
}

try {
    $homeRoot = if ($env:ORGIAST_HOME) { $env:ORGIAST_HOME } elseif ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }
    # このスクリプトは ~/.claude/hooks/ にも配置されるため、$PSScriptRoot の親では repo に辿り着かない。
    $repoRoot = if ($env:ORGIAST_REPO) { $env:ORGIAST_REPO }
        elseif (Test-Path -LiteralPath (Join-Path $homeRoot 'orgiast-claude-rules\tools')) { Join-Path $homeRoot 'orgiast-claude-rules' }
        else { Split-Path -Parent $PSScriptRoot }
    if (Test-Path -LiteralPath (Join-Path $repoRoot 'tools')) {
        $repoStatePath = Join-Path $homeRoot '.claude\.repo-sync-state.json'
        $shouldSyncRepo = $true
        try {
            $repoState = Get-Content -LiteralPath $repoStatePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            $lastRepoSync = [datetime]::Parse($repoState.last, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
            if (((Get-Date) - $lastRepoSync).TotalHours -lt 24) { $shouldSyncRepo = $false }
        } catch {}
        if ($shouldSyncRepo) {
            $repoSyncMethod = $null
            $repoSyncTemp = $null
            try {
                if ((Test-Path -LiteralPath (Join-Path $repoRoot '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)) {
                    & git -C $repoRoot pull --ff-only 2>$null | Out-Null
                    if ($LASTEXITCODE -ne 0) { throw "git pull failed (exit $LASTEXITCODE)" }
                    $repoSyncMethod = 'git'
                } else {
                    $repoSyncTemp = Join-Path ([System.IO.Path]::GetTempPath()) ("orgiast-repo-sync-" + [guid]::NewGuid().ToString('N'))
                    New-Item -ItemType Directory -Path $repoSyncTemp -Force | Out-Null
                    $repoZip = Join-Path $repoSyncTemp 'main.zip'; $repoExpanded = Join-Path $repoSyncTemp 'expanded'
                    Invoke-WebRequest -Uri 'https://github.com/kimkon1011/orgiast-claude-rules/archive/refs/heads/main.zip' -OutFile $repoZip -UseBasicParsing
                    Expand-Archive -LiteralPath $repoZip -DestinationPath $repoExpanded -Force
                    $repoSource = Join-Path $repoExpanded 'orgiast-claude-rules-main'; foreach ($name in @('tools', 'rules-extracted', 'skills')) {
                        $source = Join-Path $repoSource $name
                        if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $repoRoot -Recurse -Force }
                    }
                    $repoSyncMethod = 'zip'
                }
                New-Item -ItemType Directory -Path (Split-Path -Parent $repoStatePath) -Force | Out-Null
                @{ last = (Get-Date).ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath $repoStatePath -Encoding UTF8
                Write-SyncLog "repo updated ($repoSyncMethod)"
                try {
                    $selfUpdateSource = Join-Path $repoRoot 'tools\onboarding-sync.ps1'
                    $selfUpdateTarget = Join-Path $homeRoot '.claude\hooks\onboarding-sync.ps1'
                    if ((Test-Path -LiteralPath $selfUpdateSource) -and (Test-Path -LiteralPath $selfUpdateTarget)) {
                        $sourceHash = (Get-FileHash -LiteralPath $selfUpdateSource -Algorithm SHA256).Hash
                        $targetHash = (Get-FileHash -LiteralPath $selfUpdateTarget -Algorithm SHA256).Hash
                        if ($sourceHash -ne $targetHash) {
                            Copy-Item -LiteralPath $selfUpdateSource -Destination $selfUpdateTarget -Force
                            Write-SyncLog "onboarding-sync hook updated (effective from next session)"
                        }
                    }
                } catch {
                    Write-SyncLog "onboarding-sync hook update failed: $($_.Exception.Message)"
                }
            } catch { Write-SyncLog "repo sync failed: $($_.Exception.Message)" }
            finally { if ($repoSyncTemp -and (Test-Path -LiteralPath $repoSyncTemp)) { Remove-Item -LiteralPath $repoSyncTemp -Recurse -Force -ErrorAction SilentlyContinue } }
        }
    }
} catch { Write-SyncLog "repo sync failed: $($_.Exception.Message)" }

# 日次同期の成否・差分有無にかかわらず、後から追加された必須hookを自己修復する。
try {
    $homeRoot = if ($env:ORGIAST_HOME) { $env:ORGIAST_HOME } elseif ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }
    $repoRoot = if ($env:ORGIAST_REPO) { $env:ORGIAST_REPO }
        elseif (Test-Path -LiteralPath (Join-Path $homeRoot 'orgiast-claude-rules\tools')) { Join-Path $homeRoot 'orgiast-claude-rules' }
        else { Split-Path -Parent $PSScriptRoot }
    $env:ORGIAST_HOME = $homeRoot
    $env:ORGIAST_REPO = $repoRoot
    $registrar = Join-Path $repoRoot 'tools\register-hooks.mjs'
    if ((Get-Command node -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $registrar)) {
        & node $registrar --hooks-only 2>$null | Out-Null
    }
} catch {
    Write-SyncLog "hook registration failed: $($_.Exception.Message)"
}

exit 0
