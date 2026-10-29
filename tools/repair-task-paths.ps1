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

# Inspect each absolute path, including quoted paths and worktrees with a .git file.
function Get-ActionPaths($Action) {
  foreach ($field in @('Execute', 'Arguments', 'WorkingDirectory')) {
    $value = [Environment]::ExpandEnvironmentVariables([string]$Action.$field)
    if ($field -ne 'Arguments' -and $value) { $value.Trim('"', "'"); continue }
    foreach ($hit in [regex]::Matches($value, '(?i)(?:["''](?<p>(?:[a-z]:[\\/]|\\\\)[^"'']+)["'']|(?<p>(?:[a-z]:[\\/]|\\\\)[^\s"'']+))')) {
      $hit.Groups['p'].Value
    }
  }
}

function Test-PinnedRoot([string]$Root) {
  $parent = Normalize-Root (Join-Path $HOME '.claude')
  return $Root -match ('^' + [regex]::Escape($parent) + '\\auto-session-(?:repo|tree[^\\]*)$')
}

function Get-StaleRoots([string]$Synced, $Snapshots) {
  # Non-repository paths and checkouts without origin are ordinary scan results.
  $ErrorActionPreference = 'Continue'
  $seen = @{}
  $candidates = @((Join-Path $HOME 'orgiast-claude-rules'), (Join-Path $HOME 'Downloads\orgiast-claude-rules'))
  if ($env:ORGIAST_STALE_REPO_ROOTS) { $candidates += @($env:ORGIAST_STALE_REPO_ROOTS -split ';' | Where-Object { $_ }) }
  foreach ($snapshot in $Snapshots) {
    foreach ($action in $snapshot.Actions) {
      foreach ($candidate in @(Get-ActionPaths $action)) {
        $pinnedPattern = '^' + [regex]::Escape((Normalize-Root (Join-Path $HOME '.claude'))) + '\\(auto-session-(?:repo|tree[^\\]*))(?=\\|$)'
        if ($candidate -match $pinnedPattern) { $candidates += Join-Path (Join-Path $HOME '.claude') $Matches[1]; continue }
        $dir = $candidate
        while ($dir -and -not [IO.Directory]::Exists($dir)) { $dir = Split-Path -Parent $dir }
        if (-not $dir) { continue }
        # Only invoke git after locating a checkout, avoiding errors for executables.
        $probe = $dir
        while ($probe -and -not (Test-Path -LiteralPath (Join-Path $probe '.git'))) { $probe = Split-Path -Parent $probe }
        if (-not $probe -or $seen.ContainsKey($probe)) { continue }
        $seen[$probe] = $true
        $top = & git -C $probe rev-parse --show-toplevel 2>$null
        if ($LASTEXITCODE -ne 0) { continue }
        $common = & git -C $probe rev-parse --git-common-dir 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $common) { continue }
        $origin = & git -C $probe remote get-url origin 2>$null
        if ($LASTEXITCODE -eq 0 -and $origin -match '^(?:https?://github\.com/|ssh://git@github\.com/|git@github\.com:)kimkon1011/orgiast-claude-rules(?:\.git)?/?$') {
          $candidates += $top
        }
      }
    }
  }
  return @($candidates | ForEach-Object { Normalize-Root $_ } | Where-Object { $_ -and $_ -ne $Synced } | Select-Object -Unique | Sort-Object Length -Descending)
}

function Root-Pattern([string]$Root) {
  return [regex]::Escape($Root).Replace('\\', '[\\/]') + '(?=[\\/\s"'']|$)'
}

function Replace-Roots([string]$Value, $Roots, [string]$Synced) {
  if (-not $Value -or $Roots.Count -eq 0) { return $Value }
  # Match once, preserving the synced root even when it is nested in another repo.
  $pattern = '(?<synced>' + (Root-Pattern $Synced) + ')|' + (($Roots | ForEach-Object { Root-Pattern $_ }) -join '|')
  return [regex]::Replace($Value, $pattern, [Text.RegularExpressions.MatchEvaluator]{
    param($match)
    if ($match.Groups['synced'].Success) { return $match.Value }
    return $Synced
  }, 'IgnoreCase')
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
        WorkingDirectory = [string]$action.WorkingDirectory
      }
    }
    $snapshots += [pscustomobject]@{ TaskName = $task.TaskName; Actions = $actions }
  }
  return $snapshots
}

$synced = Get-SyncedRepo
$snapshots = @(Get-TaskSnapshots $InputJson)
$staleRoots = @(Get-StaleRoots $synced $snapshots)
Write-Host ((J '\u540c\u671f\u5148') + ":$synced")

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
    $workingDirectory = [string]$actions[$index].WorkingDirectory
    $newWorkingDirectory = $workingDirectory
    $pinned = $false
    $repairRoots = @($staleRoots | Where-Object { -not (Test-PinnedRoot $_) })
    $newExecute = Replace-Roots $execute $repairRoots $synced
    $newArguments = Replace-Roots $arguments $repairRoots $synced
    $newWorkingDirectory = Replace-Roots $workingDirectory $repairRoots $synced
    foreach ($stale in $staleRoots) {
      if (Test-PinnedRoot $stale) {
        if (($execute + ' ' + $arguments + ' ' + $workingDirectory) -match (Root-Pattern $stale)) { $pinned = $true }
        continue
      }
    }
    if (-not $pinned -and $newExecute -eq $execute -and $newArguments -eq $arguments -and $newWorkingDirectory -eq $workingDirectory) { continue }

    $missing = @(Get-MissingTargets $newWorkingDirectory $synced) + @(Get-MissingTargets $newExecute $synced) + @(Get-MissingTargets $newArguments $synced)
    $missing = @($missing | Select-Object -Unique)
    $entry = [pscustomobject]@{
      TaskName     = [string]$snapshot.TaskName
      Index        = $index
      OldExecute   = $execute
      OldArguments = $arguments
      NewExecute   = $newExecute
      NewArguments = $newArguments
      OldWorkingDirectory = $workingDirectory
      NewWorkingDirectory = $newWorkingDirectory
      Status       = 'planned'
      Missing      = $missing
    }
    if ($pinned) {
      $entry.Status = 'pinned:auto-session'
      $entry.NewExecute = $execute
      $entry.NewArguments = $arguments
      $entry.NewWorkingDirectory = $workingDirectory
    } elseif ($missing.Count -gt 0) {
      $entry.Status = 'skipped-missing'
      $errors += ((J '\u540c\u671f\u5148\u306b\u30b9\u30af\u30ea\u30d7\u30c8\u304c\u3042\u308a\u307e\u305b\u3093') + ": $($snapshot.TaskName) / " + ($missing -join ', '))
    }
    $plan += $entry
  }
}

foreach ($entry in $plan) {
  if ($entry.Status -eq 'pinned:auto-session') {
    Write-Host ("pinned:auto-session:$($entry.TaskName) / $($entry.Index)")
  } elseif ($entry.Status -eq 'skipped-missing') {
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
      $params = @{ Execute = $change.NewExecute }
      if ($change.NewArguments) { $params.Argument = $change.NewArguments }
      if ($change.NewWorkingDirectory) { $params.WorkingDirectory = $change.NewWorkingDirectory }
      $newActions += (New-ScheduledTaskAction @params)
    }
    Set-ScheduledTask -TaskName $taskName -Action $newActions -ErrorAction Stop | Out-Null
    foreach ($entry in $applicable | Where-Object { $_.TaskName -eq $taskName }) { $entry.Status = 'repaired' }
    Write-Host ((J '\u4fee\u6b63') + ":$taskName")
  }

  # Read the tasks back. The rewrite only counts if no stale root survives it.
  foreach ($snapshot in @(Get-TaskSnapshots $null)) {
    foreach ($action in @($snapshot.Actions)) {
      foreach ($stale in $staleRoots) {
        if (Test-PinnedRoot $stale) { continue }
        $joined = [string]$action.Execute + ' ' + [string]$action.Arguments + ' ' + [string]$action.WorkingDirectory
        if ($joined -ne (Replace-Roots $joined @($stale) $synced)) {
          $errors += ((J '\u691c\u8a3c\u5931\u6557') + ": $($snapshot.TaskName) -> $stale")
        }
      }
    }
  }
}

Write-Host ("summary: detected=$(@($plan | Where-Object { $_.Status -ne 'pinned:auto-session' }).Count) repaired=$(@($plan | Where-Object { $_.Status -eq 'repaired' }).Count) stale=$(@($plan | Where-Object { $_.Status -in @('planned', 'skipped-missing') }).Count) pinned=$(@($plan | Where-Object { $_.Status -eq 'pinned:auto-session' }).Count)")

if ($OutJson) {
  # Set-Content -Encoding UTF8 emits a BOM on PowerShell 5.1 and JSON parsers choke on it.
  $json = ConvertTo-Json -InputObject @($plan) -Depth 5
  [IO.File]::WriteAllText($OutJson, $json, (New-Object System.Text.UTF8Encoding $false))
}

$mode = if ($Apply -and -not $InputJson) { 'apply' } else { 'dry-run' }
Write-Host ("ok:$mode " + (J '\u8981\u4fee\u6b63') + "=$($applicable.Count)" + (J '\u4ef6') + ' ' + (J '\u30b9\u30ad\u30c3\u30d7') + "=$(@($plan).Count - $applicable.Count)" + (J '\u4ef6'))

if ($errors.Count -gt 0) { exit 1 }
exit 0
