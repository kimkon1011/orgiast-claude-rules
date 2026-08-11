# install-orgiast.ps1 — オージャスト共通ルール & コスト監視 一括インストーラ(人間が自分で実行する)
# 何をするか(透明): ①共通ルール自動追従フック ②日次コスト自己申告 ③ツール採用+委譲規律チェック
#   ④Codex/Gemini CLI 導入 ⑤Gemini MCP 登録。会話内容は読まず/送らず、送信は集計値のみ。
# 実行するのは"あなた(このPCの持ち主)"。途中で「続けますか?」を1回だけ聞きます。中身に納得してから y を押してください。
# 冪等(何度実行してもOK)。settings.json は毎回バックアップ。
param(
  [string]$Webhook = $env:ORGIAST_WEBHOOK,   # #claude-code webhook (配布者が埋め込み)
  [string]$Label   = $env:ORGIAST_LABEL,     # このPCの表示名(空ならPC名)
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
  2) このPCのClaude利用コスト概算($と使用モデルだけ)を社内Discordへ毎日報告
  3) 安いツール(Codex等)が使われているか/高いモデルの使い過ぎを毎日チェック
  4) 開発用ツール Codex と Gemini を導入(コストを下げるため)
※会話の中身は読みませんし送りません。送るのは数字の集計だけです。
※最後に「Codexのログイン」「GeminiのAPIキー」の2つだけ、あなたの操作をお願いします(自動化できない部分)。
"@ 'Gray'
if (-not $Yes) {
  $ans = Read-Host "続けてよければ y を入力して Enter (やめる場合は n)"
  if ($ans -ne 'y' -and $ans -ne 'Y') { Say "中止しました。何も変更していません。" 'Yellow'; exit 0 }
}

# --- 前提ツール(git/node)を用意 ---
Step "必要なツールの確認 (git / Node.js)"
function Have($c){ $null -ne (Get-Command $c -ErrorAction SilentlyContinue) }
if (-not (Have git)) { Warn "git が無いので導入します"; try { winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements | Out-Null } catch {} ; $env:Path += ';C:\Program Files\Git\cmd' }
if (Have git) { OK "git あり" } else { Warn "git が入りませんでした。会社担当(kim)に連絡してください" }
if (-not (Have node)) { Warn "Node.js が無いので導入します"; try { winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements | Out-Null } catch {} ; $env:Path += ';C:\Program Files\nodejs' }
if (Have node) { OK ("Node.js あり (" + (node -v) + ")") } else { Warn "Node.js が入りませんでした。会社担当(kim)に連絡してください" }

# --- リポ取得 ---
Step "共通ルール一式のダウンロード"
if (Test-Path $REPO) { try { git -C $REPO pull --quiet; OK "最新に更新" } catch { Warn "更新に失敗(既存を使用)" } }
else { git clone --quiet https://github.com/kimkon1011/orgiast-claude-rules.git $REPO; OK "ダウンロード完了" }

# --- onboarding-sync.ps1 を hooks へ配置(BOM付き) ---
Step "ルール自動追従スクリプトの配置"
New-Item -ItemType Directory -Force -Path $HOOKS | Out-Null
$src = Join-Path $REPO 'tools\onboarding-sync.ps1'
$dst = Join-Path $HOOKS 'onboarding-sync.ps1'
if (Test-Path $src) { Copy-Item $src $dst -Force; OK "配置: $dst" } else { Warn "onboarding-sync.ps1 が見つかりません" }

# --- cost-reporter.env ---
Step "コスト報告の設定"
$envPath = Join-Path $HOMEDIR '.claude\cost-reporter.env'
if (Test-Path $envPath) { OK "既存の設定を使用(上書きしません)" }
elseif ($Webhook) { "DISCORD_COST_WEBHOOK=$Webhook`r`nREPORTER_LABEL=$Label" | Set-Content -Path $envPath -Encoding UTF8; OK "作成: $envPath" }
else { Warn "Discord webhook 未指定。コスト報告は送信されません(配布者にwebhook入りランチャーをもらってください)" }

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
($json | ConvertTo-Json -Depth 20) | Set-Content $setPath -Encoding UTF8
OK "settings.json 更新(バックアップ済)"

# --- 開発ツール導入 ---
Step "開発ツール Codex / Gemini の導入 (コスト削減用)"
if (Have node) {
  try { npm i -g @openai/codex @google/gemini-cli 2>$null | Out-Null; OK "Codex / Gemini CLI 導入完了" } catch { Warn "CLI導入に一部失敗。後で会社担当に相談" }
} else { Warn "Node.js が無いためスキップ" }

# --- 初回実行(共通ルール取込) ---
Step "共通ルールの初回取込(動作確認)"
try { & $shell -NoProfile -File $dst -Force | Out-Null; OK "共通ルールを取り込みました" } catch { Warn "ルール取込は次回起動時に自動実行されます" }

# --- Gemini APIキーをこの画面で取得(ページ自動オープン→貼り付け) ---
Step "Gemini のAPIキー設定 (検索・大きな資料用・無料枠)"
$geminiKey = ''
$gEnv = Join-Path $HOMEDIR '.gemini\.env'
if (Test-Path $gEnv) { $line = (Get-Content $gEnv | Where-Object { $_ -like 'GEMINI_API_KEY=*' } | Select-Object -First 1); if ($line) { $geminiKey = $line.Split('=',2)[1] } }
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
Step "Gemini 連携(MCP)の登録"
$cj = Join-Path $HOMEDIR '.claude.json'
try {
  if (-not (Test-Path $cj)) { '{}' | Set-Content $cj -Encoding UTF8 }
  Copy-Item $cj ($cj + '.bak.' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-installer') -Force
  $cjson = Get-Content $cj -Raw | ConvertFrom-Json
  if (-not $cjson.mcpServers) { $cjson | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) -Force }
  $cjson.mcpServers | Add-Member -NotePropertyName 'gemini-cli' -NotePropertyValue ([pscustomobject]@{ type='stdio'; command='npx'; args=@('-y','@choplin/mcp-gemini-cli','--allow-npx'); env=[pscustomobject]@{ GEMINI_API_KEY=$geminiKey; GEMINI_CLI_TRUST_WORKSPACE='true' } }) -Force
  ($cjson | ConvertTo-Json -Depth 20) | Set-Content $cj -Encoding UTF8
  OK "gemini-cli MCP 登録完了"
} catch { Warn "MCP登録に失敗(後で会社担当に相談)" }

# --- Codex ログイン案内(最後の1操作) ---
Say "`n============================================================" 'Green'
Say " ほぼ完了！ 最後に『Codexのログイン』1つだけお願いします" 'Green'
Say "============================================================" 'Green'
Say @"
Codex(コードを速く安く作るツール・無料枠)を使うにはログインが要ります。
このあと Codex のログイン画面を起動します。ブラウザが開いたら ChatGPT アカウントでログインしてください。
(ログインが終わったら、その画面は閉じてOKです)
"@ 'Gray'
$doCodex = Read-Host "Codexのログインを今すぐ始めますか? (y/n)"
if ($doCodex -eq 'y' -or $doCodex -eq 'Y') {
  try { Start-Process -FilePath 'cmd.exe' -ArgumentList '/k','codex' } catch { Warn "起動できませんでした。PowerShellに codex と打って手動でログインしてください" }
} else { Say "  後で: PowerShellに『codex』と打てばログインできます。" 'Gray' }

Say "`nセットアップ完了。次にClaude Codeを開くと、共通ルール自動更新・日次コスト報告・使い過ぎチェックが自動で回ります。" 'Green'
Say "分からないことがあれば、この画面の内容をそのまま kim に送ってください。ウィンドウは閉じて大丈夫です。" 'Green'
