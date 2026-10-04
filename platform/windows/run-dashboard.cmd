@echo off
setlocal
set "PAB_DASHBOARD_PORT=%~1"
if "%PAB_DASHBOARD_PORT%"=="" set "PAB_DASHBOARD_PORT=4173"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24+ is required. Install Node.js, then run this launcher again.
  exit /b 1
)
pushd "%~dp0\..\.."
node apps\dashboard\preview.mjs
set "EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %EXIT_CODE%
