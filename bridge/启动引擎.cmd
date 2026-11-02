@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
REM 无界面跑引擎（默认：Codex 规划 + 执行 + 审核）
REM 想让 WorkBuddy 执行、Codex 只负责规划+审核，把下面这行改成：
REM   "%~dp0CodexBridge.exe" --engine --only intake,review --default-handler workbuddy
echo.
echo   Codex 协作台 · 引擎启动中（关掉这个窗口即停止）
echo.
"%~dp0CodexBridge.exe" --engine

if errorlevel 1 pause
