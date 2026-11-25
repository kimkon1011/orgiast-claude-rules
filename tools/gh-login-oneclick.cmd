@echo off
chcp 65001 >nul
setlocal DisableDelayedExpansion
set "launcher_ps=pwsh.exe"
where pwsh.exe >nul 2>nul
if errorlevel 1 set "launcher_ps=powershell.exe"
"%launcher_ps%" -NoProfile -ExecutionPolicy Bypass -File "C:\Users\kimko\.claude\tools\gh-login-oneclick.ps1"
set "launcher_result=%errorlevel%"
:result
echo Exit code: %launcher_result%
if "%launcher_result%"=="0" (echo OK) else (echo ERROR)
echo Press any key to close.
pause >nul
exit /b %launcher_result%
