# Claude 利用コスト監査 (純PowerShell / LLMトークン不使用)
# ローカルの Claude Code 記録 (~/.claude/projects/**/*.jsonl) を解析し、
# 「開発(cwd)別に どのモデルで 何トークン 推定いくら」+ 設定監査 を算出する。
#
# ── データの扱い（透明性・重要）───────────────────────────
# ● 送信するのは【集計値のみ】:
#     cwdフォルダ名 / モデル別トークン数 / 推定$ / 設定値(effort・既定model・hooks数・CLAUDE.md行数) / Fable5使用有無
# ● 【送信しないもの】: 会話本文・コード・認証情報・顧客/社内データ・.jsonl本文は
#     読み出して送信することは一切ない（トークン“数”だけ数える。中身は送らない）。
# ● 送信先: -Webhook で明示した URL のみ。既定は空＝どこにも送らない。
# ● まず必ず -DryRun で「送信される内容そのもの」を画面確認できる。全行レビュー可(約140行)。
#   → 盲目実行しないこと。中身を読み、-DryRun で確認し、送信先が社内正規か確かめてから使う。
# ─────────────────────────────────────────────────────
#
#   pwsh -File audit.ps1 -DryRun                 # 送信せず画面表示のみ(まずこれで中身確認)
#   pwsh -File audit.ps1 -Webhook "<社内URL>"    # 集計値を指定先へ送信
#
# 推定$は Anthropic API 定価換算の「目安」(サブスク実額とは別)。開発間の比較用。

param(
  [switch]$DryRun,
  [int]$Days = 30,          # 直近N日で集計 (0=全期間)
  [string]$Webhook = "",    # 投稿先 (公開リポに置くため既定は空。実行時に -Webhook で渡す)
  [string]$Label = "",
  [int]$IntervalHours = 0,  # >0 なら前回投稿からこの時間内は何もせず終了 (フック常駐用スロットル)
  [switch]$Quiet            # 画面出力を抑制 (フック常駐用)
)

$ErrorActionPreference = 'Stop'
$claude   = Join-Path $env:USERPROFILE '.claude'
$projects = Join-Path $claude 'projects'
$heartbeat = Join-Path $claude 'cost-monitor-last.txt'

# --- 間隔スロットル (定期監視フック用) ---
if ($IntervalHours -gt 0 -and (Test-Path $heartbeat)) {
  try {
    $last = [datetime](Get-Content $heartbeat -Raw).Trim()
    if (((Get-Date) - $last).TotalHours -lt $IntervalHours) {
      if (-not $Quiet) { Write-Output "throttled: 前回から $([math]::Round(((Get-Date)-$last).TotalHours,1))h (間隔 ${IntervalHours}h 未満) — skip" }
      return
    }
  } catch {}
}

# pricing USD / 1M tokens : in, out (cache_read=in*0.10, cache_creation=in*1.25)
$P = @{
  opus   = @{ i = 5.0;  o = 25.0 }
  sonnet = @{ i = 3.0;  o = 15.0 }
  haiku  = @{ i = 1.0;  o = 5.0  }
  fable  = @{ i = 10.0; o = 50.0 }
  other  = @{ i = 3.0;  o = 15.0 }
}
function ModelClass($m) {
  if (-not $m) { return 'other' }
  if ($m -match 'opus') { 'opus' }
  elseif ($m -match 'sonnet') { 'sonnet' }
  elseif ($m -match 'haiku') { 'haiku' }
  elseif ($m -match 'fable|mythos') { 'fable' }
  else { 'other' }
}

$byCwd = @{}
$grand = 0.0
$fableCost = 0.0
$cutoff = if ($Days -gt 0) { (Get-Date).AddDays(-$Days) } else { $null }

if (Test-Path $projects) {
  foreach ($d in Get-ChildItem $projects -Directory) {
    $lastCwd = $d.Name
    foreach ($f in (Get-ChildItem $d.FullName -Filter *.jsonl -ErrorAction SilentlyContinue)) {
      foreach ($line in [System.IO.File]::ReadLines($f.FullName)) {
        if ($line -notmatch '"usage"') { continue }
        if ($cutoff -and ($line -match '"timestamp":"([^"]+)"')) {
          try { if ([datetime]$Matches[1] -lt $cutoff) { continue } } catch {}
        }
        if ($line -match '"cwd":"([^"]+)"') { $lastCwd = ($Matches[1] -replace '\\\\', '\') }
        $key = $lastCwd
        $m = if ($line -match '"model":"(claude-[^"]+)"') { $Matches[1] } else { '' }
        $cls = ModelClass $m
        $i  = if ($line -match '"input_tokens":(\d+)') { [long]$Matches[1] } else { 0 }
        $o  = if ($line -match '"output_tokens":(\d+)') { [long]$Matches[1] } else { 0 }
        $cc = if ($line -match '"cache_creation_input_tokens":(\d+)') { [long]$Matches[1] } else { 0 }
        $cr = if ($line -match '"cache_read_input_tokens":(\d+)') { [long]$Matches[1] } else { 0 }
        $pr = $P[$cls]
        $c = ($i * $pr.i + $cc * $pr.i * 1.25 + $cr * $pr.i * 0.10 + $o * $pr.o) / 1e6
        if (-not $byCwd.ContainsKey($key)) { $byCwd[$key] = @{ cost = 0.0; tok = 0; models = @{} } }
        $b = $byCwd[$key]
        $b.cost += $c; $b.tok += ($i + $o + $cc + $cr)
        if ($m) { $b.models[$cls] = $true }
        $grand += $c
        if ($cls -eq 'fable') { $fableCost += $c }
      }
    }
  }
}

$rows = foreach ($k in $byCwd.Keys) {
  $b = $byCwd[$k]
  $short = (($k -split '[\\/]' | Where-Object { $_ }) | Select-Object -Last 2) -join '\'
  [pscustomobject]@{
    Project = $short
    Cost    = $b.cost
    Models  = (($b.models.Keys | Sort-Object) -join '+')
  }
}
$rows = @($rows | Sort-Object Cost -Descending)

# --- 設定監査 ---
$effort = '未設定'; $defModel = '未設定(=Opus常用)'; $hooks = 0
$sf = Join-Path $claude 'settings.json'
if (Test-Path $sf) {
  try {
    $s = Get-Content $sf -Raw | ConvertFrom-Json
    if ($s.effortLevel) { $effort = $s.effortLevel }
    if ($s.model) { $defModel = $s.model }
    if ($s.hooks) { $s.hooks.PSObject.Properties | ForEach-Object { $hooks += ($_.Value | Measure-Object).Count } }
  } catch {}
} else { $effort = '(settings.jsonなし)'; $defModel = '-' }

$cmLines = 0; $cmKB = 0
$cf = Join-Path $claude 'CLAUDE.md'
if (Test-Path $cf) {
  $cmLines = (Get-Content $cf).Count
  $cmKB = [math]::Round((Get-Item $cf).Length / 1KB)
}

# --- 利用者ラベル ---
$name = $Label
if (-not $name) { try { $name = (git config user.email 2>$null) } catch {} }
if (-not $name) { $name = "$env:USERNAME@$env:COMPUTERNAME" }

# --- レポート組み立て ---
$sb = New-Object System.Text.StringBuilder
$win = if ($Days -gt 0) { "直近${Days}日" } else { "全期間" }
[void]$sb.AppendLine("**💻 Claude利用監査: $name** ($win)")
[void]$sb.AppendLine("推定合計(ローカルCLI): **`$$([math]::Round($grand,2))** ※API定価換算の目安・比較用")
[void]$sb.AppendLine("設定: effort=**$effort** / 既定model=**$defModel** / CLAUDE.md=**${cmLines}行/${cmKB}KB** / hooks=$hooks")
if ($fableCost -gt 0) { [void]$sb.AppendLine("⚠️ Fable5使用 推定`$$([math]::Round($fableCost,2)) (§1.16 全面禁止)") }
[void]$sb.AppendLine("__開発別 推定コスト TOP8__")
$n = 0
foreach ($r in $rows) {
  if ($n -ge 8) { break }
  [void]$sb.AppendLine("- $($r.Project): `$$([math]::Round($r.Cost,2)) [$($r.Models)]")
  $n++
}
$flags = @()
if ($effort -eq 'xhigh') { $flags += 'effort=xhigh→high' }
if ($defModel -match '未設定') { $flags += '既定model→sonnet' }
if ($cmLines -gt 200) { $flags += "CLAUDE.md圧縮(${cmLines}行)" }
if ($fableCost -gt 0) { $flags += 'Fable5停止' }
if ($flags.Count) { [void]$sb.AppendLine("__要改善__: " + ($flags -join ' / ')) }

$report = $sb.ToString().TrimEnd()
if (-not $Quiet) { Write-Output $report }

if (-not $DryRun) {
  if (-not $Webhook) { throw "投稿先 -Webhook '<URL>' が未指定です（-DryRun なら表示のみ）。" }
  $payload = @{ content = $report } | ConvertTo-Json -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  Invoke-RestMethod -Uri $Webhook -Method Post -ContentType 'application/json; charset=utf-8' -Body $bytes | Out-Null
  (Get-Date).ToString('o') | Set-Content $heartbeat -Encoding UTF8
  if (-not $Quiet) { Write-Output ""; Write-Output "(Discord #claude-code に投稿しました)" }
}
