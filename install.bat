@echo off
chcp 65001 >nul
title biliup-notify 一键安装
echo.
echo  ============================================
echo    biliup-notify 安装脚本
echo  ============================================
echo.

rem ---- 检测 Node.js ----
where node >nul 2>nul
if %errorlevel% equ 0 (
  for /f "delims=" %%v in ('node --version') do set NODE_VER=%%v
  echo  [OK] 已检测到 Node.js %NODE_VER%
  goto :install
)

echo  [提示] 未检测到 Node.js,需要先安装才能运行本工具。
echo.
echo  方式一(推荐):输入 1,自动用 winget 安装 Node.js LTS 版
echo  方式二:输入 2,打开 Node.js 官网手动下载安装后,重新运行本脚本
echo  方式三:直接回车退出
echo.
set /p CHOICE=请输入选择:
if "%CHOICE%"=="1" (
  echo  正在通过 winget 安装 Node.js LTS,请稍候...
  winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  if %errorlevel% equ 0 (
    echo  [OK] Node.js 安装完成,请关闭本窗口后重新双击 install.bat
  ) else (
    echo  [失败] winget 安装未成功,请手动安装:https://nodejs.org/
  )
  pause
  exit /b
)
if "%CHOICE%"=="2" (
  start "" https://nodejs.org/
  echo  已打开官网,安装后请重新运行本脚本。
  pause
  exit /b
)
exit /b

:install
echo.
echo  [1/2] 正在安装依赖(npm install)...
call npm install --no-audit --no-fund
if %errorlevel% neq 0 (
  echo  [失败] 依赖安装失败,请检查网络后重试。
  pause
  exit /b 1
)
echo  [OK] 依赖安装完成
echo.
echo  [2/2] 完成!
echo.
echo  接下来:
echo   1. 双击 start.bat 启动服务
echo   2. 浏览器会自动打开 http://localhost:4000
echo   3. 在网页端配置 Telegram / Webhook 即可
echo.
pause
