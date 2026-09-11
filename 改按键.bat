@echo off
chcp 65001 >nul
title B站字幕快捷键 - 改按键
cd /d "%~dp0"

rem ── 和 启动.bat 用同一套运行时选择逻辑 ──
set "NODE_EXE="
if exist "runtime\node.exe" (
  set "NODE_EXE=runtime\node.exe"
) else (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE_EXE=node"
)

if not defined NODE_EXE (
  echo.
  echo   [错误] 找不到可用的运行环境。
  echo   请确认压缩包解压完整（应当有 runtime\node.exe）。
  echo.
  pause
  exit /b 1
)

"%NODE_EXE%" "src\setkey.js"

pause
