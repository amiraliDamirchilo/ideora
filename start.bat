@echo off
REM Starts Ideora on http://localhost:3000 and opens the browser.
cd /d "%~dp0"
start "Ideora" cmd /k "python server.py"
timeout /t 2 >nul
start "" http://localhost:3000
