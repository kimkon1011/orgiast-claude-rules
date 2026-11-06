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
Assert ($task1.Actions[0].Execute -like '*wscript.exe') 'task1 hidden action'
Assert ($task1.Actions[0].Arguments -like '*run-hidden.vbs*node.exe*reopen-lost-sessions.mjs*') 'task1 hidden node invocation'

$task2 = $script:stored['OrgiastReopenLostSessionsWatch']
Assert ($task2.Triggers[0].Delay -eq 'PT5M') 'task2 five minute logon delay'
Assert ($task2.Triggers[0].CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') 'task2 logon trigger'
Assert ($task2.Triggers[0].Repetition.Interval -eq 'PT15M') 'task2 15 minute repetition interval'
Assert ($task2.Actions[0].Execute -like '*wscript.exe') 'task2 hidden action'
Assert ($task2.Actions[0].Arguments -like '*--watch*') 'task2 --watch argument'

$r2 = Register-ReopenLostTask -GetTask $get -RegisterTask $register
Assert (-not $r2.changed -and $script:writes -eq 2) 'idempotent registration'

$script:stored['OrgiastReopenLostSessionsWatch'].Triggers[0].Delay = 'PT1M'
$r3 = Register-ReopenLostTask -GetTask $get -RegisterTask $register
Assert ($r3.changed -and $script:writes -eq 3) 'repair drift on watch task'

Write-Output 'PASS: reopen task registration (both logon and watch tasks, mocked scheduler)'
