@echo off
rem Execution policy applies only to this launcher process; no system setting is changed.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-PickerBridge.ps1" %*
if errorlevel 1 pause
