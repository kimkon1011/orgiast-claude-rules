# cost-loop.ps1 — SessionStartフック: コスト×作業量ループの結果を毎セッション"監督(私)"に注入し、
# 委譲(安いAIへ逃がす)が実際に効いているかを常に意識させ自己修正させる(kim 2026-08-16)。
# 計測本体(cost-work-loop.mjs)は1日1回だけ裏で実行(session起動を遅らせない)。注入は毎回(前回結果)。
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'SilentlyContinue'
$H = $env:USERPROFILE
# リポの場所はPCで異なる(配布先=~/orgiast-claude-rules / kim開発機=~/Downloads/orgiast-claude-rules)。候補を探索。
$loop = $null
$loopCandidates = @()
if ($PSScriptRoot) { $loopCandidates += (Join-Path (Split-Path -Parent $PSScriptRoot) 'tools\cost-work-loop.mjs') }
$loopCandidates += @((Join-Path $H 'orgiast-claude-rules\tools\cost-work-loop.mjs'), (Join-Path $H 'Downloads\orgiast-claude-rules\tools\cost-work-loop.mjs'))
foreach ($c in @($loopCandidates | Select-Object -Unique)) { if (Test-Path $c) { $loop = $c; break } }
$guard = Join-Path $H '.claude\.cost-loop-guard'
# 夜間バッチ: いま off-peak(UTC16:30-00:30) かつ pendingキューが有れば裏で消化(スケジューラ不要の best-effort ・50%off帯)
try {
  $u = (Get-Date).ToUniversalTime(); $mins = $u.Hour * 60 + $u.Minute
  $offpeak = ($mins -ge 990 -or $mins -lt 30)
  $pend = Join-Path $H '.claude\batch-queue\pending.jsonl'
  $nb = $null
  $batchCandidates = @()
  if ($PSScriptRoot) { $batchCandidates += (Join-Path (Split-Path -Parent $PSScriptRoot) 'tools\batch-run.mjs') }
  $batchCandidates += @((Join-Path $H 'orgiast-claude-rules\tools\batch-run.mjs'), (Join-Path $H 'Downloads\orgiast-claude-rules\tools\batch-run.mjs'))
  foreach ($c in @($batchCandidates | Select-Object -Unique)) { if (Test-Path $c) { $nb = $c; break } }
  if ($offpeak -and $nb -and (Test-Path $pend) -and ((Get-Item $pend).Length -gt 0)) { Start-Process -FilePath 'node' -ArgumentList @($nb) -WindowStyle Hidden | Out-Null }
} catch {}
# 1日1回だけ計測。ガードは実行前に先に書く(並行SessionStartの二重起動防止)。
$due = $true
if (Test-Path $guard) { if (((Get-Date) - (Get-Item $guard).LastWriteTime) -lt [TimeSpan]::FromHours(20)) { $due = $false } }
if ($due -and (Test-Path $loop)) {
  Set-Content -Path $guard -Value (Get-Date -Format o) -Encoding UTF8
  # 裏で計測+Discord日次送信(session起動をブロックしない)
  try { Start-Process -FilePath 'node' -ArgumentList @($loop, '--days=7', '--post') -WindowStyle Hidden | Out-Null } catch {}
}
# 前回の指示書を毎回コンテキストへ注入(監督が見て委譲を修正する)
$dir = Join-Path $H '.claude\cost-directive.md'
if (Test-Path $dir) {
  $txt = Get-Content $dir -Raw
  $ctx = "【コスト×作業量ループ｜監督への自己指示】前回計測の結果は下記。委譲率が低い/コスト効率が悪化している時は、作業前に必ず: 実装→Codex(定額) / 量産・分類→Groq / 汎用の安い推論→OpenRouter / 長文脈→Gemini / 別課金へ逃がす→Kimi、へ回す。監督(Opus)は最小限にとどめ大きな実装を抱えない(§1.18)。`n`n$txt"
  # 夜間バッチ: 未読の結果と保留件数を監督に見せる (結果が results-*.jsonl に埋もれて誰も読まないのを防ぐ)
  try {
    $bq = Join-Path $H '.claude\batch-queue'
    $seenFile = Join-Path $H '.claude\.batch-results-seen'
    if (Test-Path $seenFile) { $since = (Get-Item $seenFile).LastWriteTime } else { $since = (Get-Date).AddDays(-2) }
    $newRes = @()
    if (Test-Path $bq) {
      foreach ($f in (Get-ChildItem -Path $bq -Filter 'results-*.jsonl' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $since })) {
        foreach ($l in (Get-Content $f.FullName -ErrorAction SilentlyContinue)) {
          if (-not $l -or -not $l.Trim()) { continue }
          try {
            $j = $l | ConvertFrom-Json
            $t = [string]$j.text -replace '\s+', ' '
            if ($t.Length -gt 90) { $t = $t.Substring(0, 90) + '…' }
            $newRes += ("  - {0} [{1}:{2}] {3}" -f $j.id, $j.provider, $j.model, $t)
          } catch {}
        }
      }
    }
    $pendCount = 0
    $pf = Join-Path $bq 'pending.jsonl'
    if (Test-Path $pf) { $pendCount = @((Get-Content $pf -ErrorAction SilentlyContinue) | Where-Object { $_.Trim() }).Count }
    $nb = @()
    if ($newRes.Count -gt 0) {
      $nb += ('🌙 夜間バッチの新しい結果 ' + $newRes.Count + ' 件(まだ依頼主へ報告していない)。内容を確認して報告するか、続きの作業に使うこと:')
      $nb += $newRes
      $nb += ('  全文: ' + $bq + '\results-<日付>.jsonl')
    }
    if ($pendCount -gt 0) {
      $nb += ('🌙 夜間バッチ保留 ' + $pendCount + ' 件。次回 03:00(JST) に半額で自動実行される。今すぐ要るなら node tools/batch-run.mjs --force')
    }
    if ($nb.Count -gt 0) { $ctx = $ctx + "`n`n" + ($nb -join "`n") }
    if ($newRes.Count -gt 0) { Set-Content -Path $seenFile -Value (Get-Date -Format o) -Encoding UTF8 }
  } catch {}
  $out = @{ hookSpecificOutput = @{ hookEventName = 'SessionStart'; additionalContext = $ctx } } | ConvertTo-Json -Depth 6 -Compress
  Write-Output $out
}
