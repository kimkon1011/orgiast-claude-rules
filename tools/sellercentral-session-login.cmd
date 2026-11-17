@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0sellercentral-session-login.ps1"
exit /b %ERRORLEVEL%
