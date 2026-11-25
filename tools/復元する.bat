@echo off
chcp 65001 >nul
where pwsh >nul 2>nul && (pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore-claude-from-drive.ps1" %*) || (powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore-claude-from-drive.ps1" %*)
pause
