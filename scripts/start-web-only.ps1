# start-web-only.ps1 — 仅启动前端 Next.js 服务 (port 3003)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

# Load .env
$envFile = Join-Path $ProjectRoot ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $parts = $line -split "=", 2
            if ($parts.Count -eq 2) {
                $k = $parts[0].Trim()
                $v = $parts[1].Trim().Trim('"').Trim("'")
                [System.Environment]::SetEnvironmentVariable($k, $v, "Process")
            }
        }
    }
}

$port = if ($env:FRONTEND_PORT) { $env:FRONTEND_PORT } else { "3003" }
$apiPort = if ($env:API_SERVER_PORT) { $env:API_SERVER_PORT } else { "3004" }
$nextCli = Join-Path $ProjectRoot "node_modules\next\dist\bin\next"
$webDir = Join-Path $ProjectRoot "packages\web"

if (-not (Test-Path $nextCli)) {
    Write-Host "[ERR] Next CLI not found at $nextCli — run pnpm install first" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $webDir ".next"))) {
    Write-Host "[ERR] .next build not found — run pnpm start first (without -Quick) to build" -ForegroundColor Red
    exit 1
}

$env:PORT = $port
$env:API_SERVER_PORT = $apiPort
$env:NEXT_PUBLIC_API_URL = "http://localhost:$apiPort"

Write-Host "Starting frontend on http://localhost:$port ..." -ForegroundColor Cyan
Set-Location $webDir
& node $nextCli start -p $port -H 0.0.0.0
