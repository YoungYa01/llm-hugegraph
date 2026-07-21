$ErrorActionPreference = "Stop"
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BundleDir = (Resolve-Path (Join-Path $ProjectDir "..")).Path
$Python = Join-Path $ProjectDir ".venv\Scripts\python.exe"

if (-not (Test-Path $Python)) {
    throw ".venv not found. Run scripts\setup.ps1 first."
}
if (-not $env:LOGFAULT_PROJECT_PATH) { $env:LOGFAULT_PROJECT_PATH = Join-Path $BundleDir "LogFaultAlgorithm" }
$Port = if ($env:PORT) { $env:PORT } else { "8000" }

Push-Location (Join-Path $ProjectDir "backend")
try {
    & $Python -m uvicorn app.main:app --host 0.0.0.0 --port $Port
} finally {
    Pop-Location
}
