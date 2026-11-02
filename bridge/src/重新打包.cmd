@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
REM 改完 src 里的源码后，跑这个重新生成 ..\CodexBridge.exe

set "BASEPY=C:\Users\<你的用户名>\.workbuddy-ai\binaries\python\versions\3.13.12\python.exe"
if not exist "%BASEPY%" set "BASEPY=python"

set "VENV=%~dp0..\.buildenv"
REM 故意构建到临时目录再复制回来：PyInstaller 直接往项目目录写时偶尔会 WinError 5
set "TMPB=%TEMP%\codexbridge-build"

if not exist "%VENV%\Scripts\python.exe" (
  echo.
  echo 首次打包：正在创建 .buildenv 并安装 PyInstaller（约 20MB，需要联网）...
  REM 用官方源，因为本机全局 pip.ini 指向的清华镜像可能不通
  "%BASEPY%" -m venv "%VENV%"
  "%VENV%\Scripts\python.exe" -m pip install -i https://pypi.org/simple/ pyinstaller
  if errorlevel 1 ( echo 安装 PyInstaller 失败 & pause & exit /b 1 )
)

echo.
echo 正在打包 ...
"%VENV%\Scripts\python.exe" -m PyInstaller --onefile --console --name CodexBridge ^
  --distpath "%TMPB%\dist" --workpath "%TMPB%\build" --specpath "%TMPB%" --noconfirm bridge_app.py
if errorlevel 1 ( echo 打包失败 & pause & exit /b 1 )

copy /Y "%TMPB%\dist\CodexBridge.exe" "%~dp0..\CodexBridge.exe" >nul
if errorlevel 1 ( echo 复制 exe 失败 - 请先关掉正在运行的协作台再试 & pause & exit /b 1 )

echo.
echo 完成！新 exe 已生成：%~dp0..\CodexBridge.exe
pause
