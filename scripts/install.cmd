@echo off
rem dsh-keykeeper installer wrapper: bypasses PowerShell execution policy for this run only.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 (
  echo.
  echo Install failed. You can also use Settings -^> Plugins -^> Install local bundle and pick this folder.
  exit /b 1
)
