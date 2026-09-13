@echo off
title TheDarkNeptune Translator
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing Electron for the first time...
  call npm install
  if errorlevel 1 (
    echo Failed to install Electron. Check your internet connection and Node.js.
    pause
    exit /b 1
  )
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
exit /b 0