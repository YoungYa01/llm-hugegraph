$ErrorActionPreference = "Stop"
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Port = if ($env:FRONTEND_PORT) { $env:FRONTEND_PORT } else { "5174" }
$Server = Join-Path $ProjectDir "frontend-system\serve.py"

if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 $Server --port $Port --bind 0.0.0.0
} else {
    & python $Server --port $Port --bind 0.0.0.0
}
