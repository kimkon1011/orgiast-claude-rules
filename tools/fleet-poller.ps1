# fleet-poller.ps1 — 各PCで【夜間(毎日03:15)に1回】自動実行するフリート管理エージェント(コスト最小・LLM呼び出しゼロ)。
#  A) kimの指示が無くても【日次】で verify-setup を回し、設定チェック結果(OK/NG)をDiscordへ自己報告。
#  B) 中央キュー(公開 fleet-command.json)に【承認済みタスク】が積まれていれば実行し結果を返す。
#  ★ホワイトリスト方式: 決まった安全タスクだけ実行。任意コマンドは絶対に実行しない(=RCEにしない/§1.1)。
#  会話内容は読まない・送らない。Discordへ送るのは集計/実行結果の要約のみ。
#  使い方: powershell -File fleet-poller.ps1 [-Dry]
#    -Dry は副作用ゼロ: Discord送信・スケジュールタスク登録・BOM書き戻し・PC管理表への書き込み・
#    runId の消費・タスク本体の実行を一切行わず、何をするかだけ表示する。
param([switch]$Dry)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'SilentlyContinue'
# -Dry が「表示のみ」を名乗る以上、副作用を1つも起こしてはならない。かつては Post しか抑止して
# おらず、検証のつもりの -Dry が runId を消費しタスクを本当に実行していた
# (2026-09-15 実測: nishi-PC が thermal-guard-rollout-2026-09-14 を消費した)。
function DrySkip($what) { Write-Host "[DRY SKIP] $what" }
$H = $env:USERPROFILE
$repoCandidates = @()
if ($PSScriptRoot) { $repoCandidates += (Split-Path -Parent $PSScriptRoot) }
$repoCandidates += @("$H\orgiast-claude-rules", "$H\Downloads\orgiast-claude-rules")
$repo = @($repoCandidates | Select-Object -Unique) | Where-Object { Test-Path $_ } | Select-Object -First 1

# 自己修復: 既存PCにも fleet-agent の15分タスクを登録し、中央ディレクティブへ応答できるようにする
try {
  if ($repo -and -not (Get-ScheduledTask -TaskName 'OrgiastFleetAgent' -ErrorAction SilentlyContinue)) {
    $fleetAgentInstaller = Join-Path $repo 'tools\register-fleet-agent.ps1'
    if (Test-Path $fleetAgentInstaller) {
      if ($Dry) { DrySkip 'register-fleet-agent.ps1 (OrgiastFleetAgent 未登録のため本番なら登録する)' }
      else { & powershell -NoProfile -ExecutionPolicy Bypass -File $fleetAgentInstaller *> $null }
    }
  }
} catch {}

# 自己修復: 全PCで Claude 環境の Google Drive 日次バックアップを登録する
try {
  if ($repo -and -not (Get-ScheduledTask -TaskName 'ClaudeDailyDriveBackup' -ErrorAction SilentlyContinue)) {
    $backupTaskInstaller = Join-Path $repo 'tools\register-claude-backup-task.ps1'
    if (Test-Path $backupTaskInstaller) {
      if ($Dry) { DrySkip 'register-claude-backup-task.ps1 (ClaudeDailyDriveBackup 未登録のため本番なら登録する)' }
      else {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $backupTaskInstaller *> $null
        if ($LASTEXITCODE -ne 0) { throw "register-claude-backup-task.ps1 exit $LASTEXITCODE" }
      }
    }
  }
} catch {
  try {
    $fleetLogDir = Join-Path $H '.claude\logs'
    if (-not (Test-Path -LiteralPath $fleetLogDir)) { New-Item -ItemType Directory -Path $fleetLogDir -Force | Out-Null }
    $fleetLog = Join-Path $fleetLogDir 'fleet-poller.log'
    $line = '{0} WARN backup-task-self-repair-failed reason={1}' -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK'), ($_.Exception.Message -replace "[\r\n]+", ' ')
    [IO.File]::AppendAllText($fleetLog, $line + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  } catch {}
}

# 自己修復: 熱監視(5分ごと)を全PCで登録する。読み取り専用の監視でCPU設定は変更しないため自動導入してよい。
# 中央キューは task が1枠しかなく、入れ忘れると後続が無言で止まる。実際 thermal-guard は
# 2026-09-01〜09-14 の13日間キューに載らず、全PCで未導入のままだった(#200/#327)。
# キューに依存せず毎日ここで自己修復させることで、枠の取り合いと入れ忘れから切り離す。
# CPU電力上限を変える power-save は挙動が変わるため自動化せず、キュー経由のままにする。
try {
  if ($repo -and -not (Get-ScheduledTask -TaskName 'OrgiastThermalGuard' -ErrorAction SilentlyContinue)) {
    $thermalGuard = Join-Path $repo 'tools\thermal-guard.ps1'
    if (Test-Path $thermalGuard) {
      if ($Dry) { DrySkip 'thermal-guard.ps1 -Install (OrgiastThermalGuard 未登録のため本番なら登録する)' }
      else {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $thermalGuard -Install *> $null
        if ($LASTEXITCODE -ne 0) { throw "thermal-guard.ps1 -Install exit $LASTEXITCODE" }
      }
    }
  }
} catch {
  try {
    $fleetLogDir = Join-Path $H '.claude\logs'
    if (-not (Test-Path -LiteralPath $fleetLogDir)) { New-Item -ItemType Directory -Path $fleetLogDir -Force | Out-Null }
    $fleetLog = Join-Path $fleetLogDir 'fleet-poller.log'
    $line = '{0} WARN thermal-guard-self-repair-failed reason={1}' -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK'), ($_.Exception.Message -replace "[\r\n]+", ' ')
    [IO.File]::AppendAllText($fleetLog, $line + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  } catch {}
}

# 自己修復: 設定ファイルの先頭BOMを除去(BOM付きだとClaude Code/nodeがJSON.parse・env読取に失敗して起動不能になるため。schtask実行なのでClaude Codeが壊れていても直せる)
foreach ($bf in @("$H\.claude\settings.json", "$H\.claude.json", "$H\.gemini\.env", "$H\.claude\cost-reporter.env", "$H\.claude\manus.env", "$H\.claude\deepseek.env", "$H\.claude\xai.env", "$H\.claude\openrouter.env", "$H\.claude\groq.env", "$H\.claude\mistral.env", "$H\.claude\ollama.env")) {
  try { if (Test-Path $bf) { $bc = [System.IO.File]::ReadAllText($bf); if ($bc.Length -gt 0 -and $bc[0] -eq [char]0xFEFF) { if ($Dry) { DrySkip "BOM除去 $bf" } else { [System.IO.File]::WriteAllText($bf, $bc.TrimStart([char]0xFEFF), (New-Object System.Text.UTF8Encoding($false))) } } } } catch {}
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
  if ($Dry) { DrySkip "日次ガード更新 $g" } else { Set-Content -Path $g -Value (Get-Date -Format o) -Encoding UTF8 }
  $out = RunPs (Join-Path $repo 'tools\verify-setup.ps1') @()
  if ($out) {
    $ok = ([regex]::Matches($out, '\[OK \]')).Count
    $ng = ([regex]::Matches($out, '\[NG \]')).Count
    $ngItems = (($out -split "`n") | Where-Object { $_ -match '\[NG \]' } | ForEach-Object { ($_ -replace '.*\[NG \]\s*', '').Trim() }) -join ' / '
    $emoji = if ($ng -eq 0) { [char]0x2705 } else { [char]0x26A0 }
    $tail = ''; if ($ng -gt 0) { $tail = " … NG: $ngItems" }
    Post "$emoji **[$label]** 日次設定チェック: OK $ok / NG $ng$tail"
    # --specs を必ず付ける。付けないとハードウェアスペックを一度も送らず、
    # PC管理表 が「手で叩いた1台」だけの状態から永久に増えない(2026-08-28 実測)。
    try {
      $fleetLogDir = Join-Path $H '.claude\logs'; New-Item -ItemType Directory -Path $fleetLogDir -Force | Out-Null
      $fleetLog = Join-Path $fleetLogDir 'fleet-poller.log'
      $stamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
      if ($Dry) { DrySkip 'fleet-sheet-report.mjs --specs --cloud (PC管理表へ書き込む)' }
      else {
        & node (Join-Path $repo 'tools\fleet-sheet-report.mjs') '--specs' '--cloud' 2>&1 | ForEach-Object { Add-Content -LiteralPath $fleetLog -Value "$stamp $_" -Encoding UTF8 }
        if ($LASTEXITCODE -ne 0) { Add-Content -LiteralPath $fleetLog -Value "$stamp WARN fleet-sheet-report exit=$LASTEXITCODE" -Encoding UTF8 }
      }
    } catch {}
  }
  # 熱の日次サマリ。thermal-guard が未導入(=サンプルが無い)なら何も送らないので、
  # 導入済みのPCだけが1日1回 直近24hの要約を返す。
  try { RunPs (Join-Path $repo 'tools\thermal-guard.ps1') @('-Report') | Out-Null } catch {}
}

# --- B) 中央コマンドキュー(ホワイトリストのみ) ---
$processedCount = 0
$WL = @{
  'verify-setup' = { RunPs (Join-Path $repo 'tools\verify-setup.ps1') @() }
  # リポの .mjs を最優先。凍結コピー(~/.claude/hooks/onboarding-sync.ps1)は install 時に
  # コピーされて以後一度も更新されず、その中身は ONBOARDING.md の raw URL を1本取るだけで
  # tools/ を一切運ばない(2026-09-01 実測: 08-15 版の外部取得は ONBOARDING.md のみ)。
  # つまり中央キューから rules-resync を配っても新しいツールが永久に届かない。
  # fleet-poller.mjs 側には 2026-08-25 に同じ修正が入っているが、
  # スケジュールタスクが実際に実行するのはこの .ps1 なので取り残されていた。
  'rules-resync' = {
    $mjs = Join-Path $repo 'tools\onboarding-sync.mjs'
    if (Test-Path $mjs) { (& node $mjs '--force' 2>&1 | Out-String) }
    else { RunPs (Join-Path $H '.claude\hooks\onboarding-sync.ps1') @('-Force') }
  }
  'cost-report'  = { if (Test-Path (Join-Path $repo 'tools\claude-cost-reporter.mjs')) { (& node (Join-Path $repo 'tools\claude-cost-reporter.mjs') 2>&1 | Out-String) } else { '' } }
  # 熱監視を5分ごとの常駐タスクとして登録する(管理者権限不要)。CPU温度が取れない機体では
  # クロック比の低下と異常停止イベントで代替監視する。
  'thermal-guard' = { RunPs (Join-Path $repo 'tools\thermal-guard.ps1') @('-Install') }
  # CPU電力上限を絞って発熱と電気代を同時に下げる。画面OFFには触らない
  # (物理画面をキャプチャするリモート操作ソフトが黒画面になる事故を避けるため)。
  'power-save'   = { if (Test-Path (Join-Path $repo 'tools\power-save.mjs')) { (& node (Join-Path $repo 'tools\power-save.mjs') '--apply' '--post' 2>&1 | Out-String) } else { '' } }
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
      $processedCount++
      if ($Dry) { DrySkip "runId=$runId の処理済み記録" } else { Add-Content -Path $procF -Value $runId }   # 先に処理済み記録(二重実行防止)
      if ($WL.ContainsKey($task)) {
        if ($Dry) { DrySkip "タスク『$task』の実行 (runId=$runId)"; Post "▶ **[$label]** タスク『$task』を実行する (runId=$runId) ※-Dry のため未実行" }
        else {
          $res = & $WL[$task]
          $sum = ((($res -split "`n") | Where-Object { $_ -match '結果:|OK |NG |完了|エラー|error' } | Select-Object -Last 3) -join ' / ')
          Post "▶ **[$label]** タスク『$task』実行 (runId=$runId): $sum"
        }
      } else {
        Post "⚠ **[$label]** 未許可タスク『$task』は実行しません(ホワイトリスト外)"
      }
    }
  }
} catch {}
$fleetLogDir = Join-Path $H '.claude\logs'
New-Item -ItemType Directory -Path $fleetLogDir -Force | Out-Null
Add-Content -LiteralPath (Join-Path $fleetLogDir 'fleet-poller.log') -Value ((Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK') + " OK poll done processed=$processedCount") -Encoding UTF8
