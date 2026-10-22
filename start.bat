@echo off
rem ComfyEngi launcher: installs dependencies on first run, rebuilds when sources changed, then starts the app.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ComfyEngi] Node.js 22 or newer is required: https://nodejs.org/
    pause
    exit /b 1
)

if not exist "node_modules\.bin\electron-vite.cmd" (
    echo [ComfyEngi] First run: installing dependencies ...
    call npm install
    if errorlevel 1 goto fail
)
if not exist "node_modules\electron\dist\electron.exe" (
    echo [ComfyEngi] Downloading Electron runtime ...
    node node_modules\electron\install.js
    if errorlevel 1 goto fail
)

node scripts\needs-build.mjs
if not errorlevel 1 (
    echo [ComfyEngi] Building ...
    call npx electron-vite build
    if errorlevel 1 goto fail
)

start "" "node_modules\electron\dist\electron.exe" .
exit /b 0

:fail
echo [ComfyEngi] Setup failed. See the messages above.
pause
exit /b 1
