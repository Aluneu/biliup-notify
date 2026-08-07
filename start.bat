@echo off
chcp 65001 >nul
title biliup-notify 启动器
echo.
echo  ============================================
echo    biliup-notify 启动器
echo  ============================================
echo.

rem ---- 检测 Node.js ----
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo  [错误] 未检测到 Node.js,请先运行 install.bat 完成安装。
  pause
  exit /b 1
)

rem ---- 首次运行自动安装依赖 ----
if not exist node_modules (
  echo  [提示] 首次运行,自动安装依赖,请稍候...
  call npm install --no-audit --no-fund
  if %errorlevel% neq 0 (
    echo  [失败] 依赖安装失败。
    pause
    exit /b 1
  )
)

rem ---- 检查 biliup 后端是否可达 ----
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:19159/v1/status' -UseBasicParsing -TimeoutSec 3; exit 0 } catch { exit 1 }"
if %errorlevel% equ 0 (
  echo  [OK] 已检测到 biliup 后端 (localhost:19159)
) else (
  echo  [提示] 未检测到 biliup 后端 (localhost:19159)。
  echo        请先启动 biliup(默认端口 19159),或稍后在网页端修改地址。
  echo.
)

echo  正在启动服务,网页端将自动打开...
echo  (关闭本窗口即停止服务)
echo.
call node server.js
pause
