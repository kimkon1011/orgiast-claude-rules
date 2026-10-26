# hide-task-windows.ps1 — 現在ユーザーの定期タスクのうち、コンソール窓を出す起動方式のものを
# run-hidden.vbs(wscript 経由・窓なし)へ包み直す。nightly-batch から毎晩全PCで走り、
# 後から別スクリプトが窓あり方式で登録・再登録したタスクも自動で戻す。
#
# Why: LogonType=Interactive のタスクが powershell.exe / cmd.exe / node.exe を直接起動すると
# 毎回コンソール窓が出る。`-WindowStyle Hidden` は起動後に隠すだけなので、PCが重いと
# 空の青い窓が数秒〜残る(2026-10-26 nishi-PC 実測: OrgiastThermalGuard が5分おきに表示)。
#
# 使い方: powershell -NoProfile -ExecutionPolicy Bypass -File hide-task-windows.ps1 [-Dry]
[CmdletBinding()]
param([switch]$Dry)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')

$consoleExe = @('powershell', 'pwsh', 'cmd', 'node', 'python', 'py', 'bash', 'wsl', 'git')
$consoleExt = @('.cmd', '.bat')

# Windows のコマンドライン規則(二重引用符で囲んだ範囲は1語)で分割する。
# 埋め込み引用符(\")を含む引数は正しく復元できないので呼び出し側で除外する。
function Split-TaskArguments([string]$Text) {
  $tokens = New-Object System.Collections.Generic.List[string]
  if (-not $Text) { return ,$tokens.ToArray() }
  foreach ($m in [regex]::Matches($Text, '"([^"]*)"|(\S+)')) {
    if ($m.Groups[1].Success) { $tokens.Add($m.Groups[1].Value) } else { $tokens.Add($m.Groups[2].Value) }
  }
  return ,$tokens.ToArray()
}

# powershell の -WindowStyle Hidden は run-hidden 配下では不要(窓自体が作られない)。
function Remove-WindowStyle([string[]]$Tokens) {
  $out = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt $Tokens.Count; $i++) {
    if ($Tokens[$i] -match '^-(w|win|window|windowstyle)$' -and $i + 1 -lt $Tokens.Count) { $i++; continue }
    $out.Add($Tokens[$i])
  }
  return ,$out.ToArray()
}

$changed = 0; $skipped = 0; $failed = 0
$tasks = Get-ScheduledTask | Where-Object {
  $_.TaskPath -notlike '\Microsoft\*' -and $_.State -ne 'Disabled' -and
  "$($_.Principal.LogonType)" -match '^Interactive' -and
  $_.Principal.UserId -and ($_.Principal.UserId -split '\\')[-1] -eq $env:USERNAME
}
foreach ($task in $tasks) {
  $name = $task.TaskPath + $task.TaskName
  $needs = $false; $complex = $false
  $newActions = foreach ($a in $task.Actions) {
    $exe = "$($a.Execute)".Trim('"')
    $base = [IO.Path]::GetFileNameWithoutExtension($exe).ToLowerInvariant()
    $ext = [IO.Path]::GetExtension($exe).ToLowerInvariant()
    if (-not $exe -or $base -eq 'wscript' -or $base -eq 'cscript' -or
        -not (($consoleExe -contains $base) -or ($consoleExt -contains $ext))) { $a; continue }
    if ("$($a.Arguments)" -match '\\"') { $complex = $true; $a; continue }
    $needs = $true
    $tokens = Split-TaskArguments $a.Arguments
    if ($base -in @('powershell', 'pwsh')) { $tokens = Remove-WindowStyle $tokens }
    $p = @{ Execute = $exe; ChildArgument = $tokens }
    if ($a.WorkingDirectory) { $p.WorkingDirectory = $a.WorkingDirectory }
    New-HiddenScheduledTaskAction @p
  }
  if ($complex -and -not $needs) { $skipped++; Write-Host "skip(引用符入り引数・手動確認): $name"; continue }
  if (-not $needs) { continue }
  if ($Dry) { $changed++; Write-Host "dry: 隠し起動へ変更予定: $name"; continue }
  try {
    Set-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -Action @($newActions) | Out-Null
    $changed++; Write-Host "隠し起動へ変更: $name"
  } catch { $failed++; Write-Host ("エラー: " + $name + ": " + $_.Exception.Message) }
}
Write-Host ("完了: 変更=" + $changed + " / 除外=" + $skipped + " / 失敗=" + $failed)
if ($failed -gt 0) { exit 1 }
exit 0
