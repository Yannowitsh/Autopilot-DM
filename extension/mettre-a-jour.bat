@echo off
rem Met a jour l'extension depuis GitHub (sans git) : telecharge la derniere version
rem et remplace le contenu de ce dossier. Ensuite : "Recharger" dans la popup de l'extension.

rem Ce fichier va etre remplace pendant la mise a jour : on s'execute depuis une copie temporaire.
if /i not "%~1"=="--run" (
  copy /y "%~f0" "%TEMP%\dm-pilote-maj.bat" >nul
  "%TEMP%\dm-pilote-maj.bat" --run "%~dp0."
  exit /b
)

set "DEST=%~2"
echo Mise a jour de l'extension dans : %DEST%
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$dest = $env:DEST;" ^
  "$m = Join-Path $dest 'manifest.json';" ^
  "if (-not (Test-Path $m) -or -not ((Get-Content $m -Raw) -match 'Autopilot-DM|DofusMasters Pilote Auto')) { throw 'Ce dossier ne contient pas l''extension : mise a jour annulee.' }" ^
  "$tmp = Join-Path $env:TEMP ('dm-pilote-' + [guid]::NewGuid());" ^
  "New-Item -ItemType Directory $tmp | Out-Null;" ^
  "try {" ^
  "  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;" ^
  "  Invoke-WebRequest 'https://github.com/Yannowitsh/Autopilot-DM/archive/refs/heads/main.zip' -OutFile (Join-Path $tmp 'main.zip') -UseBasicParsing;" ^
  "  Expand-Archive (Join-Path $tmp 'main.zip') $tmp;" ^
  "  $src = Get-ChildItem $tmp -Directory | ForEach-Object { Join-Path $_.FullName 'extension' } | Where-Object { Test-Path (Join-Path $_ 'manifest.json') } | Select-Object -First 1;" ^
  "  if (-not $src) { throw 'Archive inattendue (dossier extension introuvable).' }" ^
  "  robocopy $src $dest /MIR /NFL /NDL /NJH /NJS /NP | Out-Null;" ^
  "  if ($LASTEXITCODE -ge 8) { throw ('Copie echouee (robocopy ' + $LASTEXITCODE + ').') }" ^
  "  $v = (Get-Content (Join-Path $dest 'manifest.json') -Raw | ConvertFrom-Json).version;" ^
  "  Write-Host ('OK : version ' + $v + ' installee. Clique maintenant sur Recharger dans la popup de l''extension.') -ForegroundColor Green" ^
  "} finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }"
if errorlevel 1 echo ECHEC de la mise a jour.
echo.
pause
