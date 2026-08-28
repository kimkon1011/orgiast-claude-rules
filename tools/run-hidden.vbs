' run-hidden.vbs -- run a command with NO console window at all.
'
' Why: Windows Scheduled Tasks with LogonType=Interactive show a console window
' every time they fire (kim saw a black window pop up once per hour). Switching
' the task principal to S4U ("run whether user is logged on or not") needs admin
' rights, so instead we launch through wscript.exe, which has no console host.
'
' Usage (as a scheduled task action):
'   Execute   : C:\Windows\System32\wscript.exe
'   Arguments : //nologo "<...>\tools\run-hidden.vbs" "<exe>" "<arg1>" "<arg2>" ...
'
' The child's stdout/stderr are appended to
'   %USERPROFILE%\.claude\logs\<exe-basename>.log
' (rotated at ~1 MB) so the output is still inspectable after the window is gone.
' The child's exit code is returned, so LastTaskResult stays meaningful.
'
' ASCII only on purpose: Windows script hosts on JP locale mis-decode non-BOM
' UTF-8, and this file is executed by wscript, not PowerShell.

Option Explicit

Dim args, i, inner, exePath, baseName, logDir, logPath, shell, fso, rc, full

Set args = WScript.Arguments
If args.Count < 1 Then
  WScript.Quit 2
End If

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

exePath = args(0)
baseName = fso.GetBaseName(exePath)
If args.Count >= 2 Then
  ' Prefer the script name over the interpreter name for the log file.
  baseName = fso.GetBaseName(args(1))
End If

logDir = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.claude\logs"
If Not fso.FolderExists(logDir) Then
  On Error Resume Next
  fso.CreateFolder logDir
  On Error Goto 0
End If
logPath = logDir & "\" & baseName & ".log"

' Rotate at ~1 MB so the log cannot grow without bound.
On Error Resume Next
If fso.FileExists(logPath) Then
  If fso.GetFile(logPath).Size > 1048576 Then
    If fso.FileExists(logPath & ".1") Then fso.DeleteFile logPath & ".1", True
    fso.MoveFile logPath, logPath & ".1"
  End If
End If
On Error Goto 0

inner = ""
For i = 0 To args.Count - 1
  inner = inner & """" & args(i) & """"
  If i < args.Count - 1 Then inner = inner & " "
Next

' cmd /s /c "<...>" always strips exactly the outer quotes, which keeps the
' quoting of the inner command intact regardless of spaces in paths.
full = "cmd.exe /d /s /c " & """" & inner & " >> """ & logPath & """ 2>&1" & """"

' 0 = hidden window, True = wait so the exit code can be propagated.
rc = shell.Run(full, 0, True)
WScript.Quit rc
