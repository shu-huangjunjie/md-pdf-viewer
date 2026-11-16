# Development runner for PrismStudio (TS + Rust)
# Run with: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run.ps1

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
$sysPath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
$extraPaths = @(
    "D:\huangjunjie\.env\web_node",
    "C:\Program Files\nodejs",
    "$env:LOCALAPPDATA\Programs\nodejs",
    "$env:USERPROFILE\.cargo\bin"
)
$env:Path = "$($extraPaths -join ';');$userPath;$sysPath;$env:Path"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

. (Join-Path $PSScriptRoot "ports.ps1")
$AppPort = Get-SafeAppPort 28460
$env:VITE_PORT = $AppPort.ToString()

if (-not (Test-Path "node_modules")) {
    Write-Host "[1/2] 首次运行，正在安装前端依赖..." -ForegroundColor Cyan
    & npm.cmd install --no-audit --no-fund
}

if (Get-Command cargo -ErrorAction SilentlyContinue) {
    Write-Host "[2/2] 启动 Tauri 桌面端热重载开发模式 (端口: $AppPort)..." -ForegroundColor Green
    $DevConfigPath = Join-Path $env:TEMP ("prismstudio-dev-" + [guid]::NewGuid().ToString('N') + ".json")
    $DevOverride = @{ build = @{ devUrl = "http://127.0.0.1:$AppPort" } } | ConvertTo-Json -Depth 3
    [IO.File]::WriteAllText($DevConfigPath, $DevOverride, [Text.UTF8Encoding]::new($false))
    try {
        & npm.cmd run tauri -- dev --config $DevConfigPath
    } finally {
        if (Test-Path $DevConfigPath) { Remove-Item $DevConfigPath -Force }
    }
} else {
    Write-Host "[2/2] 启动纯浏览器预览模式..." -ForegroundColor Yellow
    & npm.cmd run dev
}
