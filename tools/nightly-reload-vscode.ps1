# nightly-reload-vscode.ps1
#
# 目的: /session-close で閉じたセッションは jsonl が退避されても VSCode 左の一覧の
#       表示が更新されず、閉じたはずのセッションが残って見える（2026-08-28 特定）。
#       ウィンドウを再読み込みすると表示が最新化されるが、日中にやると作業が止まるため
#       深夜に自動で行う。
#
# 方式: keybindings.json に登録した [Ctrl+Alt+F12] = workbench.action.reloadWindow を
#       SendKeys で送る。長い文字列を打たないので、万一別ウィンドウが前面でも
#       この珍しい組み合わせは基本的に何も起きない（誤爆の被害を最小化する設計）。
#
# 中止条件（どれか1つでも該当したら何もしない）:
#   1. VSCode の表示中ウィンドウが無い
#   2. 直近15分に更新されたセッションがある = 誰か/何かが作業中
#   3. 前回の再読み込み以降に退避されたセッションが無い = 消すものが無い
#   4. SendKeys 直前に VSCode が前面に来ていない
#
# 2026-09-06 追記: Task Scheduler 経由（非対話的なウィンドウステーション）で実行されると
#   AppActivate/GetForegroundWindow/SendKeys が例外を投げることがあり、$ErrorActionPreference='Stop'
#   の下では例外がログに残る前にスクリプトが終了していた（2026-09-03 06:00:01 に実測: ログ0行で
#   Task Scheduler の結果コードのみ非0）。4番目のブロックを try/catch で囲み、例外はログに残した上で
#   必ず exit 0 にする（無人タスクを失敗扱いにしない代わりに原因を追えるようにする）。
#
# ログ: %USERPROFILE%\.claude\nightly-reload-vscode.log
# 手動テスト: powershell -File nightly-reload-vscode.ps1 -DryRun
#             （再読み込みの直前まで実行して、キーは送らない）

param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$claude = Join-Path $env:USERPROFILE '.claude'
$logPath = Join-Path $claude 'nightly-reload-vscode.log'
$marker = Join-Path $claude 'nightly-reload-vscode.last'

function Write-Log($message) {
    $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
    try { Add-Content -Path $logPath -Value $line -Encoding utf8 } catch {}
    Write-Output $line
}

# --- 1. VSCode の表示中ウィンドウ ---
$proc = Get-Process Code -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
if (-not $proc) {
    Write-Log 'SKIP: VSCode の表示中ウィンドウが無い'
    exit 0
}

# --- 2. 作業中でないか（直近15分に書き込まれたセッションが無いか） ---
$projects = Join-Path $claude 'projects'
$cutoff = (Get-Date).AddMinutes(-15)
$busy = @(Get-ChildItem -Path $projects -Filter *.jsonl -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt $cutoff })
if ($busy.Count -gt 0) {
    Write-Log ("SKIP: 作業中（直近15分に更新されたセッション {0} 件: {1}）" -f $busy.Count, ($busy[0].Name))
    exit 0
}

# --- 3. 前回以降に退避が起きたか（消すものがあるか） ---
$since = if (Test-Path $marker) { (Get-Item $marker).LastWriteTime } else { (Get-Date).AddDays(-1) }
$purgeLog = Join-Path $claude 'purge-hidden-sessions.log'
$moved = 0
if (Test-Path $purgeLog) {
    foreach ($line in (Get-Content -Path $purgeLog -Encoding utf8 -ErrorAction SilentlyContinue)) {
        if ($line -match '^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) MOVED') {
            [datetime]$stamp = [datetime]::MinValue
            if ([datetime]::TryParse($Matches[1], [ref]$stamp) -and $stamp -gt $since) { $moved++ }
        }
    }
}
if ($moved -eq 0) {
    Write-Log 'SKIP: 前回の再読み込み以降に退避されたセッションが無い'
    exit 0
}

if ($DryRun) {
    Write-Log ("DRYRUN: ここで再読み込みを実行する（退避 {0} 件 / PID {1}）" -f $moved, $proc.Id)
    exit 0
}

# --- 4. VSCode を前面に出し、前面であることを確認してからキーを送る ---
try {
    Add-Type -AssemblyName Microsoft.VisualBasic
    Add-Type -AssemblyName System.Windows.Forms
    if (-not ('Win32Fg' -as [type])) {
        Add-Type -Namespace '' -Name 'Win32Fg' -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
'@
    }

    [Microsoft.VisualBasic.Interaction]::AppActivate($proc.Id) | Out-Null
    Start-Sleep -Milliseconds 800

    $fg = [Win32Fg]::GetForegroundWindow()
    if ($fg -ne $proc.MainWindowHandle) {
        Write-Log ("SKIP: VSCode が前面に来なかった（誤爆防止のため中止 / fg={0}）" -f $fg)
        exit 0
    }

    [System.Windows.Forms.SendKeys]::SendWait('^%{F12}')
    Set-Content -Path $marker -Value (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') -Encoding utf8
    Write-Log ("RELOADED: 再読み込みを実行（退避 {0} 件 / PID {1}）" -f $moved, $proc.Id)
} catch {
    Write-Log ("ERROR: 再読み込み処理で例外（退避 {0} 件 / PID {1} / {2}）" -f $moved, $proc.Id, $_.Exception.Message)
}
exit 0
