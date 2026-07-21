@echo off
setlocal
for %%I in ("%~dp0..") do set "PROJECT_DIR=%%~fI"
for %%I in ("%PROJECT_DIR%\..") do set "BUNDLE_DIR=%%~fI"
set "VENV=%PROJECT_DIR%\.venv"

py -3 -m venv "%VENV%"
if errorlevel 1 exit /b %errorlevel%
"%VENV%\Scripts\python.exe" -m pip install --upgrade pip
"%VENV%\Scripts\python.exe" -m pip install -r "%PROJECT_DIR%\backend\requirements.txt"
"%VENV%\Scripts\python.exe" -m pip install -r "%BUNDLE_DIR%\LogFaultAlgorithm\requirements.txt"
"%VENV%\Scripts\python.exe" -m pip install -r "%PROJECT_DIR%\backend\requirements-dev.txt"

if not exist "%PROJECT_DIR%\backend\.env" copy "%PROJECT_DIR%\backend\.env.example" "%PROJECT_DIR%\backend\.env" >nul
echo Setup complete. Review backend\.env before starting the system.
