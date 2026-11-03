# open-url-as.ps1 — URL を「そのアカウントの Chrome プロファイル」で開く（ONBOARDING §1.5.0）。
# 使い方: pwsh -NoProfile -File "<rules repo>\tools\open-url-as.ps1" -Account seisaku-team@orgiast.jp -Url https://example.com
#        pwsh -NoProfile -File "<rules repo>\tools\open-url-as.ps1" -List   ← アカウント→プロファイルの対応表
# 対応表は Chrome の "Local State"（profile.info_cache の user_name）から毎回読む。手で保守する表は持たない。
# ランチャーで URL を開く時はこれを使う。make-desktop-launcher.mjs が既定ブラウザ直開きを拒否する（2026-11-01）。
param(
  [string]$Account,
  [string]$Url,
  [switch]$List
)
$ErrorActionPreference = 'Stop'
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$map = @{}
$localState = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data\Local State'
if (Test-Path $localState) {
  $cache = (Get-Content $localState -Raw -Encoding UTF8 | ConvertFrom-Json).profile.info_cache
  foreach ($p in $cache.PSObject.Properties) {
    $email = $p.Value.user_name
    if ($email) { $map[$email.ToLower()] = $p.Name }
  }
}
if ($List) {
  $map.GetEnumerator() | Sort-Object Name | ForEach-Object { '{0,-36} {1}' -f $_.Name, $_.Value }
  exit 0
}
if (-not $Account -or -not $Url) { throw '使い方: -Account <メール> -Url <URL> または -List' }
$dir = $map[$Account.ToLower()]
if ($chrome -and $dir) {
  Start-Process -FilePath $chrome -ArgumentList @("--profile-directory=$dir", $Url)
  Write-Host "opened as $Account ($dir): $Url"
  exit 0
}
# 指定が効かない時は黙って別アカウントで開かない。人に見える警告を出してから既定で開く。
$why = if (-not $chrome) { 'Chrome が見つかりません' } else { "$Account の Chrome プロファイルがありません" }
Write-Warning "$why。既定のブラウザで開きます。右上のアカウントが $Account でなければ、切り替えてからもう一度開いてください。"
Start-Process $Url
exit 3
