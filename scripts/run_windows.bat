@echo off
rem Запуск cyber_office на Windows. Из корня проекта: scripts\run_windows.bat
cd /d "%~dp0.."
".venv\Scripts\python.exe" -m app.main
