@echo off
setlocal
pushd "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
set "CODE=%ERRORLEVEL%"

popd

if not "%CODE%"=="0" (
    echo.
    echo [FAILED] build.ps1 exited with code %CODE%
) else (
    echo.
    echo [DONE] artifacts are in the release folder
)

if "%~1"=="" pause
endlocal & exit /b %CODE%
