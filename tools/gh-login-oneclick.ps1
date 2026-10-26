# GitHub 認証を「1回だけ」行い、そのまま溜まっている未pushブランチを着地させる。
# きっかけ: このPCは gh 未インストール・GCM に保存済み資格情報なし・SSH 鍵なしで、
#   git push が資格情報プロンプトでハングし、未pushブランチが main に着地しない状態が続いていた。
#   資格情報の取得だけは GitHub アカウントの持ち主（kim）の同意が必須＝他の全工程はここで自動化する。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# 実行ログを残す。このPCは無人セッションが後から結果を確認する必要があるため、
# 黒い画面を閉じても何が起きたか分かるようにする（トークンは出力しない）。
$logFile = Join-Path $env:USERPROFILE '.claude\gh-login-oneclick.log'
try { Start-Transcript -LiteralPath $logFile -Append -Force | Out-Null } catch { }

$gcm = 'C:\Program Files\Git\mingw64\bin\git-credential-manager.exe'
if (-not (Test-Path $gcm)) { Write-Host "NG: Git Credential Manager が見つかりません ($gcm)"; exit 1 }

# 着地させる対象。1行 = <repo パス>|<ブランチ名>。空行と # 始まりは無視。
$queueFile = Join-Path $env:USERPROFILE '.claude\github-landing-queue.txt'
# 認証の検証に使うリポジトリ（push が実際に通るかを確かめる）。
# このPC専用パスを書かない: キュー先頭のリポジトリ → 既知の候補 の順に、実在するものを使う。
$probeCandidates = @()
if (Test-Path $queueFile) {
  $probeCandidates += Get-Content -LiteralPath $queueFile -Encoding UTF8 |
    Where-Object { $_.Trim() -ne '' -and -not $_.Trim().StartsWith('#') } |
    ForEach-Object { ($_.Split('|')[0]).Trim() }
}
$probeCandidates += @(
  (Join-Path $env:USERPROFILE '.claude\nightly-repo'),
  (Join-Path $env:USERPROFILE 'orgiast-claude-rules')
)
$probeRepo = $probeCandidates | Where-Object { $_ -and (Test-Path (Join-Path $_ '.git')) } | Select-Object -First 1

Write-Host '=== GitHub の認証を1回だけ行います ==='
Write-Host 'ブラウザが開いたら GitHub にサインインし、画面に出たコードを貼り付けてください。'
Write-Host '（ブラウザが開かない場合は、黒い画面に出ている https://github.com/login/device を自分で開く）'
Write-Host ''

# --- STEP 1: 認証（デバイスフロー。ブラウザ GUI に依存せずコンソールにコードを出す） ---
& $gcm github login --device
if ($LASTEXITCODE -ne 0) { Write-Host "NG: 認証に失敗しました (exit $LASTEXITCODE)"; exit $LASTEXITCODE }

# ハング防止: 以降の git は資格情報が無ければプロンプトせず即失敗させる。
# ※ GIT_TERMINAL_PROMPT=0 だけでは GCM の GUI プロンプトが開いて push が固まる（実測: 45秒タイムアウト）。
#   credential.interactive=false / guiPrompt=false を併用すると 1秒未満で失敗する（実測 exit=128）。
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'never'
$gitNoPrompt = @('-c', 'credential.interactive=false', '-c', 'credential.guiPrompt=false')

# --- STEP 2: 資格情報が保存されたか（保存先から読み戻して確認） ---
$probe = "protocol=https`nhost=github.com`n`n" | & $gcm get
# ⚠ $probe は「行の配列」。配列に -notmatch を使うと「一致しなかった行」が返るため、
#   資格情報が正しく保存されていても常に truthy になり NG 終了する（2026-10-18 実測）。
$probeLine = $probe | Where-Object { $_ -match '^password=' } | Select-Object -First 1
if (-not $probeLine) { Write-Host 'NG: 認証情報が保存されませんでした'; exit 1 }
Write-Host 'OK: 認証情報を Windows 資格情報マネージャーに保存しました。'

# --- STEP 3: 「push が本当に通るか」を実物で検証（読み取りでは公開リポジトリのため通ってしまう） ---
Write-Host ''
if (-not $probeRepo) {
  Write-Host "NG: push 疎通の検証に使えるリポジトリが見つかりません (候補: $($probeCandidates -join ', '))"
  exit 1
}
Write-Host "--- push の実疎通を確認中 ($probeRepo) ---"
# HEAD をそのまま push すると、ローカルが origin/main より遅れているだけで
# 非fast-forward になり「認証は通っているのに NG」になる。毎回ユニークな一時ブランチ名へ
# --dry-run するので、リモートを汚さずローカル状態にも依存しない。
$probeBranch = '__auth-probe-' + [guid]::NewGuid().ToString('N')
& git @gitNoPrompt -C $probeRepo push --dry-run origin "HEAD:refs/heads/$probeBranch" 2>&1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
  Write-Host "NG: push の疎通に失敗しました (exit $LASTEXITCODE)。上のメッセージを確認してください。"
  exit $LASTEXITCODE
}
Write-Host 'OK: 以降、このPCからの git push は人の操作なしで通ります。'

# --- STEP 4: 溜まっている未pushブランチを push して PR（automerge 付き）まで作る ---
if (-not (Test-Path $queueFile)) {
  Write-Host ''
  Write-Host "着地待ちの一覧が無いため、push だけ済ませて終了します: $queueFile"
  exit 0
}

$token = ($probeLine -replace '^password=', '').Trim()
if (-not $token) { Write-Host 'NG: トークンを取り出せませんでした'; exit 1 }

$lines = @(Get-Content -LiteralPath $queueFile -Encoding UTF8 |
  Where-Object { $_.Trim() -ne '' -and -not $_.Trim().StartsWith('#') })

# --- STEP 4a: 一覧に書き忘れた未push枝を自動で拾う ---
# 2026-10-22 追加。枝を作ったセッションが一覧への追記を忘れると、その成果は永久に着地しない
# （実例: auto/20261022-kimi-billing-lane は作成済みなのに一覧に無かった）。
# 誤爆を避けるため「前回このスクリプトを実行した時刻より新しい枝」だけを対象にする。
# 初回（状態ファイルが無い）は何も拾わず、基準時刻を置くだけ。過去の放棄枝を一斉に push しない。
$stateFile = Join-Path $env:USERPROFILE '.claude\gh-login-oneclick.state.json'
$runStartedUnix = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$discoverRoots = @(
  (Join-Path $env:USERPROFILE '.claude\auto-session-repo'),
  (Join-Path $env:USERPROFILE '.claude\nightly-repo')
)
$worktreeRoot = Join-Path $env:USERPROFILE '.claude\auto-session'
if (Test-Path $worktreeRoot) {
  $discoverRoots += @(Get-ChildItem -LiteralPath $worktreeRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName '.git') } | ForEach-Object { $_.FullName })
}

$sinceUnix = 0L
if (Test-Path $stateFile) {
  try {
    $state = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $sinceUnix = [int64]$state.lastRunUnix
  } catch { $sinceUnix = 0L }
}
$seenBranch = @{}
foreach ($l in $lines) {
  $p = "$l".Split('|')
  if ($p.Count -ge 2) { $seenBranch[$p[1].Trim()] = $true }
}
if ($sinceUnix -le 0) {
  Write-Host 'INFO: 初回のため一覧に無い枝の自動追加は行いません（基準時刻だけ記録します）。'
} else {
  foreach ($root in $discoverRoots) {
    if (-not (Test-Path (Join-Path $root '.git'))) { continue }
    $localRefs = @(& git -C $root for-each-ref refs/heads/auto --format='%(refname:short)|%(committerdate:unix)' 2>$null)
    if ($LASTEXITCODE -ne 0 -or $localRefs.Count -eq 0) { continue }
    $remoteRefs = @(& git @gitNoPrompt -C $root ls-remote --heads origin 'refs/heads/auto/*' 2>$null)
    $remoteSet = @{}
    foreach ($r in $remoteRefs) { if ("$r" -match 'refs/heads/(.+)$') { $remoteSet[$matches[1]] = $true } }
    foreach ($ref in $localRefs) {
      $parts2 = "$ref".Split('|')
      if ($parts2.Count -lt 2) { continue }
      $b = $parts2[0].Trim(); $t = [int64]$parts2[1]
      if (-not $b -or $t -le $sinceUnix) { continue }
      if ($seenBranch.ContainsKey($b) -or $remoteSet.ContainsKey($b)) { continue }
      & git -C $root diff --quiet "origin/main..$b" 2>$null
      if ($LASTEXITCODE -eq 0) { continue }   # main と同じ内容＝着地させるものが無い
      $lines += "$root|$b"
      $seenBranch[$b] = $true
      Write-Host "INFO: 一覧に無い新しい枝を自動で追加: $b ($root)"
    }
  }
}

$done = 0; $failed = 0
foreach ($line in $lines) {
  $parts = $line.Split('|')
  if ($parts.Count -lt 2) { Write-Host "SKIP (書式不正): $line"; continue }
  $repo = $parts[0].Trim(); $branch = $parts[1].Trim()
  Write-Host ''
  Write-Host "--- $branch ---"

  $url = (& git -C $repo remote get-url origin 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $url) { Write-Host "FAIL: origin を取得できません ($repo)"; $failed++; continue }
  $slug = ($url -replace '^.*github\.com[:/]', '') -replace '\.git$', ''

  $headers = @{ Authorization = "Bearer $token"; 'User-Agent' = 'orgiast-oneclick' }

  # 同じ枝名の open PR が既にあるなら push も PR 作成もしない（内容が同一 tree のときだけ skip）。
  # ただし fork 由来の PR（head.repo が base と別）は auto-merge.yml の eligible=false で永久に着地しない。
  # その場合は同じ内容を origin 枝として push し直し、same-repo PR として自動着地させる。
  $existingPr = $null
  $forkPr = $null
  try {
    $openPrs = Invoke-RestMethod -Method Get -Uri "https://api.github.com/repos/$slug/pulls?state=open&per_page=100" -Headers $headers
    $existingPr = $openPrs | Where-Object { $_.head.ref -eq $branch -and $_.head.repo.full_name -eq $slug } | Select-Object -First 1
    # fork 由来の同名 PR（head が base と別リポジトリ）。auto-merge.yml の eligible=false で
    # 自動着地しないため、同内容を origin 枝として push し直して same-repo PR を作る。
    # fork 側は閉じない（別セッションの作業状態を壊さない）。URL を出して人が判断できるようにする。
    $forkPr = $openPrs | Where-Object { $_.head.ref -eq $branch -and $_.head.repo -and $_.head.repo.full_name -ne $slug } | Select-Object -First 1
  } catch {
    Write-Host "WARN: 既存PRの照会に失敗しました（重複判定なしで続行）: $($_.ErrorDetails.Message)"
  }
  if ($forkPr) {
    Write-Host "INFO: 同名の fork PR #$($forkPr.number) が open です（自動着地の対象外）: $($forkPr.html_url)"
    Write-Host '      → 同じ内容を origin 枝として push し、same-repo PR を作ります。fork 側は閉じません。'
  }
  if ($existingPr) {
    $sameTree = $false
    & git -C $repo fetch --quiet origin "refs/pull/$($existingPr.number)/head" 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
      $localTree = (& git -C $repo rev-parse "$branch^{tree}").Trim()
      $remoteTree = (& git -C $repo rev-parse 'FETCH_HEAD^{tree}').Trim()
      if ($localTree -eq $remoteTree) { $sameTree = $true }
    }
    if ($sameTree) {
      Write-Host "SKIP: 同内容の open PR #$($existingPr.number) が既にあります（重複PRを作らないため push しません）: $($existingPr.html_url)"
      try {
        Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$slug/issues/$($existingPr.number)/labels" -Headers $headers -ContentType 'application/json' -Body (@{ labels = @('automerge') } | ConvertTo-Json -Compress) | Out-Null
        Write-Host 'OK: 既存PRへ automerge ラベルを付与しました。'
      } catch {
        Write-Host "WARN: 既存PRに automerge ラベルを付けられませんでした（権限不足の可能性）: $($_.ErrorDetails.Message)"
      }
      $done++
      continue
    }
    Write-Host "WARN: 同じ枝名の open PR #$($existingPr.number) がありますが内容が異なるため、通常どおり push します。"
  }

  & git @gitNoPrompt -C $repo push -u origin $branch 2>&1 | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE -ne 0) { Write-Host "FAIL: push できません ($branch)"; $failed++; continue }

  $body = @{ title = $branch; head = $branch; base = 'main'; body = '自動セッションの成果物。CI が緑になれば automerge でマージされます。' } | ConvertTo-Json -Compress
  $pr = $null
  try {
    $pr = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$slug/pulls" -Headers $headers -ContentType 'application/json' -Body $body
    Write-Host "OK: PR #$($pr.number) $($pr.html_url)"
    $done++
  } catch {
    $msg = $_.ErrorDetails.Message
    if ($msg -match 'A pull request already exists') {
      Write-Host 'OK: PR は既に存在します（push 済み）'
      $done++
    } else {
      Write-Host "FAIL: PR 作成に失敗 ($branch): $msg"
      $failed++
      continue
    }
  }
  # ラベル付与は PR 作成の成否と切り離す（ラベルが無いだけで「失敗」に数えない）。
  if ($pr) {
    try {
      Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$slug/issues/$($pr.number)/labels" -Headers $headers -ContentType 'application/json' -Body (@{ labels = @('automerge') } | ConvertTo-Json -Compress) | Out-Null
      Write-Host 'OK: automerge ラベルを付与しました。'
    } catch {
      Write-Host "WARN: automerge ラベルを付けられませんでした（PR は作成済み）: $($_.ErrorDetails.Message)"
    }
  }
}

Write-Host ''
Write-Host "完了: 着地=$done / 失敗=$failed"
# 次回の自動追加の基準時刻。実行開始時刻を書く（実行中に作られた枝を取りこぼさない）。
try {
  @{ lastRunUnix = $runStartedUnix; lastRunAt = [DateTimeOffset]::FromUnixTimeSeconds($runStartedUnix).ToString('o') } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $stateFile -Encoding UTF8
} catch {
  Write-Host "WARN: 状態ファイルを書けませんでした（次回も自動追加は行われません）: $($_.Exception.Message)"
}
if ($failed -gt 0) { exit 1 }
exit 0
