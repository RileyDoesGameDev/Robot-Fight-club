@echo off
setlocal enabledelayedexpansion
title Battle Bots

REM ============================================================================
REM  Battle Bots - double-click to play.
REM
REM  Needs Docker Desktop and nothing else. No Node, no game engine, no repo.
REM
REM  Finds the game image in whichever of these is available, in order:
REM    1. already loaded in Docker      (fastest, nothing to do)
REM    2. battle-bots-image.tar next to this file
REM    3. downloaded from the GitHub release
REM
REM  Everything after that is a container start and a browser window.
REM ============================================================================

set "IMAGE=battle-bots:latest"
set "CONTAINER=battle-bots"
set "PORT=4300"
set "TARBALL=battle-bots-image.tar"
set "RELEASE_TAG=v0.9.0"
set "RELEASE_URL=https://github.com/RileyDoesGameDev/Robot-Fight-club/releases/download/%RELEASE_TAG%/%TARBALL%"

cd /d "%~dp0"

echo.
echo   ============================================
echo     BATTLE BOTS
echo   ============================================
echo.

REM --- 1. Docker present? -----------------------------------------------------
where docker >nul 2>&1
if errorlevel 1 (
  echo   [X] Docker is not installed, or is not on your PATH.
  echo.
  echo       Install Docker Desktop, then run this again:
  echo       https://www.docker.com/products/docker-desktop/
  echo.
  goto :fail
)

REM --- 2. Docker actually running? --------------------------------------------
REM  `docker info` is the check that matters. `where docker` only proves the CLI
REM  exists; the daemon is a separate thing and not starting it is the single most
REM  common reason this fails.
docker info >nul 2>&1
if errorlevel 1 (
  echo   [X] Docker is installed but not running.
  echo.
  echo       Start Docker Desktop, wait for the whale icon to stop animating,
  echo       then run this again.
  echo.
  goto :fail
)
echo   [1/4] Docker is running.

REM --- 3. Get the image -------------------------------------------------------
docker image inspect %IMAGE% >nul 2>&1
if not errorlevel 1 (
  echo   [2/4] Game image already loaded.
  goto :haveimage
)

if exist "%TARBALL%" (
  echo   [2/4] Loading the game from %TARBALL% ...
  docker load -i "%TARBALL%"
  if errorlevel 1 (
    echo   [X] Could not load %TARBALL% - the file may be incomplete.
    goto :fail
  )
  goto :haveimage
)

echo   [2/4] No local copy found. Downloading (about 27 MB^) ...
echo         %RELEASE_URL%
curl -L --fail --progress-bar -o "%TARBALL%" "%RELEASE_URL%"
if errorlevel 1 (
  echo.
  echo   [X] Download failed.
  echo.
  echo       Either there is no internet connection, or the release has not been
  echo       published yet. You can also copy %TARBALL% next to this file by hand
  echo       and run this again - it will be used instead of downloading.
  echo.
  goto :fail
)
docker load -i "%TARBALL%"
if errorlevel 1 (
  echo   [X] The download finished but Docker could not load it.
  goto :fail
)

:haveimage

REM --- 4. Start it ------------------------------------------------------------
REM  Remove any previous container first. Without this, a second run fails with
REM  "name already in use", which reads like a real problem and is not one.
docker rm -f %CONTAINER% >nul 2>&1

echo   [3/4] Starting the game ...
docker run -d --name %CONTAINER% --restart unless-stopped -p %PORT%:8080 ^
  --read-only --tmpfs /tmp --tmpfs /var/cache/nginx ^
  --security-opt no-new-privileges:true %IMAGE% >nul
if errorlevel 1 (
  echo   [X] The container would not start.
  echo.
  echo       If the message above mentions the port, something else is using
  echo       %PORT%. Edit this file and change the PORT line near the top.
  echo.
  goto :fail
)

REM  Give nginx a moment before opening a browser at it, so the first thing the
REM  player sees is the game rather than a connection error.
echo   [4/4] Waiting for it to come up ...
set /a tries=0
:waitloop
set /a tries+=1
curl -s -o nul --max-time 2 http://localhost:%PORT%/ >nul 2>&1
if not errorlevel 1 goto :ready
if !tries! geq 15 (
  echo   [!] It is taking longer than expected. Opening anyway.
  goto :ready
)
timeout /t 1 /nobreak >nul
goto :waitloop

:ready
echo.
echo   ============================================
echo     Ready - http://localhost:%PORT%
echo   ============================================
echo.
echo     Player 1:  W/S drive   A/D turn   E weapon   R self-right   Esc pause
echo     Player 2:  numpad 8/5 drive   4/6 turn   9 weapon   7 self-right
echo.
echo     The weapon is a TOGGLE - press once on, once off.
echo.
echo     Two things that look like bugs and are not:
echo       * Keep the tab in front. Browsers stop animation in background
echo         tabs, so the game does not slow down, it stops.
echo       * Click once before expecting sound. Browsers refuse to start
echo         audio until you have interacted with the page.
echo.
echo     To stop the game later, run Stop-Battle-Bots.cmd
echo.

start "" "http://localhost:%PORT%/"
echo   This window can be closed.
echo.
pause
exit /b 0

:fail
echo.
pause
exit /b 1
