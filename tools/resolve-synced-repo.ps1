# Resolve the repository that a scheduled task must run from.
#
# nightly-bootstrap.ps1 only ever syncs $HOME\.claude\nightly-repo with origin/main.
# register-*.ps1 used to bake in the tree the register script itself lives in, so a task
# registered from any other copy ran stale code forever: on 2026-09-16 four tasks were
# found still executing a detached-HEAD copy nobody had synced for days, while the
# bootstrap log kept reporting a healthy "ok:" about a different directory.
# Registration therefore resolves the synced repo, and only falls back to the local tree
# when the synced one cannot serve the task - loudly, never in silence.
#
# Keep this file ASCII-only: it has no UTF-8 BOM, so PowerShell 5.1 would decode raw
# Japanese as Shift-JIS and break parsing.

function Normalize-RepoRoot([string]$Path) {
  if (-not $Path) { return '' }
  return ([IO.Path]::GetFullPath($Path)).TrimEnd('\')
}

# Same resolution order as repair-task-paths.ps1's Get-SyncedRepo. Keep them in step.
function Get-SyncedRepoRoot {
  if ($env:ORGIAST_NIGHTLY_REPO) { return (Normalize-RepoRoot $env:ORGIAST_NIGHTLY_REPO) }
  return (Normalize-RepoRoot (Join-Path $HOME '.claude\nightly-repo'))
}

# $Fallback is the repo root the caller would have used ($PSScriptRoot's parent).
# $RequiredPaths are repo-relative paths the registered task will execute; pointing a
# task at a synced repo that lacks them would turn a stale task into a broken one.
function Resolve-RegisterRepoRoot {
  param(
    [Parameter(Mandatory = $true)][string]$Fallback,
    [string[]]$RequiredPaths = @()
  )
  $fallbackRoot = Normalize-RepoRoot $Fallback
  $synced = Get-SyncedRepoRoot
  if ($synced -eq $fallbackRoot) { return $synced }
  if (-not [IO.Directory]::Exists($synced)) {
    Write-Warning ("synced repo not found at '{0}'; registering against '{1}'. This task will run whatever is in that tree, which nothing keeps up to date." -f $synced, $fallbackRoot)
    return $fallbackRoot
  }
  foreach ($relative in @($RequiredPaths)) {
    if (-not $relative) { continue }
    $candidate = Join-Path $synced $relative
    # [IO.File] returns false instead of throwing on a malformed path, unlike Test-Path.
    if (-not ([IO.File]::Exists($candidate) -or [IO.Directory]::Exists($candidate))) {
      Write-Warning ("'{0}' is missing from the synced repo '{1}'; registering against '{2}'. Merge it to main, let nightly-bootstrap sync, then re-register." -f $relative, $synced, $fallbackRoot)
      return $fallbackRoot
    }
  }
  return $synced
}

# Same contract for callers that address the tools directory directly. $Fallback is the
# tools directory itself ($PSScriptRoot); $RequiredLeaves are file names inside it.
function Resolve-RegisterToolsDir {
  param(
    [Parameter(Mandatory = $true)][string]$Fallback,
    [string[]]$RequiredLeaves = @()
  )
  $fallbackDir = Normalize-RepoRoot $Fallback
  $fallbackRoot = Normalize-RepoRoot (Split-Path -Parent $fallbackDir)
  $required = @(@($RequiredLeaves) | Where-Object { $_ } | ForEach-Object { Join-Path 'tools' $_ })
  $root = Resolve-RegisterRepoRoot -Fallback $fallbackRoot -RequiredPaths $required
  if ($root -eq $fallbackRoot) { return $fallbackDir }
  return (Join-Path $root 'tools')
}
