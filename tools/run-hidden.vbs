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
Dim lockedLog, ts, primaryLock, primaryReserved, staleRecovered

' Reserve the primary log before testing it: two simultaneous task names can
' otherwise both pass CanAppendTo and race at cmd's redirection open.
Function ReservePrimary(fs, lockPath, ByRef recovered)
  Dim lockFolder
  recovered = False
  On Error Resume Next
  Err.Clear
  fs.CreateFolder lockPath
  If Err.Number = 0 Then
    ReservePrimary = True
    On Error Goto 0
    Exit Function
  End If

  Err.Clear
  If fs.FolderExists(lockPath) Then
    Set lockFolder = fs.GetFolder(lockPath)
    If Err.Number = 0 Then
      If DateDiff("s", lockFolder.DateCreated, Now) > 7200 Then
        Err.Clear
        fs.DeleteFolder lockPath, True
        If Err.Number = 0 Then
          Err.Clear
          fs.CreateFolder lockPath
          If Err.Number = 0 Then recovered = True
        End If
      End If
    End If
  End If
  ReservePrimary = recovered
  On Error Goto 0
End Function

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

Set args = WScript.Arguments
If args.Count < 1 Then
  WScript.Quit 2
End If

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

exePath = args(0)
baseName = fso.GetBaseName(exePath)

' Prefer the target script name over the interpreter or bootstrap wrapper.
For i = 1 To args.Count - 1
  If LCase(fso.GetExtensionName(args(i))) = "ps1" Or _
      LCase(fso.GetExtensionName(args(i))) = "mjs" Or _
      LCase(fso.GetExtensionName(args(i))) = "js" Then
    If LCase(fso.GetFileName(args(i))) <> "nightly-bootstrap.ps1" Then
      baseName = fso.GetBaseName(args(i))
      Exit For
    End If
  End If
Next

logDir = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.claude\logs"
If Not fso.FolderExists(logDir) Then
  On Error Resume Next
  fso.CreateFolder logDir
  On Error Goto 0
End If
logPath = logDir & "\" & baseName & ".log"
primaryLock = logPath & ".runner-lock"
primaryReserved = ReservePrimary(fso, primaryLock, staleRecovered)

' Rotate at ~1 MB so the log cannot grow without bound.
On Error Resume Next
If primaryReserved And fso.FileExists(logPath) Then
  If fso.GetFile(logPath).Size > 1048576 Then
    If fso.FileExists(logPath & ".1") Then fso.DeleteFile logPath & ".1", True
    fso.MoveFile logPath, logPath & ".1"
  End If
End If
On Error Goto 0

If staleRecovered Then
  On Error Resume Next
  Set ts = fso.OpenTextFile(logPath, 8, True)
  If Err.Number = 0 Then
    ts.WriteLine "run-hidden: stale primary lock recovered: " & primaryLock
    ts.Close
  End If
  On Error Goto 0
End If

' If a leftover child still holds a handle on the log, cmd's ">>" would fail
' and the job would never start. Switch to a sibling log and say why in it.
If Not primaryReserved Or Not CanAppendTo(fso, logPath) Then
  ' Include a random suffix: several fallback writers may start in one second.
  lockedLog = logDir & "\" & baseName & ".locked-" & Timestamp() & "-" & fso.GetBaseName(fso.GetTempName) & ".log"
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
If primaryReserved Then
  On Error Resume Next
  fso.DeleteFolder primaryLock
  On Error Goto 0
End If
WScript.Quit rc
