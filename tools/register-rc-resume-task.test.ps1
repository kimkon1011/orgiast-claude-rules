$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'register-rc-resume-task.ps1') -FunctionsOnly
function Assert($Condition, $Message) { if (-not $Condition) { throw "FAIL: $Message" } }
[xml]$xml = Get-RcResumeTaskXml 'PC\kim&test' 'C:\Program Files\PowerShell\7\pwsh.exe' 'C:\Work & 日本語\tools\register-rc-resume-task.ps1'
$task = $xml.Task
Assert ($task.Triggers.EventTrigger.Delay -eq 'PT90S') 'wake delay'
[xml]$subscription = $task.Triggers.EventTrigger.Subscription
Assert ($subscription.QueryList.Query.Select.InnerText -match 'Power-Troubleshooter.*EventID=1') 'wake event provider and ID'
Assert ($task.Triggers.SessionStateChangeTrigger.StateChange -eq 'SessionUnlock') 'unlock trigger'
Assert ($task.Triggers.SessionStateChangeTrigger.Delay -eq 'PT90S') 'unlock delay'
Assert ($task.Principals.Principal.LogonType -eq 'InteractiveToken') 'interactive user session'
Assert ($task.Principals.Principal.UserId -eq 'PC\kim&test') 'XML escaping'
Assert ($task.Settings.MultipleInstancesPolicy -eq 'IgnoreNew') 'concurrent triggers coalesce'
Assert ($task.Actions.Exec.Arguments -like '*-File "C:\Work & 日本語\tools\register-rc-resume-task.ps1" -Run') 'quoted runtime action'
Write-Output 'PASS: register-rc-resume-task tests (8 assertions; no registration)'
