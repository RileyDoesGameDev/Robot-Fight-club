@echo off
title Battle Bots - stop

REM  Stops and removes the game container. The image stays loaded, so starting
REM  again is instant and needs no download.

echo.
echo   Stopping Battle Bots ...

docker rm -f battle-bots >nul 2>&1
if errorlevel 1 (
  echo   It was not running.
) else (
  echo   Stopped.
)

echo.
echo   The game image is still loaded, so Play-Battle-Bots.cmd will start
echo   instantly next time. To remove it completely:
echo     docker rmi battle-bots:latest
echo.
pause
