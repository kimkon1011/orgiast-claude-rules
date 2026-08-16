# verify-setup.ps1 — オージャストAI設定が"全部ちゃんと適用されたか"を1コマンドで検証する。
# 使い方(青いPowerShellに貼る): 下の1行 or  powershell -File verify-setup.ps1
# 各項目を ✅/❌ で表示。❌があれば配布コマンドを再実行すれば直る(既存はスキップ)。会話内容は一切読まない。
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$H = $env:USERPROFILE
$ok = 0; $ng = 0
function Chk($name, $cond) { if ($cond) { $s = 'OK '; $script:ok++ } else { $s = 'NG '; $script:ng++ }; Write-Host ("[{0}] {1}" -f $s, $name) }
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }

Write-Host "===== オージャストAI設定 総合チェック ====="
# 前提ツール
Chk 'git 導入' (Have git)
Chk 'Node.js 導入' (Have node)
# ルールリポ
$repo = @("$H\orgiast-claude-rules", "$H\Downloads\orgiast-claude-rules") | Where-Object { Test-Path $_ } | Select-Object -First 1
Chk 'ルールリポ取得' ([bool]$repo)
# 共通ルール取込
$cm = "$H\.claude\CLAUDE.md"
# 照合はASCIIトークンで(PS5.1がUTF-8日本語を誤読して誤検知するのを回避)
Chk '共通ルール取込(CLAUDE.md)' ((Test-Path $cm) -and ((Get-Content $cm -Raw -ErrorAction SilentlyContinue) -match 'orgiast'))
# 各種キー
Chk 'コスト報告Webhook' (Test-Path "$H\.claude\cost-reporter.env")
foreach ($k in 'manus.env', 'deepseek.env', 'xai.env', 'openrouter.env', 'groq.env', 'mistral.env') { Chk ("キー: $k") (Test-Path "$H\.claude\$k") }
Chk 'Geminiキー(~/.gemini/.env)' ((Test-Path "$H\.gemini\.env") -and ((Get-Content "$H\.gemini\.env" -Raw -ErrorAction SilentlyContinue) -match 'GEMINI_API_KEY=.'))
# hooks配置
foreach ($hk in 'onboarding-sync.ps1', 'pretooluse-delegation-warn.ps1', 'verify-before-done-detector.ps1', 'cost-loop.ps1') { Chk ("hook配置: $hk") (Test-Path "$H\.claude\hooks\$hk") }
# settings.json 登録
$sraw = Get-Content "$H\.claude\settings.json" -Raw -ErrorAction SilentlyContinue
Chk 'SessionStart: 共通ルール自動更新' ($sraw -match 'onboarding-sync')
Chk 'SessionStart: 日次コスト報告' ($sraw -match 'claude-cost-reporter')
Chk 'SessionStart: 委譲/使い過ぎチェック' ($sraw -match 'tool-adoption-check')
Chk 'SessionStart: コスト×作業量ループ' ($sraw -match 'cost-loop')
Chk 'PreToolUse: 委譲警告/ハードブロック' ($sraw -match 'pretooluse-delegation-warn')
Chk 'Stop: テスト忘れ防止' ($sraw -match 'verify-before-done')
# Gemini MCP
Chk 'Gemini MCP 登録(.claude.json)' ((Get-Content "$H\.claude.json" -Raw -ErrorAction SilentlyContinue) -match 'gemini-cli')
# 夜間バッチ定時タスク
Chk '夜間バッチ 定時タスク(毎日03:00)' ([bool](Get-ScheduledTask -TaskName OrgiastNightlyBatch -ErrorAction SilentlyContinue))
# 開発CLI
Chk 'Codex CLI 導入' (Have codex)
# Codexログイン(auth.jsonにトークン)
$auth = "$H\.codex\auth.json"; $li = $false
if (Test-Path $auth) { try { $li = [bool](((Get-Content $auth -Raw) | ConvertFrom-Json).tokens.id_token) } catch {} }
Chk 'Codexログイン済(auth.jsonにトークン)' $li

Write-Host ("`n===== 結果: OK {0} / NG {1} =====" -f $ok, $ng)
if ($ng -gt 0) { Write-Host "NG項目は、青いPowerShellで配布コマンドを再実行すれば直ります(既存はスキップ=二重にならない)。Codexログインだけは codex login で。" }
else { Write-Host "全項目OK。セットアップは完全に適用されています。" }
