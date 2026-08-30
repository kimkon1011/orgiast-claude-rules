# fleet-poller.ps1 — 各PCで【夜間(毎日03:15)に1回】自動実行するフリート管理エージェント(コスト最小・LLM呼び出しゼロ)。
#  A) kimの指示が無くても【日次】で verify-setup を回し、設定チェック結果(OK/NG)をDiscordへ自己報告。
#  B) 中央キュー(公開 fleet-command.json)に【承認済みタスク】が積まれていれば実行し結果を返す。
#  ★ホワイトリスト方式: 決まった安全タスクだけ実行。任意コマンドは絶対に実行しない(=RCEにしない/§1.1)。
#  会話内容は読まない・送らない。Discordへ送るのは集計/実行結果の要約のみ。
#  使い方: powershell -File fleet-poller.ps1 [-Dry]   (-Dry は送信せず表示のみ)
param([switch]$Dry)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'SilentlyContinue'
$H = $env:USERPROFILE
$repo = @("$H\orgiast-claude-rules", "$H\Downloads\orgiast-claude-rules") | Where-Object { Test-Path $_ } | Select-Object -First 1

# 自己修復: 設定ファイルの先頭BOMを除去(BOM付きだとClaude Code/nodeがJSON.parse・env読取に失敗して起動不能になるため。schtask実行なのでClaude Codeが壊れていても直せる)
foreach ($bf in @("$H\.claude\settings.json", "$H\.claude.json", "$H\.gemini\.env", "$H\.claude\cost-reporter.env", "$H\.claude\manus.env", "$H\.claude\deepseek.env", "$H\.claude\xai.env", "$H\.claude\openrouter.env", "$H\.claude\groq.env", "$H\.claude\mistral.env", "$H\.claude\ollama.env")) {
  try { if (Test-Path $bf) { $bc = [System.IO.File]::ReadAllText($bf); if ($bc.Length -gt 0 -and $bc[0] -eq [char]0xFEFF) { [System.IO.File]::WriteAllText($bf, $bc.TrimStart([char]0xFEFF), (New-Object System.Text.UTF8Encoding($false))) } } } catch {}
}

# ラベル / webhook を cost-reporter.env から
$label = $env:COMPUTERNAME
$wh = ''
try {
  foreach ($l in (Get-Content (Join-Path $H '.claude\cost-reporter.env'))) {
    if ($l -match '^REPORTER_LABEL=(.+)') { $label = $Matches[1].Trim() }
    if ($l -match '^(COST_WEBHOOK|DISCORD_COST_WEBHOOK)=(.+)') { $wh = $Matches[2].Trim() }
  }
} catch {}
function Post($msg) {
  if ($Dry) { Write-Host "[DRY POST] $msg"; return }
  if (-not $wh) { return }
  # 日本語が ? に化けるのを防ぐ: PS5.1 は -Body に文字列を渡すと非ASCIIを ? に落とすため、必ずUTF-8バイト列で送る
  try {
    $payload = @{ content = $msg } | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
    Invoke-RestMethod -Uri $wh -Method Post -ContentType 'application/json; charset=utf-8' -Body $bytes | Out-Null
  } catch {}
}
function RunPs($path, $extra) { if (Test-Path $path) { return (& powershell -NoProfile -ExecutionPolicy Bypass -File $path @extra 2>&1 | Out-String) } return '' }

# --- A) 日次 自己ヘルスレポート(kim指示不要・20hに1回) ---
$g = Join-Path $H '.claude\.fleet-report-guard'
$dueDaily = $true
if (Test-Path $g) { if (((Get-Date) - (Get-Item $g).LastWriteTime) -lt [TimeSpan]::FromHours(20)) { $dueDaily = $false } }
if ($dueDaily -and $repo) {
  Set-Content -Path $g -Value (Get-Date -Format o) -Encoding UTF8
  $out = RunPs (Join-Path $repo 'tools\verify-setup.ps1') @()
  if ($out) {
    $ok = ([regex]::Matches($out, '\[OK \]')).Count
    $ng = ([regex]::Matches($out, '\[NG \]')).Count
    $ngItems = (($out -split "`n") | Where-Object { $_ -match '\[NG \]' } | ForEach-Object { ($_ -replace '.*\[NG \]\s*', '').Trim() }) -join ' / '
    $emoji = if ($ng -eq 0) { [char]0x2705 } else { [char]0x26A0 }
    $tail = ''; if ($ng -gt 0) { $tail = " … NG: $ngItems" }
    Post "$emoji **[$label]** 日次設定チェック: OK $ok / NG $ng$tail"
    try { & node (Join-Path $repo 'tools\fleet-sheet-report.mjs') --specs --cloud *> $null } catch {}
  }
}

# --- B) 中央コマンドキュー(ホワイトリストのみ) ---
$WL = @{
  'verify-setup' = { RunPs (Join-Path $repo 'tools\verify-setup.ps1') @() }
  'rules-resync' = { RunPs (Join-Path $H '.claude\hooks\onboarding-sync.ps1') @('-Force') }
  'cost-report'  = { if (Test-Path (Join-Path $repo 'tools\claude-cost-reporter.mjs')) { (& node (Join-Path $repo 'tools\claude-cost-reporter.mjs') 2>&1 | Out-String) } else { '' } }
}
try {
  $cmdRaw = Invoke-RestMethod -Uri 'https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/fleet-command.json' -TimeoutSec 20
  $cmd = if ($cmdRaw -is [string]) { $cmdRaw | ConvertFrom-Json } else { $cmdRaw }
  $runId = [string]$cmd.runId; $task = [string]$cmd.task; $targets = [string]$cmd.targets
  if ($runId -and $task -and $repo) {
    $procF = Join-Path $H '.claude\.fleet-processed'
    $done = @(); if (Test-Path $procF) { $done = Get-Content $procF }
    $match = ($targets -eq 'all' -or [string]::IsNullOrEmpty($targets) -or $label -like "*$targets*")
    if (($done -notcontains $runId) -and $match) {
      Add-Content -Path $procF -Value $runId   # 先に処理済み記録(二重実行防止)
      if ($WL.ContainsKey($task)) {
        $res = & $WL[$task]
        $sum = ((($res -split "`n") | Where-Object { $_ -match '結果:|OK |NG |完了|エラー|error' } | Select-Object -Last 3) -join ' / ')
        Post "▶ **[$label]** タスク『$task』実行 (runId=$runId): $sum"
      } else {
        Post "⚠ **[$label]** 未許可タスク『$task』は実行しません(ホワイトリスト外)"
      }
    }
  }
} catch {}
