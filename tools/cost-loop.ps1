# cost-loop.ps1 — SessionStartフック: コスト×作業量ループの結果を毎セッション"監督(私)"に注入し、
# 委譲(安いAIへ逃がす)が実際に効いているかを常に意識させ自己修正させる(kim 2026-08-16)。
# 計測本体(cost-work-loop.mjs)は1日1回だけ裏で実行(session起動を遅らせない)。注入は毎回(前回結果)。
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'SilentlyContinue'
$H = $env:USERPROFILE
# リポの場所はPCで異なる(配布先=~/orgiast-claude-rules / kim開発機=~/Downloads/orgiast-claude-rules)。候補を探索。
$loop = $null
foreach ($c in @((Join-Path $H 'orgiast-claude-rules\tools\cost-work-loop.mjs'), (Join-Path $H 'Downloads\orgiast-claude-rules\tools\cost-work-loop.mjs'))) { if (Test-Path $c) { $loop = $c; break } }
$guard = Join-Path $H '.claude\.cost-loop-guard'
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
  $out = @{ hookSpecificOutput = @{ hookEventName = 'SessionStart'; additionalContext = $ctx } } | ConvertTo-Json -Depth 6 -Compress
  Write-Output $out
}
