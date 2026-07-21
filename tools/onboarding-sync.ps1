# onboarding-sync.ps1
# オージャスト共通ルール(ONBOARDING)の自動更新スクリプト。
# Claude Code の SessionStart hook から呼ばれ、GitHub 配布正本の最新版を
# 各メンバーの ~/.claude/CLAUDE.md に自動反映する(1日1回まで、失敗は静かに無視)。

param(
    [string]$TargetPath = (Join-Path $env:USERPROFILE '.claude\CLAUDE.md'),
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$RawUrl      = 'https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/ONBOARDING.md'
$StatePath   = Join-Path $env:USERPROFILE '.claude\.onboarding-sync-state.json'
$LogPath     = Join-Path $env:USERPROFILE '.claude\hooks\onboarding-sync.log'
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

function Update-TargetFile {
    param([string]$NewBody, [string]$TodayLabel)

    $newBlock = "$BeginMarkerPrefix (自動同期 $TodayLabel) -->`r`n$NewBody`r`n$EndMarker"

    if (Test-Path -LiteralPath $TargetPath) {
        # 書き換え前に必ずバックアップ
        $backupPath = "{0}.bak.{1}" -f $TargetPath, (Get-Date -Format 'yyyyMMdd-HHmmss')
        Copy-Item -LiteralPath $TargetPath -Destination $backupPath -Force

        $current = Get-Content -LiteralPath $TargetPath -Raw -Encoding UTF8
        # 行単位でマーカーを探す(部分文字列一致だと、ONBOARDING本文が自分自身の
        # マーカー形式を「地の文」として説明している箇所に誤爆するため、
        # 行全体が完全にマーカーと一致する場合のみ本物として扱う)
        $lines = $current -split "`r`n|`n"
        $beginLineIdx = -1
        $endLineIdx = -1
        for ($i = 0; $i -lt $lines.Length; $i++) {
            $trimmed = $lines[$i].Trim()
            if ($beginLineIdx -lt 0 -and $trimmed.StartsWith($BeginMarkerPrefix) -and $trimmed.EndsWith('-->')) {
                $beginLineIdx = $i
                continue
            }
            if ($beginLineIdx -ge 0 -and $endLineIdx -lt 0 -and $trimmed -eq $EndMarker) {
                $endLineIdx = $i
                break
            }
        }

        if ($beginLineIdx -ge 0 -and $endLineIdx -ge 0) {
            $before = if ($beginLineIdx -gt 0) { ($lines[0..($beginLineIdx - 1)] -join "`r`n") + "`r`n" } else { '' }
            $after = if ($endLineIdx -lt ($lines.Length - 1)) { "`r`n" + ($lines[($endLineIdx + 1)..($lines.Length - 1)] -join "`r`n") } else { '' }
            $updated = $before + $newBlock + $after
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
    $body = $null
    try {
        $resp = Invoke-WebRequest -Uri $RawUrl -TimeoutSec 15 -UseBasicParsing
        $body = $resp.Content
    } catch {
        Write-SyncLog "fetch failed: $($_.Exception.Message)"
        return
    }

    if ([string]::IsNullOrEmpty($body)) {
        Write-SyncLog 'fetch returned empty body, skip'
        return
    }

    # 改行を LF に正規化してからハッシュ計算(取得経路による改行差でハッシュが揺れないように)
    $normalizedBody = $body -replace "`r`n", "`n"
    $hash = Get-Sha256Hex -Text $normalizedBody

    # 3. 差分が無ければ lastCheck だけ更新して終了
    $state = Get-SyncState
    if ($state -and $state.hash -eq $hash) {
        Save-SyncState -Hash $hash -CheckedAt $now
        return
    }

    # 4. 差分あり -> CLAUDE.md を更新
    try {
        $todayLabel = $now.ToString('yyyy-MM-dd')
        $blockBody = $normalizedBody -replace "`n", "`r`n"
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

exit 0
