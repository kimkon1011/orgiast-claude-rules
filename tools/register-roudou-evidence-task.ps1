$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }

$nightlyScript = 'C:/Users/uers/.claude/nightly-repo/tools/roudou-evidence-collect.mjs'
$worktreeScript = 'C:/Users/uers/.claude/wt-roudou-evidence/tools/roudou-evidence-collect.mjs'
$launcher = "const fs=require('fs'),cp=require('child_process');const a='$nightlyScript',b='$worktreeScript',s=fs.existsSync(a)?a:b;const r=cp.spawnSync(process.execPath,[s],{stdio:'inherit',windowsHide:true});process.exit(r.status??1)"
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @('-e', $launcher) -WorkingDirectory 'C:\Users\uers\.claude'
$triggers = @(
  (New-ScheduledTaskTrigger -Once -At ([datetime]'2026-11-26 12:00:00')),
  (New-ScheduledTaskTrigger -Once -At ([datetime]'2026-11-26 18:00:00'))
)
$settings = New-ScheduledTaskSettingsSet -Priority 4 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName 'OrgiastRoudouEvidenceCollect' -Action $action -Trigger $triggers -Settings $settings -Description 'Collect signed labour tribunal evidence from Beeper and save it to restricted Drive folder' -Force | Out-Null
Write-Host 'OK: task OrgiastRoudouEvidenceCollect registered (2026-11-26 12:00 and 18:00 JST)'
schtasks /query /tn '\OrgiastRoudouEvidenceCollect' /v /fo list
