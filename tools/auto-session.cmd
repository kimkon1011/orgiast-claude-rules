@echo off
REM Orgiast auto-session runner - double-click to run one unattended TODO session.
REM ASCII only on purpose: a .cmd with non-ASCII bytes breaks under CP932 and
REM silently does nothing when double-clicked.
setlocal
cd /d "%~dp0.."
echo === Orgiast auto-session ===
echo Repo: %CD%
echo.
echo [1/2] Listing TODOs from next-session.md ...
node "tools\auto-session.mjs" --list
echo.
echo [2/2] Running one unattended session (timeout 40 min) ...
node "tools\auto-session.mjs" --count 1 --timeout-min 40
echo.
echo Exit code: %ERRORLEVEL%
echo Logs: %USERPROFILE%\.claude\auto-session\runs
echo.
pause
