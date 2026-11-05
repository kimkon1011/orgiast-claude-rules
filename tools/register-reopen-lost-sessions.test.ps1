$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'register-reopen-lost-sessions.ps1') -FunctionsOnly
function Assert($Condition, $Message) { if (-not $Condition) { throw "FAIL: $Message" } }
# Inject scheduler calls; use local source and mock file checks to avoid dependency on installed deployment.
function Resolve-RegisterToolsDir { $PSScriptRoot }
function Test-Path { param($LiteralPath); return $true }
$script:stored = $null
$script:writes = 0
$get = { param($Name) $script:stored }
$register = { param($Name, $Task) $script:stored = $Task; $script:writes++ }
$r = Register-ReopenLostTask -GetTask $get -RegisterTask $register
Assert ($r.changed -and $script:writes -eq 1) 'initial registration'
Assert ($script:stored.Triggers[0].Delay -eq 'PT3M') 'three minute logon delay'
Assert ($script:stored.Triggers[0].CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') 'logon trigger'
Assert ($script:stored.Actions[0].Execute -like '*wscript.exe') 'hidden action'
Assert ($script:stored.Actions[0].Arguments -like '*run-hidden.vbs*node.exe*reopen-lost-sessions.mjs*') 'hidden node invocation'
$r = Register-ReopenLostTask -GetTask $get -RegisterTask $register
Assert (-not $r.changed -and $script:writes -eq 1) 'idempotent'
$script:stored.Triggers[0].Delay = 'PT1M'
$r = Register-ReopenLostTask -GetTask $get -RegisterTask $register
Assert ($r.changed -and $script:writes -eq 2) 'repair drift'
Write-Output 'PASS: reopen task registration (7 cases, mocked scheduler)'
