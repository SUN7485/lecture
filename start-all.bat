@echo off
rem ===========================================================================
rem  Lecture Studio - one launcher for the merged app.
rem
rem  HTML or PDF in  ->  edit visually  ->  PDF or PPTX out.
rem  Everything runs locally. No file leaves this machine.
rem
rem  ASCII only on purpose: the console codepage mangles non-ASCII text and a
rem  garbled launcher looks like a broken install.
rem ===========================================================================
title Lecture Studio
cd /d "%~dp0"

echo.
echo   Lecture Studio
echo   --------------
echo   Open anything. Fix it visually. Export it anywhere.
echo.

rem --- Node ------------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js was not found.
  echo       Install Node 22 or newer from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo   [ok] Node %%v

rem --- Dependencies ----------------------------------------------------------
rem Electron's binary lives in node_modules\electron\dist. Checking the folder
rem alone is not enough: a partial copy leaves the folder and no executable.
if not exist "node_modules\electron\dist\electron.exe" (
  echo   [..] First run - installing dependencies. This can take a few minutes.
  call npm install
  if errorlevel 1 (
    echo.
    echo   [X] Install failed. Check the messages above.
    pause
    exit /b 1
  )
)
echo   [ok] Dependencies present

rem --- PDF engine ------------------------------------------------------------
rem Vendored separately from npm, so its absence is a copy problem, not an
rem install problem - say which, or the next person runs npm install forever.
if not exist "engine\model-to-html.js" (
  echo.
  echo   [X] The PDF engine is missing ^(engine\model-to-html.js^).
  echo       PDF import will not work. Restore the engine folder.
  echo.
  pause
  exit /b 1
)
if not exist "node_modules\mupdf" (
  echo.
  echo   [X] mupdf is not installed - PDF import will fail.
  echo       Run: npm install
  echo.
  pause
  exit /b 1
)
echo   [ok] PDF engine ready

echo.
echo   Starting...
echo.
call npm start

if errorlevel 1 (
  echo.
  echo   The app exited with an error. The messages above say why.
  pause
)
