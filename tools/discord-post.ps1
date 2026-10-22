param([Parameter(Mandatory)][string]$Chat, [Parameter(Mandatory)][string]$BodyFile)
# 前提: 直前に discord-read-window.ps1 で対象チャットを開いてある。開いているチャット名が $Chat と完全一致する時だけ送る。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$body = [System.IO.File]::ReadAllText($BodyFile, [System.Text.Encoding]::UTF8).TrimEnd()
# Discord の UIA テキストには見えない文字が混ざる（実測: 空行に U+FEFF、画面テキストに U+FFFC）。
# 消してから空白を1つにまとめて比べる。tools/discord-post.test.mjs がこの関数を直接検証する。
function Normalize-DiscordText([string]$s) { (($s -replace '[\uFEFF\u200B\u200C\u200D\u2060\uFFFC]', '') -replace '\s+', ' ').Trim() }
$win = $null
$cw = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
foreach ($w in $AE::RootElement.FindAll($Scope::Children, $cw)) { if ($w.Current.Name -match 'Discord') { $win = $w } }
if (-not $win) { 'ERROR: no window'; exit 2 }
Add-Type -Namespace Win32 -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int flags, int extra);
'@
$hwnd = [IntPtr]$win.Current.NativeWindowHandle
[void][Win32.Native]::ShowWindow($hwnd, 9)
# 別プロセスから前面化するため ALT を1回押して離す（フォアグラウンドロック回避の定石）
[Win32.Native]::keybd_event(0x12, 0, 0, 0); [Win32.Native]::keybd_event(0x12, 0, 2, 0)
[void][Win32.Native]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 800
if ([Win32.Native]::GetForegroundWindow() -ne $hwnd) { 'ERROR: Discord を前面にできない（誤爆防止で中止）'; exit 8 }
$lc = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::List)
$chatName = ''
foreach ($l in $win.FindAll($Scope::Descendants, $lc)) { if ($l.Current.Name -match 'のメッセージ$') { $chatName = $l.Current.Name -replace 'のメッセージ$', '' } }
"CHAT: $chatName"
if ($chatName -ne $Chat) { "ERROR: open chat '$chatName' != '$Chat'"; exit 6 }
# 入力欄は「<相手>へメッセージを送信」という Name の Edit/Document。
# 画面全体を覆う Document（ページコンテナ）も Name に「メッセージ」を含むため、名前だけで選ぶと誤認する。
# → 名前（'へメッセージ' 優先）＋ 大きさ（画面の半分を超えるものは除外）で絞る。
$winRect = $win.Current.BoundingRectangle
$box = $null
$candidates = New-Object System.Collections.Generic.List[object]
foreach ($e in $win.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
  $t = $e.Current.ControlType.ProgrammaticName
  if ($t -notmatch 'Edit|Document') { continue }
  if ($e.Current.IsOffscreen) { continue }
  $r = $e.Current.BoundingRectangle
  if ($r.Width -le 0 -or $r.Height -le 0) { continue }
  if ($r.Height -gt ($winRect.Height * 0.5) -or $r.Width -gt ($winRect.Width * 0.9)) { continue }
  if ($e.Current.Name -match 'へメッセージ') { $box = $e; break }
  $candidates.Add($e)
}
if (-not $box -and $candidates.Count -eq 1 -and $candidates[0].Current.Name -match 'メッセージ') { $box = $candidates[0] }
if (-not $box) { 'ERROR: input box not found'; exit 5 }
"BOX: " + $box.Current.ControlType.ProgrammaticName + " | " + $box.Current.Name
$cur = ''
try { $cur = $box.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern).DocumentRange.GetText(200) } catch { 'ERROR: cannot verify empty input'; exit 9 }
$cur = Normalize-DiscordText $cur
if ($cur) { "ERROR: input box not empty [$cur]（kim の下書きを壊さないため中止）"; exit 9 }
$box.SetFocus()
Start-Sleep -Milliseconds 500
Set-Clipboard -Value $body
if ((Get-Clipboard -Raw).TrimEnd() -ne $body) { 'ERROR: clipboard mismatch'; exit 7 }
if ([Win32.Native]::GetForegroundWindow() -ne $hwnd) { 'ERROR: 貼付直前に Discord が前面でない（中止）'; exit 8 }
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 1500
if ([Win32.Native]::GetForegroundWindow() -ne $hwnd) { 'ERROR: focus lost before send'; exit 8 }
$finalChat = ''
foreach ($l in $win.FindAll($Scope::Descendants, $lc)) { if ($l.Current.Name -match 'のメッセージ$') { $finalChat = $l.Current.Name -replace 'のメッセージ$', '' } }
if ($finalChat -ne $Chat) { throw 'Chat changed before send' }
$pasted = $box.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern).DocumentRange.GetText(-1)
if ((Normalize-DiscordText $pasted) -ne (Normalize-DiscordText $body)) { throw 'Pasted body mismatch; not sent' }
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Seconds 2
# 送信後 Discord が直前投稿の編集モードに入ることがある。編集モードのまま終えると、次の読み取りで
# 矢印キーが直前投稿に効いて意図しない編集になるため、検出したら Esc で解除して確認する。
try {
  $editBanner = $null
  foreach ($e in $win.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($e.Current.Name -match 'Escキーでキャンセル') { $editBanner = $e; break }
  }
  if ($editBanner -and [Win32.Native]::GetForegroundWindow() -eq $hwnd) {
    [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
    Start-Sleep -Milliseconds 500
    $still = $false
    foreach ($e in $win.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
      if ($e.Current.Name -match 'Escキーでキャンセル') { $still = $true; break }
    }
    if ($still) { 'WARN: edit mode remains after Esc' } else { 'EDITMODE: cleared' }
  }
} catch { 'WARN: edit-mode check failed' }
'SENT'
