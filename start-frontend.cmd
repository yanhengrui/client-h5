@echo off
setlocal
cd /d "%~dp0"

set "GATE_TARGET=%~1"
if not defined GATE_TARGET set "GATE_TARGET=http://127.0.0.1:8080"
set "FRONTEND_PORT=%~2"
if not defined FRONTEND_PORT set "FRONTEND_PORT=5173"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install Node.js 20 or newer first.
  pause
  exit /b 1
)
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found. Check the Node.js installation.
  pause
  exit /b 1
)

if not exist "package.json" (
  echo [ERROR] package.json was not found in %CD%
  pause
  exit /b 1
)

if not exist "node_modules\.package-lock.json" (
  echo [SETUP] Installing dependencies from package-lock.json...
  call npm ci
  if errorlevel 1 (
    echo [ERROR] npm ci failed. Check the network and npm configuration.
    pause
    exit /b 1
  )
)

set "VITE_GATE_PROXY=%GATE_TARGET%"
echo [START] Frontend: http://127.0.0.1:%FRONTEND_PORT%
echo [PROXY] Backend: %VITE_GATE_PROXY%
echo [TIP] Press Ctrl+C to stop the frontend.

if not defined FARM_FRONTEND_NO_BROWSER start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%FRONTEND_PORT%'"
call npm run dev -- --port %FRONTEND_PORT% --strictPort
set "START_EXIT=%ERRORLEVEL%"

if not "%START_EXIT%"=="0" (
  echo [ERROR] Frontend exited with code %START_EXIT%.
  pause
)
exit /b %START_EXIT%
