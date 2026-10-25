@echo off
setlocal
cd /d "%~dp0"
echo === HiperMove setup ===
where node >nul 2>nul || (echo Node.js not found. Install the LTS version from https://nodejs.org then run this again. & start https://nodejs.org & pause & exit /b 1)
node -v
echo.
echo Installing packages...
call npm install || (echo npm install failed. Copy this window's text to Claude. & pause & exit /b 1)
echo.
echo Running tests...
call npm test || (echo Tests failed. Copy this window's text to Claude. & pause & exit /b 1)
if not exist .env (
  echo.
  set /p KEY=Paste your Gemini API key from https://aistudio.google.com/apikey and press Enter: 
  call :writeenv
)
echo.
echo Starting server in a new window...
start "HiperMove server" cmd /k "npm start"
timeout /t 4 >nul
echo.
echo Checking Gemma 4...
node scripts\check-gemma.js
echo.
start http://localhost:3000
echo Browser opened at http://localhost:3000 . Upload a side-view squat clip to test.
pause
exit /b 0

:writeenv
(
echo GEMINI_API_KEY=%KEY%
echo GEMMA_MODEL=gemma-4-26b-a4b-it
echo PORT=3000
) > .env
exit /b 0
