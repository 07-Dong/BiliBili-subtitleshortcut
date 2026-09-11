@echo off
chcp 65001 >nul
title B站字幕快捷键（排查模式）
cd /d "%~dp0"

echo.
echo   ================================
echo     B站字幕快捷键
echo   ================================
echo.
echo   （这是排查入口，会显示完整输出）
echo   （日常使用请双击 启动.vbs，它没有窗口）
echo.

rem ── 选一个能用的 Node：优先自带的运行时，其次系统装的 ──
set "NODE_EXE="
if exist "runtime\node.exe" (
  set "NODE_EXE=runtime\node.exe"
) else (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE_EXE=node"
)

if not defined NODE_EXE (
  echo   [错误] 找不到可用的运行环境
  echo.
  echo   便携版应自带 runtime\node.exe，请确认压缩包解压完整。
  echo   也可以自行安装 Node.js（22 或更高版本）后重试：
  echo   https://nodejs.org
  echo.
  pause
  exit /b 1
)

rem ── 直接测能力而非解析版本号：脚本用到全局 WebSocket，需要 Node 22+ ──
"%NODE_EXE%" -e "process.exit(typeof WebSocket==='function'?0:1)" >nul 2>nul
if errorlevel 1 (
  echo   [错误] 运行环境版本过低
  echo.
  echo   本程序需要 Node.js 22 或更高版本。
  echo   请确认 runtime\node.exe 完整，或升级系统里的 Node.js。
  echo.
  pause
  exit /b 1
)

"%NODE_EXE%" "src\launcher.js"
if errorlevel 1 (
  echo.
  echo   启动失败。请把上面的错误信息截图反馈。
  echo.
)

pause
