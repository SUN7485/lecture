@echo off
title Build Lecture Visual Editor Installer
cd /d "%~dp0"

rem Install dependencies (including the installer builder) if they're missing.
if not exist "node_modules\electron-builder" (
  echo Setting up build tools. This can take a few minutes the first time...
  call npm install
  if errorlevel 1 (
    echo.
    echo Setup failed. Make sure Node.js is installed ^(https://nodejs.org^).
    pause
    exit /b 1
  )
)

echo.
echo Building the Windows installer. This downloads a few things the first
echo time and can take several minutes. Please wait...
echo.
call npm run dist
if errorlevel 1 (
  echo.
  echo Build failed. See the messages above.
  pause
  exit /b 1
)

echo.
echo Done! Your installer is in the "dist" folder:
echo   %~dp0dist
echo Look for "Lecture Visual Editor Setup 0.1.0.exe" and double-click it.
echo.
rem Open the dist folder so it's easy to find.
if exist "dist" start "" "%~dp0dist"
pause
