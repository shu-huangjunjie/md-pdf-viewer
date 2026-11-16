@echo off
chcp 65001 >nul
cd /d "%~dp0"
title PrismStudio

if exist "%~dp0releases\desktop\PrismStudio.exe" (
    start "" "%~dp0releases\desktop\PrismStudio.exe" %*
    exit
)

if exist "%~dp0releases\portable\PrismStudio.exe" (
    start "" "%~dp0releases\portable\PrismStudio.exe" %*
    exit
)

echo [Error] Missing releases\desktop\PrismStudio.exe
pause
