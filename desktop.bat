@echo off
cd /d "%~dp0"
if not exist "%~dp0bin\study-agent-desktop.exe" (
  echo Desktop executable missing. Run scripts\build-desktop.ps1 first.
  pause
  exit /b 1
)
start "" "%~dp0bin\study-agent-desktop.exe"
