param(
  [switch]$Quiet
)

# Google Drive Desktop を管理者権限でサイレントインストールする。
# このスクリプト自身は昇格しない（launcher が cmd から実行する想定）。
# 昇格が必要な場合は install-google-drive-elevated.bat も併置される。

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

$downloaded = $false
$installerUrl = 'https://dl.google.com/drive-file-stream/GoogleDriveSetup.exe'
$installerLocal = Join-Path $env:TEMP 'GoogleDriveSetup.exe'

function Get-GoogleDriveInstalled {
  foreach ($path in @("$env:ProgramFiles\Google\Drive File Stream\launch.bat", "$env:ProgramFiles\Google\Drive File Stream\GoogleDriveFS.exe", "$env:LOCALAPPDATA\Google\DriveFS\GoogleDriveFS.exe")) {
    if (Test-Path -LiteralPath $path) { return $true }
  }
  foreach ($registryPath in @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
    if (Get-ItemProperty $registryPath -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Google Drive*' } | Select-Object -First 1) { return $true }
  }
  return $false
}

if (Get-GoogleDriveInstalled) {
  if (-not $Quiet) { Write-Host '✅ Google Drive Desktop は既にインストールされています' }
  exit 0
}

Write-Host '📥 Google Drive Desktop をダウンロードしています...'
try {
  $webClient = New-Object System.Net.WebClient
  $webClient.DownloadFile($installerUrl, $installerLocal)
  $downloaded = $true
  Write-Host '   ダウンロード完了'
} catch {
  Write-Host "❌ ダウンロード失敗: $($_.Exception.Message)"
  exit 1
}

Write-Host '🔧 インストールを実行しています（管理者権限が必要です）...'
try {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $installerLocal
  $psi.Arguments = '--silent --skip_launch_new'
  $psi.UseShellExecute = $true
  $psi.Verb = 'RunAs'
  Write-Host '   管理者昇格のダイアログが表示されたら「はい」をクリックしてください'
  $p = [System.Diagnostics.Process]::Start($psi)
  if (-not $p) { throw 'プロセスの起動に失敗しました' }
  $p.WaitForExit(300000)  # 5分
  if ($p.ExitCode -eq 0) {
    Write-Host '✅ Google Drive Desktop のインストールが完了しました'
    Write-Host '   アカウントでログインすると H:\ ドライブが利用可能になります'
    Write-Host '   翌日03:40から自動バックアップが開始されます'
  } else {
    Write-Host "❌ インストールが失敗しました (exit code: $($p.ExitCode))"
    Write-Host '   手動で以下のURLからインストーラをダウンロードして実行してください:'
    Write-Host "   $installerUrl"
  }
} catch {
  Write-Host "❌ インストール実行中にエラーが発生しました: $($_.Exception.Message)"
  exit 1
}