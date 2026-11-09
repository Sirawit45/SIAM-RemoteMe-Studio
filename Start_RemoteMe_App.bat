@echo off
chcp 65001 >nul
title RemoteMe Studio - Cross-Platform Remote Desktop & File Transfer
cd /d "%~dp0"

echo ====================================================================
echo   🚀 กำลังเปิดโปรแกรม SIAM RemoteMe Studio (60 FPS Low-Latency)
echo ====================================================================

:: Start backend server if port 8765 is not already listening
netstat -ano | findstr ":8765 " | findstr "LISTENING" >nul
if %errorlevel% neq 0 (
    echo [1/2] กำลังรันเอนจินรีโมทความเร็วสูงบนพอร์ต 8765...
    start "RemoteMe Background Engine" /min python server.py
    timeout /t 2 /nobreak >nul
) else (
    echo [1/2] เอนจินรีโมททำงานอยู่แล้วบนพอร์ต 8765
)

echo [2/2] กำลังเปิดหน้าต่างโปรแกรมโหมด Desktop App...
where msedge >nul 2>nul
if %errorlevel% equ 0 (
    start "" msedge --app=http://localhost:8765 --window-size=1360,840
    exit /b
)

where chrome >nul 2>nul
if %errorlevel% equ 0 (
    start "" chrome --app=http://localhost:8765 --window-size=1360,840
    exit /b
)

start "" http://localhost:8765
