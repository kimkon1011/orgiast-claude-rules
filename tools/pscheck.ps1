# 配布する .ps1 の構文と文字コードを検査する。
#
# なぜ必要か: 2026-08-28、install-orgiast.ps1 に JS/bash の癖で `\"` を書いた行が入り
# (PowerShell の文字列エスケープはバックスラッシュではなくバッククォート)、
# 文字列がそこで終わってパースエラーになった。CI は .mjs を node --check していたが
# .ps1 は素通しだったため、構文エラーのインストーラが全メンバーPCへ配布された。
#
# なぜ Windows PowerShell 5.1 で走らせる必要があるか: PowerShell 7 は BOM なし UTF-8 を
# 正しく読むので、日本語入り .ps1 が BOM 無しでも 7 では通ってしまう。
# メンバーPCの既定は 5.1 で、5.1 は BOM が無いと CP932 と誤読して日本語が化け、
# 化けた結果がトークンとして解釈されてパースエラーになる(audit.ps1 の実例)。
# 5.1 で検査しないと、この経路の事故を CI がすり抜ける。
param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$sep = [IO.Path]::DirectorySeparatorChar
$gitDir = "$sep.git$sep"
$fail = 0

Get-ChildItem -Path $Root -Recurse -Filter *.ps1 |
  Where-Object { -not $_.FullName.Contains($gitDir) } |
  Sort-Object FullName |
  ForEach-Object {
    $path = $_.FullName
    $rel = $path.Substring($Root.Length).TrimStart($sep)
    $problems = @()

    # 1) 日本語を含む .ps1 は UTF-8 BOM 必須(5.1 の CP932 誤読を防ぐ)
    $bytes = [IO.File]::ReadAllBytes($path)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $text = [Text.Encoding]::UTF8.GetString($bytes)
    $hasNonAscii = $text -match '[^\x00-\x7F]'
    if ($hasNonAscii -and -not $hasBom) {
      $problems += 'UTF-8 BOM がない(日本語を含む .ps1 は BOM 必須。PS5.1 が CP932 と誤読して化ける)'
    }

    # 2) 構文チェック
    $errs = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$errs)
    if ($errs -and $errs.Count -gt 0) {
      $problems += ("パースエラー {0}件 / 先頭 line {1}: {2}" -f $errs.Count, $errs[0].Extent.StartLineNumber, $errs[0].Message)
    }

    if ($problems.Count -gt 0) {
      $fail++
      Write-Output ("FAIL {0}" -f $rel)
      foreach ($p in $problems) { Write-Output ("       - {0}" -f $p) }
    } else {
      Write-Output ("ok   {0}" -f $rel)
    }
  }

Write-Output ("=== .ps1 検査: 失敗 {0} ファイル ===" -f $fail)
if ($fail -gt 0) { exit 1 }
