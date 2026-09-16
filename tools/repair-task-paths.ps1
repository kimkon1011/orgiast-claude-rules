param(
  [switch]$Apply,
  [string]$InputJson,
  [string]$OutJson
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

# Keep this file ASCII-only: it has no UTF-8 BOM, so PowerShell 5.1 would decode raw
# Japanese as Shift-JIS and break parsing. Japanese output goes through J '\uXXXX'.
function J([string]$Text) {
  return [regex]::Unescape($Text)
}

function Normalize-Root([string]$Path) {
  if (-not $Path) { return '' }
  return ([IO.Path]::GetFullPath($Path)).TrimEnd('\')
}

# nightly-bootstrap.ps1 only ever syncs this directory with origin/main. Tasks that run
# from any other copy of the repo silently execute stale code, so this is the one target.
function Get-SyncedRepo {
  if ($env:ORGIAST_NIGHTLY_REPO) { return (Normalize-Root $env:ORGIAST_NIGHTLY_REPO) }
  return (Normalize-Root (Join-Path $HOME '.claude\nightly-repo'))
}

# Repo copies nobody keeps in sync. ORGIAST_STALE_REPO_ROOTS overrides for tests.
function Get-StaleRoots([string]$Synced) {
  $candidates = if ($env:ORGIAST_STALE_REPO_ROOTS) {
    @($env:ORGIAST_STALE_REPO_ROOTS -split ';' | Where-Object { $_ })
  } else {
    @((Join-Path $HOME 'orgiast-claude-rules'), (Join-Path $HOME 'Downloads\orgiast-claude-rules'))
  }
  return @($candidates | ForEach-Object { Normalize-Root $_ } | Where-Object { $_ -and $_ -ne $Synced } | Select-Object -Unique)
}

function Replace-Root([string]$Value, [string]$StaleRoot, [string]$Synced) {
  if (-not $Value) { return $Value }
  return [regex]::Replace($Value, [regex]::Escape($StaleRoot), $Synced.Replace('$', '$$'), 'IgnoreCase')
}

# Every repo-relative path the rewritten action points at must exist under the synced
# repo. Rewriting a task to a file that is not there would turn a stale task into a
# broken one, which is worse.
function Get-MissingTargets([string]$Value, [string]$Synced) {
  $missing = @()
  if (-not $Value) { return $missing }
  # Blank out the quoting first so a candidate never carries a stray quote into the
  # existence check. The synced repo path itself is assumed to be space-free.
  $scan = $Value.Replace('"', ' ').Replace("'", ' ')
  $pattern = [regex]::Escape($Synced) + '[^ ]*'
  foreach ($hit in [regex]::Matches($scan, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
    $candidate = $hit.Value
    if ($candidate -eq $Synced) { continue }
    # [IO.File] returns false instead of throwing on a malformed path, unlike Test-Path.
    if (-not ([IO.File]::Exists($candidate) -or [IO.Directory]::Exists($candidate))) { $missing += $candidate }
  }
  return @($missing | Select-Object -Unique)
}

function Get-TaskSnapshots([string]$FromJson) {
  if ($FromJson) {
    $raw = Get-Content -LiteralPath $FromJson -Raw -Encoding UTF8
    return @($raw | ConvertFrom-Json)
  }
  $snapshots = @()
  foreach ($task in @(Get-ScheduledTask -TaskName 'Orgiast*' -ErrorAction SilentlyContinue)) {
    $actions = @()
    foreach ($action in @($task.Actions)) {
      $actions += [pscustomobject]@{
        Execute   = [string]$action.Execute
        Arguments = [string]$action.Arguments
      }
    }
    $snapshots += [pscustomobject]@{ TaskName = $task.TaskName; Actions = $actions }
  }
  return $snapshots
}

$synced = Get-SyncedRepo
$staleRoots = Get-StaleRoots $synced
Write-Host ((J '\u540c\u671f\u5148') + ":$synced")

$snapshots = @(Get-TaskSnapshots $InputJson)
if ($snapshots.Count -eq 0) {
  Write-Host (J '\u5bfe\u8c61\u30bf\u30b9\u30af\u306a\u3057')
}

$plan = @()
$errors = @()
foreach ($snapshot in $snapshots) {
  $actions = @($snapshot.Actions)
  for ($index = 0; $index -lt $actions.Count; $index++) {
    $execute = [string]$actions[$index].Execute
    $arguments = [string]$actions[$index].Arguments
    $newExecute = $execute
    $newArguments = $arguments
    foreach ($stale in $staleRoots) {
      $newExecute = Replace-Root $newExecute $stale $synced
      $newArguments = Replace-Root $newArguments $stale $synced
    }
    if ($newExecute -eq $execute -and $newArguments -eq $arguments) { continue }

    $missing = @(Get-MissingTargets $newExecute $synced) + @(Get-MissingTargets $newArguments $synced)
    $missing = @($missing | Select-Object -Unique)
    $entry = [pscustomobject]@{
      TaskName     = [string]$snapshot.TaskName
      Index        = $index
      OldExecute   = $execute
      OldArguments = $arguments
      NewExecute   = $newExecute
      NewArguments = $newArguments
      Status       = 'planned'
      Missing      = $missing
    }
    if ($missing.Count -gt 0) {
      $entry.Status = 'skipped-missing'
      $errors += ((J '\u540c\u671f\u5148\u306b\u30b9\u30af\u30ea\u30d7\u30c8\u304c\u3042\u308a\u307e\u305b\u3093') + ": $($snapshot.TaskName) / " + ($missing -join ', '))
    }
    $plan += $entry
  }
}

foreach ($entry in $plan) {
  if ($entry.Status -eq 'skipped-missing') {
    Write-Host (((J '\u30b9\u30ad\u30c3\u30d7') + ':{0} / {1}') -f $entry.TaskName, $entry.Index)
  } else {
    Write-Host (((J '\u8981\u4fee\u6b63') + ':{0} / {1}') -f $entry.TaskName, $entry.Index)
  }
}
foreach ($problem in $errors) { Write-Host ((J '\u30a8\u30e9\u30fc:') + $problem) }

$applicable = @($plan | Where-Object { $_.Status -eq 'planned' })

if ($Apply -and -not $InputJson) {
  foreach ($taskName in @($applicable | ForEach-Object { $_.TaskName } | Select-Object -Unique)) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $newActions = @()
    for ($index = 0; $index -lt @($task.Actions).Count; $index++) {
      $change = $applicable | Where-Object { $_.TaskName -eq $taskName -and $_.Index -eq $index } | Select-Object -First 1
      if ($null -eq $change) {
        $newActions += $task.Actions[$index]
        continue
      }
      $newActions += (New-ScheduledTaskAction -Execute $change.NewExecute -Argument $change.NewArguments)
    }
    Set-ScheduledTask -TaskName $taskName -Action $newActions -ErrorAction Stop | Out-Null
    Write-Host ((J '\u4fee\u6b63') + ":$taskName")
  }

  # Read the tasks back. The rewrite only counts if no stale root survives it.
  foreach ($snapshot in @(Get-TaskSnapshots $null)) {
    foreach ($action in @($snapshot.Actions)) {
      foreach ($stale in $staleRoots) {
        $joined = [string]$action.Execute + ' ' + [string]$action.Arguments
        if ($joined -match [regex]::Escape($stale)) {
          $errors += ((J '\u691c\u8a3c\u5931\u6557') + ": $($snapshot.TaskName) -> $stale")
        }
      }
    }
  }
}

if ($OutJson) {
  # Set-Content -Encoding UTF8 emits a BOM on PowerShell 5.1 and JSON parsers choke on it.
  $json = ConvertTo-Json -InputObject @($plan) -Depth 5
  [IO.File]::WriteAllText($OutJson, $json, (New-Object System.Text.UTF8Encoding $false))
}

$mode = if ($Apply -and -not $InputJson) { 'apply' } else { 'dry-run' }
Write-Host ("ok:$mode " + (J '\u8981\u4fee\u6b63') + "=$($applicable.Count)" + (J '\u4ef6') + ' ' + (J '\u30b9\u30ad\u30c3\u30d7') + "=$(@($plan).Count - $applicable.Count)" + (J '\u4ef6'))

if ($errors.Count -gt 0) { exit 1 }
exit 0
