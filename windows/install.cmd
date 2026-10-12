@echo off
rem Builds the Popcorn Club tray app from this checkout and installs it for this Windows user.
rem Run it once. After that, the tray menu's "Update now" pulls and rebuilds everything.
setlocal
set "DEST=%LOCALAPPDATA%\Popcorn Club\app"

where dotnet >nul 2>nul
if errorlevel 1 (
  echo The .NET 8 SDK isn't installed. Run this, then open a new window and try again:
  echo   winget install Microsoft.DotNet.SDK.8
  exit /b 1
)

tasklist /fi "imagename eq PopcornClub.exe" | find /i "PopcornClub.exe" >nul
if not errorlevel 1 (
  echo Popcorn Club is running. Quit it from its tray icon first, then run this again.
  exit /b 1
)

dotnet publish "%~dp0PopcornTray\PopcornTray.csproj" -c Release -o "%DEST%"
if errorlevel 1 exit /b 1

echo.
echo Installed to %DEST%\PopcornClub.exe
start "" "%DEST%\PopcornClub.exe"
