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
'   %USERPROFILE%\.claude\logs\<target-script-basename>.log
' (rotated at ~1 MB) so the output is still inspectable after the window is gone.
' The child's exit code is returned, so LastTaskResult stays meaningful.
'
' 2026-10-26..29: a hung descendant kept an inherited handle on the log, so
' cmd's ">>" failed and the job never started (task rc=1 nightly). We now
' test-append first and fall back to <name>.locked-<yyyymmdd-hhnnss>.log.
'
' ASCII only on purpose: Windows script hosts on JP locale mis-decode non-BOM
' UTF-8, and this file is executed by wscript, not PowerShell.

Option Explicit

Dim args, i, inner, exePath, baseName, logDir, logPath, shell, fso, rc, full
Dim lockedLog, ts, j, tokens, found

' True when path can be opened for appending right now (nobody holds a handle
' that denies it). Creates the file when missing, same as cmd's ">>" would.
Function CanAppendTo(fs, path)
  Dim t
  On Error Resume Next
  Set t = fs.OpenTextFile(path, 8, True) ' 8 = ForAppending, True = create
  CanAppendTo = (Err.Number = 0)
  On Error Goto 0
  If CanAppendTo Then t.Close
End Function

' yyyymmdd-hhnnss from Now, built from plain digits so it is locale-proof.
Function Timestamp()
  Dim n
  n = Now
  Timestamp = Right("0000" & Year(n), 4) & Right("00" & Month(n), 2) & _
      Right("00" & Day(n), 2) & "-" & Right("00" & Hour(n), 2) & _
      Right("00" & Minute(n), 2) & Right("00" & Second(n), 2)
End Function

' Returns the base name when the token looks like a runnable script, else "".
Function ScriptBaseName(fsoRef, token)
  Dim ext
  ScriptBaseName = ""
  If Len(token) = 0 Then Exit Function
  ext = LCase(fsoRef.GetExtensionName(token))
  If ext = "ps1" Or ext = "mjs" Or ext = "js" Then
    If LCase(fsoRef.GetFileName(token)) <> "nightly-bootstrap.ps1" Then
      ScriptBaseName = fsoRef.GetBaseName(token)
    End If
  End If
End Function

Set args = WScript.Arguments
If args.Count < 1 Then
  WScript.Quit 2
End If

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

exePath = args(0)
baseName = fso.GetBaseName(exePath)

' Prefer the target script name over the interpreter or bootstrap wrapper.
' Pass 1: the argument itself is the script path.
For i = 1 To args.Count - 1
  If ScriptBaseName(fso, args(i)) <> "" Then
    baseName = ScriptBaseName(fso, args(i))
    Exit For
  End If
Next

' Pass 2: the script path is embedded inside a folded argument such as
' -Command "& 'node.exe' 'C:\path\bot.mjs' --once". Split on whitespace and
' quotes, then look for a script token.
If baseName = fso.GetBaseName(exePath) Then
  For i = 1 To args.Count - 1
    found = ""
    tokens = Split(Replace(Replace(Replace(args(i), Chr(34), " "), "'", " "), vbTab, " "), " ")
    For j = 0 To UBound(tokens)
      If found = "" Then
        If ScriptBaseName(fso, tokens(j)) <> "" Then
          found = ScriptBaseName(fso, tokens(j))
        End If
      End If
    Next
    If found <> "" Then
      baseName = found
      Exit For
    End If
  Next
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

' If a leftover child still holds a handle on the log, cmd's ">>" would fail
' and the job would never start. Switch to a sibling log and say why in it.
If Not CanAppendTo(fso, logPath) Then
  lockedLog = logDir & "\" & baseName & ".locked-" & Timestamp() & ".log"
  On Error Resume Next
  Set ts = fso.OpenTextFile(lockedLog, 8, True)
  If Err.Number = 0 Then
    ts.WriteLine "run-hidden: primary log locked: " & logPath
    ts.Close
  End If
  On Error Goto 0
  logPath = lockedLog
End If

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
