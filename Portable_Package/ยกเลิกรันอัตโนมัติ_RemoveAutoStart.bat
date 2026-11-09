@echo off
chcp 65001 >nul
title ยกเลิกรันอัตโนมัติ (Remove Auto-Start)

set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_LAUNCHER=%STARTUP_DIR%\SIAM_RemoteMe_AutoStart.vbs"

if exist "%VBS_LAUNCHER%" (
    del /f /q "%VBS_LAUNCHER%"
    echo ✅ ยกเลิกการรันอัตโนมัติตอนเปิดเครื่องเรียบร้อยแล้ว
) else (
    echo ℹ️ ไม่พบการตั้งค่ารันอัตโนมัติในระบบ
)
pause
