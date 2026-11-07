# nightly-reload-vscode.ps1
#
# 目的: 退避済みセッションを VSCode の一覧から消し、ディスク上で更新された
#       orgiast.next-session を拡張ホストへ確実に反映する。
#
# 方式: 有効化確認済みの orgiast.next-session が 0.2.0 以上なら、まずフォーカス不要の
#       /reload URI を使う。20秒後も拡張ホスト PID が変わらなければ URI が旧コードに
#       吸われたものとして、穏やかな再起動へフォールバックする。旧版の場合も SendKeys は
#       使わず、可視 VSCode ウィンドウすべてへ WM_CLOSE を送り、全 Code プロセス終了後に
#       code.cmd を引数なしで起動する。復元されなければ storage.json から記録したフォルダを
#       明示的に開く。強制終了はしない。
#
# 通常は日付をまたいだ Code を毎晩再起動。72時間以上経過時は busy を無視し理由を記録。
# 中止条件: 可視ウィンドウなし、VSCode 内の対話セッションが直近15分に活動中、
#             当日再起動済みで退避も拡張更新待ちもなし、code.cmd なし、または穏やかに終了できない場合。
# 未クローズの実会話は idle / Overdue にかかわらず保護。一覧不明もスキップ。
# ログ: %USERPROFILE%\.claude\nightly-reload-vscode.log
# 手動テスト: pwsh -NoProfile -File tools/nightly-reload-vscode.ps1 -DryRun

param([switch]$DryRun, [switch]$FunctionsOnly)

$ErrorActionPreference = 'Stop'

# SetThreadExecutionState flags. Decimal literals keep these UInt32 values valid in Windows PowerShell 5.1.
$script:ES_CONTINUOUS_SYSTEM_AWAYMODE_REQUIRED = [uint32]2147483713 # ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED
$script:ES_CONTINUOUS = [uint32]2147483648 # ES_CONTINUOUS

function Write-Log($message) {
    $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
    try { Add-Content -Path $script:logPath -Value $line -Encoding utf8 } catch {}
    Write-Output $line
}

# Use the oldest live Code process, not the URI-reload marker (which is not a restart).
function Get-RestartPolicy([datetime[]]$StartTimes, [datetime]$Now = (Get-Date)) {
    $oldest = @($StartTimes | Sort-Object | Select-Object -First 1)
    if ($oldest.Count -eq 0) { return @{ Due = $false; Overdue = $false; AgeHours = $null } }
    $age = ($Now - $oldest[0]).TotalHours
    return @{ Due = $oldest[0].Date -lt $Now.Date; Overdue = $age -ge 72; AgeHours = $age }
}

function Get-ActivatedExtVersion($Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $text = Get-Content -LiteralPath $Path -Encoding utf8 -ErrorAction Stop | Select-Object -First 1
        if (-not $text) { return $null }
        return [version]$text.Trim()
    } catch { return $null }
}

function Test-ExtensionUpdatePending($DiskVersion, $ActivatedVersion) {
    if (-not $DiskVersion) { return $false }
    $active = if ($ActivatedVersion) { [version]$ActivatedVersion } else { [version]'0.0.0' }
    return ([version]$DiskVersion -gt $active)
}

function Get-InteractiveSessionIdsFromJson($Json) {
    if ([string]::IsNullOrWhiteSpace($Json)) { return @() }
    try { $agents = $Json | ConvertFrom-Json -ErrorAction Stop } catch { return @() }
    $ids = @()
    foreach ($agent in $agents) {
        if ($agent.kind -eq 'interactive' -and $agent.sessionId) { $ids += [string]$agent.sessionId }
    }
    return @($ids | Select-Object -Unique)
}

# Throws on unknown state: callers must fail closed, including malformed inventories.
function Get-ValidatedInteractiveIds($Json) {
    if ([string]::IsNullOrWhiteSpace($Json) -or -not $Json.Trim().StartsWith('[')) { throw 'Invalid agents array' }
    if ($Json -match '^\s*\[\s*\]\s*$') { return @() }
    $agents = @($Json | ConvertFrom-Json -ErrorAction Stop)
    foreach ($agent in $agents) {
        if (-not $agent.kind -or ($agent.kind -eq 'interactive' -and -not $agent.sessionId)) { throw 'Invalid agent' }
    }
    return @(Get-InteractiveSessionIdsFromJson $Json)
}

function Test-TranscriptHasConversation($Lines, [long]$Length = 0) {
    if ($Length -gt 200KB) { return $true }
    foreach ($line in $Lines) {
        try { $row = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
        if ($row.type -notin @('user', 'assistant')) { continue }
        $content = $row.message.content
        if ($content -is [array]) { $content = ($content | ForEach-Object { $_.text }) -join ' ' }
        if ($content -isnot [string] -or [string]::IsNullOrWhiteSpace($content)) { continue }
        if ($row.type -eq 'assistant' -or $content -notmatch '<local-command-caveat>|<command-name>|<command-message>') { return $true }
    }
    return $false
}

function Select-ProtectedSessionIds($InteractiveIds, $ClosedIds, $Transcripts) {
    foreach ($id in @($InteractiveIds)) {
        if ($id -notin @($ClosedIds) -and @($Transcripts | Where-Object { $_.Id -eq $id -and $_.HasConversation }).Count -gt 0) { $id }
    }
}

function Get-ProtectedSessionIds {
    $cli = (Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $cli) { $cli = Join-Path $env:USERPROFILE '.local\bin\claude.exe' }
    $json = (& $cli agents --json 2>$null) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'agents failed' }
    $ids = @(Get-ValidatedInteractiveIds $json)
    if ($ids.Count -eq 0) { return @() }
    $base = Join-Path $env:USERPROFILE '.claude'
    $closed = @()
    $ledger = Join-Path $base 'closed-sessions.json'
    if (Test-Path -LiteralPath $ledger) {
        $data = Get-Content -LiteralPath $ledger -Raw -Encoding utf8 | ConvertFrom-Json
        if ($data.ids -isnot [array]) { throw 'Invalid closed ledger' }
        $closed = @($data.ids)
    }
    $transcripts = @(Get-ChildItem -LiteralPath (Join-Path $base 'projects') -Directory | Where-Object { $_.Name -ne '_deleted-backup' } | ForEach-Object {
        foreach ($file in @(Get-ChildItem -LiteralPath $_.FullName -Filter '*.jsonl' -File)) {
            if ($file.BaseName -in $ids -and $file.BaseName -notin $closed) {
                $hasConversation = $file.Length -gt 200KB
                if (-not $hasConversation) { $hasConversation = Test-TranscriptHasConversation (Get-Content -LiteralPath $file.FullName -Encoding utf8) $file.Length }
                @{ Id = $file.BaseName; HasConversation = $hasConversation }
            }
        }
    })
    return @(Select-ProtectedSessionIds $ids $closed $transcripts)
}

function Test-RemoteControlProtection {
    try { $protected = @(Get-ProtectedSessionIds) } catch {
        Write-Log 'SKIP: セッション一覧を取得できない（Remote Control 保護）' | Out-Host
        return $true
    }
    if ($protected.Count -gt 0) {
        Write-Log ("SKIP: 未クローズの稼働セッション {0} 件（Remote Control 保護）" -f $protected.Count) | Out-Host
        return $true
    }
    Write-Log 'RC-GUARD: 保護対象 0 件' | Out-Host
    return $false
}

function Get-InteractiveSessionCount {
    try {
        $claudeCli = (Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1).Source
        if (-not $claudeCli) {
            $candidate = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
            if (Test-Path -LiteralPath $candidate) { $claudeCli = $candidate }
        }
        if (-not $claudeCli) { return 0 }
        $json = (& $claudeCli agents --json 2>$null) -join "`n"
        return @(Get-InteractiveSessionIdsFromJson $json).Count
    } catch { return 0 }
}

function Get-BusySessionFiles($ProjectsPath, [datetime]$Cutoff, [string[]]$InteractiveSessionIds, [bool]$AgentsUsable) {
    $recent = @(Get-ChildItem -Path $ProjectsPath -Filter *.jsonl -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -gt $Cutoff })
    if (-not $AgentsUsable) { return $recent }
    $wanted = @{}
    foreach ($id in @($InteractiveSessionIds)) { if ($id) { $wanted[$id] = $true } }
    return @($recent | Where-Object { $wanted.ContainsKey($_.BaseName) })
}

function Get-VSCodeRestoreTargets($StoragePath) {
    if (-not (Test-Path -LiteralPath $StoragePath)) { return @() }
    try { $state = Get-Content -LiteralPath $StoragePath -Raw -Encoding utf8 | ConvertFrom-Json -ErrorAction Stop } catch { return @() }
    $values = @()
    foreach ($window in @($state.windowsState.openedWindows) + @($state.windowsState.lastActiveWindow)) {
        if (-not $window) { continue }
        foreach ($property in @('folder', 'workspace')) {
            $value = $window.$property
            if ($value -isnot [string] -and $value) { $value = $value.folderUri; if (-not $value) { $value = $window.$property.configPath } }
            if ($value -is [string] -and $value.StartsWith('file:///', [System.StringComparison]::OrdinalIgnoreCase)) {
                try { $values += [uri]::UnescapeDataString(([uri]$value).LocalPath) } catch {}
            }
        }
    }
    return @($values | Where-Object { $_ } | Select-Object -Unique)
}

function Initialize-WindowApi {
    if ('NightlyReloadWin32' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NightlyReloadWin32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
}
'@
}

function Enable-SleepInhibition {
    try {
        Initialize-WindowApi
        [void][NightlyReloadWin32]::SetThreadExecutionState($script:ES_CONTINUOUS_SYSTEM_AWAYMODE_REQUIRED)
    } catch {
        Write-Log ("WARN: スリープ抑止に失敗（{0}）" -f $_.Exception.Message)
    }
}

function Disable-SleepInhibition {
    try {
        Initialize-WindowApi
        [void][NightlyReloadWin32]::SetThreadExecutionState($script:ES_CONTINUOUS)
    } catch {
        Write-Log ("WARN: スリープ抑止に失敗（{0}）" -f $_.Exception.Message)
    }
}

function Get-VSCodeWindowHandles {
    Initialize-WindowApi
    $handles = [System.Collections.Generic.List[System.IntPtr]]::new()
    $callback = [NightlyReloadWin32+EnumWindowsProc]{
        param([IntPtr]$handle, [IntPtr]$unused)
        if ([NightlyReloadWin32]::IsWindowVisible($handle)) {
            $title = [Text.StringBuilder]::new(1024)
            [void][NightlyReloadWin32]::GetWindowText($handle, $title, $title.Capacity)
            if ($title.ToString() -like '*Visual Studio Code') { $handles.Add($handle) }
        }
        return $true
    }
    [void][NightlyReloadWin32]::EnumWindows($callback, [IntPtr]::Zero)
    return @($handles)
}

function Get-ExtensionHostPids {
    return @(Get-CimInstance Win32_Process -Filter "Name = 'Code.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match '--type[= ]extensionHost' } | ForEach-Object { [int]$_.ProcessId } | Sort-Object)
}

function Resolve-CodeCli {
    if ($env:VSCODE_CLI_PATH -and (Test-Path -LiteralPath $env:VSCODE_CLI_PATH)) { return $env:VSCODE_CLI_PATH }
    return @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'),
        'C:\Program Files\Microsoft VS Code\bin\code.cmd',
        'C:\Program Files (x86)\Microsoft VS Code\bin\code.cmd'
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

function Start-CodeCli($CodeCli, [string[]]$Arguments = @()) {
    $quoted = '"' + $CodeCli.Replace('"', '""') + '"'
    foreach ($argument in $Arguments) { $quoted += ' "' + $argument.Replace('"', '""') + '"' }
    Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/c', $quoted) -WindowStyle Hidden | Out-Null
}

function Wait-Until($Condition, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (& $Condition) { return $true }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Invoke-VSCodeRestart($CodeCli, [string[]]$RestoreTargets) {
    if (Test-RemoteControlProtection) { return $false }
    $handles = @(Get-VSCodeWindowHandles)
    foreach ($handle in $handles) { [void][NightlyReloadWin32]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
    if (-not (Wait-Until { @(Get-Process Code -ErrorAction SilentlyContinue).Count -eq 0 } 60)) {
        Write-Log 'SKIP: VSCode が終了しなかった' | Out-Host
        return $false
    }
    Start-CodeCli $CodeCli
    if (-not (Wait-Until { @(Get-VSCodeWindowHandles).Count -gt 0 } 60)) {
        foreach ($target in $RestoreTargets) { Start-CodeCli $CodeCli @($target) }
        if (-not (Wait-Until { @(Get-VSCodeWindowHandles).Count -gt 0 } 60)) {
            Write-Log 'SKIP: VSCode の再起動後に可視ウィンドウを確認できなかった' | Out-Host
            return $false
        }
    }
    return $true
}

function Wait-InteractiveSessions([int]$Target, [int]$TimeoutSeconds, [int]$IntervalSeconds = 20) {
    for ($elapsed = 0; $elapsed -le $TimeoutSeconds; $elapsed += $IntervalSeconds) {
        $count = Get-InteractiveSessionCount
        if ($count -ge $Target -and $count -ge 1) {
            Write-Log ("RESUMED: interactive {0} 件 / 目標 {1} 件 / {2} 秒" -f $count, $Target, $elapsed) | Out-Host
            return $count
        }
        if ($elapsed + $IntervalSeconds -le $TimeoutSeconds) { Start-Sleep -Seconds $IntervalSeconds }
    }
    return $count
}

function Confirm-VSCodeResume([int]$Target, $CodeCli, [string[]]$RestoreTargets) {
    $count = Wait-InteractiveSessions $Target 360 20
    if ($count -eq 0) {
        if (Test-RemoteControlProtection) { return $count }
        Write-Log 'RESUME-RETRY: 起動失敗を検知、再起動を 1 回やり直す' | Out-Host
        if (Invoke-VSCodeRestart $CodeCli $RestoreTargets) {
            $count = Wait-InteractiveSessions $Target 240 20
        }
        if ($count -eq 0) { Write-Log 'RESUME-FAIL: interactive 0 件' | Out-Host }
    }
    return $count
}

if ($FunctionsOnly) { return }

$claude = Join-Path $env:USERPROFILE '.claude'
$script:logPath = Join-Path $claude 'nightly-reload-vscode.log'
$marker = Join-Path $claude 'nightly-reload-vscode.last'
$activatedMarker = Join-Path $claude 'nightly-reload-vscode.ext-activated'

try {
    $windowHandles = @(Get-VSCodeWindowHandles)
    if ($windowHandles.Count -eq 0) { Write-Log 'SKIP: VSCode の表示中ウィンドウが無い'; exit 0 }

    if (Test-RemoteControlProtection) { exit 0 }
    $policy = Get-RestartPolicy @(Get-Process Code -ErrorAction SilentlyContinue | ForEach-Object { $_.StartTime })
    if ($policy.Overdue) { Write-Log ('FORCE-RESTART: Code age={0:N1}h >= 72h; bypass busy and URI reload' -f $policy.AgeHours) }

    $agentsUsable = $false
    $interactiveIds = @()
    try {
        # タスクスケジューラの非対話環境では PATH に claude が無いことがある。無ければ既定の導入先を直接使う。
        $claudeCli = (Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1).Source
        if (-not $claudeCli) {
            $candidate = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
            if (Test-Path -LiteralPath $candidate) { $claudeCli = $candidate }
        }
        if (-not $claudeCli) { Write-Log 'WARN: claude CLI が見つからないため busy 判定を全 jsonl に戻す'; throw 'claude CLI not found' }
        $agentsOutput = (& $claudeCli agents --json 2>$null) -join "`n"
        if (-not [string]::IsNullOrWhiteSpace($agentsOutput)) {
            $parsed = $agentsOutput | ConvertFrom-Json -ErrorAction Stop
            $interactiveIds = @(Get-InteractiveSessionIdsFromJson $agentsOutput)
            $agentsUsable = $null -ne $parsed
        }
    } catch { $agentsUsable = $false }
    $busy = @(Get-BusySessionFiles (Join-Path $claude 'projects') (Get-Date).AddMinutes(-15) $interactiveIds $agentsUsable)
    if ($busy.Count -gt 0 -and -not $policy.Overdue) {
        $busyMessage = "作業中（直近15分に更新されたVSCodeセッション {0} 件: {1}）" -f $busy.Count, $busy[0].Name
        if ($DryRun) { Write-Log ("DRYRUN: 実行時はSKIP（{0}）" -f $busyMessage) }
        else { Write-Log ("SKIP: {0}" -f $busyMessage) }
        exit 0
    }

    $codeCli = Resolve-CodeCli
    if (-not $codeCli) { Write-Log 'SKIP: code.cmd（VSCode CLI）が見つからない'; exit 0 }

    $installedLine = (& $codeCli --list-extensions --show-versions 2>$null) |
        Where-Object { $_ -match '^orgiast\.next-session@' } | Select-Object -First 1
    $diskVersion = $null
    if ($installedLine) { try { $diskVersion = [version](($installedLine -split '@', 2)[1]) } catch {} }
    $activatedVersion = Get-ActivatedExtVersion $activatedMarker
    $updatePending = Test-ExtensionUpdatePending $diskVersion $activatedVersion

    $since = if (Test-Path $marker) { (Get-Item $marker).LastWriteTime } else { (Get-Date).AddDays(-1) }
    $moved = 0
    $purgeLog = Join-Path $claude 'purge-hidden-sessions.log'
    if (Test-Path $purgeLog) {
        foreach ($line in (Get-Content -Path $purgeLog -Encoding utf8 -ErrorAction SilentlyContinue)) {
            if ($line -match '^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) MOVED') {
                [datetime]$stamp = [datetime]::MinValue
                if ([datetime]::TryParse($Matches[1], [ref]$stamp) -and $stamp -gt $since) { $moved++ }
            }
        }
    }
    if (-not $policy.Due -and $moved -eq 0 -and -not $updatePending) { Write-Log 'SKIP: 退避されたセッションも拡張の更新待ちも無い'; exit 0 }

    $reasonParts = @()
    if ($policy.Due) { $reasonParts += ('nightly restart / Code age={0:N1}h' -f $policy.AgeHours) }
    if ($moved -gt 0) { $reasonParts += "退避 $moved 件" }
    if ($updatePending) { $reasonParts += "更新待ち $diskVersion" }
    $reason = $reasonParts -join ' / '
    $requiredVersion = [version]'0.2.0'
    $uriEligible = -not $policy.Due -and $diskVersion -and $diskVersion -ge $requiredVersion -and $activatedVersion -and $activatedVersion -ge $requiredVersion
    $pathLabel = if ($uriEligible) { 'URI（未確認時はRestart）' } else { 'Restart' }
    if ($DryRun) {
        Write-Log ("DRYRUN: ここで再起動する（{0} / {1} / 対象窓 {2}）" -f $pathLabel, $reason, $windowHandles.Count)
        Write-Log 'DRYRUN: 復帰確認をスキップ'
        exit 0
    }

    $useRestart = -not $uriEligible
    if ($uriEligible) {
        if (Test-RemoteControlProtection) { exit 0 }
        $beforePids = @(Get-ExtensionHostPids)
        & $codeCli --open-url 'vscode://orgiast.next-session/reload?probe=1' | Out-Null
        Start-Sleep -Seconds 20
        $afterPids = @(Get-ExtensionHostPids)
        $useRestart = (($beforePids -join ',') -eq ($afterPids -join ','))
        if (-not $useRestart) {
            Set-Content -Path $marker -Value (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') -Encoding utf8
            if ($diskVersion) { Set-Content -Path $activatedMarker -Value $diskVersion.ToString() -Encoding utf8 }
            Write-Log ("RELOADED: 再読み込みを実行（URI / {0}）" -f $reason)
        } else { Write-Log 'FALLBACK: URI 後も拡張ホスト PID が変わらないため Restart へ切替' }
    }

    if ($useRestart) {
        Enable-SleepInhibition
        try {
            $storage = Join-Path $env:APPDATA 'Code\User\globalStorage\storage.json'
            $restoreTargets = @(Get-VSCodeRestoreTargets $storage)
            $resumeTarget = [Math]::Min($interactiveIds.Count, 3)
            if ($resumeTarget -lt 1) { $resumeTarget = [Math]::Min((Get-InteractiveSessionCount), 3) }
            if ($resumeTarget -lt 1) { $resumeTarget = 1 }
            $restartSince = (Get-Date).ToUniversalTime().ToString("o")
            if (-not (Invoke-VSCodeRestart $codeCli $restoreTargets)) { exit 0 }
            Set-Content -Path $marker -Value (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') -Encoding utf8
            if ($diskVersion) { Set-Content -Path $activatedMarker -Value $diskVersion.ToString() -Encoding utf8 }
            $updateLabel = if ($updatePending) { $diskVersion.ToString() } else { 'なし' }
            Write-Log ("RELOADED: 再起動を実行（Restart / 退避 {0} 件 / 更新待ち {1}）" -f $moved, $updateLabel)
            [void](Confirm-VSCodeResume $resumeTarget $codeCli $restoreTargets)
            $reopenScript = Join-Path $PSScriptRoot 'reopen-lost-sessions.mjs'
            $reopenUntil = (Get-Date).ToUniversalTime().ToString('o')
            Start-Process -FilePath (Get-Command node.exe -ErrorAction Stop).Source -ArgumentList @(('"{0}"' -f $reopenScript), '--since', $restartSince, '--until', $reopenUntil) -WindowStyle Hidden | Out-Null
            Write-Log 'RECOVERY: host_exit の自動復旧をバックグラウンドで起動'
        } finally {
            Disable-SleepInhibition
        }
    }
} catch {
    Write-Log ("ERROR: 再読み込み処理で例外（{0}）" -f $_.Exception.Message)
}
exit 0
