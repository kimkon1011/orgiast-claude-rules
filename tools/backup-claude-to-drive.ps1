param(
  [switch]$DryRun
)

# 使用中の transcript を直接圧縮すると一部だけ欠けるため、差分ミラーを静止点として使う。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$startedAt = Get-Date
$claudeDir = Join-Path $env:USERPROFILE '.claude'
$claudeJson = Join-Path $env:USERPROFILE '.claude.json'
$claudeJsonBackup = Join-Path $env:USERPROFILE '.claude.json.backup'
$codexDir = Join-Path $env:USERPROFILE '.codex'
$logDir = Join-Path $claudeDir 'logs'
$logFile = Join-Path $logDir 'backup-to-drive.log'
$stateFile = Join-Path $claudeDir 'backup-to-drive-state.json'
$stagingDir = Join-Path $env:LOCALAPPDATA 'claude-backup-staging'
$stagingClaudeDir = Join-Path $stagingDir '.claude'
$stagingHomeDir = Join-Path $stagingDir 'home'
$stagingCodexDir = Join-Path $stagingHomeDir '.codex'
$localZip = Join-Path $env:LOCALAPPDATA 'claude-backup-staging.zip'
$restoreSource = Join-Path $PSScriptRoot 'RESTORE-claude-backup.md'
$hostname = [Environment]::MachineName
$script:driveBackup = $null
$script:driveZipWritten = $false

function Write-Event([string]$Message) {
  $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK'), ($Message -replace "[\r\n]+", ' ')
  Write-Host $line
  if ($DryRun) { return }
  if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
  # 肥大したログ自身がバックアップ容量を増やし続けないよう、追記前に1世代だけ退避する。
  if ((Test-Path -LiteralPath $logFile) -and (Get-Item -LiteralPath $logFile).Length -gt 1MB) {
    $rotated = "$logFile.1"
    if (Test-Path -LiteralPath $rotated) { Remove-Item -LiteralPath $rotated -Force }
    Move-Item -LiteralPath $logFile -Destination $rotated -Force
  }
  [IO.File]::AppendAllText($logFile, $line + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
}

function Get-DiscordWebhook {
  $path = Join-Path $claudeDir 'discord-webhooks.json'
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try { $ledger = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
  $urlPattern = 'https://discord(?:app)?\.com/api/webhooks/[^\s"'']+'
  foreach ($property in $ledger.PSObject.Properties) {
    # 新旧PCで形式が違っても通知不能にならないよう、単純マップと台帳形式を両方読む。
    if ($property.Value -is [string] -and $property.Value -match $urlPattern) { return $Matches[0] }
    if ($property.Value.url -and ([string]$property.Value.url) -match $urlPattern) { return $Matches[0] }
    foreach ($file in @($property.Value.files)) {
      if ($file -and (Test-Path -LiteralPath $file)) {
        $text = Get-Content -LiteralPath $file -Raw -ErrorAction SilentlyContinue
        if ($text -match $urlPattern) { return $Matches[0] }
      }
    }
  }
  return $null
}

function Send-Discord([string]$Message) {
  $webhook = Get-DiscordWebhook
  if (-not $webhook) { Write-Event 'WARN discord-notification=skipped reason=webhook-not-found'; return }
  try {
    $body = @{ content = $Message.Substring(0, [Math]::Min(1900, $Message.Length)) } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri $webhook -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 20 | Out-Null
    Write-Event 'discord-notification=sent'
  } catch { Write-Event ('WARN discord-notification=failed reason={0}' -f $_.Exception.Message) }
}

function Find-GoogleDrive {
  $candidates = @(Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)
  foreach ($drive in $candidates) {
    $description = [string]$drive.Description
    if ($description -eq 'Google Drive') { return $drive.Root }
  }
  foreach ($drive in $candidates) {
    if ((Test-Path -LiteralPath (Join-Path $drive.Root 'マイドライブ')) -or (Test-Path -LiteralPath (Join-Path $drive.Root 'My Drive'))) { return $drive.Root }
  }
  if (Test-Path -LiteralPath 'H:\') { return 'H:\' }
  return $null
}

function Get-PreviousSuccess {
  if (-not (Test-Path -LiteralPath $stateFile)) { return $null }
  try {
    $state = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($state.lastSuccessUtc) { return [DateTime]::Parse([string]$state.lastSuccessUtc).ToUniversalTime() }
  } catch { Write-Event ('WARN state-read-failed reason={0}' -f $_.Exception.Message) }
  return $null
}

function Copy-HomeFileWithRetry([string]$Source, [string]$Destination, [int]$MaxRetries = 2, [switch]$WarnOnly) {
  # 前日のコピーを今日取得したものと誤認しないよう、存在確認より先に消す。
  if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
  if (-not (Test-Path -LiteralPath $Source)) {
    Write-Event ('WARN home-file=skipped source={0} reason=not-found' -f $Source)
    return $false
  }

  for ($attempt = 1; $attempt -le ($MaxRetries + 1); $attempt++) {
    try {
      Copy-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop
      Write-Event ('home-file-copied source={0} attempt={1}' -f $Source, $attempt)
      return $true
    } catch {
      if ($attempt -le $MaxRetries) {
        Write-Event ('WARN home-file-copy-retry source={0} attempt={1} reason={2}' -f $Source, $attempt, $_.Exception.Message)
        Start-Sleep -Seconds 2
      } elseif ($WarnOnly) {
        Write-Event ('WARN home-file-copy-failed source={0} attempts={1} reason={2}; backup continues, but read-back will fail if this file is required' -f $Source, $attempt, $_.Exception.Message)
        return $false
      } else {
        throw
      }
    }
  }
}

function ConvertTo-ExtendedPath([string]$Path) {
  # GetFullPath は拡張プレフィックスを付ける前の末尾ドットを落とすため、絶対パスはそのまま使う。
  $absolutePath = if ([IO.Path]::IsPathFullyQualified($Path)) { $Path } else { [IO.Path]::GetFullPath($Path) }
  if ($absolutePath.StartsWith('\\?\')) { return $absolutePath }
  if ($absolutePath.StartsWith('\\')) { return '\\?\UNC\' + $absolutePath.Substring(2) }
  return '\\?\' + $absolutePath
}

function Test-ExtendedPath([string]$Path) {
  $extendedPath = ConvertTo-ExtendedPath $Path
  return [IO.File]::Exists($extendedPath) -or [IO.Directory]::Exists($extendedPath)
}

function Repair-StagingNames {
  $renamedFile = Join-Path $stagingHomeDir 'renamed-files.txt'
  if (Test-Path -LiteralPath $renamedFile) { Remove-Item -LiteralPath $renamedFile -Force }

  # 子を先に処理すれば、親ディレクトリの改名で未処理の子のパスが変わらない。
  $unsafeItems = @(Get-ChildItem -LiteralPath $stagingDir -Recurse -Force | Where-Object {
    $_.Name -match '[\. \u3000]+$'
  } | Sort-Object { $_.FullName.Length } -Descending)
  $renamed = New-Object System.Collections.Generic.List[string]

  foreach ($item in $unsafeItems) {
    $oldName = $item.Name
    # 末尾ドット名では FileSystemInfo.Parent 自体が Win32 正規化で null になりうる。
    $parentPath = $item.FullName.Substring(0, $item.FullName.Length - $oldName.Length).TrimEnd('\')
    $trailingLength = ([regex]::Match($oldName, '[\. \u3000]+$')).Length
    $safeName = $oldName.Substring(0, $oldName.Length - $trailingLength) + ('_' * $trailingLength)
    $destination = Join-Path $parentPath $safeName
    $suffix = 1
    while (Test-ExtendedPath $destination) {
      $destination = Join-Path $parentPath ('{0}-{1}' -f $safeName, $suffix)
      $suffix++
    }

    $sourceExtended = ConvertTo-ExtendedPath $item.FullName
    $destinationExtended = ConvertTo-ExtendedPath $destination
    if ($item.PSIsContainer) {
      [IO.Directory]::Move($sourceExtended, $destinationExtended)
    } else {
      [IO.File]::Move($sourceExtended, $destinationExtended)
    }
    $renamed.Add(('{0} → {1}' -f $oldName, [IO.Path]::GetFileName($destination)))
  }

  if ($renamed.Count -gt 0) {
    [IO.File]::WriteAllLines($renamedFile, $renamed, (New-Object Text.UTF8Encoding($false)))
  }
  Write-Event ('sanitized-names count={0}' -f $renamed.Count)
}

try {
  Write-Event ('start dryRun={0} source={1}' -f $DryRun.IsPresent, $claudeDir)
  if (-not (Test-Path -LiteralPath $claudeDir)) { throw "バックアップ元がありません: $claudeDir" }
  if (-not (Test-Path -LiteralPath $restoreSource)) { throw "復元手順書がありません: $restoreSource" }

  $driveProcess = Get-Process -Name 'GoogleDriveFS' -ErrorAction SilentlyContinue
  $driveRoot = Find-GoogleDrive
  if ($DryRun -and -not $driveRoot) { $driveRoot = 'H:\'; Write-Event 'plan drive-root=H:\ reason=no-mounted-drive-dry-run-fallback' }
  if (-not $DryRun -and -not $driveProcess) { throw 'GoogleDriveFS プロセスが動いていません' }
  if (-not $driveRoot) { throw 'Google Drive のマウントが見つかりません' }

  $myDriveName = if (Test-Path -LiteralPath (Join-Path $driveRoot 'マイドライブ')) { 'マイドライブ' } elseif (Test-Path -LiteralPath (Join-Path $driveRoot 'My Drive')) { 'My Drive' } else { 'マイドライブ' }
  $script:driveBackup = Join-Path (Join-Path (Join-Path $driveRoot $myDriveName) 'Claude-Backups') $hostname
  $driveZip = Join-Path $script:driveBackup ('claude-{0}-{1}.zip' -f $hostname, (Get-Date).ToString('yyyy-MM-dd'))
  Write-Event ('plan staging={0} destination={1}' -f $stagingDir, $driveZip)
  Write-Event ('plan structure={0}<=~/.claude; {1}<=~/.claude.json,~/.claude.json.backup; {2}<=~/.codex' -f $stagingClaudeDir, $stagingHomeDir, $stagingCodexDir)

  if ($DryRun) {
    Write-Event 'plan robocopy=.claude:/MIR .codex:/MIR excludedDirs=cache,shell-snapshots,statsig,__pycache__,ide,node_modules,.git,sessions,tmp,logs excludedFiles=*.tmp,*.lock,*.tmp[0-9]*,*.heartbeat codexExcludedFiles=logs_*.sqlite*'
    Write-Event 'plan home-files=.claude.json(retry=2,warn-only),.claude.json.backup(optional); excludes=.claude.json.tmp.*,.bak*'
    Write-Event 'plan compress=local-zip copy=drive readBack=min-5000+.claude/CLAUDE.md+.claude/settings.json+.claude/projects/*+home/.claude.json retention=14-days+monthly-day-1/180-days'
    Write-Event ('complete dryRun=true elapsedSeconds={0}' -f [Math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1))
    exit 0
  }

  $stagingDrive = New-Object System.IO.DriveInfo([IO.Path]::GetPathRoot($stagingDir))
  $freeGb = $stagingDrive.AvailableFreeSpace / 1GB
  if ($freeGb -lt 6) { throw ('ステージング先ドライブの空き容量が不足しています (空き: {0:N2} GB、必要: 6 GB)' -f $freeGb) }

  New-Item -ItemType Directory -Path $stagingClaudeDir -Force | Out-Null
  New-Item -ItemType Directory -Path $stagingHomeDir -Force | Out-Null
  # 旧形式（zip 直下が ~/.claude）から移行した際の残骸を zip に混ぜない。
  foreach ($legacyItem in @(Get-ChildItem -LiteralPath $stagingDir -Force)) {
    if ($legacyItem.Name -notin @('.claude', 'home')) { Remove-Item -LiteralPath $legacyItem.FullName -Recurse -Force }
  }
  $excludeDirs = @('cache', 'shell-snapshots', 'statsig', '__pycache__', 'ide', 'node_modules', '.git')
  $excludeFiles = @('*.tmp', '*.lock', '*.tmp[0-9]*', '*.heartbeat')
  $roboArgs = @($claudeDir, $stagingClaudeDir, '/MIR', '/R:2', '/W:2', '/XJ', '/NP', '/NFL', '/NDL', '/NJH', '/NJS', '/XD') + $excludeDirs + @('/XF') + $excludeFiles
  & robocopy @roboArgs
  $robocopyCode = $LASTEXITCODE
  if ($robocopyCode -ge 8) { throw "~/.claude の robocopy が失敗しました (exit=$robocopyCode)" }

  if (Test-Path -LiteralPath $codexDir) {
    # 実環境を確認し、設定・認証・skills/plugins は残して、再生成可能な実行履歴だけを除外する。
    $codexExcludeDirs = $excludeDirs + @('sessions', 'tmp', 'logs')
    $codexExcludeFiles = $excludeFiles + @('logs_*.sqlite*')
    $codexRoboArgs = @($codexDir, $stagingCodexDir, '/MIR', '/R:2', '/W:2', '/XJ', '/NP', '/NFL', '/NDL', '/NJH', '/NJS', '/XD') + $codexExcludeDirs + @('/XF') + $codexExcludeFiles
    & robocopy @codexRoboArgs
    $codexRobocopyCode = $LASTEXITCODE
    if ($codexRobocopyCode -ge 8) { throw "~/.codex の robocopy が失敗しました (exit=$codexRobocopyCode)" }
  } else {
    $codexRobocopyCode = 'skipped'
    if (Test-Path -LiteralPath $stagingCodexDir) { Remove-Item -LiteralPath $stagingCodexDir -Recurse -Force }
    Write-Event ('WARN codex-mirror=skipped reason=not-found source={0}' -f $codexDir)
  }

  Copy-HomeFileWithRetry -Source $claudeJson -Destination (Join-Path $stagingHomeDir '.claude.json') -MaxRetries 2 -WarnOnly | Out-Null
  # 復元に必須なのは home/.claude.json のみなので、補助バックアップのロックでは処理を止めない。
  Copy-HomeFileWithRetry -Source $claudeJsonBackup -Destination (Join-Path $stagingHomeDir '.claude.json.backup') -MaxRetries 2 -WarnOnly | Out-Null
  $stagedCount = @(Get-ChildItem -LiteralPath $stagingDir -File -Recurse -Force).Count
  Write-Event ('mirror-complete claudeRobocopyExit={0} codexRobocopyExit={1} stagedFiles={2}' -f $robocopyCode, $codexRobocopyCode, $stagedCount)

  # /MIR は次回、改名後を余分として削除し、元の末尾不正名を再コピーするため毎回ここで再改名する。
  Repair-StagingNames

  if (Test-Path -LiteralPath $localZip) { Remove-Item -LiteralPath $localZip -Force }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory($stagingDir, $localZip, [IO.Compression.CompressionLevel]::Optimal, $false)
  $zipSize = (Get-Item -LiteralPath $localZip).Length
  Write-Event ('zip-created bytes={0}' -f $zipSize)

  New-Item -ItemType Directory -Path $script:driveBackup -Force | Out-Null
  Copy-Item -LiteralPath $localZip -Destination $driveZip -Force
  $script:driveZipWritten = $true
  Copy-Item -LiteralPath $restoreSource -Destination (Join-Path $script:driveBackup 'RESTORE-claude-backup.md') -Force

  $archive = [IO.Compression.ZipFile]::OpenRead($driveZip)
  try {
    $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    $hasClaude = @($names | Where-Object { $_ -eq '.claude/CLAUDE.md' }).Count -gt 0
    $hasSettings = @($names | Where-Object { $_ -eq '.claude/settings.json' }).Count -gt 0
    $hasProjects = @($names | Where-Object { $_ -like '.claude/projects/*' }).Count -gt 0
    $hasClaudeJson = @($names | Where-Object { $_ -eq 'home/.claude.json' }).Count -gt 0
    if ($names.Count -lt 5000 -or -not $hasClaude -or -not $hasSettings -or -not $hasProjects -or -not $hasClaudeJson) {
      $claudeJsonHint = if (-not $hasClaudeJson) { ' Claude Code が書き込み中で .claude.json を取得できなかった可能性があります。' } else { '' }
      throw ('read-back 不合格 entries={0} .claude/CLAUDE.md={1} .claude/settings.json={2} .claude/projects={3} home/.claude.json={4}.{5}' -f $names.Count, $hasClaude, $hasSettings, $hasProjects, $hasClaudeJson, $claudeJsonHint)
    }
    Write-Event ('verified entries={0} .claude/CLAUDE.md={1} .claude/settings.json={2} .claude/projects={3} home/.claude.json={4}' -f $names.Count, $hasClaude, $hasSettings, $hasProjects, $hasClaudeJson)
  } finally { $archive.Dispose() }

  $today = (Get-Date).Date
  foreach ($file in @(Get-ChildItem -LiteralPath $script:driveBackup -File -Filter ('claude-{0}-*.zip' -f $hostname))) {
    if ($file.Name -notmatch '^claude-.+-(\d{4}-\d{2}-\d{2})\.zip$') { continue }
    $backupDate = [DateTime]::MinValue
    if (-not [DateTime]::TryParseExact($Matches[1], 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$backupDate)) { continue }
    $age = ($today - $backupDate.Date).TotalDays
    $delete = ($age -gt 180) -or ($age -gt 14 -and $backupDate.Day -ne 1)
    if ($delete) { Remove-Item -LiteralPath $file.FullName -Force; Write-Event ('retention-deleted file={0}' -f $file.Name) }
  }

  $previousSuccess = Get-PreviousSuccess
  $nowUtc = (Get-Date).ToUniversalTime()
  @{ lastSuccessUtc = $nowUtc.ToString('o'); lastBackup = $driveZip; verifiedEntries = $names.Count } | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
  if ($previousSuccess -and (($nowUtc - $previousSuccess).TotalDays -ge 3)) { Send-Discord ('✅ Claude バックアップが復旧しました。PC: {0} / 前回成功: {1}' -f $hostname, $previousSuccess.ToString('yyyy-MM-dd HH:mm UTC')) }
  Remove-Item -LiteralPath $localZip -Force
  Write-Event ('complete bytes={0} entries={1} elapsedSeconds={2}' -f $zipSize, $names.Count, [Math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1))
  exit 0
} catch {
  $reason = $_.Exception.Message
  Write-Event ('ERROR failed reason={0} elapsedSeconds={1}' -f $reason, [Math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1))
  # 検証に落ちた成果物を成功世代として残さない。
  if (-not $DryRun -and $script:driveBackup -and $script:driveZipWritten) {
    $failedZip = Join-Path $script:driveBackup ('claude-{0}-{1}.zip' -f $hostname, (Get-Date).ToString('yyyy-MM-dd'))
    if (Test-Path -LiteralPath $failedZip) { Remove-Item -LiteralPath $failedZip -Force; Write-Event ('invalid-zip-deleted file={0}' -f $failedZip) }
  }
  if (-not $DryRun) { Send-Discord ('🚨 Claude の Google Drive バックアップに失敗しました。PC: {0} / 理由: {1}' -f $hostname, $reason) }
  exit 1
}
