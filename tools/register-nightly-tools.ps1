param(
  [switch]$DryRun,
  [switch]$Remove,
  [switch]$HealthOnly
)

$ErrorActionPreference = 'Stop'
if ($HealthOnly -and $Remove) { throw 'HealthOnly cannot be combined with Remove' }
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

function J([string]$Text) {
  return [regex]::Unescape($Text)
}

function Quote-TaskArgument([string]$Value) {
  return '"' + $Value.Replace('"', '""') + '"'
}

$runHidden = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.claude\tools\run-hidden.vbs'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
# Keep this file ASCII-only: it has no UTF-8 BOM, so PowerShell 5.1 would decode raw
# Japanese as Shift-JIS and break parsing. Japanese output goes through J '\uXXXX'.
# open-work runs before next-actions so the inventory exists when priorities are picked.
$specs = @(
  [pscustomobject]@{ TaskName = 'OrgiastMorningBatch'; ScriptName = 'open-work.mjs'; ScriptArgs = @() },
  [pscustomobject]@{ TaskName = 'OrgiastMorningBatch'; ScriptName = 'next-actions.mjs'; ScriptArgs = @() },
  [pscustomobject]@{ TaskName = 'OrgiastNightlyBatch'; ScriptName = 'ai-news-triage.mjs'; ScriptArgs = @('--confidence', 'high,medium', '--limit', '8') },
  [pscustomobject]@{ TaskName = 'OrgiastNightlyBatch'; ScriptName = 'pricing-brief.mjs'; ScriptArgs = @('--limit', '8') },
  [pscustomobject]@{ TaskName = 'OrgiastNightlyBatch'; ScriptName = 'drive-hub-mirror.mjs'; ScriptArgs = @() },
  [pscustomobject]@{ TaskName = 'OrgiastNightlyBatch'; ScriptName = 'expense-leak-check.mjs'; ScriptArgs = @('--weekly') }
)

# Targeted repair avoids adding unrelated nightly actions on older installations.
if ($HealthOnly) { $specs = @($specs | Where-Object { $_.TaskName -eq 'OrgiastMorningBatch' }) }

. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
# The tasks must run from the synced repo, not from the tree this script sits in.
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths (@($specs | ForEach-Object { Join-Path 'tools' $_.ScriptName }) + @('tools\nightly-health.mjs'))

# Deadline jobs have their own schedules and kim-seat guard.
if (-not $HealthOnly) {
  & (Join-Path $PSScriptRoot 'register-deadline-watch-tasks.ps1') -Ensure -DryRun:$DryRun -Unregister:$Remove
  if (-not $?) { throw 'deadline-watch registration failed' }
}

# Resolve every prerequisite before changing either task.
$taskNames = @($specs | ForEach-Object { $_.TaskName } | Select-Object -Unique)
$tasks = @{}
foreach ($taskName in $taskNames) {
  $tasks[$taskName] = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}

$presentTaskCount = @($tasks.Values | Where-Object { $null -ne $_ }).Count
if ($presentTaskCount -eq 0) {
  Write-Host (J 'skip:\u5bfe\u8c61\u30bf\u30b9\u30af\u306a\u3057')
  Write-Host (J 'ok:\u8ffd\u52a00\u4ef6/\u66f4\u65b00\u4ef6/\u30b9\u30ad\u30c3\u30d70\u4ef6')
  exit 0
}

$errors = @()
foreach ($taskName in $taskNames) {
  if ($null -eq $tasks[$taskName]) {
    $errors += ((J '\u5bfe\u8c61\u30bf\u30b9\u30af\u304c\u3042\u308a\u307e\u305b\u3093') + ": $taskName")
  }
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
  $errors += (J 'node \u304c PATH \u306b\u3042\u308a\u307e\u305b\u3093')
}
if (-not (Test-Path -LiteralPath $runHidden -PathType Leaf)) {
  $errors += ((J 'run-hidden.vbs \u304c\u3042\u308a\u307e\u305b\u3093') + ": $runHidden")
}
foreach ($spec in $specs) {
  $scriptPath = Join-Path $repo (Join-Path 'tools' $spec.ScriptName)
  if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    $errors += ((J '\u30b9\u30af\u30ea\u30d7\u30c8\u304c\u3042\u308a\u307e\u305b\u3093') + ": $scriptPath")
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $repo 'tools\nightly-health.mjs') -PathType Leaf)) {
  $errors += 'nightly-health.mjs is missing'
}

if ($errors.Count -gt 0) {
  foreach ($problem in $errors) { Write-Host ((J '\u30a8\u30e9\u30fc:') + $problem) }
  exit 1
}

$node = $nodeCommand.Source
$addCount = 0
$updateCount = 0
$skipCount = 0
$removeCount = 0

# Health needs its own budget: the morning task's PT15M covers all actions.
# open-work reads nightly-batch logs, not .nightly-health-last.json, so it stays.
# Register and verify the replacement BEFORE removing the old morning action.
if (-not $Remove) {
  $morning = $tasks['OrgiastMorningBatch']
  $healthPath = Join-Path $repo 'tools\nightly-health.mjs'
  $healthArguments = @('//nologo', (Quote-TaskArgument $runHidden), (Quote-TaskArgument $node), (Quote-TaskArgument $healthPath)) -join ' '
  $healthPattern = '(?i)(^|[\\/" ])nightly-health\.mjs(?=[" ]|$)'
  $healthKept = @($morning.Actions | Where-Object { [string]$_.Arguments -notmatch $healthPattern })
  if ($healthKept.Count -eq 0) { throw 'refusing to remove the last morning action' }
  if ($DryRun) {
    Write-Host '[DRY] OrgiastNightlyHealth daily 07:10 PT30M; remove health from OrgiastMorningBatch'
  } else {
    $healthAction = New-ScheduledTaskAction -Execute $wscript -Argument $healthArguments -WorkingDirectory $repo
    $healthTrigger = New-ScheduledTaskTrigger -Daily -At '07:10'
    # This is a detached CIM copy; the morning task retains its original limit.
    $healthSettings = [Microsoft.Management.Infrastructure.CimInstance]::new($morning.Settings)
    $healthSettings.ExecutionTimeLimit = 'PT30M'
    Register-ScheduledTask -TaskName 'OrgiastNightlyHealth' -Action $healthAction -Trigger $healthTrigger -Principal $morning.Principal -Settings $healthSettings -Description 'Collect nightly health (daily 07:10, independent 30-minute budget)' -Force -ErrorAction Stop | Out-Null
    $health = Get-ScheduledTask -TaskName 'OrgiastNightlyHealth' -ErrorAction Stop
    if (@($health.Actions).Count -ne 1 -or
        $health.Actions[0].Execute -ine $wscript -or
        $health.Actions[0].Arguments -ne $healthArguments -or
        $health.Actions[0].WorkingDirectory -ne $repo -or
        $health.Settings.ExecutionTimeLimit -ne 'PT30M' -or
        $health.Settings.MultipleInstances -ne $morning.Settings.MultipleInstances -or
        $health.Principal.UserId -ne $morning.Principal.UserId -or
        $health.Principal.LogonType -ne $morning.Principal.LogonType -or
        $health.Principal.RunLevel -ne $morning.Principal.RunLevel -or
        @($health.Triggers).Count -ne 1 -or
        $health.Triggers[0].StartBoundary -notmatch 'T07:10:00' -or
        $health.Triggers[0].DaysInterval -ne 1) {
      throw 'OrgiastNightlyHealth read-back failed; morning health action retained'
    }
    if ($healthKept.Count -ne @($morning.Actions).Count) {
      Set-ScheduledTask -TaskName 'OrgiastMorningBatch' -Action $healthKept -ErrorAction Stop | Out-Null
    }
    $tasks['OrgiastMorningBatch'] = Get-ScheduledTask -TaskName 'OrgiastMorningBatch' -ErrorAction Stop
    if (@($tasks['OrgiastMorningBatch'].Actions | Where-Object { [string]$_.Arguments -match $healthPattern }).Count) {
      throw 'legacy health action remains in OrgiastMorningBatch'
    }
    Write-Host 'ok: OrgiastNightlyHealth daily 07:10 PT30M; morning health action removed'
  }
}

# Converge old installations: remediation now has its own 90-minute task.
$legacyPattern = '(?i)(^|[\\/" ])nightly-health-remediate\.mjs(?=[" ]|$)'
$morning = $tasks['OrgiastMorningBatch']
$kept = @($morning.Actions | Where-Object { [string]$_.Arguments -notmatch $legacyPattern })
if (-not $HealthOnly -and $kept.Count -ne @($morning.Actions).Count) {
  if ($kept.Count -eq 0) { throw 'refusing to remove the last morning action' }
  if (-not $DryRun) {
    Set-ScheduledTask -TaskName 'OrgiastMorningBatch' -Action $kept -ErrorAction Stop | Out-Null
    $tasks['OrgiastMorningBatch'] = Get-ScheduledTask -TaskName 'OrgiastMorningBatch' -ErrorAction Stop
    if (@($tasks['OrgiastMorningBatch'].Actions | Where-Object { [string]$_.Arguments -match $legacyPattern }).Count) {
      throw 'legacy remediation action remains after removal'
    }
  }
  $updateCount++
}

foreach ($spec in $specs) {
  $task = $tasks[$spec.TaskName]
  $scriptPath = Join-Path $repo (Join-Path 'tools' $spec.ScriptName)
  $argumentParts = @('//nologo', (Quote-TaskArgument $runHidden), (Quote-TaskArgument $node), (Quote-TaskArgument $scriptPath))
  $argumentParts += @($spec.ScriptArgs | ForEach-Object { Quote-TaskArgument $_ })
  $desiredArguments = $argumentParts -join ' '
  $namePattern = '(?i)(^|[\\/" ])' + [regex]::Escape($spec.ScriptName) + '(?=[" ]|$)'
  $matchingIndexes = @()
  for ($index = 0; $index -lt @($task.Actions).Count; $index++) {
    if ([string]$task.Actions[$index].Arguments -match $namePattern) { $matchingIndexes += $index }
  }

  if ($Remove) {
    if ($matchingIndexes.Count -eq 0) {
      $skipCount++
      Write-Host (((J '\u30b9\u30ad\u30c3\u30d7') + ':{0} / {1}') -f $spec.TaskName, $spec.ScriptName)
      continue
    }
    Write-Host (((J '\u524a\u9664') + ':{0} / {1}') -f $spec.TaskName, $spec.ScriptName)
    if (-not $DryRun) {
      $keptActions = @()
      for ($index = 0; $index -lt @($task.Actions).Count; $index++) {
        if ($matchingIndexes -notcontains $index) { $keptActions += $task.Actions[$index] }
      }
      if ($keptActions.Count -eq 0) { throw "refusing to remove the last action from $($spec.TaskName)" }
      Set-ScheduledTask -TaskName $spec.TaskName -Action $keptActions -ErrorAction Stop | Out-Null
      $task = Get-ScheduledTask -TaskName $spec.TaskName -ErrorAction Stop
      $tasks[$spec.TaskName] = $task
    }
    $removeCount += $matchingIndexes.Count
    continue
  }

  $isExact = $matchingIndexes.Count -eq 1 -and
    [string]$task.Actions[$matchingIndexes[0]].Execute -ieq $wscript -and
    [string]$task.Actions[$matchingIndexes[0]].Arguments -eq $desiredArguments
  if ($isExact) {
    $skipCount++
    Write-Host (((J '\u30b9\u30ad\u30c3\u30d7') + ':{0} / {1}') -f $spec.TaskName, $spec.ScriptName)
    continue
  }

  $newAction = New-ScheduledTaskAction -Execute $wscript -Argument $desiredArguments
  if ($matchingIndexes.Count -eq 0) {
    $addCount++
    Write-Host (((J '\u8ffd\u52a0') + ':{0} / {1}') -f $spec.TaskName, $spec.ScriptName)
    if (-not $DryRun) {
      Set-ScheduledTask -TaskName $spec.TaskName -Action (@($task.Actions) + $newAction) -ErrorAction Stop | Out-Null
    }
  } else {
    $updateCount++
    Write-Host (((J '\u66f4\u65b0') + ':{0} / {1}') -f $spec.TaskName, $spec.ScriptName)
    if (-not $DryRun) {
      $updatedActions = @()
      for ($index = 0; $index -lt @($task.Actions).Count; $index++) {
        if ($index -eq $matchingIndexes[0]) { $updatedActions += $newAction }
        elseif ($matchingIndexes -notcontains $index) { $updatedActions += $task.Actions[$index] }
      }
      Set-ScheduledTask -TaskName $spec.TaskName -Action $updatedActions -ErrorAction Stop | Out-Null
    }
  }

  if (-not $DryRun) {
    $task = Get-ScheduledTask -TaskName $spec.TaskName -ErrorAction Stop
    $tasks[$spec.TaskName] = $task
  }
}

if (-not $DryRun) {
  # Read back from Task Scheduler, not from the objects used for mutation.
  foreach ($taskName in $taskNames) {
    $tasks[$taskName] = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  }
  foreach ($spec in $specs) {
    $scriptPath = Join-Path $repo (Join-Path 'tools' $spec.ScriptName)
    $expectedParts = @('//nologo', (Quote-TaskArgument $runHidden), (Quote-TaskArgument $node), (Quote-TaskArgument $scriptPath))
    $expectedParts += @($spec.ScriptArgs | ForEach-Object { Quote-TaskArgument $_ })
    $expectedArguments = $expectedParts -join ' '
    $found = @($tasks[$spec.TaskName].Actions | Where-Object {
      [string]$_.Execute -ieq $wscript -and [string]$_.Arguments -eq $expectedArguments
    })
    if (($Remove -and $found.Count -ne 0) -or (-not $Remove -and $found.Count -ne 1)) {
      throw ((J '\u8aad\u307f\u623b\u3057\u691c\u8a3c\u306b\u5931\u6557') + ": $($spec.TaskName) / $($spec.ScriptName)")
    }
  }
  Write-Host (J '\u8aad\u307f\u623b\u3057\u691c\u8a3c:ok')
}

if ($Remove) { Write-Host (((J '\u524a\u9664') + ":$removeCount" + (J '\u4ef6')) ) }
Write-Host ((J 'ok:\u8ffd\u52a0') + $addCount + (J '\u4ef6/\u66f4\u65b0') + $updateCount + (J '\u4ef6/\u30b9\u30ad\u30c3\u30d7') + $skipCount + (J '\u4ef6'))
