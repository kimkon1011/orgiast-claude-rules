param(
  [switch]$DryRun
)

# 使用中の transcript を直接圧縮すると一部だけ欠けるため、差分ミラーを静止点として使う。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

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
$restoreScriptSource = Join-Path $PSScriptRoot 'restore-claude-from-drive.ps1'
$restoreLauncherSource = Join-Path $PSScriptRoot '復元する.bat'
$repoDir = Join-Path $env:USERPROFILE 'orgiast-claude-rules'
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
  if (-not $webhook) { Write-Event 'WARN discord-notification=skipped reason=webhook-not-found'; return $false }
  try {
    $body = @{ content = $Message.Substring(0, [Math]::Min(1900, $Message.Length)) } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri $webhook -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 20 | Out-Null
    Write-Event 'discord-notification=sent'
    return $true
  } catch { Write-Event ('WARN discord-notification=failed reason={0}' -f $_.Exception.Message); return $false }
}

function Read-BackupState {
  if (-not (Test-Path -LiteralPath $stateFile)) { return [ordered]@{} }
  try {
    $savedState = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $result = [ordered]@{}
    foreach ($property in $savedState.PSObject.Properties) { $result[$property.Name] = $property.Value }
    return $result
  } catch { Write-Event ('WARN state-read-failed reason={0}' -f $_.Exception.Message); return [ordered]@{} }
}

function Write-BackupState([System.Collections.IDictionary]$State) {
  if (-not (Test-Path -LiteralPath $claudeDir)) { New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null }
  $State | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
}

function Test-GoogleDriveInstalled {
  foreach ($path in @("$env:ProgramFiles\Google\Drive File Stream\launch.bat", "$env:ProgramFiles\Google\Drive File Stream\GoogleDriveFS.exe", "$env:LOCALAPPDATA\Google\DriveFS\GoogleDriveFS.exe")) {
    if (Test-Path -LiteralPath $path) { return $true }
  }
  foreach ($registryPath in @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
    if (Get-ItemProperty $registryPath -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Google Drive*' } | Select-Object -First 1) { return $true }
  }
  return $false
}

function Install-GoogleDriveIfMissing {
  if (Test-GoogleDriveInstalled) { return }
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) { $winget = Get-Command winget -ErrorAction SilentlyContinue }
  if (-not $winget) { Write-Event 'WARN google-drive-install=skipped reason=winget-not-found'; return }
  Write-Event 'WARN google-drive-install=attempting package=Google.GoogleDrive timeoutSeconds=300'
  try {
    $installProcess = Start-Process -FilePath $winget.Source -ArgumentList @('install','--id','Google.GoogleDrive','-e','--accept-package-agreements','--accept-source-agreements','--silent') -PassThru -NoNewWindow
    if (-not $installProcess.WaitForExit(300000)) { try { $installProcess.Kill() } catch {}; Write-Event 'WARN google-drive-install=failed reason=timeout'; return }
    if ($installProcess.ExitCode -ne 0) { Write-Event ('WARN google-drive-install=failed exit={0}' -f $installProcess.ExitCode); return }
    Write-Event 'google-drive-install=complete'
  } catch { Write-Event ('WARN google-drive-install=failed reason={0}' -f $_.Exception.Message) }
}

function Stop-DriveNotAvailable {
  Install-GoogleDriveIfMissing
  $state = Read-BackupState
  $nowUtc = (Get-Date).ToUniversalTime()
  $notifyDue = $true
  if ($state.lastDriveMissingNotifyUtc) {
    try { $notifyDue = (($nowUtc - [DateTime]::Parse([string]$state.lastDriveMissingNotifyUtc).ToUniversalTime()).TotalDays -ge 7) } catch {}
  }
  $notified = $false
  if ($notifyDue) {
    $message = '📦 このPC（{0}）の Claude 環境バックアップは、Google Drive デスクトップが入っていないか、ログインされていないため動いていません。準備は1回だけ: ① https://www.google.com/drive/download/ から「パソコン版ドライブ」を入れる ② 会社の Google アカウントでログインする。翌日から自動でバックアップされます。' -f $hostname
    $notified = [bool](Send-Discord $message)
    if ($notified) { $state['lastDriveMissingNotifyUtc'] = $nowUtc.ToString('o'); Write-BackupState $state }
  }
  Write-Event ('WARN drive-not-available notified={0}' -f $notified.ToString().ToLowerInvariant())
  exit 1
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
  $state = Read-BackupState
  if ($state.lastSuccessUtc) { try { return [DateTime]::Parse([string]$state.lastSuccessUtc).ToUniversalTime() } catch {} }
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
  $isFullyQualified = [IO.Path]::IsPathRooted($Path) -and ($Path -match '^(?:[A-Za-z]:\\|\\\\)')
  $absolutePath = if ($isFullyQualified) { $Path } else { [IO.Path]::GetFullPath($Path) }
  if ($absolutePath.StartsWith('\\?\')) { return $absolutePath }
  if ($absolutePath.StartsWith('\\')) { return '\\?\UNC\' + $absolutePath.Substring(2) }
  return '\\?\' + $absolutePath
}

function Test-ExtendedPath([string]$Path) {
  $extendedPath = ConvertTo-ExtendedPath $Path
  return [IO.File]::Exists($extendedPath) -or [IO.Directory]::Exists($extendedPath)
}

function Invoke-OptionalMirror([string]$Source, [string]$Destination, [string[]]$ExtraExcludeDirs = @(), [string[]]$ExtraExcludeFiles = @()) {
  if (-not (Test-Path -LiteralPath $Source)) {
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    Write-Event ('WARN home-directory=skipped source={0} reason=not-found' -f $Source)
    return 'skipped'
  }
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  $dirs = @('cache', 'shell-snapshots', 'statsig', '__pycache__', 'ide', 'node_modules', '.git') + $ExtraExcludeDirs
  $files = @('*.tmp', '*.lock', '*.tmp[0-9]*', '*.heartbeat') + $ExtraExcludeFiles
  $args = @($Source, $Destination, '/MIR', '/R:2', '/W:2', '/XJ', '/NP', '/NFL', '/NDL', '/NJH', '/NJS', '/XD') + $dirs + @('/XF') + $files
  & robocopy @args
  $code = $LASTEXITCODE
  if ($code -ge 8) { Write-Event ('WARN home-directory-copy-failed source={0} exit={1}' -f $Source, $code) }
  return $code
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
  if (-not $DryRun -and (-not $driveProcess -or -not $driveRoot)) { Stop-DriveNotAvailable }
  if (-not $driveRoot) { throw 'Google Drive のマウントが見つかりません' }

  $myDriveName = if (Test-Path -LiteralPath (Join-Path $driveRoot 'マイドライブ')) { 'マイドライブ' } elseif (Test-Path -LiteralPath (Join-Path $driveRoot 'My Drive')) { 'My Drive' } else { 'マイドライブ' }
  $script:driveBackup = Join-Path (Join-Path (Join-Path $driveRoot $myDriveName) 'Claude-Backups') $hostname
  $driveZip = Join-Path $script:driveBackup ('claude-{0}-{1}.zip' -f $hostname, (Get-Date).ToString('yyyy-MM-dd'))
  Write-Event ('plan staging={0} destination={1}' -f $stagingDir, $driveZip)
  Write-Event ('plan structure={0}<=~/.claude; {1}<=home files/directories/tasks/repo/npm/manifest; {2}<=~/.codex' -f $stagingClaudeDir, $stagingHomeDir, $stagingCodexDir)

  if ($DryRun) {
    Write-Event 'plan robocopy=.claude:/MIR .codex:/MIR excludedDirs=cache,shell-snapshots,statsig,__pycache__,ide,node_modules,.git,sessions,tmp,logs excludedFiles=*.tmp,*.lock,*.tmp[0-9]*,*.heartbeat codexExcludedFiles=logs_*.sqlite*'
    Write-Event 'plan home-files=.claude.json(retry=2,warn-only),.claude.json.backup(optional); excludes=.claude.json.tmp.*,.bak*'
    Write-Event 'plan extras=.gitconfig,.clasprc.json,.ssh,.gemini,AppData/gh,orgiast-claude-rules,scheduled-tasks,npm-global-packages.json,backup-manifest.json'
    Write-Event 'plan restore-set=RESTORE-claude-backup.md,restore-claude-from-drive.ps1,復元する.bat'
    Write-Event 'plan compress=local-zip copy=drive readBack=min-5000+required-core+home/backup-manifest.json+scheduled-task-if-any retention=14-days+monthly-day-1/180-days'
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
  Copy-HomeFileWithRetry -Source (Join-Path $env:USERPROFILE '.gitconfig') -Destination (Join-Path $stagingHomeDir '.gitconfig') -MaxRetries 2 -WarnOnly | Out-Null
  Copy-HomeFileWithRetry -Source (Join-Path $env:USERPROFILE '.clasprc.json') -Destination (Join-Path $stagingHomeDir '.clasprc.json') -MaxRetries 2 -WarnOnly | Out-Null
  Invoke-OptionalMirror (Join-Path $env:USERPROFILE '.ssh') (Join-Path $stagingHomeDir '.ssh') | Out-Null
  Invoke-OptionalMirror (Join-Path $env:USERPROFILE '.gemini') (Join-Path $stagingHomeDir '.gemini') @('tmp', 'history', 'antigravity-cli') @('*.log', '*.bak*', '*.tmp.*') | Out-Null
  $ghSource = if ($env:APPDATA) { Join-Path $env:APPDATA 'gh' } else { $null }
  if ($ghSource) { Invoke-OptionalMirror $ghSource (Join-Path $stagingHomeDir 'AppData\gh') | Out-Null }

  Invoke-OptionalMirror $repoDir (Join-Path $stagingHomeDir 'orgiast-claude-rules') @('.git', 'node_modules') | Out-Null
  $gitInfo = Join-Path $stagingHomeDir 'orgiast-claude-rules.git-info.txt'
  if (Test-Path -LiteralPath $gitInfo) { Remove-Item -LiteralPath $gitInfo -Force }
  if ((Get-Command git -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath (Join-Path $repoDir '.git'))) {
    @('remote -v:') + @(git -C $repoDir remote -v) + @('branch:', (git -C $repoDir branch --show-current), 'head:', (git -C $repoDir rev-parse HEAD), 'status --short:') + @(git -C $repoDir status --short) | Set-Content -LiteralPath $gitInfo -Encoding UTF8
  } else { Write-Event 'WARN repo-git-info=skipped reason=git-or-repository-not-found' }

  $tasksDir = Join-Path $stagingHomeDir 'scheduled-tasks'
  if (Test-Path -LiteralPath $tasksDir) { Remove-Item -LiteralPath $tasksDir -Recurse -Force }
  New-Item -ItemType Directory -Path $tasksDir -Force | Out-Null
  $taskCount = 0
  try {
    foreach ($task in @(Get-ScheduledTask | Where-Object { $_.TaskName -match '^(Orgiast|Claude)' })) {
      $safeTaskName = $task.TaskName -replace '[\\/:*?"<>|]', '_'
      Export-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath | Set-Content -LiteralPath (Join-Path $tasksDir ($safeTaskName + '.xml')) -Encoding Unicode
      $taskCount++
    }
  } catch { Write-Event ('WARN tasks-export-failed reason={0}' -f $_.Exception.Message) }
  Write-Event ('tasks-exported count={0}' -f $taskCount)
  if ($taskCount -eq 0) { Write-Event 'WARN tasks-exported count=0' }

  $npmPackages = @{}
  if (Get-Command npm -ErrorAction SilentlyContinue) {
    try {
      $npmResult = (& npm ls -g --depth=0 --json 2>$null | Out-String) | ConvertFrom-Json
      if ($npmResult.dependencies) { foreach ($property in $npmResult.dependencies.PSObject.Properties) { $npmPackages[$property.Name] = [string]$property.Value.version } }
      $npmPackages | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stagingHomeDir 'npm-global-packages.json') -Encoding UTF8
    } catch { Write-Event ('WARN npm-global-list=skipped reason={0}' -f $_.Exception.Message) }
  } else { Write-Event 'WARN npm-global-list=skipped reason=npm-not-found' }
  $nodeVersion = if (Get-Command node -ErrorAction SilentlyContinue) { [string](& node --version 2>$null) } else { $null }
  $claudeVersion = if (Get-Command claude -ErrorAction SilentlyContinue) { try { [string](& claude --version 2>$null) } catch { $null } } else { $null }
  [ordered]@{ hostname=$hostname; userName=$env:USERNAME; userProfile=$env:USERPROFILE; createdAt=(Get-Date).ToString('o'); nodeVersion=$nodeVersion; claudeVersion=$claudeVersion; pwshVersion=$PSVersionTable.PSVersion.ToString(); taskCount=$taskCount; npmGlobalCount=$npmPackages.Count; scriptVersion='2' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stagingHomeDir 'backup-manifest.json') -Encoding UTF8
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
  foreach ($restoreFile in @($restoreScriptSource, $restoreLauncherSource)) {
    if (Test-Path -LiteralPath $restoreFile) { Copy-Item -LiteralPath $restoreFile -Destination (Join-Path $script:driveBackup ([IO.Path]::GetFileName($restoreFile))) -Force }
    else { Write-Event ('WARN restore-set-copy=skipped source={0} reason=not-found' -f $restoreFile) }
  }

  $archive = [IO.Compression.ZipFile]::OpenRead($driveZip)
  try {
    $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    $hasClaude = @($names | Where-Object { $_ -eq '.claude/CLAUDE.md' }).Count -gt 0
    $hasSettings = @($names | Where-Object { $_ -eq '.claude/settings.json' }).Count -gt 0
    $hasProjects = @($names | Where-Object { $_ -like '.claude/projects/*' }).Count -gt 0
    $hasClaudeJson = @($names | Where-Object { $_ -eq 'home/.claude.json' }).Count -gt 0
    $hasManifest = @($names | Where-Object { $_ -eq 'home/backup-manifest.json' }).Count -gt 0
    $hasBackupTask = @($names | Where-Object { $_ -eq 'home/scheduled-tasks/ClaudeDailyDriveBackup.xml' }).Count -gt 0
    $taskRequirementMet = ($taskCount -eq 0) -or $hasBackupTask
    if ($names.Count -lt 5000 -or -not $hasClaude -or -not $hasSettings -or -not $hasProjects -or -not $hasClaudeJson -or -not $hasManifest -or -not $taskRequirementMet) {
      $claudeJsonHint = if (-not $hasClaudeJson) { ' Claude Code が書き込み中で .claude.json を取得できなかった可能性があります。' } else { '' }
      throw ('read-back 不合格 entries={0} .claude/CLAUDE.md={1} .claude/settings.json={2} .claude/projects={3} home/.claude.json={4} manifest={5} backupTask={6}.{7}' -f $names.Count, $hasClaude, $hasSettings, $hasProjects, $hasClaudeJson, $hasManifest, $taskRequirementMet, $claudeJsonHint)
    }
    Write-Event ('verified entries={0} .claude/CLAUDE.md={1} .claude/settings.json={2} .claude/projects={3} home/.claude.json={4} manifest={5} backupTask={6}' -f $names.Count, $hasClaude, $hasSettings, $hasProjects, $hasClaudeJson, $hasManifest, $taskRequirementMet)
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
  $successState = Read-BackupState
  $successState['lastSuccessUtc'] = $nowUtc.ToString('o')
  $successState['lastBackup'] = $driveZip
  $successState['verifiedEntries'] = $names.Count
  Write-BackupState $successState
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
