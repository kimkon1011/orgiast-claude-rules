<#
.SYNOPSIS
グロボ用 claude -p ランチャーテンプレート。PowerShell 5.0+ 互換。
既定モデルは sonnet。opus は -ModelReason 10 文字以上必須。
#>
param(
  [string]$Model = 'sonnet',
  [string]$ModelReason = '',
  [string]$CaseDir = ''
)

$ErrorActionPreference = 'Stop'

# ---- model policy ----
$rejected = $false
if ($Model -eq 'sonnet' -or $Model -eq 'haiku') {
  # 許可
} elseif ($Model -eq 'opus' -or $Model -like 'opus-*') {
  if ([string]::IsNullOrEmpty($ModelReason) -or $ModelReason.Length -lt 10) {
    $rejected = $true
  }
} else {
  $rejected = $true
}

if ($rejected) {
  "REJECTED $Model without ModelReason" | Out-File -Encoding utf8 -FilePath 'STATUS-LAUNCH.txt'
  exit 2
}

# ---- usage log ----
$usageFile = [System.Environment]::GetEnvironmentVariable('CC_MODEL_USAGE_FILE')
if ([string]::IsNullOrEmpty($usageFile)) {
  $usageFile = "$env:USERPROFILE\gb-reports\model-usage.jsonl"
}
$dir = Split-Path $usageFile -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
$pc = $env:COMPUTERNAME
$logLine = "{""ts"":""$ts"",""pc"":""$pc"",""model"":""$Model"",""reason"":""$ModelReason"",""case"":""$CaseDir""}"
Add-Content -Encoding utf8 -Path $usageFile -Value $logLine

# ---- launch claude ----
$claudeExe = [System.Environment]::GetEnvironmentVariable('CC_CLAUDE_EXE')
if ([string]::IsNullOrEmpty($claudeExe)) {
  # 既定の探索: %LOCALAPPDATA%\claude\claude.exe など
  $candidates = @(
    "$env:LOCALAPPDATA\claude\claude.exe",
    "$env:LOCALAPPDATA\Programs\claude\claude.exe",
    "$env:PROGRAMFILES\claude\claude.exe"
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) { $claudeExe = $c; break }
  }
}

if ([string]::IsNullOrEmpty($claudeExe)) {
  "ERROR: claude executable not found" | Out-File -Encoding utf8 -FilePath 'STATUS-LAUNCH.txt'
  exit 1
}

& $claudeExe -p "--model" $Model