param([switch]$SkipWebBuild)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
& (Join-Path $PSScriptRoot 'build-video.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Bundled engine preparation failed' }
Push-Location $Root
try {
    if (-not $SkipWebBuild) {
        Push-Location (Join-Path $Root 'web')
        try {
            if (-not (Test-Path 'node_modules')) { npm.cmd ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'Dependency install failed' } }
            npm.cmd run build
            if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
        } finally { Pop-Location }
    }
    $env:CARGO_BUILD_JOBS = '2'
    cargo build --release --locked --features desktop --bin study-agent-desktop
    if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
    if (-not $SkipWebBuild -or -not (Test-Path 'bin\study-agent.exe')) {
        cargo build --release --locked --bin study-agent
        if ($LASTEXITCODE -ne 0) { throw 'Backend build failed' }
        New-Item -ItemType Directory -Path 'bin' -Force | Out-Null
        Copy-Item 'target\release\study-agent.exe' 'bin\study-agent.exe' -Force
    }
    Copy-Item 'target\release\study-agent-desktop.exe' 'bin\study-agent-desktop.exe' -Force
    Write-Host 'Desktop ready: bin\study-agent-desktop.exe'
} finally { Pop-Location }
