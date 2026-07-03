@echo off
title Lecture Visual Editor
cd /d "%~dp0"

rem First run: install dependencies if they're missing.
if not exist "node_modules\electron" (
  echo Setting up for the first time. This can take a minute...
  call npm install
  if errorlevel 1 (
    echo.
    echo Setup failed. Make sure Node.js is installed ^(https://nodejs.org^).
    pause
    exit /b 1
  )
)

echo Starting Lecture Visual Editor...
call npm start

rem Keep the window open only if something went wrong.
if errorlevel 1 pause
