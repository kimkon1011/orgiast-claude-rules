$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdministrator) {
  $powerShell = if (Get-Command pwsh.exe -ErrorAction SilentlyContinue) { 'pwsh.exe' } else { 'powershell.exe' }
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  try {
    $elevated = Start-Process -FilePath $powerShell -Verb RunAs -ArgumentList $arguments -Wait -PassThru
    exit $elevated.ExitCode
  } catch {
    Write-Host "管理者権限での起動がキャンセルされたか、失敗しました。" -ForegroundColor Red
    exit 1
  }
}

$shutdownSucceeded = $false
try {
  Write-Host "WSL を停止しています..."
  & wsl.exe --shutdown
  $shutdownSucceeded = ($LASTEXITCODE -eq 0)
  if (-not $shutdownSucceeded) {
    Write-Host "wsl --shutdown が失敗しました (終了コード: $LASTEXITCODE)。" -ForegroundColor Red
  }
} catch {
  Write-Host "wsl --shutdown の実行に失敗しました: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "LxssManager サービスを再起動しています..."
try {
  Restart-Service -Name LxssManager -Force -ErrorAction Stop
  Write-Host "LxssManager サービスを再起動しました。"
} catch {
  Write-Host "LxssManager サービスは再起動できませんでした: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "WSL の状態:"
& wsl.exe --status
$statusSucceeded = ($LASTEXITCODE -eq 0)

if ($shutdownSucceeded -and $statusSucceeded) {
  Write-Host ""
  Write-Host "WSL を再起動しました" -ForegroundColor Green
  exit 0
}

Write-Host ""
Write-Host "WSL の再起動を確認できませんでした。上のエラーを確認してください。" -ForegroundColor Red
exit 1
