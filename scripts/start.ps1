$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Exe = Join-Path $Root 'bin\study-agent.exe'
$Url = 'http://127.0.0.1:8731'
if (-not (Test-Path -LiteralPath $Exe)) { throw 'Executable missing. Run scripts\build.ps1 first.' }
try {
    $health = Invoke-RestMethod "$Url/api/health" -TimeoutSec 2
    if ($health.app -eq 'study-agent') { Start-Process $Url; exit 0 }
    throw 'Port 8731 is in use by another application.'
} catch {
    $busy = Get-NetTCPConnection -LocalPort 8731 -State Listen -ErrorAction SilentlyContinue
    if ($busy) { throw 'Port 8731 is occupied; stop the conflicting service first.' }
}
New-Item -ItemType Directory -Path (Join-Path $Root 'logs') -Force | Out-Null
$env:STUDY_DATA_DIR = Join-Path $Root 'data'
$env:STUDY_PORT = '8731'
$proc = Start-Process -FilePath $Exe -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $Root 'logs\server.out.log') `
    -RedirectStandardError (Join-Path $Root 'logs\server.err.log')
for ($i=0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if ($proc.HasExited) { throw 'Server exited. Check logs\server.err.log.' }
    try {
        $health = Invoke-RestMethod "$Url/api/health" -TimeoutSec 1
        if ($health.app -eq 'study-agent') { Start-Process $Url; exit 0 }
    } catch { }
}
throw 'Server did not become ready. Check the logs folder.'
