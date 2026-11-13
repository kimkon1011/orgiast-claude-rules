# Deploy the hidden console runner outside the development worktree and build a
# Scheduled Task action whose child arguments are individually quoted.

function Get-FileHashSafe {
  param([string]$Path)
  if (Get-Command Get-FileHash -ErrorAction SilentlyContinue) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
  }
  Import-Module Microsoft.PowerShell.Utility -ErrorAction SilentlyContinue
  if (Get-Command Get-FileHash -ErrorAction SilentlyContinue) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
  }
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  return [System.BitConverter]::ToString($hasher.ComputeHash($bytes)) -replace '-'
}

function Ensure-RunHidden {
  $source = Join-Path $PSScriptRoot 'run-hidden.vbs'
  if (-not (Test-Path -LiteralPath $source)) { throw "hidden runner not found: $source" }

  $destinationDirectory = Join-Path $env:USERPROFILE '.claude\tools'
  $destination = Join-Path $destinationDirectory 'run-hidden.vbs'
  New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
  # Running tasks may hold the installed runner open. Identical bytes need no copy.
  $copyRequired = -not (Test-Path -LiteralPath $destination -PathType Leaf)
  if (-not $copyRequired) {
    $copyRequired = (Get-FileHashSafe -Path $source) -ne (Get-FileHashSafe -Path $destination)
  }
  if ($copyRequired) { Copy-Item -LiteralPath $source -Destination $destination -Force }
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
