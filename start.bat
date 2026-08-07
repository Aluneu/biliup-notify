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

echo  正在启动服务,网页端将自动打开...
echo  (关闭本窗口即停止服务)
echo.
echo  [提示] biliup 后端地址默认 http://localhost:19159,
echo         如果 biliup 端口不是 19159,启动后在网页端
echo         「通知配置」页的 biliup 服务地址 里修改即可。
echo.
call node server.js
pause
