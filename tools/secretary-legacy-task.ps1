# Only this exact legacy action can coexist: it starts Next, never kills a PID.
function Test-SafeLegacyGateway {
  param([xml]$TaskXml)
  $ns = New-Object System.Xml.XmlNamespaceManager($TaskXml.NameTable)
  $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
  $triggers = @($TaskXml.SelectNodes('/t:Task/t:Triggers/*', $ns))
  if (!$triggers.Count -or @($triggers | Where-Object { $_.LocalName -notin @('BootTrigger','LogonTrigger') }).Count) { return $false }
  $actions = @($TaskXml.SelectNodes('/t:Task/t:Actions/*', $ns))
  if ($actions.Count -ne 1 -or $actions[0].LocalName -ne 'Exec') { return $false }
  $action = $actions[0]
  $hidden = Join-Path $env:USERPROFILE '.claude\tools\run-hidden.vbs'
  $node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  $app = Join-Path $env:USERPROFILE 'Downloads\claude-mobile'
  $next = Join-Path $app 'node_modules\next\dist\bin\next'
  $expected = '//nologo "{0}" "{1}" "{2}" "start" "-H" "0.0.0.0" "-p" "3939"' -f $hidden,$node,$next
  return ($action.Command -ieq (Join-Path $env:WINDIR 'System32\wscript.exe') -and $action.Arguments -ceq $expected -and $action.WorkingDirectory -ieq $app)
}

function Get-LegacyTaskEvidence {
  param([string]$TaskName,[string]$Failure)
  $sddl = $null; $securityError = $null; $userSid = $null; $elevated = $null
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $userSid = $identity.User.Value
    $elevated = (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $sddl = $service.GetFolder('\').GetTask($TaskName).GetSecurityDescriptor(7)
  } catch { $securityError = $_.ToString() }
  return [pscustomobject]@{ TaskName=$TaskName; DisableError=$Failure; SecurityDescriptor=$sddl; SecurityReadError=$securityError; UserSid=$userSid; Elevated=$elevated }
}
