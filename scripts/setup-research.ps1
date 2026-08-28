param([switch]$InstallBrowser)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Python = (Get-Command python -ErrorAction Stop).Source
if (-not (Test-Path '.venv')) { & $Python -m venv .venv }
$VenvPython = Join-Path $Root '.venv\Scripts\python.exe'
& $VenvPython -m pip install --upgrade pip
& $VenvPython -m pip install -r requirements-research.txt
if ($InstallBrowser) { & $VenvPython -m playwright install chromium }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Warning 'FFmpeg is not on PATH. YouTube frame extraction and some caption/audio conversions require FFmpeg.'
}
Write-Host 'Research integrations installed.'
