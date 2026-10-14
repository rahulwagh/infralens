@echo off
rem InfraLens: export the live GCP estate to .\snapshot using gcloud (read-only).
rem Usage: export-gcloud.cmd [extra args passed to the PowerShell script]
rem   export-gcloud.cmd
rem   export-gcloud.cmd -Organization 123456789012
rem   export-gcloud.cmd -Projects prj-a,prj-b -SkipOrg
rem   export-gcloud.cmd -SkipSaPolicies        (faster)
where gcloud >nul 2>nul || (echo gcloud not found on PATH. Open a "Google Cloud SDK Shell" or add it to PATH. & exit /b 1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\export-gcloud.ps1" %*
if errorlevel 1 (
  echo.
  echo If PowerShell scripts are blocked by policy, run the exporter through gcloud's bundled Python instead:
  echo   for /f "delims=" %%p in ('gcloud info --format="value(basic.python_location)"') do "%%p" tools\export_gcloud.py
)
