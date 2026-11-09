@echo off
chcp 65001 >nul
title ตั้งค่ารันอัตโนมัติตอนเปิดคอม (Auto-Start Unattended Mode)
cd /d "%~dp0"

set "EXE_PATH=%~dp0SIAM_RemoteMe_Portable.exe"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_LAUNCHER=%STARTUP_DIR%\SIAM_RemoteMe_AutoStart.vbs"

echo Set WshShell = CreateObject("WScript.Shell") > "%VBS_LAUNCHER%"
echo WshShell.CurrentDirectory = "%~dp0" >> "%VBS_LAUNCHER%"
echo WshShell.Run chr(34) ^& "%EXE_PATH%" ^& chr(34) ^& " --headless", 0, False >> "%VBS_LAUNCHER%"

echo ====================================================================
echo   ✅ ตั้งค่าให้ SIAM RemoteMe ทำงานเบื้องหลังอัตโนมัติทุกครั้งที่เปิดคอมสำเร็จ!
echo   📌 ตำแหน่งไฟล์ Startup: %VBS_LAUNCHER%
echo   💡 ต่อจากนี้ แค่เปิดสวิตช์คอมเครื่องนี้ทิ้งไว้ ก็รีโมทเข้ามาได้ตลอด 24 ชม.
echo ====================================================================
pause
