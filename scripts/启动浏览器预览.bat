@echo off
chcp 65001 >nul
cd /d "%~dp0.."
set "PATH=D:\huangjunjie\.env\web_node;%PATH%"
start "" "http://127.0.0.1:28460"
call npm.cmd run dev
