@echo off
cd /d "%~dp0"
echo プロテイン最安値チェッカー 起動中...
start http://localhost:3000
node server.js
pause
