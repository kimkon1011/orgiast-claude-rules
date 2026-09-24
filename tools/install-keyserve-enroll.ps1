# Enrollment implementation shared by normal install and the isolated-home check.
param(
  [Parameter(Mandatory=$true)][string]$Enroll,
  [Parameter(Mandatory=$true)][string]$TargetHome,
  [Parameter(Mandatory=$true)][string]$Repo
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$previousHome = $env:ORGIAST_HOME
$previousSecret = $env:ORGIAST_KEYSERVE_SECRET
$env:ORGIAST_HOME = $TargetHome
# Verify the saved primary file, not an inherited process credential.
$env:ORGIAST_KEYSERVE_SECRET = $null
$claudeDir = Join-Path $TargetHome '.claude'
$enrollFile = Join-Path $claudeDir 'enroll.env'
$resultFile = Join-Path $claudeDir '.enroll-result.json'
$primaryFile = Join-Path $claudeDir 'keyserve.env'
$authVia = '未設定'
$httpStatus = $null
$success = $false
$reason = '鍵の導入を開始できませんでした。'
$stage = 'prepare'
function Get-PrimaryStatus {
  $raw = & node (Join-Path $Repo 'tools\keyserve-status.mjs') --json
  if ($LASTEXITCODE -ne 0) { throw 'status-command-failed' }
  return ($raw -join "`n" | ConvertFrom-Json)
}
try {
  if ($Enroll -match "[`r`n`0]") { throw 'invalid-token-line' }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node-missing' }
  foreach ($file in @('onboarding-sync.mjs', 'keyserve-status.mjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Repo "tools\$file"))) { throw 'client-missing' }
  }
  New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null
  $stage = 'acl'
  if (Test-Path -LiteralPath $enrollFile) {
    if ((Get-Item -LiteralPath $enrollFile -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'unsafe-token-file' }
  } else { [IO.File]::WriteAllText($enrollFile, '') }
  # No secret is written until inheritance and every other user's ACE are removed.
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = New-Object Security.AccessControl.FileSecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $enrollFile -AclObject $acl
  [IO.File]::WriteAllText($enrollFile, "ORGIAST_ENROLL_TOKEN=$Enroll`n", [Text.UTF8Encoding]::new($false))
  $stage = 'sync'
  # Preserve primary-first semantics; only quarantine a file proven to be rejected.
  # A network outage must never cause a working primary to be replaced.
  $before = Get-PrimaryStatus
  if ($before.auth -eq 'primary' -and $before.status -eq 401) {
    Move-Item -LiteralPath $primaryFile -Destination ($primaryFile + '.pre-enroll-' + [guid]::NewGuid().ToString('N'))
    Write-Host '既存の primary は HTTP 401 のため退避しました。enroll で再取得します。'
  }
  Remove-Item -LiteralPath $resultFile -Force -ErrorAction SilentlyContinue
  & node (Join-Path $Repo 'tools\onboarding-sync.mjs') --keys-only --force | Out-Null
  $syncExit = $LASTEXITCODE
  $attempt = $null
  if (Test-Path -LiteralPath $resultFile) { $attempt = Get-Content -LiteralPath $resultFile -Raw -Encoding UTF8 | ConvertFrom-Json }
  $checked = Get-PrimaryStatus
  $authVia = $checked.auth
  $httpStatus = $checked.status
  if ($attempt) { $authVia = $attempt.authVia; $httpStatus = $attempt.status }
  if ($syncExit -eq 0 -and $checked.auth -eq 'primary' -and $checked.status -eq 200 -and $checked.success) {
    if ($attempt -and $attempt.kind -ne 'ok') {
      $reason = 'primary は HTTP 200 ですが、鍵一式の保存が完了していません。フォルダーの権限と空き容量を確認してください。'
    } else {
      # Also removes an unused token when the PC already had a working primary.
      Remove-Item -LiteralPath $enrollFile -Force -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $enrollFile) {
        $reason = 'primary / HTTP 200 は確認できましたが、enroll.env を削除できません。ファイルの権限を確認して再実行してください。'
      } else {
        $success = $true
        $httpStatus = $checked.status
        Write-Host '鍵の復帰に成功：認証経路 primary / HTTP 200。enroll.env の削除も確認しました。' -ForegroundColor Green
      }
    }
  } elseif ($attempt -and $attempt.kind -eq 'expired') {
    $reason = 'サーバがトークン期限切れを返しました。kim に新しい enroll コマンドの発行を依頼してください。'
  } elseif ($httpStatus -eq 401) {
    $reason = 'HTTP 401：認証が拒否されました。トークンの貼り付け漏れ・対象PC・サーバ設定を確認してください。サーバが期限切れを明示していないため、期限切れかは判定できません。'
  } elseif (($attempt -and $attempt.kind -eq 'network') -or $checked.error) {
    $reason = 'ネットワーク接続またはタイムアウトで keyserve に接続できません。インターネット・VPN・プロキシを確認して再実行してください。'
  } elseif ($attempt -and $attempt.kind -eq 'write') {
    $reason = '鍵の応答は届きましたが、primary を含む鍵一式を保存できません。配布内容・フォルダー権限・空き容量を確認してください。'
  } elseif ($attempt -and $attempt.kind -eq 'invalid-response') {
    $reason = 'keyserve の応答形式が不正です。サーバのデプロイ状態を kim に確認してください。'
  } elseif ($httpStatus) {
    $reason = "HTTP $httpStatus：primary 認証を確認できませんでした。サーバの稼働状況を kim に確認してください。"
  } else {
    $reason = 'primary が保存されていません。鍵同期クライアントとサーバが enroll 対応版か確認してください。'
  }
} catch {
  # Never print exception text: it can contain the secret parameter or native arguments.
  if ($stage -eq 'acl') { $reason = 'enroll.env を現ユーザーだけが読める権限で保存できません。Windows のファイル権限を確認してください。' }
  elseif ($stage -eq 'prepare') { $reason = '導入準備に失敗しました。Node.js と最新版の配布ツールを確認し、コマンドを改行せず貼り付けてください。' }
  else { $reason = '鍵同期または認証結果の読み取りに失敗しました。配布ツールと保存先フォルダーを確認してください。' }
} finally {
  if (-not $success) { Write-Host "鍵の復帰に失敗：$reason enroll.env が残っている場合は再試行に利用できます。" -ForegroundColor Red }
  $httpText = if ($null -eq $httpStatus) { '未取得' } else { [string]$httpStatus }
  $outcome = if ($success) { '成功' } else { '失敗' }
  try {
    $message = "keyserve 導入結果: PC=$env:COMPUTERNAME / authVia=$authVia / HTTP=$httpText / $outcome"
    & node (Join-Path $Repo 'tools\notify-kim.mjs') $message | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host 'Discord 自己報告に失敗しました。導入結果は変わりません。' -ForegroundColor Yellow }
  } catch { Write-Host 'Discord 自己報告に失敗しました。導入結果は変わりません。' -ForegroundColor Yellow }
  $env:ORGIAST_HOME = $previousHome
  $env:ORGIAST_KEYSERVE_SECRET = $previousSecret
}
if (-not $success) { exit 1 }
exit 0
