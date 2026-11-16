<#
.SYNOPSIS
  Discord デスクトップアプリの表示中チャット（グループDM含む）を Windows UI Automation で読み取り、
  過去分まで自動スクロールして時系列テキストに書き出す。トークン不要。Bot が入れないグループDMの履歴取得用。

.PARAMETER Chat
  開きたいチャット名（表示中チャット名との完全一致を確認する）。指定すると UIA で該当リンクを Invoke して切り替える。
  省略時は今 Discord が表示しているチャットを読む。
.PARAMETER Out
  出力ファイル（UTF-8）。省略時は %TEMP%\discord-<chat>.md
.PARAMETER MaxRounds
  上方向スクロールの最大回数（1回 = PageUp 相当×3）。既定 40。
.PARAMETER Switch
  クイックスイッチャー（Ctrl+K）の検索語。[string] で指定。省略時は '@' + $Chat を検索する。
  サイドバーにリンクが見つからなかった場合のフォールバックとして使われる。
  例: -Switch '倉庫リーダー'
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\discord-read-window.ps1 -Chat 'W2様' -Out C:\tmp\w2.md
#>
param(
  [string]$Chat = '',
  [string]$Out = '',
  [int]$MaxRounds = 40,
  [int]$StableRounds = 3,
  [string]$Switch = '',
  [int]$Recent = 0,
  [switch]$RestoreOnly
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
Add-Type -Namespace Win32 -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
'@

function Find-DiscordWindow {
  $root = $AE::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  foreach ($w in $root.FindAll($Scope::Children, $cond)) {
    if ($w.Current.Name -match 'Discord') { return $w }
  }
  return $null
}
function Warm-Up($win) {
  # Chromium は AT から問い合わせが来るまでアクセシビリティツリーを作らない。数回舐めて起こす。
  for ($i = 0; $i -lt 8; $i++) {
    $all = $win.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    if ($all.Count -gt 50) { return $true }
    Start-Sleep -Milliseconds 800
  }
  return $false
}
function Get-ByType($win, $type, $nameRegex) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $type)
  foreach ($e in $win.FindAll($Scope::Descendants, $cond)) {
    if ($e.Current.Name -match $nameRegex) { return $e }
  }
  return $null
}

# クイックスイッチャー安全装置（2026-11-11 事故対策）
# メッセージ入力欄（名前が「メッセージ」を含む Edit）にフォーカスがあると
# クリップボード貼り付け＋Enter が誤送信になるため、事前検出して中止する。
function Assert-QuickSwitcherOpen($win) {
  $edits = $win.FindAll($Scope::Descendants, (
    New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
  ))
  $hasQuickSwitcher = $false
  $messageInputFocused = $false
  foreach ($e in $edits) {
    $n = $e.Current.Name
    if ($n -match 'メッセージ|へメッセージ|Message') {
      if ($e.Current.IsKeyboardFocused) { $messageInputFocused = $true }
    } else {
      # 空または検索系の Edit = クイックスイッチャーの検索ボックス
      if ($e.Current.IsKeyboardFocused) { $hasQuickSwitcher = $true }
    }
  }
  if ($messageInputFocused) {
    throw 'QUICKSWITCHER_SAFETY: Ctrl+K が開かなかったか Discord フォーカスが外れました（メッセージ入力欄にフォーカスあり）'
  }
  if (-not $hasQuickSwitcher) {
    throw 'QUICKSWITCHER_SAFETY: クイックスイッチャーの検索ボックスが見つかりません（Ctrl+K が効かなかった可能性）'
  }
}

function Get-SidebarLink($win, $chatName) {
  $escaped = [regex]::Escape($chatName)
  # グループDMの実測名: "N件の未読、倉庫リーダー×倉庫社員(グループメッセージ), 4人のメンバー"
  # 1) Chat 名そのまま（通常DM）
  # 2) Chat 名 + (グループメッセージ)（グループDMで未読あり）
  # 3) Chat 名を含む文言（未読なし等）
  foreach ($pattern in @(
    "^$escaped$",
    "$escaped\(グループメッセージ\)",
    "の未読.*$escaped",
    "$escaped"
  )) {
    $link = Get-ByType $win ([System.Windows.Automation.ControlType]::Hyperlink) $pattern
    if ($link) { return $link }
  }
  return $null
}

$win = Find-DiscordWindow
if (-not $win) { Write-Output 'ERROR: Discord window not found (Discord デスクトップを起動しておく必要あり)'; exit 2 }
if (-not (Warm-Up $win)) { Write-Output 'ERROR: accessibility tree did not populate'; exit 3 }

if ($Chat) {
  # 常にサイドバーリンクを先に試す（-Switch の有無にかかわらず）
  $link = Get-SidebarLink $win $Chat
  if ($link) {
    $inv = $link.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $inv.Invoke()
    # Invoke 後に実際のチャット名が一致するまで最大5秒リトライ
    $matched = $false
    for ($retry = 0; $retry -lt 5; $retry++) {
      Start-Sleep -Seconds 1
      $list = Get-ByType $win ([System.Windows.Automation.ControlType]::List) 'のメッセージ$'
      if ($list) {
        $currentChat = $list.Current.Name -replace 'のメッセージ$', ''
        if ($currentChat -eq $Chat -or $currentChat -match [regex]::Escape($Chat)) { $matched = $true; break }
      }
    }
    if (-not $matched) {
      Write-Output "WARN: Invoke 後もチャット名 '$Chat' に一致しません。クイックスイッチャーにフォールバックします。"
    } else { Start-Sleep -Milliseconds 500 }
  }
  if (-not $link -or -not $matched) {
    # フォールバック: DM 一覧は仮想化リストで画面外だとリンクが無い → クイックスイッチャー Ctrl+K で検索して開く
    $hwnd = [IntPtr]$win.Current.NativeWindowHandle
    [void][Win32.Native]::ShowWindow($hwnd, 9)
    [void][Win32.Native]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 800
    if ([Win32.Native]::GetForegroundWindow() -ne $hwnd) { throw 'Discord focus unavailable' }
    [System.Windows.Forms.SendKeys]::SendWait('^k')
    Start-Sleep -Milliseconds 1000
    # ★ 安全装置: クイックスイッチャーが実際に開いたことを確認してから貼り付けに進む
    Assert-QuickSwitcherOpen $win
    # 日本語は SendKeys が不安定なのでクリップボード経由で貼る
    $qsSearch = if ($Switch) { $Switch } else { '@' + $Chat }
    $clipOk = $false
    for ($t = 0; $t -lt 5 -and -not $clipOk; $t++) {
      try { Set-Clipboard -Value $qsSearch; $clipOk = $true } catch { Start-Sleep -Milliseconds 400 }
    }
    if (-not $clipOk) { Write-Output 'ERROR: clipboard set failed'; exit 7 }
    if ([Win32.Native]::GetForegroundWindow() -ne $hwnd) { throw 'Discord focus lost' }
    # ★ 安全装置: 貼り付け直前にも再確認
    Assert-QuickSwitcherOpen $win
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 1500
    Assert-QuickSwitcherOpen $win
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Seconds 2
  }
}

$list = Get-ByType $win ([System.Windows.Automation.ControlType]::List) 'のメッセージ$'
if (-not $list) { Write-Output 'ERROR: message list not found'; exit 5 }
$chatName = $list.Current.Name -replace 'のメッセージ$', ''
Write-Output ("CHAT: " + $chatName)
if ($Chat -and -not ($chatName -eq $Chat)) {
  Write-Output "ERROR: opened chat '$chatName' does not match -Chat '$Chat' (別チャット誤読防止で中止)"; exit 6
}

if ($RestoreOnly) { exit 0 }

$itemCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
$grpCond  = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Group)

function Read-Visible($list) {
  $res = New-Object System.Collections.Generic.List[string]
  foreach ($li in $list.FindAll($Scope::Children, $itemCond)) {
    $g = $li.FindFirst($Scope::Children, $grpCond)
    $name = if ($g) { $g.Current.Name } else { $li.Current.Name }
    if (-not [string]::IsNullOrWhiteSpace($name)) { $res.Add($name) }
  }
  return $res
}

if ($Recent -gt 0) {
  $recentScroll = $null
  try { $recentScroll = $list.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern) } catch {}
  if ($recentScroll -and $recentScroll.Current.VerticallyScrollable) {
    $recentScroll.SetScrollPercent(-1, 100)
  } else {
    $list.SetFocus()
    [System.Windows.Forms.SendKeys]::SendWait('^{END}')
  }
  Start-Sleep -Milliseconds 800
}
# 収集: key -> [round, index]。後のラウンドほど古い。
$seen = @{}
$order = New-Object System.Collections.Generic.List[object]
$stable = 0
$scroll = $null
try { $scroll = $list.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern) } catch {}
for ($round = 0; $round -lt $MaxRounds; $round++) {
  $vis = Read-Visible $list
  $new = 0; $idx = 0
  foreach ($m in $vis) {
    if (-not $seen.ContainsKey($m)) { $seen[$m] = $true; $order.Add([pscustomobject]@{ r = $round; i = $idx; t = $m }); $new++ }
    $idx++
  }
  Write-Output ("round $round visible=" + $vis.Count + " new=$new total=" + $order.Count)
  if ($new -eq 0) { $stable++; if ($stable -ge $StableRounds) { break } } else { $stable = 0 }
  if ($Recent -gt 0 -and $order.Count -ge $Recent) { break }
  # 上へスクロール
  if ($scroll -and $scroll.Current.VerticallyScrollable) {
    for ($k = 0; $k -lt 3; $k++) { $scroll.ScrollVertical([System.Windows.Automation.ScrollAmount]::LargeDecrement) }
  } else {
    $list.SetFocus()
    [System.Windows.Forms.SendKeys]::SendWait('{PGUP}{PGUP}{PGUP}')
  }
  Start-Sleep -Milliseconds 1500
}

$sorted = $order | Sort-Object @{Expression='r';Descending=$true}, @{Expression='i';Descending=$false}
if ($Recent -gt 0) { $sorted = @($sorted | Select-Object -Last $Recent) }
if (-not $Out) { $safe = ($chatName -replace '[\\/:*?"<>|\s]', '_'); $Out = Join-Path $env:TEMP "discord-$safe.md" }
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("# Discord: $chatName")
$lines.Add("取得: " + (Get-Date -Format 'yyyy-MM-dd HH:mm') + " / 件数: " + $sorted.Count + " / 経路: UI Automation (読み取り専用)")
$lines.Add('')
foreach ($o in $sorted) { $lines.Add('- ' + $o.t) }
$lines | Out-File -FilePath $Out -Encoding utf8
Write-Output ("OUT: $Out (" + $sorted.Count + " messages)")

# 読み取り中のスクロールキーが入力欄に効くと、Discord は直前投稿を編集モードにする。
# 編集モードのまま終えると次の操作が意図しない編集になるため、検出したら Esc で解除する。
try {
  $inEdit = $false
  foreach ($e in $win.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($e.Current.Name -match 'Escキーでキャンセル') { $inEdit = $true; break }
  }
  if ($inEdit) {
    $hwnd2 = [IntPtr]$win.Current.NativeWindowHandle
    [void][Win32.Native]::ShowWindow($hwnd2, 9)
    [void][Win32.Native]::SetForegroundWindow($hwnd2)
    Start-Sleep -Milliseconds 500
    if ([Win32.Native]::GetForegroundWindow() -eq $hwnd2) {
      [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
      Start-Sleep -Milliseconds 500
      $stillEdit = $false
      foreach ($e in $win.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($e.Current.Name -match 'Escキーでキャンセル') { $stillEdit = $true; break }
      }
      if ($stillEdit) { Write-Output 'WARN: edit mode remains after Esc' } else { Write-Output 'EDITMODE: cleared' }
    } else { Write-Output 'WARN: edit mode detected but Discord is not foreground' }
  }
} catch { Write-Output 'WARN: edit-mode check failed' }
