$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
& (Join-Path $PSScriptRoot 'build-video.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Bundled engine preparation failed' }
Push-Location (Join-Path $Root 'web')
try {
    if (-not (Test-Path 'node_modules')) { npm.cmd ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency install failed' } }
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
} finally { Pop-Location }
Push-Location $Root
try {
    $env:CARGO_BUILD_JOBS = '2'
    cargo build --release --locked
    if ($LASTEXITCODE -ne 0) { throw 'Rust build failed' }
    New-Item -ItemType Directory -Path 'bin' -Force | Out-Null
    Copy-Item -LiteralPath 'target\release\study-agent.exe' -Destination 'bin\study-agent.exe' -Force
    Write-Host 'Build ready: bin\study-agent.exe'
} finally { Pop-Location }
