param([switch]$IdleOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DmIdle {
 [StructLayout(LayoutKind.Sequential)] public struct Info { public uint size; public uint time; }
 [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref Info i);
 public static uint Milliseconds() { var i = new Info(); i.size = (uint)Marshal.SizeOf(i); if (!GetLastInputInfo(ref i)) throw new Exception("GetLastInputInfo failed"); return unchecked((uint)Environment.TickCount - i.time); }
}
'@
$idle = [DmIdle]::Milliseconds()
if ($IdleOnly -or $idle -lt 300000) { @{idleMs=$idle} | ConvertTo-Json -Compress; exit }
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$win = $null
foreach ($w in $AE::RootElement.FindAll($Scope::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
 if ($w.Current.Name -match 'Discord') { $win = $w; break }
}
if (-not $win) { throw 'Discord window not found' }
$original = ''
$unread = @()
foreach ($e in $win.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
 if ($e.Current.ControlType -eq [System.Windows.Automation.ControlType]::List -and $e.Current.Name -match 'のメッセージ$') { $original = $e.Current.Name -replace 'のメッセージ$', '' }
 if ($e.Current.ControlType -eq [System.Windows.Automation.ControlType]::Hyperlink -and $e.Current.Name -match '未読のメッセージ') {
  # DM links expose their /channels/@me/ route as AutomationId in Chromium.
  # If absent, require an explicit DM label: never inspect unread server channels.
  $name = $e.Current.Name
  $inDmList = $false
  $parent = $e
  for ($depth = 0; $depth -lt 8 -and $parent; $depth++) {
   if ($parent.Current.Name -match '^(ダイレクトメッセージ|Direct Messages)$') { $inDmList = $true; break }
   $parent = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($parent)
  }
  if ($inDmList -or $e.Current.AutomationId -match '/channels/@me/' -or $name -match 'ダイレクトメッセージ|グループメッセージ|グループDM') {
   $chat = ($name -replace '、?\s*未読のメッセージ.*$', '' -replace '[\s、,(（]*(ダイレクトメッセージ|グループメッセージ|グループDM).*$', '').Trim(' ', ',')
   if ($chat) { $unread += $chat }
  }
 }
}
@{idleMs=$idle; original=$original; unread=@($unread | Select-Object -Unique)} | ConvertTo-Json -Compress
