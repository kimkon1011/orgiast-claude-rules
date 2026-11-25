# pretooluse-delegation-warn.ps1 — 監督(main loop)がアプリ実装コードを"直接"編集しようとしたら警告する(§1.18)。
# 警告方式: 絶対にブロックしない(必ず exit 0)。編集は通るが「Codexへ委譲を」とリマインドを注入する。
# stdin(UTF-8) から PreToolUse の JSON を受け取り、出力も UTF-8(BOM無し)にする。
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

  # 対象外パス(実装コードでない/監督が直接触ってよいもの)
  $exclude = @('\memory\','settings.json','.bak','rules-extracted','onboarding-compress','\docs\','node_modules','\.git\','scratchpad','\test\','\tests\','\__tests__\','.test.','.spec.','.stories.')
  foreach ($x in $exclude) { if ($lower.Contains($x)) { exit 0 } }

  # アプリ実装コードの拡張子のみ対象(設定/ドキュメント/データは対象外)
  $codeExt = @('.ts','.tsx','.js','.jsx','.mjs','.cjs','.ps1','.py','.go','.rs','.java','.gs','.vue','.svelte','.php','.rb','.cs','.kt','.swift')
  $ext = [System.IO.Path]::GetExtension($lower)
  if ($codeExt -notcontains $ext) { exit 0 }

  # 実際に追加する内容を合算し、短い修正は警告しない。
  $parts = @()
  if ($tool -eq 'Write') {
    $parts += [string]$j.tool_input.content
  } elseif ($tool -eq 'Edit') {
    $parts += [string]$j.tool_input.new_string
  } else {
    foreach ($edit in @($j.tool_input.edits)) { $parts += [string]$edit.new_string }
  }
  $charCount = 0
  $lineCount = 0
  foreach ($part in $parts) {
    $charCount += $part.Length
    if ($part.Length -gt 0) { $lineCount += @($part -split "`r?`n").Count }
  }
  if ($lineCount -lt 60 -and $charCount -lt 2500) { exit 0 }

  $name = [System.IO.Path]::GetFileName($fp)
  $msg = "⚠️ 委譲規律(§1.18): アプリ実装コード($name) を $lineCount 行 直接書き込もうとしています。この規模は Codex(定額枠)へ委譲すべき規模です。監督(main loop)は実装を手打ちせず、`codex exec` に投げて結果を verify してください。"
  $out = @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; additionalContext = $msg } } | ConvertTo-Json -Compress -Depth 5
  Write-Output $out
} catch {
  # 例外時もユーザー操作をブロックしない。
}
exit 0
