# GitHub / Google / Vercel / Codex / Cursor を1つの画面で順番にログインする。
$ErrorActionPreference = 'Continue'
$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
function Say($m, $c = 'White') { Write-Host $m -ForegroundColor $c }
function Title($m) { Say "`n■ $m" 'Cyan' }
function Have($name) { $null -ne (Get-Command $name -ErrorAction SilentlyContinue) }
# 導入直後でも gh/codex を見つけられるよう PATH を読み直す。
$env:Path = (@([Environment]::GetEnvironmentVariable('Path','Machine'), [Environment]::GetEnvironmentVariable('Path','User'), 'C:\Program Files\GitHub CLI', (Join-Path $env:APPDATA 'npm'), (Join-Path $env:LOCALAPPDATA 'cursor-agent')) | Where-Object { $_ }) -join ';'

$account = 'seisaku-team@orgiast.jp'
$homeDir = $env:USERPROFILE
$results = [ordered]@{}

function Test-GitHubLogin {
  if (-not (Have 'gh')) { return $false }
  & gh auth status --hostname github.com *> $null
  return $LASTEXITCODE -eq 0
}
function Test-ClaspLogin { return Test-Path (Join-Path $homeDir '.clasprc.json') }
function Test-VercelLogin {
  if (-not (Have 'npx')) { return $false }
  & npx.cmd -y vercel whoami *> $null
  return $LASTEXITCODE -eq 0
}
function Test-CodexLogin {
  $file = Join-Path $homeDir '.codex\auth.json'
  if (-not (Test-Path $file)) { return $false }
  try { return [bool]((Get-Content $file -Raw | ConvertFrom-Json).tokens.id_token) } catch { return $false }
}
function Test-CursorLogin {
  if ($env:CURSOR_API_KEY) { return $true }
  foreach ($rel in @('.cursor\cli-config.json', '.cursor\auth.json')) {
    if (Test-Path (Join-Path $homeDir $rel)) { return $true }
  }
  if (Have 'agent') {
    & agent status *> $null
    return $LASTEXITCODE -eq 0
  }
  return $false
}
function Show-LoopbackNotice {
  Say "Windows Defender ファイアウォールの警告は『キャンセル』で構いません。PC内の localhost 通信だけなので許可不要です。" 'Yellow'
}

Say "5サービスを $account でログインします。済みのものは自動で飛ばします。" 'Green'

Title '1/5 GitHub'
if (Test-GitHubLogin) { Say 'ログイン済みのためスキップします。' 'Green' }
elseif (-not (Have 'gh')) { Say 'gh が見つかりません。インストーラをもう一度実行してください。' 'Red' }
else {
  Say '1. 「Authenticate Git with your GitHub credentials? (Y/n)」は Enter。'
  Say '2. コードが表示されたら Enter。'
  Say '3. ブラウザで Ctrl+V → Continue → Authorize GitHub CLI。'
  & gh auth login --hostname github.com --git-protocol https --web --clipboard
}
$results.GitHub = Test-GitHubLogin

Title '2/5 Google (clasp)'
if (Test-ClaspLogin) { Say 'ログイン済みのためスキップします。' 'Green' }
elseif (-not (Have 'npx')) { Say 'npx が見つかりません。' 'Red' }
else {
  Say "ブラウザで $account を選び、アクセスを許可します。"
  Show-LoopbackNotice
  Say '古いログイン画面の localhost が ERR_CONNECTION_REFUSED になっても、そのタブは閉じて構いません。' 'Yellow'
  $log = Join-Path $env:TEMP ('orgiast-clasp-login-' + [guid]::NewGuid().ToString('N') + '.log')
  $err = $log + '.err'
  try {
    $process = Start-Process -FilePath 'npx.cmd' -ArgumentList '-y', '@google/clasp', 'login' -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError $err
    $opened = $false; $shownLength = 0
    while (-not $process.HasExited) {
      Start-Sleep -Milliseconds 500
      $text = ((Get-Content $log -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $err -Raw -ErrorAction SilentlyContinue))
      if ($text.Length -gt $shownLength) { Write-Host $text.Substring($shownLength); $shownLength = $text.Length }
      if (-not $opened -and $text -match 'https://accounts\.google\.com/\S+') {
        $url = $matches[0].TrimEnd('.', ',', ')')
        try { Start-Process $url; $opened = $true } catch {}
      }
    }
    $process.WaitForExit()
  } catch { Say ("clasp ログインの起動失敗: " + $_.Exception.Message) 'Red' }
  finally { Remove-Item $log, $err -Force -ErrorAction SilentlyContinue }
}
$results.Google = Test-ClaspLogin

Title '3/5 Vercel'
if (Test-VercelLogin) { Say 'ログイン済みのためスキップします。' 'Green' }
elseif (-not (Have 'npx')) { Say 'npx が見つかりません。' 'Red' }
else {
  Say "表示されたURLを開き、$account で確認コードを承認します。"
  Show-LoopbackNotice
  & npx.cmd -y vercel login
}
$results.Vercel = Test-VercelLogin

Title '4/5 Codex'
if (Test-CodexLogin) { Say 'ログイン済みのためスキップします。' 'Green' }
elseif (-not (Have 'codex')) { Say 'codex が見つかりません。' 'Red' }
else {
  Say "ブラウザで ChatGPT の $account を選んで許可します。"
  Show-LoopbackNotice
  & codex login
}
$results.Codex = Test-CodexLogin

Title '5/5 Cursor'
if (Test-CursorLogin) { Say 'ログイン済みのためスキップします。' 'Green' }
elseif (-not (Have 'agent')) { Say 'agent が見つかりません。インストーラをもう一度実行してください。' 'Red' }
else {
  Say "Cursor アプリでも $account でログインできます。CLI は次のブラウザ画面で同じアカウントを承認します。"
  Say 'ブラウザが開かないときは、表示された URL を開いてください。'
  & agent login
}
$results.Cursor = Test-CursorLogin

Title '最終結果'
$allOk = $true
foreach ($entry in $results.GetEnumerator()) {
  if ($entry.Value) { Say ("[OK] " + $entry.Key) 'Green' }
  else { Say ("[NG] " + $entry.Key) 'Red'; $allOk = $false }
}
if ($allOk) { Say 'ログイン5件がすべて完了しました。不要な AI Studio / localhost エラーのタブは閉じて構いません。' 'Green'; exit 0 }
Say 'NG のサービスを確認し、このランチャーをもう一度実行してください。' 'Yellow'
exit 1
