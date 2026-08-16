# session-triage-hook.ps1 — SessionStartフック: 放置された未完了セッションを1日1回、応答の冒頭に提示させる。
# 重いトリアージ生成は裏で起動し、セッション起動をブロックしない。
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'SilentlyContinue'
$H = $env:USERPROFILE

# 1日1回だけ提示。並行SessionStartでも、最初に書いたセッション以外は即終了する。
$guard = Join-Path $H '.claude\.session-triage-shown'
if (Test-Path $guard) {
  if (((Get-Date) - (Get-Item $guard).LastWriteTime) -lt [TimeSpan]::FromHours(20)) { return }
}

# リポの場所はPCで異なるため2候補から探索。
$triage = $null
foreach ($c in @((Join-Path $H 'orgiast-claude-rules\tools\session-triage.mjs'), (Join-Path $H 'Downloads\orgiast-claude-rules\tools\session-triage.mjs'))) {
  if (Test-Path $c) { $triage = $c; break }
}
$md = Join-Path $H '.claude\session-triage.md'
$hasPrevious = Test-Path $md
$stale = -not $hasPrevious
if ($hasPrevious) { $stale = ((Get-Date) - (Get-Item $md).LastWriteTime) -ge [TimeSpan]::FromHours(24) }

# 作り置きが無い/古い場合は裏で更新。古い内容はこの回の提示には使う。
if ($stale -and $triage) {
  try { Start-Process -FilePath 'node' -ArgumentList @($triage, '--llm', '--top', '20', '--md', $md) -WindowStyle Hidden | Out-Null } catch {}
}
if (-not $hasPrevious) { return }

# 並行SessionStartの二重提示を防ぐため、内容を出力する前にガードを書く。
Set-Content -LiteralPath $guard -Value (Get-Date -Format o) -Encoding UTF8

$txt = Get-Content -LiteralPath $md -Raw -Encoding UTF8
$items = @()
foreach ($line in ($txt -split "`r?`n")) {
  if ($items.Count -ge 5) { break }
  if ($line -notmatch '^\s*\|\s*🔴\s+要対応\s*\|') { continue }
  $cols = @($line -split '(?<!\\)\|' | ForEach-Object { $_.Trim().Replace('\|', '|') })
  if ($cols.Count -lt 10) { continue }
  $rawTitle = $cols[3]
  $title = $rawTitle
  if ($title.Length -gt 40) { $title = $title.Substring(0, 39) + '…' }
  $updated = $cols[4]
  $sessionCwd = $cols[5]
  $next = $cols[7]
  $resume = $cols[8].Trim('`')
  # VSCodeサイドバーの検索はセッション名(=最初のプロンプト原文)にしか当たらない。
  # 言い換えた見出しを渡すと「見つからない」になるため、原文の先頭を検索語として必ず添える。
  $searchKey = $rawTitle
  if ($searchKey.Length -gt 14) { $searchKey = $searchKey.Substring(0, 14) }
  $items += "🔴 [$updated] $title — $next / 検索語「$searchKey」 / $resume / cwd: $sessionCwd"
}

$generated = ''
if ($txt -match '生成時刻\s+([^\s]+)') { $generated = $Matches[1] }
if (-not $generated) { $generated = (Get-Item $md).LastWriteTime.ToString('o') }
$previousNote = if ($stale) { '※前回生成分' } else { '' }
$body = if ($items.Count) { $items -join "`n" } else { '積み残しなし' }
$ctx = "【積み残しセッション｜必ずこの応答の冒頭でユーザーに提示すること】`n下記は放置されている未完了セッション。ユーザーはこれを見るために何も操作していないので、`n今回のユーザー依頼に答える前に、まず1行/件の簡潔な箇条書きで提示し、`n「どれか再開しますか？」と一言添える。長い引用や解説は不要。`n`n【提示の絶対ルール】`n・タイトルは原文のまま出す。要約・言い換え・略称にしない(例:「内藤さんの会議の続き」を「内藤さんMTG」と書き換えない)。`n  VSCodeサイドバーの検索はセッション名の原文にしか当たらず、言い換えると「検索しても出てこない」になる。`n・各件に『検索語』をコードブロックかバッククォートでそのまま貼れる形で必ず添える。`n・cwd が現在のワークスペースと違う件は「別ワークスペース(<cwd>)なのでこの一覧には出ない」と明記する。`n`n$body`n`n※詳細は /session-triage。$previousNote 生成: $generated"

$out = @{ hookSpecificOutput = @{ hookEventName = 'SessionStart'; additionalContext = $ctx } } | ConvertTo-Json -Depth 6 -Compress
Write-Output $out
