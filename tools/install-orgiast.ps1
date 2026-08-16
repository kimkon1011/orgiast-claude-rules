# install-orgiast.ps1 — オージャスト共通ルール & コスト監視 一括インストーラ(人間が自分で実行する)
# 何をするか(透明): ①共通ルール自動追従フック ②日次コスト自己申告 ③ツール採用+委譲規律チェック
#   ④Codex/Gemini CLI 導入 ⑤Gemini MCP 登録。会話内容は読まず/送らず、送信は集計値のみ。
# 実行するのは"あなた(このPCの持ち主)"。途中で「続けますか?」を1回だけ聞きます。中身に納得してから y を押してください。
# 冪等(何度実行してもOK)。settings.json は毎回バックアップ。
param(
  [string]$Webhook  = $env:ORGIAST_WEBHOOK,    # #claude-code webhook (配布者が埋め込み)
  [string]$Label    = $env:ORGIAST_LABEL,      # このPCの表示名(空ならPC名)
  [string]$ManusKey = $env:ORGIAST_MANUS_KEY,  # Manus APIキー(Web調査委譲用・配布者が埋め込み・任意)
  [string]$DeepSeekKey = $env:ORGIAST_DEEPSEEK_KEY, # DeepSeek APIキー(安い推論委譲用・任意)
  [string]$GrokKey = $env:ORGIAST_GROK_KEY,    # xAI Grok APIキー(任意)
  [string]$OpenRouterKey = $env:ORGIAST_OPENROUTER_KEY, # OpenRouter(1キーで413モデル/無料19本・任意)
  [string]$GroqKey = $env:ORGIAST_GROQ_KEY,    # Groq(超高速LPU・量産向け・任意)
  [string]$MistralKey = $env:ORGIAST_MISTRAL_KEY, # Mistral/Codestral(安いコード補助・任意)
  [string]$GeminiKey = $env:ORGIAST_GEMINI_KEY, # Gemini APIキー(配布者が埋め込み→鍵作成画面を省略・任意)
  [switch]$NoOllama,                           # Ollama(無料ローカル)導入をスキップ
  [switch]$NoReboot,                           # 最後の自動再起動をスキップ
  [switch]$Yes                                # 確認を省略(配布ランチャーから)
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
function Say($m,$c='White'){ Write-Host $m -ForegroundColor $c }
function OK($m){ Say "  [OK] $m" 'Green' }
function Warn($m){ Say "  [注意] $m" 'Yellow' }
function Step($m){ Say "`n■ $m" 'Cyan' }

$HOMEDIR = $env:USERPROFILE
$REPO    = Join-Path $HOMEDIR 'orgiast-claude-rules'
$HOOKS   = Join-Path $HOMEDIR '.claude\hooks'
if (-not $Label) { $Label = $env:COMPUTERNAME }

Say "============================================================" 'Cyan'
Say " オージャスト Claude セットアップ (このPC: $Label)" 'Cyan'
Say "============================================================" 'Cyan'
Say @"
このツールは、あなたのPCのClaudeを次のようにします(すべて自動):
  1) 会社の共通ルールを毎回自動で最新化(元に戻せるようバックアップ付き)
  2) このPCのClaude利用コスト概算($と使用モデルだけ)を社内Discordへ毎日報告/使い過ぎチェック
  3) 開発を安く速くする多数のAIを導入: Codex・Gemini・Manus・DeepSeek・Grok・Ollama(無料)・OpenRouter(413モデル)・Groq(超高速)・Mistral
  4) 開発時の"うっかり"防止リマインド(実装は安いツールへ/完了前にテスト)
※会話の中身は読みませんし送りません。送るのは数字の集計だけです。
※Gemini鍵は会社共有分を自動設定。あなたの操作は「最後のCodexログイン(会社アカウントを選ぶ1クリック)」だけです。
※最後にCodexログインの完了を確認してから自動再起動します(未ログインなら再起動しません)。完了後は全設定の適用チェックも自動表示。
"@ 'Gray'
Say "上記の内容で自動セットアップを始めます(入力は不要)。途中でブラウザが開いたら会社共有アカウント(seisaku-team@orgiast.jp)を選んでください。" 'Gray'

# --- 前提ツール(git/node)を用意 ---
Step "必要なツールの確認 (git / Node.js)"
function Have($c){ $null -ne (Get-Command $c -ErrorAction SilentlyContinue) }
if (-not (Have git)) { Warn "git が無いので導入します"; try { winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements | Out-Null } catch {} ; $env:Path += ';C:\Program Files\Git\cmd' }
if (Have git) { OK "git あり" } else { Warn "git が入りませんでした。会社担当(kim)に連絡してください" }
if (-not (Have node)) { Warn "Node.js が無いので導入します"; try { winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements | Out-Null } catch {} ; $env:Path += ';C:\Program Files\nodejs' }
if (Have node) { OK ("Node.js あり (" + (node -v) + ")") } else { Warn "Node.js が入りませんでした。会社担当(kim)に連絡してください" }

# --- リポ取得(ZIP優先: git の pack ロック/Defender 干渉を回避) ---
Step "共通ルール一式のダウンロード"
$gotRepo = $false
try {
  $zip = Join-Path $env:TEMP 'orgiast-rules.zip'
  $ext = Join-Path $env:TEMP ('orgiast-rules-ext-' + [guid]::NewGuid().ToString('N'))
  Invoke-WebRequest -UseBasicParsing 'https://github.com/kimkon1011/orgiast-claude-rules/archive/refs/heads/main.zip' -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $ext -Force
  $src = Join-Path $ext 'orgiast-claude-rules-main'
  if (Test-Path $src) {
    if (Test-Path $REPO) { Remove-Item $REPO -Recurse -Force -ErrorAction SilentlyContinue }
    Move-Item $src $REPO -Force
    if (Test-Path (Join-Path $REPO 'tools')) { $gotRepo = $true; OK "ダウンロード完了(zip)" }
  }
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Remove-Item $ext -Recurse -Force -ErrorAction SilentlyContinue
} catch { Warn "zip取得に失敗、gitで再試行します" }
if (-not $gotRepo -and (Test-Path (Join-Path $REPO '.git'))) {
  try { git -C $REPO pull --quiet; if (Test-Path (Join-Path $REPO 'tools')) { $gotRepo = $true; OK "最新に更新" } } catch { if (Test-Path (Join-Path $REPO 'tools')) { $gotRepo = $true; Warn "更新失敗(既存を使用)" } }
}
if (-not $gotRepo) {
  if (Test-Path $REPO) { Remove-Item $REPO -Recurse -Force -ErrorAction SilentlyContinue }
  for ($i = 1; $i -le 3 -and -not $gotRepo; $i++) {
    try { git clone --depth 1 --quiet https://github.com/kimkon1011/orgiast-claude-rules.git $REPO; if (Test-Path (Join-Path $REPO 'tools')) { $gotRepo = $true; OK "ダウンロード完了(git)" } }
    catch { Warn ("git clone 失敗 (試行 " + $i + "/3)"); if (Test-Path $REPO) { Remove-Item $REPO -Recurse -Force -ErrorAction SilentlyContinue } }
  }
}
if (-not $gotRepo) { Warn "共通ルールの取得に失敗。ネット接続を確認して、青い画面を閉じてもう一度コマンドを貼り付けてください(それでも駄目なら kim に連絡)" }

# --- onboarding-sync.ps1 を hooks へ配置(BOM付き) ---
Step "ルール自動追従スクリプトの配置"
New-Item -ItemType Directory -Force -Path $HOOKS | Out-Null
$src = Join-Path $REPO 'tools\onboarding-sync.ps1'
$dst = Join-Path $HOOKS 'onboarding-sync.ps1'
if (Test-Path $src) { Copy-Item $src $dst -Force; OK "配置: $dst" } else { Warn "onboarding-sync.ps1 が見つかりません" }
$srcW = Join-Path $REPO 'tools\pretooluse-delegation-warn.ps1'
$dstW = Join-Path $HOOKS 'pretooluse-delegation-warn.ps1'
if (Test-Path $srcW) { Copy-Item $srcW $dstW -Force; OK "配置: 委譲警告フック" }
$srcV = Join-Path $REPO 'tools\verify-before-done-detector.ps1'
$dstV = Join-Path $HOOKS 'verify-before-done-detector.ps1'
if (Test-Path $srcV) { Copy-Item $srcV $dstV -Force; OK "配置: テスト忘れ防止フック" }
$srcC = Join-Path $REPO 'tools\cost-loop.ps1'
$dstC = Join-Path $HOOKS 'cost-loop.ps1'
if (Test-Path $srcC) { Copy-Item $srcC $dstC -Force; OK "配置: コスト×作業量ループフック" }

# --- cost-reporter.env ---
Step "コスト報告の設定"
$envPath = Join-Path $HOMEDIR '.claude\cost-reporter.env'
if (Test-Path $envPath) { OK "既存の設定を使用(上書きしません)" }
elseif ($Webhook) { "DISCORD_COST_WEBHOOK=$Webhook`r`nREPORTER_LABEL=$Label" | Set-Content -Path $envPath -Encoding UTF8; OK "作成: $envPath" }
else { Warn "Discord webhook 未指定。コスト報告は送信されません(配布者にwebhook入りランチャーをもらってください)" }

# --- Manus(Web調査委譲)キー ---
Step "Manus(Web調査委譲)の設定"
$manusEnv = Join-Path $HOMEDIR '.claude\manus.env'
if (Test-Path $manusEnv) { OK "Manusキー 既存(上書きしません)" }
elseif ($ManusKey) { "MANUS_API_KEY=$ManusKey" | Set-Content -Path $manusEnv -Encoding UTF8; OK "Manusキー設定(Web調査を Manus へ委譲可能に)" }
else { Warn "Manusキー未指定(Web調査委譲は無効。他機能は動作)" }

# --- DeepSeek(安い推論委譲)キー ---
Step "DeepSeek(安い推論委譲)の設定"
$dsEnv = Join-Path $HOMEDIR '.claude\deepseek.env'
if (Test-Path $dsEnv) { OK "DeepSeekキー 既存(上書きしません)" }
elseif ($DeepSeekKey) { "DEEPSEEK_API_KEY=$DeepSeekKey" | Set-Content -Path $dsEnv -Encoding UTF8; OK "DeepSeekキー設定(安い推論/生成を DeepSeek へ委譲可能に)" }
else { Warn "DeepSeekキー未指定(委譲は無効。他機能は動作)" }

# --- Grok(xAI)キー ---
Step "Grok(xAI)の設定"
$xaiEnv = Join-Path $HOMEDIR '.claude\xai.env'
if (Test-Path $xaiEnv) { OK "Grokキー 既存(上書きしません)" }
elseif ($GrokKey) { "XAI_API_KEY=$GrokKey" | Set-Content -Path $xaiEnv -Encoding UTF8; OK "Grokキー設定" }
else { Warn "Grokキー未指定(Grok委譲は無効。他機能は動作)" }

# --- OpenRouter / Groq / Mistral キー(統合ヘルパー llm-ask.mjs 用) ---
Step "OpenRouter/Groq/Mistral の設定 (多モデル・超高速・安コード)"
$orEnv = Join-Path $HOMEDIR '.claude\openrouter.env'
if (Test-Path $orEnv) { OK "OpenRouterキー 既存(上書きしません)" }
elseif ($OpenRouterKey) { "OPENROUTER_API_KEY=$OpenRouterKey" | Set-Content -Path $orEnv -Encoding UTF8; OK "OpenRouterキー設定(1キーで413モデル/無料19本に委譲可能に)" }
else { Warn "OpenRouterキー未指定(他機能は動作)" }
$grqEnv = Join-Path $HOMEDIR '.claude\groq.env'
if (Test-Path $grqEnv) { OK "Groqキー 既存(上書きしません)" }
elseif ($GroqKey) { "GROQ_API_KEY=$GroqKey" | Set-Content -Path $grqEnv -Encoding UTF8; OK "Groqキー設定(超高速な分類/量産を Groq へ委譲可能に)" }
else { Warn "Groqキー未指定(他機能は動作)" }
$msEnv = Join-Path $HOMEDIR '.claude\mistral.env'
if (Test-Path $msEnv) { OK "Mistralキー 既存(上書きしません)" }
elseif ($MistralKey) { "MISTRAL_API_KEY=$MistralKey" | Set-Content -Path $msEnv -Encoding UTF8; OK "Mistralキー設定(安いコード補助 Codestral を利用可能に)" }
else { Warn "Mistralキー未指定(他機能は動作)" }

# --- Ollama(無料ローカルAI)導入: 裏側プロセスで非ブロッキング実行(DLで画面を止めない) ---
if (-not $NoOllama) {
  Step "Ollama(無料ローカルAI・大量の軽作業用)の導入"
  "OLLAMA_MODEL=qwen2.5:3b" | Set-Content -Path (Join-Path $HOMEDIR '.claude\ollama.env') -Encoding UTF8
  $ollExe = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
  # winget導入(未導入時)→モデル取得 を1つの隠しcmdで直列実行。メイン処理はブロックせず次へ進む。
  $ollCmd = 'winget install --id Ollama.Ollama -e --accept-package-agreements --accept-source-agreements & "' + $ollExe + '" pull qwen2.5:3b'
  try {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $ollCmd -WindowStyle Hidden | Out-Null
    OK "Ollama は裏でダウンロード中(数分)。この画面は止めずに次へ進みます(完了後 node <repo>\tools\ollama-ask.mjs で利用可)"
  } catch { Warn "Ollama の裏実行を起動できませんでした(他機能は動作)。後で会社担当に相談" }
} else { OK "Ollama はスキップ(-NoOllama)" }

# --- settings.json に3フック登録(バックアップ+マージ) ---
Step "自動実行フックの登録 (毎日1回まで/裏で静かに動作)"
$setPath = Join-Path $HOMEDIR '.claude\settings.json'
$shell = if (Have pwsh) { 'pwsh' } else { 'powershell' }
$h = "$HOMEDIR"
$wanted = @(
  "$shell -NoProfile -NonInteractive -File `"$h\.claude\hooks\onboarding-sync.ps1`"",
  "node `"$h\orgiast-claude-rules\tools\claude-cost-reporter.mjs`"",
  "node `"$h\orgiast-claude-rules\tools\tool-adoption-check.mjs`" --fix"
)
if (-not (Test-Path $setPath)) { '{}' | Set-Content $setPath -Encoding UTF8 }
Copy-Item $setPath ($setPath + '.bak.' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-installer') -Force
$json = Get-Content $setPath -Raw | ConvertFrom-Json
if (-not $json.hooks) { $json | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $json.hooks.SessionStart) { $json.hooks | Add-Member -NotePropertyName SessionStart -NotePropertyValue @() -Force }
$existing = @($json.hooks.SessionStart)
$existingCmds = $existing | ForEach-Object { $_.hooks } | ForEach-Object { $_.command }
foreach ($cmd in $wanted) {
  $key = ($cmd -split '\\')[-1]
  if ($existingCmds -match [regex]::Escape($key.Split('"')[0])) { OK "登録済(スキップ): $key" ; continue }
  $to = if ($cmd -match 'tool-adoption') { 30 } elseif ($cmd -match 'onboarding-sync') { 20 } else { 15 }
  $existing += [pscustomobject]@{ hooks = @([pscustomobject]@{ type='command'; command=$cmd; timeout=$to; async=$true }) }
  OK "追加: $key"
}
$json.hooks.SessionStart = $existing
# PreToolUse: 委譲警告フック(アプリ実装コードの直接編集時にCodex委譲をリマインド・警告のみ/§1.18)
if (Test-Path $dstW) {
  if (-not $json.hooks.PreToolUse) { $json.hooks | Add-Member -NotePropertyName PreToolUse -NotePropertyValue @() -Force }
  $pre = @($json.hooks.PreToolUse)
  $already = $pre | ForEach-Object { $_.hooks } | ForEach-Object { $_.command } | Where-Object { $_ -match 'pretooluse-delegation-warn' }
  if ($already) { OK "委譲警告フック 登録済(スキップ)" }
  else {
    $pre += [pscustomobject]@{ matcher='Write|Edit|MultiEdit'; hooks=@([pscustomobject]@{ type='command'; command="$shell -NoProfile -File `"$h\.claude\hooks\pretooluse-delegation-warn.ps1`"" }) }
    $json.hooks.PreToolUse = $pre
    OK "委譲警告フック PreToolUse 登録"
  }
}
# Stop: テスト忘れ防止フック(コード変更を完了報告する前に実行テストを促す・警告のみ/§1.18)
if (Test-Path $dstV) {
  if (-not $json.hooks.Stop) { $json.hooks | Add-Member -NotePropertyName Stop -NotePropertyValue @() -Force }
  $stp = @($json.hooks.Stop)
  $sAlready = $stp | ForEach-Object { $_.hooks } | ForEach-Object { $_.command } | Where-Object { $_ -match 'verify-before-done' }
  if ($sAlready) { OK "テスト忘れ防止フック 登録済(スキップ)" }
  else {
    $stp += [pscustomobject]@{ hooks=@([pscustomobject]@{ type='command'; command="$shell -NoProfile -File `"$h\.claude\hooks\verify-before-done-detector.ps1`"" }) }
    $json.hooks.Stop = $stp
    OK "テスト忘れ防止フック Stop 登録"
  }
}
# SessionStart: コスト×作業量ループ(指示書を毎回注入)。context注入なので async は付けない(付けると黙殺される)
if (Test-Path $dstC) {
  $ss2 = @($json.hooks.SessionStart)
  $cAlready = $ss2 | ForEach-Object { $_.hooks } | ForEach-Object { $_.command } | Where-Object { $_ -match 'cost-loop' }
  if ($cAlready) { OK "コスト×作業量ループ 登録済(スキップ)" }
  else {
    $ss2 += [pscustomobject]@{ hooks = @([pscustomobject]@{ type='command'; command="$shell -NoProfile -NonInteractive -File `"$h\.claude\hooks\cost-loop.ps1`""; timeout=15 }) }
    $json.hooks.SessionStart = $ss2
    OK "コスト×作業量ループ SessionStart 登録(毎回指示注入+日次計測)"
  }
}
($json | ConvertTo-Json -Depth 20) | Set-Content $setPath -Encoding UTF8
OK "settings.json 更新(バックアップ済)"

# --- 夜間バッチの定時起動(毎日03:00・off-peak帯にキュー消化=50%off) ---
Step "夜間バッチの定時起動を登録 (毎日03:00)"
try {
  $nb = Join-Path $REPO 'tools\nightly-batch.ps1'
  if (Test-Path $nb) {
    $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $nb + '"')
    $trg = New-ScheduledTaskTrigger -Daily -At 3:00am
    $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName 'OrgiastNightlyBatch' -Action $act -Trigger $trg -Settings $set -Force -ErrorAction Stop | Out-Null
    OK "定時起動 登録完了(毎日03:00 OrgiastNightlyBatch・夜間バッチ半額実行)"
  } else { Warn "nightly-batch.ps1 未取得=定時起動スキップ(他機能は動作)" }
} catch { Warn ("定時起動の登録に失敗(他機能は動作。後で会社担当に相談): " + $_.Exception.Message) }

# --- フリートポーラーの定時起動(毎日03:15・夜間1回=コスト最小/LLM呼び出しゼロ) ---
Step "フリート自己点検の定時起動を登録 (毎日03:15)"
try {
  $fp = Join-Path $REPO 'tools\fleet-poller.ps1'
  if (Test-Path $fp) {
    $fact = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $fp + '"')
    $ftrg = New-ScheduledTaskTrigger -Daily -At 3:15am
    $fset = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName 'OrgiastFleetPoller' -Action $fact -Trigger $ftrg -Settings $fset -Force -ErrorAction Stop | Out-Null
    OK "フリート自己点検 登録完了(毎日03:15・設定チェック結果をDiscordへ自己報告+承認済みタスク処理)"
  } else { Warn "fleet-poller.ps1 未取得=スキップ(他機能は動作)" }
} catch { Warn ("フリート点検の登録に失敗(他機能は動作): " + $_.Exception.Message) }

# --- 開発ツール導入 ---
Step "開発ツール Codex / Gemini の導入 (コスト削減用)"
# 直前にwingetで入れたNodeを"同一セッション"で使えるよう、PATHをレジストリから再読込(未反映だとnpm/codexが見つからず失敗する)
try {
  $npmBin = Join-Path $env:APPDATA 'npm'
  $paths = @([Environment]::GetEnvironmentVariable('Path','Machine'), [Environment]::GetEnvironmentVariable('Path','User'), 'C:\Program Files\nodejs', $npmBin) | Where-Object { $_ }
  $env:Path = ($paths -join ';')
} catch {}
if (Have npm) {
  # npm i -g をタイムアウト付きで実行(遅い/ハングするネットでも固まらない)。導入判定はコマンドの有無で。
  function NpmInstallTO($pkg, $sec) {
    try {
      $pr = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('npm i -g ' + $pkg + ' --no-fund --no-audit') -NoNewWindow -PassThru
      if (-not $pr.WaitForExit($sec * 1000)) { try { $pr.Kill() } catch {} }
    } catch {}
  }
  # Codex(必須・codex loginで使う): 180秒でタイムアウト
  NpmInstallTO '@openai/codex' 180
  if (Have codex) { OK "Codex CLI 導入完了" } else { Warn "Codex CLI が時間内に入りませんでした(ネット状況次第)。後で青い画面に『npm i -g @openai/codex』で導入可。他機能は動作" }
  # Gemini(任意・MCPが--allow-npxで自動取得): 120秒でタイムアウト
  NpmInstallTO '@google/gemini-cli' 120
  if (Have gemini) { OK "Gemini CLI 導入完了" } else { OK "Gemini CLIのグローバル導入はスキップ(GeminiはMCP経由=npxで自動取得されるので問題ありません)" }
  # このあとの codex login 用に npm グローバルbin を現セッションPATHへ
  if ((Test-Path $npmBin) -and ($env:Path -notlike "*$npmBin*")) { $env:Path += ";$npmBin" }
} else { Warn "npm が見つからないためCLI導入をスキップ(PC再起動後にコマンドを再実行してください)" }

# --- 初回実行(共通ルール取込) ---
Step "共通ルールの初回取込(動作確認)"
try { & $shell -NoProfile -File $dst -Force | Out-Null; OK "共通ルールを取り込みました" } catch { Warn "ルール取込は次回起動時に自動実行されます" }

# --- Gemini APIキーをこの画面で取得(ページ自動オープン→貼り付け) ---
Step "Gemini のAPIキー設定 (検索・大きな資料用・無料枠)"
$geminiKey = ''
$gEnv = Join-Path $HOMEDIR '.gemini\.env'
if (Test-Path $gEnv) { $line = (Get-Content $gEnv | Where-Object { $_ -like 'GEMINI_API_KEY=*' } | Select-Object -First 1); if ($line) { $geminiKey = $line.Split('=',2)[1] } }
# 配布者が埋め込んだ共有キーがあれば鍵作成画面を丸ごと省略。
# param束縛が揺れるケースがあるため env:ORGIAST_GEMINI_KEY も直接フォールバック参照する(堅牢化)。
$embedKey = if ($GeminiKey) { $GeminiKey } elseif ($env:ORGIAST_GEMINI_KEY) { $env:ORGIAST_GEMINI_KEY } else { '' }
if (-not $geminiKey -and $embedKey) {
  $geminiKey = $embedKey.Trim()
  New-Item -ItemType Directory -Force -Path (Split-Path $gEnv) | Out-Null
  "GEMINI_API_KEY=$geminiKey`r`nGEMINI_CLI_TRUST_WORKSPACE=true" | Set-Content $gEnv -Encoding UTF8
  OK "Gemini APIキー(会社共有)を設定しました(鍵作成の操作は不要)"
}
if ($geminiKey) { OK "Gemini APIキーは設定済み(スキップ)" }
else {
  Say "  これから APIキー作成ページをブラウザで開きます。会社のGoogle(orgiast.jp)でログインしてください。" 'Gray'
  Say "  ページで『APIキーを作成 / Create API key』を押し、出てきた文字(AIza... か AQ...)をコピー。" 'Gray'
  try { Start-Process 'https://aistudio.google.com/apikey' } catch { Say "  手動で開いてください: https://aistudio.google.com/apikey" 'Yellow' }
  $geminiKey = (Read-Host "  コピーしたAPIキーをここに貼り付けて Enter (今やらない場合は空Enterでスキップ)").Trim()
  if ($geminiKey) {
    New-Item -ItemType Directory -Force -Path (Split-Path $gEnv) | Out-Null
    "GEMINI_API_KEY=$geminiKey`r`nGEMINI_CLI_TRUST_WORKSPACE=true" | Set-Content $gEnv -Encoding UTF8
    OK "APIキーを保存しました"
  } else { Warn "APIキー未設定(後で再実行すれば設定できます)。Geminiは使えませんが他は動きます" }
}

# --- Gemini MCP 登録(キーを反映) ---
# 注意: PS5.1 の ConvertFrom-Json は約2MB超のJSONで落ちる(maxJsonLength)。~/.claude.json は履歴で肥大するため
#       JavaScriptSerializer(上限解除)で読み書きする。書き込みはBOM無しUTF-8(NodeのJSON.parseはBOMで壊れるため)。
Step "Gemini 連携(MCP)の登録"
$cj = Join-Path $HOMEDIR '.claude.json'
$mcpVal = @{ type = 'stdio'; command = 'npx'; args = @('-y', '@choplin/mcp-gemini-cli', '--allow-npx'); env = @{ GEMINI_API_KEY = $geminiKey; GEMINI_CLI_TRUST_WORKSPACE = 'true' } }
try {
  if (-not (Test-Path $cj)) { '{}' | Set-Content $cj -Encoding UTF8 }
  Copy-Item $cj ($cj + '.bak.' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-installer') -Force
  $raw = Get-Content $cj -Raw; if (-not $raw -or -not $raw.Trim()) { $raw = '{}' }
  $done = $false
  # 方法1: ConvertFrom-Json (PS7は無制限/PS5.1も小さいファイルなら成功)
  try {
    $cjson = $raw | ConvertFrom-Json
    if (-not $cjson.mcpServers) { $cjson | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) -Force }
    $cjson.mcpServers | Add-Member -NotePropertyName 'gemini-cli' -NotePropertyValue ([pscustomobject]$mcpVal) -Force
    $out = $cjson | ConvertTo-Json -Depth 100
    [System.IO.File]::WriteAllText($cj, $out, (New-Object System.Text.UTF8Encoding($false)))
    $done = $true
  } catch { }
  # 方法2: PS5.1で大きい.claude.json(約2MB超)がConvertFrom-Jsonの上限で落ちた場合 → JavaScriptSerializer(上限解除)
  if (-not $done) {
    Add-Type -AssemblyName System.Web.Extensions
    $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $ser.MaxJsonLength = [int]::MaxValue
    $obj = $ser.DeserializeObject($raw); if ($null -eq $obj) { $obj = @{} }
    if (-not $obj.ContainsKey('mcpServers') -or $null -eq $obj['mcpServers']) { $obj['mcpServers'] = @{} }
    $obj['mcpServers']['gemini-cli'] = $mcpVal
    [System.IO.File]::WriteAllText($cj, $ser.Serialize($obj), (New-Object System.Text.UTF8Encoding($false)))
    $done = $true
  }
  if ($done) { OK "gemini-cli MCP 登録完了" }
} catch { Warn ("MCP自動登録に失敗(他ツールは動作): " + $_.Exception.Message) }

# --- 設定ファイルのBOM除去(PS5.1のSet-Content -Encoding UTF8はBOMを付ける。node/Claude CodeのJSON.parse・env読取がBOMで壊れるため全部no-BOM化) ---
$bomFix = @((Join-Path $HOMEDIR '.claude\settings.json'), (Join-Path $HOMEDIR '.claude.json'), (Join-Path $HOMEDIR '.gemini\.env'), $envPath, $manusEnv, $dsEnv, $xaiEnv, $orEnv, $grqEnv, $msEnv, (Join-Path $HOMEDIR '.claude\ollama.env'))
foreach ($bf in $bomFix) { try { if ($bf -and (Test-Path $bf)) { $bc = [System.IO.File]::ReadAllText($bf); if ($bc.Length -gt 0 -and $bc[0] -eq [char]0xFEFF) { [System.IO.File]::WriteAllText($bf, $bc.TrimStart([char]0xFEFF), (New-Object System.Text.UTF8Encoding($false))) } } } catch {} }

# --- Codex ログイン(Codex導入済みの時だけ・未導入なら待たずにスキップ) ---
Say "`n============================================================" 'Green'
$codexCmd = (Get-Command codex -ErrorAction SilentlyContinue)
if (-not $codexCmd) {
  Say " ほぼ完了！ (ただし Codex CLI が未導入)" 'Yellow'
  Say "============================================================" 'Green'
  Warn "Codex未導入のためログインはスキップ(待ちません)。ネット改善後に青い画面で『npm i -g @openai/codex』→『codex login』(seisaku-team@orgiast.jp)を。"
  Say "`n--- 適用状況の総合チェック ---" 'Cyan'
  try { $vs = Join-Path $REPO 'tools\verify-setup.ps1'; if (Test-Path $vs) { & $vs } } catch {}
  Say "`nCodex以外は設定済み。Codex導入+ログイン後に手動でPC再起動してください(自動再起動はしません)。" 'Yellow'
}
else {
  Say " ほぼ完了！ 最後に『Codexのログイン』1つだけお願いします" 'Green'
  Say "============================================================" 'Green'
  Say @"
Codex(コードを速く安く作るツール・定額枠)を使うにはログインが要ります。
今からログイン画面を自動で開きます。ブラウザが開いたら、会社共有の ChatGPT アカウント
【seisaku-team@orgiast.jp】でログイン(またはそのアカウントを選ぶ)だけでOKです。
"@ 'Gray'
  $authFile = Join-Path $env:USERPROFILE '.codex\auth.json'
  function Test-CodexLogin { if (-not (Test-Path $authFile)) { return $false }; try { $x = Get-Content $authFile -Raw | ConvertFrom-Json; return [bool]($x.tokens.id_token) } catch { return $false } }
  $beforeLogin = if (Test-Path $authFile) { (Get-Item $authFile).LastWriteTimeUtc } else { [datetime]::MinValue }
  $alreadyIn = Test-CodexLogin
  # フルパスで起動(新しいcmdがnpmのグローバルbinをPATHに持たず『codexは認識されていません』となる対策)
  try { Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', ('"' + $codexCmd.Source + '" login') ; OK "Codexログイン画面を開きました(ブラウザで seisaku-team@orgiast.jp を選ぶだけ)" }
  catch { Warn "自動起動できませんでした。青い画面に『codex login』と打ってください" }
  Say "`nCodexのログイン完了を待っています(最大10分)。ブラウザで seisaku-team@orgiast.jp を選んでください..." 'Cyan'
  $loggedIn = $false; $deadline = (Get-Date).AddMinutes(10)
  while ((Get-Date) -lt $deadline) { Start-Sleep -Seconds 5; if (Test-CodexLogin) { $now = (Get-Item $authFile).LastWriteTimeUtc; if ($alreadyIn -or $now -gt $beforeLogin) { $loggedIn = $true; break } } }
  Say "`n--- 適用状況の総合チェック ---" 'Cyan'
  try { $vs = Join-Path $REPO 'tools\verify-setup.ps1'; if (Test-Path $vs) { & $vs } } catch {}
  if ($loggedIn) {
    OK "Codexログイン確認OK(auth.json にトークンを検出)"
    if ($NoReboot) { Say "自動再起動はスキップ(-NoReboot)。手動で再起動を。" 'Yellow' }
    else { Say "`nセットアップ完了。30秒後に再起動します(中止: 青い画面に『shutdown /a』)。" 'Green'; try { shutdown /r /t 30 /c "オージャストAI設定の反映のため再起動します(中止: shutdown /a)" | Out-Null } catch {} }
  }
  else { Warn "10分待ちましたがCodexログインが未完了。自動再起動はしません。ログイン完了後に手動でPC再起動を。" }
}
Say "`n分からないことがあれば、この画面の内容をそのまま kim に送ってください。" 'Green'
