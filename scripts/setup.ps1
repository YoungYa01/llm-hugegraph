$ErrorActionPreference = "Stop"
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BundleDir = (Resolve-Path (Join-Path $ProjectDir "..")).Path
$Venv = Join-Path $ProjectDir ".venv"
$Python = Join-Path $Venv "Scripts\python.exe"

& py -3 -m venv $Venv
& $Python -m pip install --upgrade pip
& $Python -m pip install -r (Join-Path $ProjectDir "backend\requirements.txt")
& $Python -m pip install -r (Join-Path $BundleDir "LogFaultAlgorithm\requirements.txt")
& $Python -m pip install -r (Join-Path $ProjectDir "backend\requirements-dev.txt")

$EnvFile = Join-Path $ProjectDir "backend\.env"
if (-not (Test-Path $EnvFile)) {
    Copy-Item (Join-Path $ProjectDir "backend\.env.example") $EnvFile
}
Write-Host "Setup complete. Review backend\.env before starting the system." -ForegroundColor Green
