@echo off
REM 官公庁入札 日次収集バッチ
REM タスクスケジューラから毎朝 06:00 に実行
REM 使い方: C:\Users\kimko\orgiast-bid\tools\daily-collect.bat

cd /d C:\Users\kimko\orgiast-bid
echo [%date% %time%] === 官公庁入札 日次収集開始 === >> data\daily-collect.log
node tools\collect.mjs >> data\daily-collect.log 2>&1
echo [%date% %time%] === 完了 === >> data\daily-collect.log