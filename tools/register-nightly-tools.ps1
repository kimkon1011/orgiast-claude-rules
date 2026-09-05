param(
  [switch]$DryRun,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

function J([string]$Text) {
  return [regex]::Unescape($Text)
}

function Quote-TaskArgument([string]$Value) {
  return '"' + $Value.Replace('"', '""') + '"'
}

$repo = Split-Path -Parent $PSScriptRoot
$runHidden = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.claude\tools\run-hidden.vbs'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$specs = @(
  [pscustomobject]@{ TaskName = 'OrgiastMorningBatch'; ScriptName = 'next-actions.mjs'; ScriptArgs = @() },
  [pscustomobject]@{ TaskName = 'OrgiastMorningBatch'; ScriptName = 'nightly-health.mjs'; ScriptArgs = @() },
  [pscustomobject]@{ TaskName = 'OrgiastNightlyBatch'; ScriptName = 'pricing-brief.mjs'; ScriptArgs = @('--limit', '8') }
)

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

if ($errors.Count -gt 0) {
  foreach ($problem in $errors) { Write-Host ((J '\u30a8\u30e9\u30fc:') + $problem) }
  exit 1
}

$node = $nodeCommand.Source
$addCount = 0
$updateCount = 0
$skipCount = 0
$removeCount = 0

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
