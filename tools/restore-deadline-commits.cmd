@echo off
node "%~dp0restore-deadline-commits.mjs"
if errorlevel 1 pause
