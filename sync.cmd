@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem ---------------------------------------------------------------------------
rem  InfraLens sync. Everything lives in this folder:
rem    repos.txt          the repositories to clone (one URL per line)
rem    repos\<name>\      the clones (created / pulled by this script)
rem    estate.js          every file of repos\, written for index.html
rem    sync-status.json   result per repository, shown on the Repositories page
rem    sync.log           git output
rem  Run it, then open or refresh index.html. Git handles credentials and proxy.
rem ---------------------------------------------------------------------------
set "HERE=%~dp0"
set "REPOS=%HERE%repos.txt"
set "DEST=%HERE%repos"
set "STATUS=%HERE%sync-status.json"
set "LOG=%HERE%sync.log"

where git >nul 2>&1
if errorlevel 1 (
  echo git was not found on PATH. Install Git for Windows or add it to PATH.
  exit /b 1
)
if not exist "%REPOS%" (
  copy /y "%HERE%repos.example.txt" "%REPOS%" >nul
  echo Created repos.txt - add your repository URLs to it and run sync.cmd again.
  start "" notepad "%REPOS%"
  exit /b 0
)
if not exist "%DEST%" mkdir "%DEST%"

> "%LOG%" echo InfraLens sync %DATE% %TIME%
echo InfraLens sync - cloning into %DEST%
set /a OK=0
set /a FAIL=0
set /a N=0
set "JSON="

set "TMPLOG=%TEMP%\infralens-git.tmp"
for /f "usebackq eol=# tokens=1,2 delims=	 " %%A in ("%REPOS%") do (
  set "URL=%%A"
  set "NAME=%%B"
  rem URLs may carry credentials: https://user:token@host/scm/repo.git
  rem SAFE is the URL without them - used for names, the log, the status file.
  set "SAFE=!URL!"
  set "CRED="
  for /f "tokens=1,* delims=@" %%X in ("!URL!") do if not "%%Y"=="" (
    set "CRED=%%X"
    set "SAFE=https://%%Y"
    if /I "!URL:~0,7!"=="http://" set "SAFE=http://%%Y"
  )
  if defined CRED (
    set "CRED=!CRED:*//=!"
  )
  if "!NAME!"=="" for %%F in ("!SAFE:/=\!") do set "NAME=%%~nF"
  set "DIR=%DEST%\!NAME!"
  set "RESULT=ok"
  set "MSG="
  >>"%LOG%" echo.
  >>"%LOG%" echo === !NAME!  !SAFE!
  if exist "!DIR!\.git" (
    echo   pull   !NAME!
    git -C "!DIR!" pull --ff-only >"%TMPLOG%" 2>&1
    if errorlevel 1 ( set "RESULT=failed" & set "MSG=git pull failed - see sync.log" )
  ) else (
    echo   clone  !NAME!
    git clone "!URL!" "!DIR!" >"%TMPLOG%" 2>&1
    if errorlevel 1 ( set "RESULT=failed" & set "MSG=git clone failed - see sync.log" )
  )
  rem copy git's output to the log with the credentials blanked out
  for /f "usebackq delims=" %%Z in ("%TMPLOG%") do (
    set "L=%%Z"
    if defined CRED call set "L=%%L:!CRED!@=***@%%"
    >>"%LOG%" echo(!L!
  )
  del "%TMPLOG%" >nul 2>&1
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
  set "JSON=!JSON!{"name":"!NAME!","url":"!SAFE!","folder":"!NAME!","result":"!RESULT!","message":"!MSG!","branch":"!BRANCH!","commit":"!COMMIT!","commit_date":"!WHEN!","subject":"!SUBJECT!"}"
)

set "DESTJ=%DEST:\=/%"
> "%STATUS%" echo {"tool":"sync.cmd","synced_at":"%DATE% %TIME%","workspace":"%DESTJ%","ok":%OK%,"failed":%FAIL%,"repos":[!JSON!]}
echo.
echo Done: %OK% ok, %FAIL% failed ^(%N% listed^). Details in sync.log

rem --- estate.js: all files of repos\ for index.html. Batch cannot encode text
rem     safely, so this uses the bash that ships with Git for Windows, else PowerShell.
set "BASH="
for /f "delims=" %%G in ('where git 2^>nul') do if not defined BASH (
  set "GITEXE=%%G"
  set "BASH=!GITEXE:\cmd\git.exe=\bin\bash.exe!"
  set "BASH=!BASH:\mingw64\bin\git.exe=\bin\bash.exe!"
  set "BASH=!BASH:\bin\git.exe=\bin\bash.exe!"
)
if defined BASH if exist "!BASH!" (
  "!BASH!" "%HERE%sync.sh" --build-only
  goto :done
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $h='%HERE:'=''%'; $files=@(); foreach($f in @('repos.txt','sync-status.json')){ if(Test-Path (Join-Path $h $f)){ $files += [pscustomobject]@{path=$f;text=[IO.File]::ReadAllText((Join-Path $h $f))} } }; Get-ChildItem -Path (Join-Path $h 'repos') -Recurse -File -Include *.tf,*.tfvars,*.json,*.yaml,*.yml,*.hcl,*.md,*.txt | Where-Object { $_.FullName -notmatch '\\(\.git|\.terraform|node_modules)\\' } | ForEach-Object { $files += [pscustomobject]@{path=($_.FullName.Substring((Join-Path $h 'repos').Length+1) -replace '\\','/');text=[IO.File]::ReadAllText($_.FullName)} }; $o=[pscustomobject]@{name='infralens';generated_at=(Get-Date -Format 's');workspace=(Join-Path $h 'repos');files=$files}; 'window.__INFRALENS_ESTATE__ = ' + ($o | ConvertTo-Json -Compress -Depth 4) + ';' | Set-Content -Encoding UTF8 (Join-Path $h 'estate.js'); 'Dashboard data: ' + $files.Count + ' files written to estate.js' }"
if errorlevel 1 echo Could not write estate.js ^(neither Git bash nor PowerShell worked^). Open index.html and use Open folder on "%DEST%".
:done
echo Now open index.html, or refresh it if it is already open.
endlocal
exit /b 0
