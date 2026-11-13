' The startup shortcut shares the watchdog lock with the scheduled task.
' This avoids launching a second Next server after the boot watchdog repaired it.
Option Explicit
Dim sh, userRoot, programRoot, runner, watchdog, command
Set sh = CreateObject("WScript.Shell")
userRoot = sh.ExpandEnvironmentStrings("%USERPROFILE%")
programRoot = sh.ExpandEnvironmentStrings("%ProgramFiles%")
runner = userRoot & "\.claude\tools\run-hidden.vbs"
watchdog = userRoot & "\.claude\nightly-repo\tools\secretary-uptime.mjs"
command = "wscript.exe //nologo """ & runner & """ """ & programRoot & "\nodejs\node.exe"" """ & watchdog & """"
sh.Run command, 0, False
