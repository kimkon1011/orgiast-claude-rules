# Stop hook: コード変更を「完了」と報告しているのに、そのコードを"実行テスト"した痕跡が無い場合に注意を促す(§1.18/§1.4)。
# 目的: 文字化け・構文エラー・二重実行等の初歩的バグを、テストせず「完了」と言って出す事故を減らす。
# 動作: 直近ウィンドウで ①完了報告の語彙 ②コードファイルのEdit/Write ③実行テストの痕跡なし が揃ったら decision=block でテストを促す。
# 解除: 応答に [TESTED](テスト済み) または [NO-TEST-OK](軽微でテスト不要) を含めれば通る。stop_hook_active中はskip(ループ防止)。
$ErrorActionPreference = 'Stop'
try { [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}

$reader = New-Object System.IO.StreamReader -ArgumentList ([Console]::OpenStandardInput()), ([System.Text.UTF8Encoding]::new($false))
$stdin = $reader.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($stdin)) { exit 0 }
try { $data = $stdin | ConvertFrom-Json } catch { exit 0 }
if ($data.stop_hook_active) { exit 0 }
$tp = $data.transcript_path
if ([string]::IsNullOrWhiteSpace($tp) -or -not (Test-Path $tp)) { exit 0 }

# 直近ウィンドウ(現在ターン相当)を走査
$lines = Get-Content -Path $tp -Encoding UTF8 -Tail 60
$assistantText = ''
$codeEdited = $false
$editedName = ''
$testRun = $false

$codeExt = @('.ts','.tsx','.js','.jsx','.mjs','.cjs','.py','.go','.rs','.java','.gs','.vue','.svelte','.php','.rb','.cs')
$excl = @('\memory\','\.claude\','rules-extracted','onboarding-compress','\docs\','node_modules','\tools\','\.git\','scratchpad','.test.','.spec.','\test\','\tests\')

foreach ($ln in $lines) {
  $e = $null; try { $e = $ln | ConvertFrom-Json } catch { continue }
  if (-not $e.message -or -not $e.message.content) { continue }
  foreach ($b in $e.message.content) {
    if ($b.type -eq 'text' -and $b.text) { $assistantText += "`n" + $b.text }
    if ($b.type -eq 'tool_use') {
      $nm = [string]$b.name
      if ($nm -match '^(Edit|Write|MultiEdit)$') {
        $fp = ([string]$b.input.file_path).ToLower()
        if ($fp) {
          $isExcl = $false; foreach ($x in $excl) { if ($fp.Contains($x)) { $isExcl = $true; break } }
          $ext = [System.IO.Path]::GetExtension($fp)
          if (-not $isExcl -and ($codeExt -contains $ext)) { $codeEdited = $true; $editedName = [System.IO.Path]::GetFileName($fp) }
        }
      }
      if ($nm -eq 'Bash') {
        $cmd = [string]$b.input.command
        if ($cmd -match '(?i)(\bnode\b|\bpython3?\b|\bpwsh\b|\bpowershell\b|npm (test|run)|\btsc\b|pytest|vitest|jest|--dry[-_]?run|\bcurl\b|Invoke-RestMethod|Invoke-WebRequest|go test|cargo test|-Force|ParseFile|--noEmit)') { $testRun = $true }
      }
    }
  }
}

if ([string]::IsNullOrWhiteSpace($assistantText)) { exit 0 }
# 解除タグ
if ($assistantText -match '\[TESTED\]' -or $assistantText -match '\[NO-TEST-OK\]') { exit 0 }
# 完了報告の語彙(コード変更の文脈)
$doneVocab = $assistantText -match '(完了|できました|直しました|修正しました|実装しました|反映しました|デプロイ|deployed|push(しました|済)|fixに|バグ.*修正|動くように)'
if (-not $doneVocab) { exit 0 }

# 条件成立: 完了報告 + コード編集あり + 実行テスト痕跡なし
if ($codeEdited -and -not $testRun) {
  $reason = @"
[VERIFY-BEFORE-DONE] コード($editedName 等)を変更して「完了」と報告していますが、この直近ターンに"実際に実行してテストした痕跡"が見当たりません(§1.18/§1.4)。

出す前に必ず実行して確認してください:
  - スクリプト: 実際に走らせて出力を目視(文字化け・構文エラー・二重実行/重複送信・空出力が無いか)
  - 型/ビルド: tsc --noEmit / ParseFile 等
  - 送信・DB系: read-back で結果確認
  - Codexに実装させた場合も、Claude側で実行テストして結果を見て直すまでが1タスク

テスト済みなら応答に [TESTED] を、テスト不要な軽微変更(typo/コメント等)なら [NO-TEST-OK] を(理由付きで)含めれば通ります。
"@
  $out = @{ decision = 'block'; reason = $reason } | ConvertTo-Json -Compress -Depth 3
  Write-Output $out
  exit 0
}
exit 0
