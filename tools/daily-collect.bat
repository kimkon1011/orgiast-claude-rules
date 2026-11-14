@echo off
REM Public procurement daily collection batch
REM Scheduled at 06:00 every morning via Task Scheduler
REM Usage: C:\Users\kimko\orgiast-bid\tools\daily-collect.bat

cd /d C:\Users\kimko\orgiast-bid
echo [%date% %time%] === Daily collection start === >> data\daily-collect.log
node tools\collect.mjs >> data\daily-collect.log 2>&1
set RET=%errorlevel%
echo [%date% %time%] === Done === >> data\daily-collect.log
exit /b %RET%