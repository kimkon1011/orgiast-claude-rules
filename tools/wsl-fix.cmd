@echo off
:: wsl-fix.cmd — WSLService 凍結解除スクリプト
taskkill /F /IM wslservice.exe 2>nul
net start WslService 2>nul
wsl -d Ubuntu echo WSL_OK
