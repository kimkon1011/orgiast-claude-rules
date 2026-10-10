@echo off
node "%~dp0recover-overlay.mjs"
if errorlevel 1 (echo Recovery failed. See error above.) else (echo Recovery verified.)
pause
