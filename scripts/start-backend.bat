@echo off
setlocal
for %%I in ("%~dp0..") do set "PROJECT_DIR=%%~fI"
for %%I in ("%PROJECT_DIR%\..") do set "BUNDLE_DIR=%%~fI"
set "PYTHON=%PROJECT_DIR%\.venv\Scripts\python.exe"

if not exist "%PYTHON%" (
  echo [ERROR] .venv not found. Run scripts\setup.bat first.
  exit /b 1
)

if not defined LOGFAULT_PROJECT_PATH set "LOGFAULT_PROJECT_PATH=%BUNDLE_DIR%\LogFaultAlgorithm"
if not defined PORT set "PORT=8000"
pushd "%PROJECT_DIR%\backend"
"%PYTHON%" -m uvicorn app.main:app --host 0.0.0.0 --port %PORT%
set "EXIT_CODE=%errorlevel%"
popd
exit /b %EXIT_CODE%
