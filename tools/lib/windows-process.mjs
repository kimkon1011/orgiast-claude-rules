// Shared Win32_Process enumeration; one CIM query per snapshot.
export const WINDOWS_PROCESS_SCRIPT = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
$separator=[char]31
Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object {
  $commandLine=[string]$_.CommandLine
  $commandLine=$commandLine.Replace([char]13,' ').Replace([char]10,' ')
  $fields=@([string]$_.ProcessId,[string]$_.ParentProcessId,$_.CreationDate.ToUniversalTime().ToString('o'),[string]$_.WorkingSetSize,[string]$_.Name,$commandLine)
  ($fields -join $separator)
}`;
