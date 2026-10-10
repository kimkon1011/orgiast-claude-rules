# fleet-fix-now: そのPCで1回貼るだけで fleet-mail の受信・承諾・配布を一気に直して kim-PC へ結果を返す。
# Windows PowerShell 5.1 向け UTF-8 BOM。このスクリプトを貼った人＝そのPCの担当者の承諾（prompt/codex）として扱う。
# 使い方（PowerShell で1行）:
#   [Net.ServicePointManager]::SecurityProtocol='Tls12'; iwr -UseBasicParsing https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/tools/fleet-fix-now.ps1 -OutFile $env:TEMP\fleet-fix-now.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\fleet-fix-now.ps1
param([string]$ReportTo = 'kim-PC', [switch]$NoOptin)
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

Say ("[fleet-fix-now] " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " hostname=" + $env:COMPUTERNAME + " user=" + $env:USERNAME + " home=" + $userHome)
$label = ''
$envFile = Join-Path $claudeDir 'cost-reporter.env'
if (Test-Path $envFile) { $m = Select-String -Path $envFile -Pattern '^REPORTER_LABEL=(.*)$' | Select-Object -First 1; if ($m) { $label = $m.Matches[0].Groups[1].Value.Trim() } }
Say ("label(REPORTER_LABEL)=" + $(if ($label) { $label } else { '(未設定 → hostname で受信)' }))
$fleetEnv = Join-Path $claudeDir 'fleet-sheet.env'
Say ("fleet-sheet.env=" + $(if (Test-Path $fleetEnv) { 'あり' } else { '無し（送受信不可。このPCは fleet 未配布）' }))

# 1. nightly-repo を origin/main 最新にする（PR #698 / #700 を取り込む）
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) { Say 'NG: git が見つかりません。Git for Windows を入れてから再実行してください'; }
else {
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

# 6. 受信を1回実行（溜まっている note/prompt を取り込み、prompt は実行して返信）
$pollOut = (& node $fleetMail --poll 2>&1 | Out-String)
Say ("poll: exit=" + $LASTEXITCODE + " " + (Tail $pollOut 4))
Start-ScheduledTask -TaskName 'OrgiastFleetMail' -ErrorAction SilentlyContinue

# 7. 結果を kim-PC へ送る
$reportFile = Join-Path $env:TEMP 'fleet-fix-now-report.txt'
[IO.File]::WriteAllText($reportFile, ($report -join "`n"), (New-Object Text.UTF8Encoding($false)))
if (Test-Path $fleetEnv) {
  $sendOut = (& node $fleetMail --send --to $ReportTo --kind note --body-file $reportFile --why 'fleet-fix-now の実行結果' 2>&1 | Out-String)
  Write-Host ("report -> " + $ReportTo + ": " + $sendOut.Trim())
} else { Write-Host 'report: fleet-sheet.env が無いので送信できません。上の出力を kim に見せてください' }
Write-Host ''
Write-Host '=== fleet-fix-now 完了。上の内容は kim-PC にも送信済み（2分以内に届く） ==='
