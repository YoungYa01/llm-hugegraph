$ErrorActionPreference = "Stop"
Write-Host "Starting LogSys vanilla frontend: http://127.0.0.1:5174" -ForegroundColor Cyan
python -m http.server 5174
