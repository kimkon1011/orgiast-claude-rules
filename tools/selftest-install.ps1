# selftest-install.ps1 — install-orgiast.ps1 の「環境依存で壊れやすい部分」を"まっさらPC"を模擬して自動検証するゲート。
# 目的: 開発機の既存状態に頼らず、新規環境で出るバグ(ファイル無し/巨大JSON/param束縛)を配布前に機械的に潰す
#       ([[feedback-test-under-real-runtime-conditions]] の機械化)。install-orgiast.ps1 を変更したら必ず本テストを緑にしてから配布。
# 注意: winget/npm/codex login/自動再起動 等の破壊的・対話的部分は実機(ユーザー通し実行)で確認する範囲。ここは純ロジックの回帰テスト。
# ※ここのロジックは install-orgiast.ps1 の該当箇所と同一に保つこと(乖離させない)。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$pass = 0; $fail = 0
function Assert($name, $cond) { if ($cond) { $script:pass++; Write-Host "[PASS] $name" } else { $script:fail++; Write-Host "[FAIL] $name" } }
$root = Join-Path $env:TEMP ('selftest-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $root | Out-Null

# ---- install-orgiast.ps1 と同一の2ロジックを関数化(乖離防止のためコメントで同期を明記) ----
function Resolve-GeminiKey($HOMEDIR, $ParamKey, $EnvKey) {
  $geminiKey = ''
  $gEnv = Join-Path $HOMEDIR '.gemini\.env'
  if (Test-Path $gEnv) { $line = (Get-Content $gEnv | Where-Object { $_ -like 'GEMINI_API_KEY=*' } | Select-Object -First 1); if ($line) { $geminiKey = $line.Split('=', 2)[1] } }
  $embedKey = if ($ParamKey) { $ParamKey } elseif ($EnvKey) { $EnvKey } else { '' }
  if (-not $geminiKey -and $embedKey) {
    $geminiKey = $embedKey.Trim()
    New-Item -ItemType Directory -Force -Path (Split-Path $gEnv) | Out-Null
    "GEMINI_API_KEY=$geminiKey`r`nGEMINI_CLI_TRUST_WORKSPACE=true" | Set-Content $gEnv -Encoding UTF8
  }
  return $geminiKey  # 空なら本番ではプロンプトへ
}
function Register-Mcp($cj, $geminiKey) {
  $mcpVal = @{ type = 'stdio'; command = 'npx'; args = @('-y', '@choplin/mcp-gemini-cli', '--allow-npx'); env = @{ GEMINI_API_KEY = $geminiKey; GEMINI_CLI_TRUST_WORKSPACE = 'true' } }
  if (-not (Test-Path $cj)) { '{}' | Set-Content $cj -Encoding UTF8 }
  $raw = Get-Content $cj -Raw; if (-not $raw -or -not $raw.Trim()) { $raw = '{}' }
  $done = $false
  try {
    $cjson = $raw | ConvertFrom-Json
    if (-not $cjson.mcpServers) { $cjson | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) -Force }
    $cjson.mcpServers | Add-Member -NotePropertyName 'gemini-cli' -NotePropertyValue ([pscustomobject]$mcpVal) -Force
    [System.IO.File]::WriteAllText($cj, ($cjson | ConvertTo-Json -Depth 100), (New-Object System.Text.UTF8Encoding($false)))
    $done = $true
  } catch { }
  if (-not $done) {
    Add-Type -AssemblyName System.Web.Extensions
    $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer; $ser.MaxJsonLength = [int]::MaxValue
    $obj = $ser.DeserializeObject($raw); if ($null -eq $obj) { $obj = @{} }
    if (-not $obj.ContainsKey('mcpServers') -or $null -eq $obj['mcpServers']) { $obj['mcpServers'] = @{} }
    $obj['mcpServers']['gemini-cli'] = $mcpVal
    [System.IO.File]::WriteAllText($cj, $ser.Serialize($obj), (New-Object System.Text.UTF8Encoding($false)))
  }
}
function NoBom($f) { $b = [System.IO.File]::ReadAllBytes($f); return -not ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) }

Write-Host "=== まっさらPC模擬テスト ==="
# 1. 新規PC(既存.gemini無し)+埋込キー → 自動解決・書込・プロンプト行きにならない
$h1 = Join-Path $root 'home_new'; New-Item -ItemType Directory -Force $h1 | Out-Null
$k1 = Resolve-GeminiKey $h1 '' 'AQ.EMBED_NEW'
Assert 'Gemini: 新規PCで埋込キーを自動解決(空でない=プロンプト回避)' ($k1 -eq 'AQ.EMBED_NEW')
Assert 'Gemini: 新規PCで.gemini/.envに書込まれた' (Test-Path (Join-Path $h1 '.gemini\.env'))

# 2. 既存.gemini優先(埋込より既存)
$h2 = Join-Path $root 'home_exist'; New-Item -ItemType Directory -Force (Join-Path $h2 '.gemini') | Out-Null
"GEMINI_API_KEY=AQ.EXISTING`r`nGEMINI_CLI_TRUST_WORKSPACE=true" | Set-Content (Join-Path $h2 '.gemini\.env') -Encoding UTF8
$k2 = Resolve-GeminiKey $h2 'AQ.EMBED' 'AQ.ENV'
Assert 'Gemini: 既存キーが埋込より優先' ($k2 -eq 'AQ.EXISTING')

# 3. 埋込も既存も無い → 空(本番でプロンプト=正しい挙動)
$h3 = Join-Path $root 'home_none'; New-Item -ItemType Directory -Force $h3 | Out-Null
$k3 = Resolve-GeminiKey $h3 '' ''
Assert 'Gemini: キー全く無しは空を返す(プロンプト経路が正しく残る)' ($k3 -eq '')

# 4. MCP: 小さいclaude.json(既存mcpServers.other)→ gemini-cli追加・other保持・BOM無し
$cjS = Join-Path $root 'small.json'
'{"numStartups":5,"mcpServers":{"other":{"command":"x"}}}' | Set-Content $cjS -Encoding UTF8
Register-Mcp $cjS 'AQ.S'
$pS = Get-Content $cjS -Raw | ConvertFrom-Json
Assert 'MCP小: gemini-cli登録' ($null -ne $pS.mcpServers.'gemini-cli')
Assert 'MCP小: 既存other保持' ($null -ne $pS.mcpServers.other)
Assert 'MCP小: numStartups保持' ($pS.numStartups -eq 5)
Assert 'MCP小: BOM無し' (NoBom $cjS)

# 5. MCP: 2MB超claude.json(PS5.1 ConvertFrom-Json上限)→ JavaScriptSerializerフォールバックで成功
$cjL = Join-Path $root 'large.json'
$sb = New-Object System.Text.StringBuilder
[void]$sb.Append('{"numStartups":9,"pad":"'); [void]$sb.Append(('x' * 2500000)); [void]$sb.Append('","mcpServers":{"other":{"command":"y"}}}')
[System.IO.File]::WriteAllText($cjL, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
Register-Mcp $cjL 'AQ.L'
Add-Type -AssemblyName System.Web.Extensions
$serL = New-Object System.Web.Script.Serialization.JavaScriptSerializer; $serL.MaxJsonLength = [int]::MaxValue
$pL = $serL.DeserializeObject((Get-Content $cjL -Raw))
Assert 'MCP大(2MB+): gemini-cli登録' ($pL['mcpServers'].ContainsKey('gemini-cli'))
Assert 'MCP大: 既存other保持' ($pL['mcpServers'].ContainsKey('other'))
Assert 'MCP大: numStartups保持' ($pL['numStartups'] -eq 9)
Assert 'MCP大: BOM無し(NodeのJSON.parseが壊れない)' (NoBom $cjL)

# 6. MCP: claude.json自体が無い新規PC → 生成して登録
$cjN = Join-Path $root 'none.json'
Register-Mcp $cjN 'AQ.N'
$pN = Get-Content $cjN -Raw | ConvertFrom-Json
Assert 'MCP無ファイル: 生成してgemini-cli登録' ($null -ne $pN.mcpServers.'gemini-cli')

Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "`n=== 結果: PASS=$pass FAIL=$fail ==="
if ($fail -gt 0) { Write-Host 'FAILあり: 配布してはいけない'; exit 1 } else { Write-Host '全緑: 環境依存ロジックは新規PCでも安全' }
