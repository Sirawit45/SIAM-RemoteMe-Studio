@echo off
chcp 65001 >nul
title SIAM RemoteMe Studio - Portable Launcher
cd /d "%~dp0"

echo ====================================================================
echo   🚀 กำลังเปิดโปรแกรม SIAM RemoteMe Studio (Portable Edition)
echo ====================================================================

if exist "SIAM_RemoteMe_Portable.exe" (
    start "" "SIAM_RemoteMe_Portable.exe"
) else (
    echo ไม่พบไฟล์ SIAM_RemoteMe_Portable.exe ในโฟลเดอร์นี้
    pause
)
