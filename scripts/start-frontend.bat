@echo off
setlocal
for %%I in ("%~dp0..") do set "PROJECT_DIR=%%~fI"
if not defined FRONTEND_PORT set "FRONTEND_PORT=5174"

where py >nul 2>nul
if not errorlevel 1 (
  py -3 "%PROJECT_DIR%\frontend-system\serve.py" --port %FRONTEND_PORT% --bind 0.0.0.0
  exit /b %errorlevel%
)

python "%PROJECT_DIR%\frontend-system\serve.py" --port %FRONTEND_PORT% --bind 0.0.0.0
