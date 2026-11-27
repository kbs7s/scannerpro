@echo off
rem Double-click to run Smart Scanner Pro on this computer (no internet needed).
cd /d "%~dp0\.."
where node >nul 2>nul
if %errorlevel%==0 (
  node run-local\server.js
  goto :end
)
where py >nul 2>nul
if %errorlevel%==0 (
  echo Node.js not found, using Python. Open http://localhost:8090/ in Chrome or Edge.
  start "" "http://localhost:8090/"
  py -m http.server 8090 --bind 127.0.0.1
  goto :end
)
echo Please install Node.js from https://nodejs.org (or Python from https://python.org), then run this again.
pause
:end
