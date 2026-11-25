# session-status.ps1
# Lightweight 60-min session STATUS writer. No Claude API.
# Each PC scans local gb-reports, writes STATUS-<PC>.md, publishes to
# fleet-heartbeat git branch. 000 collects all and writes SUMMARY.md.
param([switch]$Install)
$ErrorActionPreference = 'Continue'
$HOME_DIR = $env:USERPROFILE
$GB_DIR   = Join-Path $HOME_DIR 'gb-offload'
$GB_REP   = Join-Path $HOME_DIR 'gb-reports'
$OUT_DIR  = Join-Path $GB_REP 'session-status'
$UTF8     = New-Object Text.UTF8Encoding $false
$NOW      = Get-Date
$STALE    = $NOW.AddDays(-3)
$HOSTN    = $env:COMPUTERNAME
$LABEL    = $null
$labelFile = Join-Path $GB_DIR 'pc-label.txt'
if (Test-Path $labelFile) {
  $t = (Get-Content $labelFile -Raw -ErrorAction SilentlyContinue)
  if ($t) { $t = $t.Trim(); if ($t) { $LABEL = $t } }
}
if (-not $LABEL) {
  if ($HOSTN -match '^(000|004|008|011|014|015|018|019|999)') { $LABEL = $Matches[1] }
  else { $LABEL = $HOSTN }
}
$IS000 = ($LABEL -eq '000' -or $HOSTN -match '^000')
New-Item -ItemType Directory -Force $OUT_DIR, $GB_REP | Out-Null

function Get-TextPreview([string]$Path, [int]$MaxChars = 4000) {
  if (-not (Test-Path $Path)) { return '' }
  try {
    $fs = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
    try {
      $len = [Math]::Min($fs.Length, $MaxChars)
      if ($fs.Length -gt $MaxChars) { [void]$fs.Seek(-$len, 'End') }
      $buf = New-Object byte[] $len
      $n = $fs.Read($buf, 0, $len)
      $txt = [Text.Encoding]::UTF8.GetString($buf, 0, $n)
      return $txt
    } finally { $fs.Close() }
  } catch { return '' }
}

function Get-Field([string]$Text, [string]$Name) {
  if (-not $Text) { return '' }
  $rx = '(?im)(?:^|\n)\s*(?:[-*]\s*)?(?:\#+\s*)?' + [regex]::Escape($Name) + '\s*[:：]\s*(.+)$'
  $m = [regex]::Match($Text, $rx)
  if ($m.Success) { return $m.Groups[1].Value.Trim() }
  return ''
}

function Get-AuthStatus {
  $exe = $null
  $cmd = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { $exe = $cmd.Source }
  if (-not $exe) {
    foreach ($p in @(
      (Join-Path $HOME_DIR '.local\bin\claude.exe'),
      (Join-Path $env:APPDATA 'npm\claude.cmd')
    )) { if (Test-Path $p) { $exe = $p; break } }
  }
  if (-not $exe) { return 'claude実行ファイルなし' }
  $of = Join-Path $env:TEMP ("session-status-auth-{0}.out.txt" -f $PID)
  $ef = Join-Path $env:TEMP ("session-status-auth-{0}.err.txt" -f $PID)
  try {
    $pr = Start-Process -FilePath $exe -ArgumentList @('auth','status') -PassThru -RedirectStandardOutput $of -RedirectStandardError $ef -WindowStyle Hidden
    if (-not $pr) { return 'auth status 起動失敗' }
    if (-not $pr.WaitForExit(30000)) { try { $pr.Kill() } catch {}; return 'auth status タイムアウト' }
    $txt = ''
    foreach ($f in @($of,$ef)) { if (Test-Path $f) { $txt += [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8) } }
    $one = (($txt -replace '\s+', ' ').Trim())
    if ($one.Length -gt 200) { $one = $one.Substring(0,200) }
    if ($one -match 'loggedIn\s*=\s*false|logged out|not logged|未ログイン') { return "ログアウト ($one)" }
    if ($one -match 'loggedIn\s*=\s*true|Logged in|ログイン') { return "ログイン中 ($one)" }
    if ($one) { return $one }
    return "auth status 空 (exit=$($pr.ExitCode))"
  } catch {
    return "auth status 失敗: $($_.Exception.Message)"
  } finally {
    Remove-Item $of,$ef -ErrorAction SilentlyContinue
  }
}

function Get-CaseRow([IO.DirectoryInfo]$Dir) {
  $statusPath = Join-Path $Dir.FullName 'STATUS.md'
  $done = @(Get-ChildItem $Dir.FullName -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(DONE|done)(\.|$)' } | Sort-Object LastWriteTime -Descending)
  $report = @(Get-ChildItem $Dir.FullName -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(REPORT|report)(\.|$)' -or $_.Name -eq 'REPORT.md' -or $_.Name -eq 'REPORT.txt' } | Sort-Object LastWriteTime -Descending)
  $runlog = @(Get-ChildItem $Dir.FullName -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(run\.log|run\.txt)$' } | Sort-Object LastWriteTime -Descending)
  $markers = @()
  if (Test-Path $statusPath) { $markers += Get-Item $statusPath }
  $markers += $done
  $markers += $report
  $markers += $runlog
  $latest = $null
  if ($markers.Count -gt 0) { $latest = $markers | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }
  else {
    $any = Get-ChildItem $Dir.FullName -File -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $latest = $any
  }
  $latestTime = if ($latest) { $latest.LastWriteTime } else { $Dir.LastWriteTime }
  $statusTxt = Get-TextPreview $statusPath 8000
  $reportTxt = ''
  if ($report.Count -gt 0) { $reportTxt = Get-TextPreview $report[0].FullName 4000 }
  $logTxt = ''
  if ($runlog.Count -gt 0) { $logTxt = Get-TextPreview $runlog[0].FullName 4000 }
  $blob = ($statusTxt + "`n" + $reportTxt + "`n" + $logTxt)

  $name = Get-Field $statusTxt '案件名'
  if (-not $name) {
    $hm = [regex]::Match($statusTxt, '(?m)^#\s+(.+)$')
    if ($hm.Success) { $name = $hm.Groups[1].Value.Trim() }
  }
  if (-not $name) { $name = $Dir.Name }

  $state = Get-Field $statusTxt '状態'
  $reason = Get-Field $statusTxt '理由'
  $next = Get-Field $statusTxt '次の一手'
  if (-not $next) { $next = Get-Field $statusTxt '次の手順' }
  $due = Get-Field $statusTxt '期限'
  if (-not $due) { $due = 'なし' }

  $waitRx = '金さん待ち|判断待ち|承認待ち|返事待ち|回答待ち|決めてほしい|要判断'
  $errRx  = '上限|rate limit|usage limit|Overage|logged ?out|ログアウト|認証切れ|auth status.*false|ERROR|エラー|Traceback|Exception'
  $unstartedRx = '次の手順が未着手|未着手|まだ着手していない'

  if (-not $state) {
    if ($done.Count -gt 0) { $state = '完了' }
    elseif ($blob -match $waitRx) { $state = '金さん待ち' }
    elseif ($latestTime -gt $NOW.AddMinutes(-90) -and ($runlog.Count -gt 0 -or $report.Count -gt 0 -or $statusTxt)) { $state = '進行中' }
    elseif ($latest) { $state = '停止' }
    else { $state = '停止' }
  }

  if ($state -eq '完了' -and $latestTime -lt $STALE) { return $null }

  if (-not $reason) {
    $bits = @()
    $bits += ("最終更新 {0:MM/dd HH:mm}" -f $latestTime)
    if (Test-Path $statusPath) { $bits += 'STATUS.mdあり' } else { $bits += 'STATUS.mdなし' }
    if ($done.Count -gt 0) { $bits += 'DONEあり' }
    if ($report.Count -gt 0) { $bits += 'REPORTあり' }
    if ($runlog.Count -gt 0) { $bits += 'run.logあり' }
    if ($blob -match $errRx) { $bits += 'ログに上限・ログアウト・エラー' }
    if ($blob -match $unstartedRx) { $bits += '次の手順が未着手' }
    if ($blob -match $waitRx) { $bits += '金さん待ちの記述あり' }
    $reason = ($bits -join '、')
  }
  if (-not $next) {
    if ($state -eq '完了') { $next = 'なし' }
    elseif ($blob -match $waitRx) { $next = '金さんの判断を待つ' }
    elseif ($blob -match $unstartedRx) { $next = '次の手順に着手する' }
    else { $next = '作業フォルダを確認して続きを進める' }
  }

  $state = ($state -replace '[\r\n\|]', ' ').Trim()
  $reason = ($reason -replace '[\r\n\|]', ' ').Trim()
  $next = ($next -replace '[\r\n\|]', ' ').Trim()
  $due = ($due -replace '[\r\n\|]', ' ').Trim()
  $name = ($name -replace '[\r\n\|]', ' ').Trim()
  if ($reason.Length -gt 180) { $reason = $reason.Substring(0,180) }
  if ($next.Length -gt 180) { $next = $next.Substring(0,180) }
  return [pscustomobject]@{
    PC=$LABEL; Name=$name; State=$state; Reason=$reason; Due=$due; Next=$next; Latest=$latestTime
  }
}

function Get-LocalRows {
  $rows = @()
  if (-not (Test-Path $GB_REP)) { return $rows }
  $skip = @('session-status','stalled-sessions-hourly','stalled-sessions-hourly-1125','stalled-sessions','heartbeat','terminals')
  Get-ChildItem $GB_REP -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    if ($skip -contains $_.Name) { return }
    $row = Get-CaseRow $_
    if ($row) { $rows += $row }
  }
  return $rows
}

function Write-LocalStatus($rows, [string]$auth) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine("# session-status  PC=$LABEL  host=$HOSTN  updated $($NOW.ToString('yyyy-MM-dd HH:mm')) JST")
  [void]$sb.AppendLine("")
  [void]$sb.AppendLine("- claude auth: $auth")
  [void]$sb.AppendLine("- 案件数: $($rows.Count)")
  [void]$sb.AppendLine("")
  foreach ($r in $rows) {
    [void]$sb.AppendLine(("- {0}・{1}・{2}・{3}・期限{4}・次:{5}" -f $r.PC,$r.Name,$r.State,$r.Reason,$r.Due,$r.Next))
  }
  $text = $sb.ToString()
  $outFile = Join-Path $OUT_DIR ("STATUS-{0}.md" -f $LABEL)
  [IO.File]::WriteAllText($outFile, $text, $UTF8)
  return $outFile
}

function Invoke-Git([string]$Cwd, [string[]]$GitArgs) {
  $prevPrompt = $env:GIT_TERMINAL_PROMPT
  $prevGcm = $env:GCM_INTERACTIVE
  $env:GIT_TERMINAL_PROMPT = '0'
  $env:GCM_INTERACTIVE = 'never'
  $of = Join-Path $env:TEMP ("session-status-git-{0}.out.txt" -f [guid]::NewGuid().ToString('N'))
  $ef = Join-Path $env:TEMP ("session-status-git-{0}.err.txt" -f [guid]::NewGuid().ToString('N'))
  try {
    $argLine = ($GitArgs | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"','\"') + '"' } else { $_ } }) -join ' '
    $cmdline = "git $argLine > `"$of`" 2> `"$ef`" & exit /b %ERRORLEVEL%"
    $pr = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d','/c', $cmdline) -WorkingDirectory $Cwd -PassThru -WindowStyle Hidden
    if (-not $pr) { throw "git start failed: $argLine" }
    if (-not $pr.WaitForExit(45000)) {
      try { taskkill.exe /PID $pr.Id /T /F | Out-Null } catch {}
      throw ("git {0} timeout" -f $argLine)
    }
    $pr.Refresh()
    $code = 1
    if ($pr.HasExited -and $null -ne $pr.ExitCode) { $code = [int]$pr.ExitCode }
    $text = ''
    foreach ($f in @($of,$ef)) { if (Test-Path $f) { $text += [IO.File]::ReadAllText($f) } }
    if ($code -ne 0) { throw ("git {0} failed (exit {1}): {2}" -f $argLine, $code, $text) }
    return $text.Trim()
  } finally {
    $env:GIT_TERMINAL_PROMPT = $prevPrompt
    $env:GCM_INTERACTIVE = $prevGcm
    Remove-Item $of,$ef -ErrorAction SilentlyContinue
  }
}

function Sync-Shared([string]$LocalFile) {
  $repoDir = Join-Path $HOME_DIR '.claude\fleet-heartbeat-repo'
  $nightly = Join-Path $HOME_DIR '.claude\nightly-repo'
  $url = 'https://github.com/kimkon1011/orgiast-claude-rules.git'
  if (Test-Path (Join-Path $nightly '.git')) {
    try { $url = Invoke-Git $nightly @('remote','get-url','origin') } catch {}
  }
  if (-not (Test-Path (Join-Path $repoDir '.git'))) {
    New-Item -ItemType Directory -Force (Split-Path $repoDir) | Out-Null
    if (Test-Path $repoDir) { Remove-Item $repoDir -Recurse -Force -ErrorAction SilentlyContinue }
    $parent = Split-Path $repoDir
    Invoke-Git $parent @('clone','--depth','1','--no-checkout','--filter=blob:none', $url, 'fleet-heartbeat-repo')
    try {
      [void](Invoke-Git $repoDir @('ls-remote','--heads','origin','fleet-heartbeat'))
      Invoke-Git $repoDir @('fetch','origin','fleet-heartbeat')
      Invoke-Git $repoDir @('checkout','-b','fleet-heartbeat','FETCH_HEAD')
    } catch {
      Invoke-Git $repoDir @('symbolic-ref','HEAD','refs/heads/fleet-heartbeat')
      Invoke-Git $repoDir @('read-tree','--empty')
    }
  }
  $cur = ''
  try { $cur = Invoke-Git $repoDir @('branch','--show-current') } catch { $cur = '' }
  if ($cur -ne 'fleet-heartbeat') {
    try {
      Invoke-Git $repoDir @('fetch','origin','fleet-heartbeat')
      try { Invoke-Git $repoDir @('checkout','-B','fleet-heartbeat','origin/fleet-heartbeat') }
      catch { Invoke-Git $repoDir @('checkout','-B','fleet-heartbeat') }
    } catch {
      throw "heartbeat clone branch mismatch: $cur / $($_.Exception.Message)"
    }
  }

  function Save-StatusAndCommit {
    $relDir = Join-Path $repoDir 'session-status'
    New-Item -ItemType Directory -Force $relDir | Out-Null
    $sharedFile = Join-Path $relDir ("STATUS-{0}.md" -f $LABEL)
    Copy-Item $LocalFile $sharedFile -Force
    Invoke-Git $repoDir @('add','--',("session-status/STATUS-{0}.md" -f $LABEL))
    $changed = $true
    try { [void](Invoke-Git $repoDir @('diff','--cached','--quiet')); $changed = $false } catch { $changed = $true }
    if ($changed) {
      Invoke-Git $repoDir @('-c','user.name=Orgiast session-status','-c','user.email=session-status@orgiast.jp','commit','-m',("session-status {0}" -f $LABEL))
    }
  }

  function Sync-ToOrigin {
    Invoke-Git $repoDir @('fetch','origin','fleet-heartbeat:refs/remotes/origin/fleet-heartbeat')
    try { Invoke-Git $repoDir @('rebase','origin/fleet-heartbeat') }
    catch {
      Invoke-Git $repoDir @('checkout','-B','fleet-heartbeat','origin/fleet-heartbeat')
      Save-StatusAndCommit
    }
  }

  Save-StatusAndCommit
  $pushed = $false
  $pushErr = ''
  for ($i = 0; $i -lt 4; $i++) {
    try {
      Sync-ToOrigin
      [void](Invoke-Git $repoDir @('push','origin','HEAD:refs/heads/fleet-heartbeat'))
      [void](Invoke-Git $repoDir @('fetch','origin','fleet-heartbeat:refs/remotes/origin/fleet-heartbeat'))
      $listed = Invoke-Git $repoDir @('ls-tree','-r','--name-only','origin/fleet-heartbeat')
      $want = "session-status/STATUS-$LABEL.md"
      if ($listed -notmatch [regex]::Escape($want)) { throw "push reported ok but $want missing on origin" }
      $pushed = $true
      $pushErr = ''
      break
    } catch {
      $pushErr = $_.Exception.Message
    }
  }
  $collected = @()
  if ($IS000) {
    try { Invoke-Rebase } catch {}
    if (Test-Path $relDir) {
      Get-ChildItem $relDir -File -Filter 'STATUS-*.md' | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $OUT_DIR $_.Name) -Force
        $collected += $_.Name
      }
    }
  }
  return [pscustomobject]@{ Pushed=$pushed; PushError=$pushErr; Collected=$collected; RepoDir=$repoDir }
}

function Write-Summary([string]$Auth, $SyncResult) {
  $files = @(Get-ChildItem $OUT_DIR -File -Filter 'STATUS-*.md' -ErrorAction SilentlyContinue)
  $known = @('000','004','008','011','014','015','018','019','999')
  $sb = New-Object System.Text.StringBuilder
  $updated = Get-Date -Format 'yyyy-MM-dd HH:mm'
  [void]$sb.AppendLine("# session-status SUMMARY  updated $updated JST")
  [void]$sb.AppendLine("")
  [void]$sb.AppendLine("000は他PCのディスクを直接読まない。各PCが fleet-heartbeat ブランチの session-status/ に STATUS を置き、000が集める。")
  [void]$sb.AppendLine("")
  [void]$sb.AppendLine("## 到達（共有gitにSTATUSがあったか）")
  $reach = @{}
  foreach ($pc in $known) {
    $f = $files | Where-Object { $_.Name -eq ("STATUS-{0}.md" -f $pc) } | Select-Object -First 1
    if ($f) {
      $ageMin = [int]((Get-Date) - $f.LastWriteTime).TotalMinutes
      if ($ageMin -le 180) { $reach[$pc] = "○ 最終更新 $($f.LastWriteTime.ToString('MM/dd HH:mm'))" }
      else { $reach[$pc] = "× 古いSTATUSのみ（$($f.LastWriteTime.ToString('MM/dd HH:mm'))）。原因: 60分タスク未実行かPCオフライン。直し方: そのPCで session-status.ps1 を実行し、タスク GrokBot-Offload-session-status を確認する。" }
    } else {
      $reach[$pc] = "× STATUSなし。原因: 未導入かオフライン、またはgit未同期。直し方: そのPCで gb-offload\\session-status.ps1 -Install を実行する。"
    }
    [void]$sb.AppendLine(("- {0}: {1}" -f $pc, $reach[$pc]))
  }
  [void]$sb.AppendLine("")
  [void]$sb.AppendLine("## 000の認証")
  [void]$sb.AppendLine("- $Auth")
  [void]$sb.AppendLine("")
  [void]$sb.AppendLine("## 案件")
  foreach ($f in ($files | Sort-Object Name)) {
    $lines = [IO.File]::ReadAllLines($f.FullName, [Text.Encoding]::UTF8)
    foreach ($line in $lines) {
      if ($line -match '^\s*-\s+\S+・') { [void]$sb.AppendLine($line) }
    }
  }
  [void]$sb.AppendLine("")
  [void]$sb.AppendLine("## 共有同期")
  $pushText = if ($SyncResult.Pushed) { '成功' } else { '失敗 ' + $SyncResult.PushError }
  [void]$sb.AppendLine("- 000のpush: $pushText")
  [void]$sb.AppendLine("- 収集ファイル: " + (($SyncResult.Collected | ForEach-Object { $_ }) -join ', '))
  $text = $sb.ToString()
  $sum = Join-Path $OUT_DIR 'SUMMARY.md'
  [IO.File]::WriteAllText($sum, $text, $UTF8)
  if ($SyncResult.RepoDir -and (Test-Path $SyncResult.RepoDir)) {
    $sharedSum = Join-Path $SyncResult.RepoDir 'session-status\SUMMARY.md'
    try {
      Copy-Item $sum $sharedSum -Force
      Invoke-Git $SyncResult.RepoDir @('add','--','session-status/SUMMARY.md')
      $changed = $true
      try { [void](Invoke-Git $SyncResult.RepoDir @('diff','--cached','--quiet')); $changed = $false } catch { $changed = $true }
      if ($changed) {
        Invoke-Git $SyncResult.RepoDir @('-c','user.name=Orgiast session-status','-c','user.email=session-status@orgiast.jp','commit','-m','session-status SUMMARY')
        try { [void](Invoke-Git $SyncResult.RepoDir @('push','origin','HEAD:refs/heads/fleet-heartbeat')) } catch {}
      }
    } catch {}
  }
  return $sum
}

function Install-Task {
  $scriptPath = Join-Path $GB_DIR 'session-status.ps1'
  $vbs = Join-Path $HOME_DIR '.claude\tools\run-hidden.vbs'
  $ps = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
  $action = $null
  if (Test-Path $vbs) {
    $action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument ("//nologo `"$vbs`" `"$ps`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`"")
  } else {
    $action = New-ScheduledTaskAction -Execute $ps -Argument ("-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`"")
  }
  $principal = $null
  $settings = $null
  $trigger = $null
  $ref = Get-ScheduledTask -TaskName 'GrokBot-Offload-patrol' -ErrorAction SilentlyContinue
  if ($ref) {
    $principal = $ref.Principal
    $settings = $ref.Settings
    $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(3)) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 9990)
  } else {
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
    $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(3)) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 9990)
  }
  Register-ScheduledTask -TaskName 'GrokBot-Offload-session-status' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  return 'INSTALLED GrokBot-Offload-session-status'
}

$installMsg = $null
if ($Install) {
  if ($PSCommandPath -and $PSCommandPath -ne (Join-Path $GB_DIR 'session-status.ps1')) {
    New-Item -ItemType Directory -Force $GB_DIR | Out-Null
    Copy-Item $PSCommandPath (Join-Path $GB_DIR 'session-status.ps1') -Force
  }
  $installMsg = Install-Task
}

$auth = Get-AuthStatus
$rows = @(Get-LocalRows)
$localFile = Write-LocalStatus $rows $auth
$sync = $null
$syncErr = ''
try { $sync = Sync-Shared $localFile } catch { $syncErr = $_.Exception.Message; $sync = [pscustomobject]@{ Pushed=$false; PushError=$syncErr; Collected=@(); RepoDir=(Join-Path $HOME_DIR '.claude\fleet-heartbeat-repo') } }
$sum = $null
if ($IS000) { $sum = Write-Summary $auth $sync }

Write-Output ("PC={0} host={1} rows={2} auth={3}" -f $LABEL,$HOSTN,$rows.Count,$auth)
Write-Output ("LOCAL={0}" -f $localFile)
if ($installMsg) { Write-Output $installMsg }
if ($sync) { Write-Output ("PUSHED={0} ERR={1} COLLECTED={2}" -f $sync.Pushed,$sync.PushError,(($sync.Collected) -join ',')) }
if ($syncErr) { Write-Output ("SYNCERR={0}" -f $syncErr) }
if ($sum) { Write-Output ("SUMMARY={0}" -f $sum) }
