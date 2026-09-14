# 実トークンを受け取った後、このスクリプトを1行で呼ぶ。
# 例: & .\tools\keyserve-enroll-e2e.ps1 -Enroll '<受け取ったトークン>'
param(
  [Parameter(Mandatory=$true)][string]$Enroll,
  [string]$IsolatedHome = (Join-Path $env:TEMP ('orgiast-enroll-e2e-' + [guid]::NewGuid().ToString('N')))
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$previousHome = $env:ORGIAST_HOME
$previousSecret = $env:ORGIAST_KEYSERVE_SECRET
try {
  # A reused home could pass with an old primary, masking a broken enrollment path.
  if (Test-Path -LiteralPath $IsolatedHome) { throw '隔離ホームは未作成のパスを指定してください。既存ホームは使えません。' }
  New-Item -ItemType Directory -Path $IsolatedHome | Out-Null
  $env:ORGIAST_HOME = $IsolatedHome
  $env:ORGIAST_KEYSERVE_SECRET = $null
  & (Join-Path $PSScriptRoot 'install-orgiast.ps1') -Enroll $Enroll -EnrollOnly -Yes -NonInteractive -NoReboot
  if ($LASTEXITCODE -ne 0) { throw '隔離ホームへの enroll 導入に失敗しました。直前の日本語メッセージを確認してください。' }
  $raw = & node (Join-Path $PSScriptRoot 'keyserve-status.mjs') --json
  if ($LASTEXITCODE -ne 0) { throw '隔離ホームの keyserve-status を実行できません。' }
  $status = ($raw -join "`n") | ConvertFrom-Json
  if ($status.auth -ne 'primary' -or $status.status -ne 200 -or -not $status.success) { throw '隔離ホームで primary / HTTP 200 を確認できません。' }
  if (Test-Path -LiteralPath (Join-Path $IsolatedHome '.claude\enroll.env')) { throw 'enroll.env が残っています。' }
  Write-Host "Layer2 成功: 認証経路: primary / HTTP 200 / 隔離ホーム: $IsolatedHome"
} finally {
  $env:ORGIAST_HOME = $previousHome
  $env:ORGIAST_KEYSERVE_SECRET = $previousSecret
}
