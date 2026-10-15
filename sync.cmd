@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem ---------------------------------------------------------------------------
rem  InfraLens sync - clone or pull every repository listed in repos.txt.
rem
rem    sync.cmd                      uses %USERPROFILE%\infralens-workspace
rem    sync.cmd C:\path\to\workspace
rem    sync.cmd ... --no-open        do not open the dashboard afterwards
rem
rem  The workspace folder holds repos.txt (one URL per line, optional second
rem  word = folder name), one sub-folder per repository, sync-status.json and
rem  sync.log. Open the workspace folder in index.html; click Re-scan after
rem  each sync. Credentials are handled by git itself (Git Credential Manager
rem  asks once, then remembers). InfraLens never sees them.
rem ---------------------------------------------------------------------------
set "HERE=%~dp0"
set "WS="
set "NOOPEN="
:args
if "%~1"=="" goto :argsdone
if /I "%~1"=="--no-open" ( set "NOOPEN=1" ) else ( set "WS=%~1" )
shift
goto :args
:argsdone
if "%WS%"=="" set "WS=%USERPROFILE%\infralens-workspace"
if not exist "%WS%" mkdir "%WS%"
set "REPOS=%WS%\repos.txt"
set "STATUS=%WS%\sync-status.json"
set "LOG=%WS%\sync.log"

where git >nul 2>&1
if errorlevel 1 (
  echo git was not found on PATH. Install Git for Windows or add it to PATH.
  exit /b 1
)

if not exist "%REPOS%" (
  > "%REPOS%" echo # InfraLens repositories - one per line. Optional second word = folder name.
  >>"%REPOS%" echo # Lines starting with # are ignored. Save, then run sync.cmd again.
  >>"%REPOS%" echo # https://bitbucket.example.com/scm/plat/tf-landing-zone.git
  >>"%REPOS%" echo # https://bitbucket.example.com/scm/plat/tf-network.git  network
  echo Created "%REPOS%".
  echo Add your Bitbucket repository URLs to it ^(or on the Repositories page of the dashboard^) and run sync.cmd again.
  start "" notepad "%REPOS%"
  exit /b 0
)

> "%LOG%" echo InfraLens sync %DATE% %TIME%
echo InfraLens sync - workspace %WS%
set /a OK=0
set /a FAIL=0
set /a N=0
set "JSON="

for /f "usebackq eol=# tokens=1,2 delims=	 " %%A in ("%REPOS%") do (
  set "URL=%%A"
  set "NAME=%%B"
  if "!NAME!"=="" for %%F in ("%%A") do set "NAME=%%~nF"
  set "DIR=%WS%\!NAME!"
  set "RESULT=ok"
  set "MSG="
  >>"%LOG%" echo.
  >>"%LOG%" echo === !NAME!  !URL!
  if exist "!DIR!\.git" (
    echo   pull   !NAME!
    git -C "!DIR!" pull --ff-only >>"%LOG%" 2>&1
    if errorlevel 1 ( set "RESULT=failed" & set "MSG=git pull failed - see sync.log" )
  ) else (
    echo   clone  !NAME!
    git clone "!URL!" "!DIR!" >>"%LOG%" 2>&1
    if errorlevel 1 ( set "RESULT=failed" & set "MSG=git clone failed - see sync.log" )
  )
  set "COMMIT="
  set "BRANCH="
  set "WHEN="
  set "SUBJECT="
  if exist "!DIR!\.git" (
    for /f "delims=" %%C in ('git -C "!DIR!" rev-parse --short HEAD 2^>nul') do set "COMMIT=%%C"
    for /f "delims=" %%C in ('git -C "!DIR!" rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%C"
    for /f "delims=" %%C in ('git -C "!DIR!" log -1 --format=%%ci 2^>nul') do set "WHEN=%%C"
    for /f "delims=" %%C in ('git -C "!DIR!" log -1 --format=%%s 2^>nul') do set "SUBJECT=%%C"
  )
  rem strip characters that would break the JSON line or the shell
  if defined SUBJECT (
    set "SUBJECT=!SUBJECT:"='!"
    set "SUBJECT=!SUBJECT:\=/!"
    set "SUBJECT=!SUBJECT:&=+!"
    set "SUBJECT=!SUBJECT:|=/!"
    set "SUBJECT=!SUBJECT:<=(!"
    set "SUBJECT=!SUBJECT:>=)!"
  )
  if "!RESULT!"=="ok" ( set /a OK+=1 ) else ( set /a FAIL+=1 )
  set /a N+=1
  echo          !RESULT!  !BRANCH! !COMMIT!  !MSG!
  if defined JSON set "JSON=!JSON!,"
  set "JSON=!JSON!{"name":"!NAME!","url":"!URL!","folder":"!NAME!","result":"!RESULT!","message":"!MSG!","branch":"!BRANCH!","commit":"!COMMIT!","commit_date":"!WHEN!","subject":"!SUBJECT!"}"
)

set "WSJ=%WS:\=/%"
> "%STATUS%" echo {"tool":"sync.cmd","synced_at":"%DATE% %TIME%","workspace":"%WSJ%","ok":%OK%,"failed":%FAIL%,"repos":[!JSON!]}
echo.
echo Done: %OK% ok, %FAIL% failed ^(%N% listed^). Details in "%LOG%".
echo Now open the workspace folder in InfraLens and click Re-scan.
if not defined NOOPEN start "" "%HERE%index.html"
endlocal
exit /b 0
