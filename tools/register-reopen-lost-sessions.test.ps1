$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'register-reopen-lost-sessions.ps1') -FunctionsOnly
function Assert($Condition, $Message) { if (-not $Condition) { throw "FAIL: $Message" } }
# Inject scheduler calls; use local source and mock file checks to avoid dependency on installed deployment.
function Resolve-RegisterToolsDir { $PSScriptRoot }
function Test-Path { param($LiteralPath); return $true }
$script:stored = @{}
$script:writes = 0
$get = { param($Name) $script:stored[$Name] }
$register = { param($Name, $Task) $script:stored[$Name] = $Task; $script:writes++ }

$r = Register-ReopenLostTask -GetTask $get -RegisterTask $register
Assert ($r.changed -and $script:writes -eq 2) 'initial registration of two tasks'

$task1 = $script:stored['OrgiastReopenLostSessions']
Assert ($task1.Triggers[0].Delay -eq 'PT3M') 'task1 three minute logon delay'
Assert ($task1.Triggers[0].CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') 'task1 logon trigger'
Assert ($task1.Triggers.Count -eq 2) 'task1 has logon and polling triggers'
Assert ($task1.Triggers[1].CimClass.CimClassName -eq 'MSFT_TaskTimeTrigger') 'task1 polling trigger is time based'
Assert ($task1.Triggers[1].Repetition.Interval -eq 'PT15M') 'task1 polls every 15 minutes'
Assert ($task1.Actions[0].Execute -like '*wscript.exe') 'task1 hidden action'
Assert ($task1.Actions[0].Arguments -like '*run-hidden.vbs*node.exe*reopen-lost-sessions.mjs*') 'task1 hidden node invocation'

$task2 = $script:stored['OrgiastReopenLostSessionsWatch']
$fixedStart = '2026-01-01T00:00:00'
# StartBoundary is normalized to UTC by the time/date conversion in New-ScheduledTaskTrigger,
# so compare against the same conversion instead of a literal local-time string.
$expectedStart = (New-ScheduledTaskTrigger -Once -At $fixedStart).StartBoundary
Assert ($task2.Triggers.Count -eq 1) 'task2 has one timed trigger'
Assert ($task2.Triggers[0].CimClass.CimClassName -eq 'MSFT_TaskTimeTrigger') 'task2 only trigger is time'
Assert ($task2.Triggers[0].StartBoundary -eq $expectedStart) 'task2 fixed start (UTC-normalized)'
Assert ($task2.Triggers[0].Repetition.Interval -eq 'PT15M') 'task2 has 15 minute repetition'
Assert (-not $task2.Triggers[0].Repetition.Duration) 'task2 repeats indefinitely'
Assert ($task2.Actions[0].Execute -like '*wscript.exe') 'task2 hidden action'
Assert ($task2.Actions[0].Arguments -like '*--watch*') 'task2 --watch argument'

$r2 = Register-ReopenLostTask -GetTask $get -RegisterTask $register
Assert (-not $r2.changed -and $script:writes -eq 2) 'idempotent registration'

# Verify that DOMAIN\user / bare user / SID differences are normalized and match as identical
$script:stored['OrgiastReopenLostSessions'].Principal.UserId = "DOMAIN\$env:USERNAME"
$script:stored['OrgiastReopenLostSessions'].Triggers[0].UserId = "DESKTOP-2D0R4LI\$env:USERNAME"
$script:stored['OrgiastReopenLostSessionsWatch'].Principal.UserId = ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
$rNorm = Register-ReopenLostTask -GetTask $get -RegisterTask $register
Assert (-not $rNorm.changed -and $script:writes -eq 2) 'UserId normalization handles DOMAIN\user, bare user, and SID as identical'

$script:stored['OrgiastReopenLostSessionsWatch'].Triggers[0].Repetition.Interval = 'PT5M'
$r3 = Register-ReopenLostTask -GetTask $get -RegisterTask $register
Assert ($r3.changed -and $script:writes -eq 3) 'repair drift on watch task'

# Priority 5 の確認
Assert ($task1.Settings.Priority -eq 5) 'task1 has Priority 5'
Assert ($task2.Settings.Priority -eq 5) 'task2 has Priority 5'

# Priority が 5 でない既存タスクは再登録される
$script:stored['OrgiastReopenLostSessions'].Settings.Priority = 7
$r4 = Register-ReopenLostTask -GetTask $get -RegisterTask $register
Assert ($r4.changed -and $script:writes -eq 4) 'Priority 7 の既存タスクは再登録される'

# Upgrade the old two-trigger definition without touching the logon task.
$legacyLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$legacyLogon.Delay = 'PT5M'
$legacyLogon.Repetition = (New-ScheduledTaskTrigger -Once -At $fixedStart -RepetitionInterval (New-TimeSpan -Minutes 15)).Repetition
$watch = $script:stored['OrgiastReopenLostSessionsWatch']
$watch.Triggers = @($legacyLogon, $watch.Triggers[0])
$r5 = Register-ReopenLostTask -GetTask $get -RegisterTask $register
Assert ($r5.changed -and $script:writes -eq 5) 'repair legacy double trigger'
Assert (-not $r5.tasks['OrgiastReopenLostSessions']) 'legacy repair preserves logon task'
Assert ($script:stored['OrgiastReopenLostSessionsWatch'].Triggers.Count -eq 1) 'legacy repair leaves one trigger'
$r6 = Register-ReopenLostTask -GetTask $get -RegisterTask $register
Assert (-not $r6.changed -and $script:writes -eq 5) 'legacy repair is idempotent'

# 既存タスクがローカルラッパーを指していれば、再登録で正本パスに戻さない。
# 実パスは実行環境の tools ディレクトリなので、ファイル名だけを見る。
$wrapperName = 'reopen-lost-sessions-pc.mjs'
foreach ($name in @('OrgiastReopenLostSessions', 'OrgiastReopenLostSessionsWatch')) {
    $script:stored[$name].Actions[0].Arguments = $script:stored[$name].Actions[0].Arguments -replace 'reopen-lost-sessions\.mjs', $wrapperName
}
$writesBefore = $script:writes
$rWrap = Register-ReopenLostTask -GetTask $get -RegisterTask $register -ScriptConfigFile 'C:\missing\reopen-lost-sessions.json'
Assert (-not $rWrap.changed -and $script:writes -eq $writesBefore) 'local wrapper survives re-register'
Assert ($script:stored['OrgiastReopenLostSessions'].Actions[0].Arguments -like "*$wrapperName*") 'logon task keeps wrapper'
Assert ($script:stored['OrgiastReopenLostSessionsWatch'].Actions[0].Arguments -like "*$wrapperName*") 'watch task keeps wrapper'
Assert ($script:stored['OrgiastReopenLostSessionsWatch'].Actions[0].Arguments -like '*--watch*') 'watch flag remains'

# 環境変数の明示パスはラッパー検出より優先し、両方のタスクへ使う。
$env:ORGIAST_REOPEN_SCRIPT = 'D:\custom\reopen-lost-sessions-box.mjs'
$rEnv = Register-ReopenLostTask -GetTask $get -RegisterTask $register -ScriptConfigFile 'C:\missing\reopen-lost-sessions.json'
Assert ($rEnv.changed) 'env override re-registers'
Assert ($script:stored['OrgiastReopenLostSessions'].Actions[0].Arguments -like '*reopen-lost-sessions-box.mjs*') 'logon uses env script'
Assert ($script:stored['OrgiastReopenLostSessionsWatch'].Actions[0].Arguments -like '*reopen-lost-sessions-box.mjs*') 'watch uses env script'
Remove-Item Env:ORGIAST_REOPEN_SCRIPT
$writesEnv = $script:writes
$rKeep = Register-ReopenLostTask -GetTask $get -RegisterTask $register -ScriptConfigFile 'C:\missing\reopen-lost-sessions.json'
Assert (-not $rKeep.changed -and $script:writes -eq $writesEnv) 'wrapper-shaped env path survives after the env is cleared'

# 設定 JSON の script も正本より優先する。
$cfg = Join-Path $env:TEMP 'reopen-lost-sessions-config.json'
Set-Content -LiteralPath $cfg -Value '{"script":"E:\\pc\\reopen-lost-sessions-cfg.mjs"}' -Encoding ascii
$rCfg = Register-ReopenLostTask -GetTask $get -RegisterTask $register -ScriptOverride '' -ScriptConfigFile $cfg
Assert ($rCfg.changed) 'config override re-registers'
Assert ($script:stored['OrgiastReopenLostSessions'].Actions[0].Arguments -like '*reopen-lost-sessions-cfg.mjs*') 'logon uses config script'
Remove-Item -LiteralPath $cfg -ErrorAction SilentlyContinue

Write-Output 'PASS: reopen task registration (both logon and watch tasks, mocked scheduler)'
