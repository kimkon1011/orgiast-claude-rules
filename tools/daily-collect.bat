@echo off
REM Public procurement daily collection + pipeline
cd /d C:\Users\kimko\orgiast-bid
echo [%date% %time%] === Daily collection start === >> data\daily-collect.log
"C:\Program Files\nodejs\node.exe" tools\collect.mjs >> data\daily-collect.log 2>&1
set RET=%errorlevel%
if not %RET%==0 (
  echo [%date% %time%] === Collect failed %RET% === >> data\daily-collect.log
  exit /b %RET%
)
echo [%date% %time%] === Pipeline start === >> data\daily-pipeline.log
"C:\Program Files\nodejs\node.exe" tools\daily-pipeline.mjs >> data\daily-pipeline.log 2>&1
set RET=%errorlevel%
echo [%date% %time%] === Done === >> data\daily-collect.log
exit /b %RET%
