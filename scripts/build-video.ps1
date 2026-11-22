param([switch]$SkipTools)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
Push-Location $Root
try {
    if (-not $SkipTools) {
        python scripts\prepare-runtime.py
        if ($LASTEXITCODE -ne 0) { throw 'Video runtime preparation failed' }
    }
    $env:CARGO_BUILD_JOBS = '2'
    cargo build --manifest-path vendor\course2md-engine\Cargo.toml -p course2md --release --locked --target-dir target\engine
    if ($LASTEXITCODE -ne 0) { throw 'Bundled video engine build failed' }
    New-Item -ItemType Directory -Path runtime\video\bin -Force | Out-Null
    Copy-Item -LiteralPath target\engine\release\course2md.exe -Destination runtime\video\bin\course2md.exe.next -Force
    Move-Item -LiteralPath runtime\video\bin\course2md.exe.next -Destination runtime\video\bin\course2md.exe -Force
    Write-Host 'Bundled video engine ready: runtime\video'
} finally { Pop-Location }
