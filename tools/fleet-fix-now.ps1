# fleet-fix-now: そのPCで1回貼るだけで fleet-mail の受信・承諾・配布を一気に直して kim-PC へ結果を返す。
# Windows PowerShell 5.1 向け UTF-8 BOM。このスクリプトを貼った人＝そのPCの担当者の承諾（prompt/codex）として扱う。
# 使い方（PowerShell で1行）:
#   [Net.ServicePointManager]::SecurityProtocol='Tls12'; iwr -UseBasicParsing https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/tools/fleet-fix-now.ps1 -OutFile $env:TEMP\fleet-fix-now.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\fleet-fix-now.ps1
param([string]$ReportTo = 'kim-PC', [switch]$NoOptin, [string]$Label = '', [string]$Enroll = '', [switch]$NoLogin)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$report = New-Object System.Collections.Generic.List[string]
function Say([string]$s) { Write-Host $s; $script:report.Add($s) | Out-Null }
function Tail([string]$text, [int]$n = 12) { $lines = @(($text -split "`r?`n") | Where-Object { $_ -ne '' }); if ($lines.Count -gt $n) { $lines = $lines[($lines.Count - $n)..($lines.Count - 1)] }; return ($lines -join "`n") }

$userHome = $env:USERPROFILE
$claudeDir = Join-Path $userHome '.claude'
$repo = Join-Path $claudeDir 'nightly-repo'
$repoUrl = 'https://github.com/kimkon1011/orgiast-claude-rules.git'
New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null

Say ("[fleet-fix-now] version=" + $(try { (git -C (Join-Path $env:USERPROFILE '.claude\nightly-repo') log -1 --format=%h 2>$null) } catch { '?' }) + " ")
Say ("[fleet-fix-now] " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " hostname=" + $env:COMPUTERNAME + " user=" + $env:USERNAME + " home=" + $userHome)
$curLabel = ''
$fleetEnv = Join-Path $claudeDir 'fleet-sheet.env'
$envFile = Join-Path $claudeDir 'cost-reporter.env'
if (Test-Path $envFile) { $m0 = Select-String -Path $envFile -Pattern '^REPORTER_LABEL=(.*)$' | Select-Object -First 1; if ($m0) { $curLabel = $m0.Matches[0].Groups[1].Value.Trim() } }
Say ("label(REPORTER_LABEL)=" + $(if ($curLabel) { $curLabel } else { '(未設定 → hostname で受信)' }))
Say ("fleet-sheet.env=" + $(if (Test-Path $fleetEnv) { 'あり' } else { '無し' }))
$envFile = Join-Path $claudeDir 'cost-reporter.env'
if (Test-Path $envFile) { $m = Select-String -Path $envFile -Pattern '^REPORTER_LABEL=(.*)$' | Select-Object -First 1; if ($m) { $curLabel = $m.Matches[0].Groups[1].Value.Trim() } }
# 注意: PowerShell の変数名は大小を区別しないので、現在値は $curLabel、引数は $Label と別名にする
# 1. nightly-repo を origin/main 最新にする（PR #698 / #700 を取り込む）
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
  # cr-PC(作業用011) 2026-10-10 実測: git 無しで止まった。winget で入れて同じセッションの PATH に足す。
  Say 'git が無いので winget でインストールします（1〜3分）'
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) { & winget install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null }
  foreach ($p in @('C:\Program Files\Git\cmd', (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd'))) { if (Test-Path $p) { $env:PATH = "$p;$env:PATH" } }
  $git = Get-Command git -ErrorAction SilentlyContinue
  Say ("git: " + $(if ($git) { 'インストール OK ' + $git.Source } else { 'インストール失敗（winget ' + $(if ($winget) { 'あり' } else { '無し' }) + '）→ zip 取得に切替' }))
}
if (-not $git) {
  # git が無くても動けるように zip で main を展開する（.git 無し＝日次 self-sync は動かないが tools は動く）
  $zip = Join-Path $env:TEMP 'orgiast-claude-rules-main.zip'
  $tmpDir = Join-Path $env:TEMP 'orgiast-claude-rules-zip'
  try {
    Invoke-WebRequest -UseBasicParsing 'https://github.com/kimkon1011/orgiast-claude-rules/archive/refs/heads/main.zip' -OutFile $zip
    if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir }
    Expand-Archive -Path $zip -DestinationPath $tmpDir -Force
    $src = Get-ChildItem $tmpDir | Select-Object -First 1
    if (Test-Path $repo) { Remove-Item -Recurse -Force $repo }
    Move-Item -Path $src.FullName -Destination $repo
    Say 'repo: zip 展開 OK（git 無し）'
  } catch { Say ('NG: zip 取得に失敗: ' + $_.Exception.Message) }
} else {
  if (-not (Test-Path (Join-Path $repo '.git'))) {
    git clone --quiet $repoUrl $repo 2>&1 | Out-Null
    Say ("repo: clone " + $(if (Test-Path (Join-Path $repo '.git')) { 'OK' } else { 'NG' }))
  } else {
    $dirty = git -C $repo status --porcelain 2>$null
    git -C $repo fetch --quiet origin main 2>&1 | Out-Null
    if ($dirty) { git -C $repo stash push -u -q -m 'fleet-fix-now' 2>&1 | Out-Null; Say 'repo: 未コミット変更を stash に退避' }
    git -C $repo checkout -q main 2>&1 | Out-Null
    git -C $repo reset -q --hard origin/main 2>&1 | Out-Null
  }
  Say ("repo: " + (git -C $repo log --oneline -1 2>$null))
}
# ラベル自動判定: fleet-pc-map.json でこの hostname に対応するラベルがあればそれを使う（2026-10-10 作業用018 の複製対策）
if (-not $Label) {
  $mapFile = Join-Path $repo 'fleet-pc-map.json'
  if (Test-Path $mapFile) {
    try {
      $map0 = Get-Content $mapFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $cur0 = if ($curLabel) { $map0.PSObject.Properties | Where-Object { $_.Name -eq $curLabel } | Select-Object -First 1 } else { $null }
      if ($cur0 -and $cur0.Value.hostname -and $cur0.Value.hostname -ne $env:COMPUTERNAME) { $Label = $env:COMPUTERNAME }
    } catch { Say ('fleet-pc-map 読み込み失敗: ' + $_.Exception.Message) }
  }
}
if ($Label -and $Label -ne $curLabel) {
  $lines = @(); if (Test-Path $envFile) { $lines = @(Get-Content $envFile | Where-Object { $_ -notmatch '^REPORTER_LABEL=' }) }
  $lines += "REPORTER_LABEL=$Label"
  [IO.File]::WriteAllText($envFile, (($lines -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding($false)))
  Say ("label: " + $(if ($curLabel) { $curLabel } else { '(未設定)' }) + " → " + $Label + " に変更")
  $curLabel = $Label
}
$fleetMail = Join-Path $repo 'tools\fleet-mail.mjs'
if (-not (Test-Path $fleetMail)) { Say "NG: $fleetMail が無いので中断"; $report -join "`n" | Out-Host; exit 1 }

# 2. 承諾ファイル（貼った本人の承諾）
$optin = Join-Path $claudeDir 'fleet-agent-optin.json'
if (-not $NoOptin) {
  node -e "const f=require('fs'),o=require('os'),p=require('path').join(o.homedir(),'.claude','fleet-agent-optin.json');let a=[];try{a=JSON.parse(f.readFileSync(p,'utf8')).accept||[]}catch{};f.writeFileSync(p,JSON.stringify({accept:[...new Set([...a,'prompt','codex'])],acceptedAt:new Date().toISOString(),acceptedBy:o.userInfo().username+' (fleet-fix-now)'},null,2))"
}
Say ("optin(" + $optin + ")=" + $(if (Test-Path $optin) { (Get-Content $optin -Raw) -replace '\s+', ' ' } else { '無し' }))

# 3. hook・タスクの収束と受信タスクの再登録（現在のユーザーで -Force）
$setupOut = (& node (Join-Path $repo 'tools\setup.mjs') --converge 2>&1 | Out-String)
Say ("setup --converge: exit=" + $LASTEXITCODE + "`n" + (Tail $setupOut 6))
$regOut = (& powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $repo 'tools\register-fleet-mail.ps1') 2>&1 | Out-String)
Say ("register-fleet-mail: exit=" + $LASTEXITCODE + " " + (Tail $regOut 3))

# 4. 受信タスクの状態
$t = Get-ScheduledTask -TaskName 'OrgiastFleetMail' -ErrorAction SilentlyContinue
if ($t) {
  $i = Get-ScheduledTaskInfo -TaskName 'OrgiastFleetMail' -ErrorAction SilentlyContinue
  Say ("task OrgiastFleetMail: state=" + $t.State + " user=" + $t.Principal.UserId + " lastRun=" + $i.LastRunTime + " lastResult=" + $i.LastTaskResult + " nextRun=" + $i.NextRunTime)
} else { Say 'task OrgiastFleetMail: 未登録（register が失敗）' }

# 5. claude CLI の解決（PR #700 と同じ関数）
$exeJson = (& node --input-type=module -e "import('file:///' + process.argv[1].replace(/\\/g,'/')).then(m=>m.resolveClaudeExecutableFromDisk()).then(r=>console.log(JSON.stringify(r))).catch(e=>console.log('ERR '+e.message))" (Join-Path $repo 'tools\claude-exe.mjs') 2>&1 | Out-String)
Say ("claude exe: " + $exeJson.Trim())

# 5b. 熱監視タスクが無ければ登録
if (-not (Get-ScheduledTask -TaskName 'OrgiastThermalGuard' -ErrorAction SilentlyContinue)) {
  $tg = Join-Path $repo 'tools\thermal-guard.ps1'
  if (Test-Path $tg) { & powershell -NoProfile -ExecutionPolicy Bypass -File $tg -Install 2>&1 | Out-Null }
  Say ('thermal-guard: ' + $(if (Get-ScheduledTask -TaskName 'OrgiastThermalGuard' -ErrorAction SilentlyContinue) { '登録 OK' } else { '登録失敗' }))
}

# Codex のログイン画面を Chrome/Edge のシークレットウィンドウで開く。通常ウィンドウだと既にログイン中の
# ChatGPT アカウント（例: seisaku-team@）しか選べず切り替えられない（2026-10-10 nishi-PC 実測）。
function Invoke-CodexLoginPrivate {
  $out = Join-Path $env:TEMP ('codex-login-' + [guid]::NewGuid().ToString('N') + '.txt')
  # ArgumentList は1本の文字列で渡す。配列だと空白を含む要素が二重引用され、出力ファイルが作られず URL を取れない（2026-10-12 作業用018・kim-PC で再現）
  $p = Start-Process -FilePath 'cmd.exe' -ArgumentList ('/c set "BROWSER=none" && codex login > "' + $out + '" 2>&1') -WindowStyle Hidden -PassThru
  $url = $null
  for ($i = 0; $i -lt 60 -and -not $url; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $out) { $m = Select-String -Path $out -Pattern 'https://auth\.openai\.com/\S+' | Select-Object -First 1; if ($m) { $url = $m.Matches[0].Value } }
  }
  if (-not $url) { Say 'codex login: ログイン用アドレスを取得できませんでした'; return }
  $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($chrome) { Start-Process $chrome -ArgumentList @('--incognito', $url) }
  else { $edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"; if (Test-Path $edge) { Start-Process $edge -ArgumentList @('--inprivate', $url) } else { Start-Process $url } }
  Write-Host '>>> シークレットウィンドウでログイン画面を開きました。担当のアカウントでログインし「続行」を押してください（最大5分待ちます） <<<' -ForegroundColor Yellow
  $null = $p.WaitForExit(300000)
  if (-not $p.HasExited) { try { $p.Kill() } catch {} }
}

# 5c. ログイン切れをその場で直す（OAuth は本人の同意が要るのでブラウザが開く。-NoLogin で省略）
$claudeExe = ''
try { $claudeExe = (($exeJson | ConvertFrom-Json).executable) } catch {}
if (-not $claudeExe) { $c = Get-Command claude -ErrorAction SilentlyContinue; if ($c) { $claudeExe = $c.Source } }
if ($claudeExe -and (Test-Path $claudeExe)) {
  $st = (& $claudeExe auth status 2>&1 | Out-String)
  $loggedIn = ($LASTEXITCODE -eq 0) -and ($st -notmatch 'not logged in|Not logged|expired|ログインしていません')
  if (-not $loggedIn -and -not $NoLogin) {
    Write-Host ''; Write-Host '>>> Claude のログインが切れています。ブラウザが開くので、このPCの担当者のアカウントでログインしてください <<<' -ForegroundColor Yellow
    & $claudeExe auth login
    $st = (& $claudeExe auth status 2>&1 | Out-String); $loggedIn = ($LASTEXITCODE -eq 0) -and ($st -notmatch 'not logged in|Not logged|expired')
  }
  Say ('claude login: ' + $(if ($loggedIn) { 'OK' } else { 'NG ' + (Tail $st 2) }))
} else { Say 'claude login: claude.exe が見つからず確認できません' }
$codex = Get-Command codex -ErrorAction SilentlyContinue
if ($codex) {
  & codex login status 2>&1 | Out-Null
  $codexOk = ($LASTEXITCODE -eq 0)
  if (-not $codexOk -and -not $NoLogin) {
    Write-Host ''; Write-Host '>>> Codex のログインが必要です。シークレットウィンドウが開くので、このPCの担当者の ChatGPT アカウントでログインしてください <<<' -ForegroundColor Yellow
    Invoke-CodexLoginPrivate
    & codex login status 2>&1 | Out-Null; $codexOk = ($LASTEXITCODE -eq 0)
  }
  # ログイン中のアカウントを PC 名簿(fleet-pc-map.json の account)と照合する。共有アカウント(例: seisaku-team@)で
  # ログインしていると複数PCで1つの週間枠を取り合い、1台の上限が全台を止める（2026-10-10 nishi-PC と作業用999 が同一アカウント）。
  function Get-CodexEmail {
    try {
      $j = Get-Content (Join-Path $userHome '.codex\auth.json') -Raw | ConvertFrom-Json
      $p = $j.tokens.id_token.Split('.')[1].Replace('-', '+').Replace('_', '/'); while ($p.Length % 4) { $p += '=' }
      $c = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)) | ConvertFrom-Json
      return @{ email = $c.email; plan = $c.'https://api.openai.com/auth'.chatgpt_plan_type }
    } catch { return $null }
  }
  $expected = ''
  try {
    $map = Get-Content (Join-Path $repo 'fleet-pc-map.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    # label だけでなく aliases・hostname でも探す（cr-PC は label=作業用011 で報告しており名前で一致しなかった。2026-10-12）
    $entry = $map.PSObject.Properties | Where-Object { $_.Name -notlike '_*' -and ($_.Name -eq $curLabel -or (@($_.Value.aliases) -contains $curLabel) -or $_.Value.hostname -eq $env:COMPUTERNAME) } | Select-Object -First 1
    # Codex の照合先: PC個別の codexAccount → 全PC共通の _codexAccountDefault。account は Claude の担当席なので使わない（2026-10-10 C案）。
    if ($entry -and $entry.Value.codexAccount) { $expected = [string]$entry.Value.codexAccount }
    elseif ($map._codexAccountDefault) { $expected = [string]$map._codexAccountDefault }
  } catch {}
  $acct = Get-CodexEmail
  # 担当一致でもトークンのプランが free のままなら取り直す（購入前に発行されたトークンは plan=free のまま。2026-10-12 nishi-PC 実測）
  $needRelogin = $codexOk -and $acct -and $expected -and (($acct.email -ne $expected) -or ($acct.plan -eq 'free'))
  if ($needRelogin -and -not $NoLogin) {
    Write-Host ''; Write-Host (">>> Codex のログイン(" + $acct.email + " / plan=" + $acct.plan + ")を取り直します。ブラウザが開いたら " + $expected + " でログインしてください <<<") -ForegroundColor Yellow
    # logout はしない: codex login は成功時に auth.json を上書きする。失敗時に未ログインにならないよう既存は残す（2026-10-12 作業用018）
    Invoke-CodexLoginPrivate
    & codex login status 2>&1 | Out-Null; $codexOk = ($LASTEXITCODE -eq 0); $acct = Get-CodexEmail
  }
  if ($acct) { Say ('codex account: ' + $acct.email + ' plan=' + $acct.plan + $(if ($expected) { ' 担当=' + $expected + $(if ($acct.email -eq $expected) { ' 一致' } else { ' 不一致' }) } else { '' })) }
  Say ('codex login: ' + $(if ($codexOk) { 'OK' } else { 'NG' }))
} else { Say 'codex login: codex コマンドが無い（このPCでは Codex 実装は deepseek 等へ自動退避）' }

# 5d. 自己テスト: 受信タスクと同じ claude で短い応答が返るか
if ($claudeExe -and (Test-Path $claudeExe)) {
  $t = (& $claudeExe -p 'OK とだけ返してください' --model haiku 2>&1 | Out-String)
  Say ('self-test(claude -p): ' + $(if ($t -match 'OK') { 'OK' } else { 'NG ' + (Tail $t 2) }))
}

# 6. 受信を1回実行（溜まっている note/prompt を取り込み、prompt は実行して返信）
$pollOut = (& node $fleetMail --poll 2>&1 | Out-String)
Say ("poll: exit=" + $LASTEXITCODE + " " + (Tail $pollOut 4))
Start-ScheduledTask -TaskName 'OrgiastFleetMail' -ErrorAction SilentlyContinue

# 7. 結果を kim-PC へ送る
$reportFile = Join-Path $env:TEMP 'fleet-fix-now-report.txt'
[IO.File]::WriteAllText($reportFile, ($report -join "`n"), (New-Object Text.UTF8Encoding($false)))
$sendOut = ''
if (Test-Path $fleetEnv) {
  $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $sendOut = (& node $fleetMail --send --to $ReportTo --kind note --body-file $reportFile --why 'fleet-fix-now の実行結果' 2>&1 | ForEach-Object { "$_" } | Out-String)
  $ErrorActionPreference = $prevEap
  Write-Host ("report -> " + $ReportTo + ": " + $sendOut.Trim())
} else { Write-Host 'report: fleet-sheet.env が無いので送信できません。上の出力を kim に見せてください' }
Write-Host ''
if ($sendOut -match '送信済み') { Write-Host '=== fleet-fix-now 完了。上の内容は kim-PC にも送信済み（2分以内に届く） ===' }
else { Write-Host '=== fleet-fix-now 完了。kim-PC への送信はできていません。この画面を kim に見せてください ===' -ForegroundColor Yellow }
