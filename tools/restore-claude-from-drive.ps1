param(
  [string]$Zip,
  [string]$TargetProfile,
  [switch]$SkipInstall,
  [switch]$SkipTasks,
  [switch]$SkipNpm,
  [switch]$Yes,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$testMode = -not [string]::IsNullOrWhiteSpace($TargetProfile)
$targetProfilePath = if ($testMode) { [IO.Path]::GetFullPath($TargetProfile) } else { $env:USERPROFILE }
$workRoot = Join-Path $env:LOCALAPPDATA 'claude-restore'
$earlyLog = Join-Path $workRoot 'restore.log'
$script:logFile = $earlyLog
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$script:backups = New-Object System.Collections.Generic.List[string]

function Log([string]$Message, [string]$Level = 'INFO') {
  $line = '{0} {1} {2}' -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK'), $Level, ($Message -replace '[\r\n]+',' ')
  Write-Host $line
  if (-not $DryRun) {
    $parent = Split-Path $script:logFile -Parent
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [IO.File]::AppendAllText($script:logFile, $line + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  }
}
function Warn([string]$Message) { Log $Message 'WARN' }
function Find-BackupZip {
  $local = @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter 'claude-*-????-??-??.zip' -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
  if ($local.Count -gt 0) { return $local[0].FullName }
  $parent = Split-Path $PSScriptRoot -Parent
  $all = @(Get-ChildItem -LiteralPath $parent -File -Recurse -Filter 'claude-*-????-??-??.zip' -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
  if ($all.Count -eq 0) { throw '復元できるバックアップ zip が見つかりません' }
  $pcs = @($all | ForEach-Object { $_.DirectoryName } | Sort-Object -Unique)
  if ($pcs.Count -gt 1 -and -not $Yes) {
    Write-Host '複数のパソコンのバックアップがあります:'
    for ($i=0; $i -lt $pcs.Count; $i++) { Write-Host ('  {0}: {1}' -f ($i+1), (Split-Path $pcs[$i] -Leaf)) }
    $choice = Read-Host '番号を入力してください'
    $index = 0
    if (-not [int]::TryParse($choice, [ref]$index) -or $index -lt 1 -or $index -gt $pcs.Count) { throw '選択が正しくありません' }
    return @($all | Where-Object DirectoryName -eq $pcs[$index-1] | Sort-Object Name -Descending)[0].FullName
  }
  return $all[0].FullName
}
function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path','Machine')
  $user = [Environment]::GetEnvironmentVariable('Path','User')
  $env:Path = @($machine,$user,'C:\Program Files\Git\cmd','C:\Program Files\nodejs') -join ';'
}
function Invoke-WithTimeout([string]$File, [string[]]$Arguments, [int]$Seconds = 300) {
  $p = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru -NoNewWindow
  if (-not $p.WaitForExit($Seconds * 1000)) { try { $p.Kill() } catch {}; throw "$File が ${Seconds}秒でタイムアウトしました" }
  if ($p.ExitCode -ne 0) { throw "$File が失敗しました (exit=$($p.ExitCode))" }
}
function Install-Tools {
  if ($SkipInstall -or $testMode) { return }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    foreach ($item in @(@('git','Git.Git'),@('node','OpenJS.NodeJS.LTS'),@('pwsh','Microsoft.PowerShell'),@('claude','Anthropic.ClaudeCode'))) {
      if (-not (Get-Command $item[0] -ErrorAction SilentlyContinue)) {
        try { Log ('installing package={0}' -f $item[1]); Invoke-WithTimeout $winget.Source @('install','--id',$item[1],'-e','--accept-package-agreements','--accept-source-agreements') }
        catch { Warn ('winget-install-failed package={0} reason={1}' -f $item[1],$_.Exception.Message) }
        Refresh-Path
      }
    }
  } else { Warn 'winget が見つかりません' }
  Refresh-Path
  if (-not (Get-Command claude -ErrorAction SilentlyContinue) -and (Get-Command npm -ErrorAction SilentlyContinue)) { try { Invoke-WithTimeout (Get-Command npm).Source @('install','-g','@anthropic-ai/claude-code') } catch { Warn $_.Exception.Message } }
  if (-not (Get-Command codex -ErrorAction SilentlyContinue) -and (Get-Command npm -ErrorAction SilentlyContinue)) { try { Invoke-WithTimeout (Get-Command npm).Source @('install','-g','@openai/codex') } catch { Warn $_.Exception.Message } }
  Refresh-Path
}
function Restore-UnsafeNames([string]$Extracted) {
  $map = Join-Path $Extracted 'home\renamed-files.txt'
  if (-not (Test-Path -LiteralPath $map)) { return }
  foreach ($line in @(Get-Content -LiteralPath $map -Encoding UTF8)) {
    if ($line -notmatch '^(.*?)\s+→\s+(.*?)$') { continue }
    $oldName=$Matches[1]; $newName=$Matches[2]
    foreach ($item in @(Get-ChildItem -LiteralPath $Extracted -Recurse -Force | Where-Object Name -eq $newName | Sort-Object {$_.FullName.Length} -Descending)) {
      try {
        $destination = Join-Path $item.DirectoryName $oldName
        $src = '\\?\' + $item.FullName; $dst = '\\?\' + $destination
        if ($item.PSIsContainer) { [IO.Directory]::Move($src,$dst) } else { [IO.File]::Move($src,$dst) }
      } catch { Warn ('unsafe-name-restore-failed name={0} reason={1}' -f $oldName,$_.Exception.Message) }
    }
  }
}
function Backup-And-Move([string]$Source,[string]$Destination,[switch]$Directory) {
  if (-not (Test-Path -LiteralPath $Source)) { Warn ('restore-source-missing path={0}' -f $Source); return }
  if (Test-Path -LiteralPath $Destination) {
    $saved = if ($Directory) { "$Destination-before-restore-$stamp" } else { "$Destination.before-restore-$stamp" }
    Move-Item -LiteralPath $Destination -Destination $saved
    $script:backups.Add($saved)
  }
  $parent = Split-Path $Destination -Parent
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  Move-Item -LiteralPath $Source -Destination $Destination -Force
}
function Restore-Repo([string]$BackupHome) {
  $source = Join-Path $BackupHome 'orgiast-claude-rules'; if (-not (Test-Path $source)) { Warn 'repo-backup=missing'; return }
  $destination = Join-Path $targetProfilePath 'orgiast-claude-rules'
  if (-not (Test-Path $destination)) {
    $remote='https://github.com/kimkon1011/orgiast-claude-rules.git'; $info=Join-Path $BackupHome 'orgiast-claude-rules.git-info.txt'
    if (Test-Path $info) { $match=[regex]::Match((Get-Content $info -Raw),'(?m)^origin\s+(\S+)\s+\(fetch\)'); if($match.Success){$remote=$match.Groups[1].Value} }
    if (Get-Command git -ErrorAction SilentlyContinue) { try { & git clone $remote $destination; if($LASTEXITCODE -ne 0){throw 'git clone failed'} } catch { Warn $_.Exception.Message } }
    if (-not (Test-Path $destination)) { New-Item -ItemType Directory -Path $destination -Force | Out-Null; Warn 'git が使えないため作業ツリーだけを復元します' }
  }
  & robocopy $source $destination /E /R:2 /W:2 /XJ /NP /NFL /NDL /NJH /NJS /XD .git node_modules
  if ($LASTEXITCODE -ge 8) { throw "リポジトリ復元の robocopy が失敗しました (exit=$LASTEXITCODE)" }
}
function Restore-Npm([string]$BackupHome) {
  if ($SkipNpm -or $testMode) { return }; $list=Join-Path $BackupHome 'npm-global-packages.json'
  if (-not (Test-Path $list) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) { Warn 'npm-package-restore=skipped'; return }
  $wanted=Get-Content $list -Raw -Encoding UTF8 | ConvertFrom-Json; $installed=@{}
  try { $current=(& npm ls -g --depth=0 --json 2>$null | Out-String)|ConvertFrom-Json; foreach($p in $current.dependencies.PSObject.Properties){$installed[$p.Name]=$true} } catch {}
  foreach($p in $wanted.PSObject.Properties){ if($p.Name -in @('npm','corepack') -or $installed.ContainsKey($p.Name)){continue}; try{Invoke-WithTimeout (Get-Command npm).Source @('install','-g',($p.Name+'@'+$p.Value))}catch{Warn $_.Exception.Message} }
}
function Convert-TaskXml([string]$Text,[string]$OldProfile) {
  $domainUser = "$env:USERDOMAIN\$env:USERNAME"
  $Text = [regex]::Replace($Text,'(<Principals[\s\S]*?<UserId>)[^<]*(</UserId>)',('$1'+$domainUser+'$2'))
  if ($OldProfile) { $Text = $Text.Replace($OldProfile,$env:USERPROFILE) }
  return $Text
}
function Restore-Tasks([string]$BackupHome,[object]$Manifest) {
  if ($SkipTasks -or $testMode) { return @(0,0) }; $ok=0;$bad=0;$dir=Join-Path $BackupHome 'scheduled-tasks'
  foreach($file in @(Get-ChildItem $dir -Filter '*.xml' -File -ErrorAction SilentlyContinue)) { try{$xml=Convert-TaskXml (Get-Content $file.FullName -Raw) ([string]$Manifest.userProfile); Register-ScheduledTask -Xml $xml -TaskName $file.BaseName -Force | Out-Null;$ok++}catch{$bad++;Warn ('task-register-failed name={0} reason={1}' -f $file.BaseName,$_.Exception.Message)} }
  Log ('tasks-registered success={0} failed={1}' -f $ok,$bad); return @($ok,$bad)
}

try {
  if (-not $Zip) { $Zip=Find-BackupZip }; if (-not [IO.Path]::IsPathRooted($Zip)) { $Zip=Join-Path (Get-Location) $Zip }; $Zip=[IO.Path]::GetFullPath($Zip)
  if (-not (Test-Path -LiteralPath $Zip)) { throw "zip がありません: $Zip" }
  Write-Host ''; Write-Host '復元内容:'; Write-Host "  バックアップ: $Zip"; Write-Host "  復元先: $targetProfilePath"; Write-Host '  Claude/Codex設定、認証、SSH、Git設定、作業ツリー、npm、定期タスクを復元します。'
  if ($DryRun) { Log ('plan zip={0} target={1} install={2} tasks={3} npm={4} testMode={5}' -f $Zip,$targetProfilePath,(-not $SkipInstall),(-not $SkipTasks),(-not $SkipNpm),$testMode); exit 0 }
  if (-not $Yes) { if ((Read-Host '実行しますか? (y/N)') -notmatch '^[yY]$') { Log 'cancelled'; exit 0 } }
  if (-not $testMode) { $running=@(Get-Process -ErrorAction SilentlyContinue | Where-Object {$_.ProcessName -in @('claude','Code','codex')}); if($running.Count){Write-Host ('停止が必要なプロセス: '+(($running.ProcessName|Sort-Object -Unique)-join ', ')); exit 1} }
  Install-Tools
  New-Item -ItemType Directory -Path $workRoot -Force | Out-Null; $localZip=Join-Path $workRoot 'backup.zip'; Copy-Item $Zip $localZip -Force
  $extracted=Join-Path $workRoot 'extracted'; if(Test-Path $extracted){Remove-Item $extracted -Recurse -Force}; New-Item -ItemType Directory $extracted | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($localZip,$extracted)
  $sourceClaude=Join-Path $extracted '.claude';$backupHomePath=Join-Path $extracted 'home';if(-not(Test-Path $sourceClaude)-or-not(Test-Path $backupHomePath)){throw 'zip に .claude と home が揃っていません'}
  Restore-UnsafeNames $extracted
  Backup-And-Move $sourceClaude (Join-Path $targetProfilePath '.claude') -Directory
  $script:logFile=Join-Path $targetProfilePath '.claude\logs\restore-from-drive.log'
  foreach($name in @('.claude.json','.claude.json.backup','.gitconfig','.clasprc.json')){Backup-And-Move (Join-Path $backupHomePath $name) (Join-Path $targetProfilePath $name)}
  foreach($name in @('.codex','.ssh','.gemini')){Backup-And-Move (Join-Path $backupHomePath $name) (Join-Path $targetProfilePath $name) -Directory}
  $appDataTarget=if($testMode){Join-Path $targetProfilePath 'AppData\Roaming\gh'}else{Join-Path $env:APPDATA 'gh'};Backup-And-Move (Join-Path $backupHomePath 'AppData\gh') $appDataTarget -Directory
  Restore-Repo $backupHomePath; Restore-Npm $backupHomePath
  $manifest=@{};$manifestPath=Join-Path $backupHomePath 'backup-manifest.json';if(Test-Path $manifestPath){$manifest=Get-Content $manifestPath -Raw -Encoding UTF8|ConvertFrom-Json};$taskResult=Restore-Tasks $backupHomePath $manifest
  $checks=[ordered]@{'CLAUDE.md'=Test-Path (Join-Path $targetProfilePath '.claude\CLAUDE.md');'settings.json'=Test-Path (Join-Path $targetProfilePath '.claude\settings.json');'projects'=Test-Path (Join-Path $targetProfilePath '.claude\projects')}
  if(-not $testMode){$checks['claude --version']=if(Get-Command claude -ErrorAction SilentlyContinue){try{[string](& claude --version)}catch{$false}}else{$false};$checks['registered tasks']=$taskResult[0]}
  $checks.GetEnumerator()|Format-Table Name,Value -AutoSize
  if(-not $checks['CLAUDE.md']-or-not $checks['settings.json']-or-not $checks['projects']){throw '必須ファイルの検証に失敗しました'}
  Log 'restore-complete'; Write-Host '次にやること: Claude Code を起動し、ログイン画面が出たらログインしてください（これだけは人にしか出来ません）'; exit 0
} catch {
  Log ('restore-failed reason={0}' -f $_.Exception.Message) 'ERROR'; if($script:backups.Count){Write-Host '退避済み:';$script:backups|ForEach-Object{Write-Host "  $_"};Write-Host '元に戻す方法: 復元先を削除し、上記の名前から before-restore-日時部分を外してください。'}; exit 1
}
