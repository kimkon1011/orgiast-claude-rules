# Deploy the hidden console runner outside the development worktree and build a
# Scheduled Task action whose child arguments are individually quoted.

function Ensure-RunHidden {
  $source = Join-Path $PSScriptRoot 'run-hidden.vbs'
  if (-not (Test-Path -LiteralPath $source)) { throw "hidden runner not found: $source" }

  $destinationDirectory = Join-Path $env:USERPROFILE '.claude\tools'
  $destination = Join-Path $destinationDirectory 'run-hidden.vbs'
  New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Force
  return $destination
}

function New-HiddenScheduledTaskAction {
  param(
    [Parameter(Mandatory = $true)][string]$Execute,
    [string[]]$ChildArgument = @(),
    [string]$WorkingDirectory
  )

  $hiddenRunner = Ensure-RunHidden
  $quoted = @($hiddenRunner, $Execute) + @($ChildArgument) | ForEach-Object {
    '"{0}"' -f ($_ -replace '"', '\"')
  }
  $actionParameters = @{
    Execute = Join-Path $env:SystemRoot 'System32\wscript.exe'
    Argument = '//nologo ' + ($quoted -join ' ')
  }
  if ($WorkingDirectory) { $actionParameters.WorkingDirectory = $WorkingDirectory }
  return New-ScheduledTaskAction @actionParameters
}
