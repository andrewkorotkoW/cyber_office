# Запуск cyber_office на Windows. Из корня проекта: powershell -ExecutionPolicy Bypass -File scripts\run_windows.ps1
# AO_FAKE=1 перед запуском — режим имитации, чтобы посмотреть интерфейс без входа в claude.
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
& "$root\.venv\Scripts\python.exe" -m app.main
