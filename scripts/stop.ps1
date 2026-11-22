$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Executables = @('study-agent.exe', 'study-agent-desktop.exe') | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $Root "bin\$_")) }
$targets = @(Get-CimInstance Win32_Process -Filter "Name='study-agent.exe' OR Name='study-agent-desktop.exe'" | Where-Object { $_.ExecutablePath -in $Executables })
foreach ($target in $targets) { Stop-Process -Id $target.ProcessId }
Write-Host ("Stopped {0} Study Agent process(es)." -f $targets.Count)
