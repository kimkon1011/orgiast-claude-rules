# nightly-reload-vscode.ps1
#
# 目的: /session-close で閉じたセッションは jsonl が退避されても VSCode 左の一覧の
#       表示が更新されず、閉じたはずのセッションが残って見える（2026-08-28 特定）。
#       ウィンドウを再読み込みすると表示が最新化されるが、日中にやると作業が止まるため
#       深夜に自動で行う。
#
# 方式（2026-09-06 SendKeys から乗り換え、同日中に二段構えへ修正）: 本線は
#       orgiast.next-session 拡張の URI ハンドラ (vscode://orgiast.next-session/reload) に
#       workbench.action.reloadWindow を実行させる。旧方式は AppActivate で前面に出してから
#       SendKeys '^%{F12}' を送っていたが、2026-09-06 に4回中3回「SKIP: VSCode が前面に来なかった」
#       で再読み込みそのものが発生しなくなった（他アプリが前面にいると誤爆防止ガードが正しく
#       中止する設計自体は健全だが、それにより本来やりたい再読み込みが実行されない日が続いた）。
#       URI 経由は前面/フォーカスに一切依存せず、別ウィンドウを誤爆する経路も無いため、
#       このガードごと不要になった…はずだったが、実行前に読める `--list-extensions --show-versions`
#       の結果は「ディスク上のバージョン」であって「拡張ホストで走っている実行中のバージョン」
#       ではない（拡張の更新は Reload Window するまで有効化されない）。そのため
#       「バージョンが古い→vsix を入れる→その場で URI を撃つ」の順にすると、URI を処理するのは
#       まだ旧コードのままで、旧コードは uri.path を見ないため /reload が /start 相当に落ち、
#       `claude /session-start` を実行するターミナルを無人で開いてしまう（設計時に見落とし、
#       実装前のレビューで指摘されて修正）。
#
#       そこで二段構えにする。ただし判定を「ディスク版が0.2.0以上か」だけにすると別の詰みが
#       起きる（2026-09-06 レビューで実測に基づき指摘・修正）: vsix を入れた回に SendKeys の
#       前面化が失敗すると（4回中3回起きる程度にはよくある）、ディスク版だけは 0.2.0 に
#       なるが実行中は旧 0.1.1 のまま。翌日の run は「ディスク版0.2.0」を見て URI 経路を
#       選んでしまうが、処理するのはまだ有効化されていない旧コードなので /reload が /start に
#       落ちてターミナルが無人で開き、しかも再読み込みが二度と起きないので永久に有効化されない
#       （自力で抜け出せない詰み）。
#       これを避けるため、URI 経路の条件を「ディスク版 ≥ 0.2.0」**かつ**「有効化を確認済みの
#       バージョン（`%USERPROFILE%\.claude\nightly-reload-vscode.ext-activated` に、過去の
#       再読み込み成功時点のディスク版を記録したもの）≥ 0.2.0」の両方にする。マーカーが無い・
#       読めない・解釈できない場合は未確認として安全側（SendKeys 経路）に倒す。
#         - 両方 0.2.0 以上 → URI 経路（本線。probe=1 を付けて撃つ。新版の /reload 分岐は
#           probe を読まず即 reload するので無害。万一まだ未有効化の旧コードに届いても、
#           旧コードは probe=1 を見て echo するだけの無害な probe ターミナルを作るだけで、
#           claude /session-start は絶対に走らない＝保険）。
#         - どちらか欠ける → 同梱 vsix の中で一番新しいものを（ディスク版がまだ古ければ）
#           `--install-extension ... --force` で入れつつ、**この回は**旧来の SendKeys 経路
#           （AppActivate → GetForegroundWindow で前面確認 → SendKeys '^%{F12}'、前面に来な
#           ければ従来どおり SKIP ログを出して中止）で再読み込みする。成功したらそのとき
#           入れた/入っているディスク版を ext-activated マーカーに書く。
#           前面化に失敗し続けても、翌日以降も同じ理由で SendKeys を試し続けるので、いつか
#           前面に来た日に有効化が確認され、以後は自動的に URI 経路へ切り替わる（詰まない）。
#       SendKeys 経路を削除しきらないのはこのため（拡張が入ってから有効化が確認できるまでの
#       過渡措置として必要）。
#       ログの `RELOADED:` 行にどちらの経路を通ったか（`URI` / `SendKeys`）を残す
#       （先頭の `RELOADED:` 自体は変えない。過去ログの grep 互換のため）。URI 経路を選ばなかった
#       理由は `INSTALL:` 行、またはインストール不要なら `WAIT-ACTIVATION:` 行に残す。
#
# 中止条件（どれか1つでも該当したら何もしない）:
#   1. VSCode の表示中ウィンドウが無い
#   2. 直近15分に更新されたセッションがある = 誰か/何かが作業中
#   3. 前回の再読み込み以降に退避されたセッションが無い = 消すものが無い
#   4. code.cmd（VSCode CLI）が見つからない
#   5.（ディスク版/有効化確認のどちらかが 0.2.0 未満で SendKeys にフォールバックした回のみ）
#      SendKeys 直前に VSCode が前面に来ていない
#
# 2026-09-06 追記: Task Scheduler 経由（非対話的なウィンドウステーション）で実行されると
#   外部プロセス呼び出しが例外を投げることがあり、$ErrorActionPreference='Stop' の下では
#   例外がログに残る前にスクリプトが終了していた（2026-09-03 06:00:01 に実測: ログ0行で
#   Task Scheduler の結果コードのみ非0）。拡張バージョン確認〜URI発火のブロックを try/catch で
#   囲み、例外はログに残した上で必ず exit 0 にする（無人タスクを失敗扱いにしない代わりに
#   原因を追えるようにする）。
#
# ログ: %USERPROFILE%\.claude\nightly-reload-vscode.log
# 手動テスト: powershell -File nightly-reload-vscode.ps1 -DryRun
#             （再読み込みの直前まで実行して、URI は撃たない）

param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$claude = Join-Path $env:USERPROFILE '.claude'
$logPath = Join-Path $claude 'nightly-reload-vscode.log'
$marker = Join-Path $claude 'nightly-reload-vscode.last'
$activatedMarker = Join-Path $claude 'nightly-reload-vscode.ext-activated'

function Write-Log($message) {
    $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
    try { Add-Content -Path $logPath -Value $line -Encoding utf8 } catch {}
    Write-Output $line
}

# 拡張が 0.2.0 未満で走っている回だけの過渡的フォールバック。
# AppActivate で前面に出し、実際に前面に来たことを確認してから SendKeys を送る
# （誤爆防止。前面に来なければ何もキーを送らず失敗を返す）。
function Invoke-SendKeysReload($proc) {
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
        return [pscustomobject]@{ Success = $false; ForegroundHandle = $fg }
    }

    [System.Windows.Forms.SendKeys]::SendWait('^%{F12}')
    return [pscustomobject]@{ Success = $true }
}

# 「ディスク上に入っている」ではなく「実際に再読み込みされて有効化されたことを
# 確認済み」のバージョンを読む。無い／読めない／版として解釈できない場合は
# $null（＝未確認）を返し、呼び出し側は安全側（SendKeys 経路）に倒す。
function Get-ActivatedExtVersion($path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        $text = Get-Content -LiteralPath $path -Encoding utf8 -ErrorAction Stop | Select-Object -First 1
        if (-not $text) { return $null }
        return [version]$text.Trim()
    } catch {
        return $null
    }
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

# --- 4. code.cmd を解決し、拡張バージョンを確認してから reload URI を撃つ ---
try {
    $codeCli = $env:VSCODE_CLI_PATH
    if (-not $codeCli -or -not (Test-Path -LiteralPath $codeCli)) {
        $candidates = @(
            (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'),
            'C:\Program Files\Microsoft VS Code\bin\code.cmd',
            'C:\Program Files (x86)\Microsoft VS Code\bin\code.cmd'
        )
        $codeCli = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    }
    if (-not $codeCli) {
        Write-Log 'SKIP: code.cmd（VSCode CLI）が見つからない'
        exit 0
    }

    # `--list-extensions --show-versions` が返すのは「ディスク上のバージョン」であって
    # 「拡張ホストで走っている実行中のバージョン」ではない（更新は Reload Window するまで
    # 有効化されない）。ディスク版だけを見て URI 経路に倒すと、入れた直後でまだ有効化されて
    # いない旧コードが URI を処理して /reload が /start に落ちる事故が起きる上、二度と
    # 再読み込みが起きない詰みに陥る（有効化されないと永久に旧コードのまま）。
    # そのため判定は「ディスク版 ≥ 0.2.0」と「有効化を確認済みの版（$activatedMarker、
    # 過去に SendKeys/URI いずれかで再読み込みが成功した時点のディスク版を記録）≥ 0.2.0」の
    # 両方が揃って初めて URI 経路にする。マーカーが無い／読めない／解釈できない場合は
    # 未確認として安全側（SendKeys 経路）に倒す。SendKeys 経路は成功する度にマーカーを
    # 更新するので、前面化に失敗し続けても前面に来た日に有効化が確認され、以後は URI 経路に
    # 自動で切り替わる（詰みにならない）。
    $requiredVersion = [version]'0.2.0'
    $installedLine = (& $codeCli --list-extensions --show-versions 2>$null) |
        Where-Object { $_ -match '^orgiast\.next-session@' } |
        Select-Object -First 1
    $diskVersion = $null
    if ($installedLine) {
        $verText = ($installedLine -split '@', 2)[1]
        try { $diskVersion = [version]$verText } catch { $diskVersion = $null }
    }
    $diskVersionOk = $diskVersion -and ($diskVersion -ge $requiredVersion)

    $activatedVersion = Get-ActivatedExtVersion $activatedMarker
    $activatedVersionOk = $activatedVersion -and ($activatedVersion -ge $requiredVersion)

    $runningVersionOk = $diskVersionOk -and $activatedVersionOk

    if ($runningVersionOk) {
        # --- 本線: ディスク版・有効化確認済み版とも 0.2.0 以上 → URI 経路 ---
        # probe=1 は保険。0.2.0 の /reload 分岐は probe を読まず即 reload するため無害。
        # 万一ここの判定をすり抜けて未有効化の旧コードに届いても、旧コードは probe=1 を見て
        # echo するだけの無害な probe ターミナルを作るだけで済む（claude /session-start は走らない）。
        & $codeCli --open-url 'vscode://orgiast.next-session/reload?probe=1' | Out-Null
        Set-Content -Path $marker -Value (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') -Encoding utf8
        Set-Content -Path $activatedMarker -Value $diskVersion.ToString() -Encoding utf8
        Write-Log ("RELOADED: 再読み込みを実行（URI / 退避 {0} 件 / PID {1}）" -f $moved, $proc.Id)
    } else {
        # --- 過渡期: ディスク版・有効化確認とも揃うまで SendKeys で再読み込みする ---
        $reason = if (-not $diskVersionOk) { 'ディスク版が0.2.0未満' } else { "有効化未確認（マーカー: $(if ($activatedVersion) { $activatedVersion } else { '無し' })）" }

        $vsixInstallVersion = $diskVersion
        if (-not $diskVersionOk) {
            $vsixDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'packages\vscode-next-session'
            $vsix = Get-ChildItem -Path $vsixDir -Filter 'orgiast-next-session-*.vsix' -File -ErrorAction SilentlyContinue |
                Sort-Object -Property @{ Expression = { [version]($_.BaseName -replace '^orgiast-next-session-', '') } } -Descending |
                Select-Object -First 1
            if (-not $vsix) {
                Write-Log 'SKIP: orgiast-next-session の vsix が見つからない（拡張を更新できない）'
                exit 0
            }
            & $codeCli --install-extension $vsix.FullName --force | Out-Null
            $beforeLabel = if ($installedLine) { $installedLine } else { '未インストール' }
            $vsixInstallVersion = [version]($vsix.BaseName -replace '^orgiast-next-session-', '')
            Write-Log ("INSTALL: orgiast.next-session を更新（現在: {0} → {1} / 理由: {2} / 次回以降 URI 経路へ切替予定）" -f $beforeLabel, $vsix.Name, $reason)
        } else {
            Write-Log ("WAIT-ACTIVATION: URI経路を使わずSendKeysで再読み込みします（理由: {0}）" -f $reason)
        }

        $sendKeysResult = Invoke-SendKeysReload $proc
        if (-not $sendKeysResult.Success) {
            Write-Log ("SKIP: VSCode が前面に来なかった（誤爆防止のため中止 / fg={0}）" -f $sendKeysResult.ForegroundHandle)
            exit 0
        }
        Set-Content -Path $marker -Value (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') -Encoding utf8
        if ($vsixInstallVersion) { Set-Content -Path $activatedMarker -Value $vsixInstallVersion.ToString() -Encoding utf8 }
        Write-Log ("RELOADED: 再読み込みを実行（SendKeys / 退避 {0} 件 / PID {1}）" -f $moved, $proc.Id)
    }
} catch {
    Write-Log ("ERROR: 再読み込み処理で例外（退避 {0} 件 / PID {1} / {2}）" -f $moved, $proc.Id, $_.Exception.Message)
}
exit 0
