# pretooluse-delegation-warn.ps1 — 監督(main loop)がアプリ実装コードを"直接"編集しようとしたら警告する(§1.18)。
# 警告方式: 絶対にブロックしない(必ず exit 0)。編集は通るが「Codexへ委譲を」とリマインドを注入する。
# 対象=アプリの実装ソース(.ts/.py 等)。対象外=memory/設定(.json/.md/.env)/ルールリポ/docs/tools/node_modules/テスト。
# stdin(UTF-8) から PreToolUse の JSON を受け取る。
# 出力も必ず UTF-8(BOM無し)で。JP Windows 既定コードページだと日本語/絵文字が文字化けするため。
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
try {
  $stdin = [Console]::OpenStandardInput()
  $reader = New-Object System.IO.StreamReader -ArgumentList $stdin, ([System.Text.UTF8Encoding]::new($false))
  $raw = $reader.ReadToEnd()
  if (-not $raw) { exit 0 }
  $j = $raw | ConvertFrom-Json
  $tool = [string]$j.tool_name
  if ($tool -notmatch '^(Write|Edit|MultiEdit)$') { exit 0 }
  $fp = [string]$j.tool_input.file_path
  if (-not $fp) { exit 0 }
  $lower = $fp.ToLower()

  # 対象外パス(実装コードでない/触ってよいもの)
  $exclude = @('\memory\','\.claude\','rules-extracted','onboarding-compress','\docs\','node_modules','\tools\','\.git\','scratchpad','\test\','\tests\','\__tests__\','.test.','.spec.','.stories.')
  foreach ($x in $exclude) { if ($lower.Contains($x)) { exit 0 } }

  # アプリ実装コードの拡張子のみ対象(設定/ドキュメント/データは対象外)
  $codeExt = @('.ts','.tsx','.js','.jsx','.mjs','.cjs','.py','.go','.rs','.java','.gs','.vue','.svelte','.php','.rb','.cs','.kt','.swift')
  $ext = [System.IO.Path]::GetExtension($lower)
  if ($codeExt -notcontains $ext) { exit 0 }

  $name = [System.IO.Path]::GetFileName($fp)
  $msg = "⚠️ 委譲規律(§1.18): これはアプリ実装コード($name)の直接編集です。監督(main loop)は大きな実装を手打ちせず、原則 Codex(定額枠)へ委譲してください。ごく短い修正(数行/typo/import)なら続行可。まとまった実装なら、この編集を止めて `codex exec` に投げ、結果を verify する方が安く速く正確です。"
  $out = @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; additionalContext = $msg } } | ConvertTo-Json -Compress
  Write-Output $out
} catch {
  # 何があってもブロックしない(警告方式)
}
exit 0
