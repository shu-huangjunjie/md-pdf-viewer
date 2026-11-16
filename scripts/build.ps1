# Build script for PrismStudio (TS + Rust)
# Run with: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build.ps1

param(
    [string]$PortableDir = ""
)

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

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host " 棱镜工坊 PrismStudio (TS + Rust) 桌面与便携版构建脚本" -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

if (-not (Test-Path "node_modules")) {
    Write-Host "[1/3] 正在安装前端依赖 (npm install)..." -ForegroundColor Yellow
    & npm.cmd install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
} else {
    Write-Host "[1/3] 前端依赖已就绪。" -ForegroundColor Green
}

Write-Host "[2/3] 正在构建前端静态资产 (npm run build)..." -ForegroundColor Yellow
if ((Test-Path "node_modules\pdfjs-dist\cmaps") -and -not (Test-Path "public\pdfjs\cmaps")) {
    New-Item -ItemType Directory -Force -Path "public\pdfjs\cmaps", "public\pdfjs\standard_fonts" | Out-Null
    Copy-Item "node_modules\pdfjs-dist\cmaps\*" "public\pdfjs\cmaps\" -Force
    Copy-Item "node_modules\pdfjs-dist\standard_fonts\*" "public\pdfjs\standard_fonts\" -Force
}
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw "Frontend build failed with exit code $LASTEXITCODE" }

Write-Host "[3/3] 正在编译 Rust 后端与打包 EXE..." -ForegroundColor Yellow
Set-Location "$ProjectRoot\src-tauri"
if (Test-Path "$ProjectRoot\src-tauri\build.rs") {
    (Get-Item "$ProjectRoot\src-tauri\build.rs").LastWriteTime = Get-Date
}
$CargoTargetDir = if ($env:CARGO_TARGET_DIR) {
    [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
} else {
    Join-Path $ProjectRoot "src-tauri\target"
}

$ToolchainArgs = @()
$VsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$HasMsvcTools = (Test-Path $VsWhere) -and
    (& $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
if ($HasMsvcTools -and (Get-Command rustup -ErrorAction SilentlyContinue) -and
    (rustup toolchain list | Select-String -SimpleMatch 'stable-x86_64-pc-windows-msvc')) {
    $ToolchainArgs = @('+stable-x86_64-pc-windows-msvc')
}

cargo @ToolchainArgs build --release
if ($LASTEXITCODE -ne 0) { throw "Rust build failed with exit code $LASTEXITCODE" }

Set-Location $ProjectRoot
$OutDir = if ($PortableDir) { $PortableDir } else { Join-Path $ProjectRoot "releases\portable" }
$DesktopOutDir = Join-Path $ProjectRoot "releases\desktop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path $DesktopOutDir | Out-Null

$ReleaseExe = Join-Path $CargoTargetDir "release\md-pdf-reader.exe"
if (Test-Path $ReleaseExe) {
    Get-Process -Name "PrismStudio", "DocPrism-Reader" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
    Copy-Item $ReleaseExe -Destination (Join-Path $OutDir "PrismStudio.exe") -Force
    Copy-Item $ReleaseExe -Destination (Join-Path $DesktopOutDir "PrismStudio.exe") -Force
    foreach ($oldExe in @((Join-Path $OutDir "DocPrism-Reader.exe"), (Join-Path $DesktopOutDir "DocPrism-Reader.exe"))) {
        if (Test-Path $oldExe) { Remove-Item $oldExe -Force -ErrorAction SilentlyContinue }
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $OutDir "data") | Out-Null
    & ie4uinit.exe -show 2>$null
    Write-Host "`n[√] 桌面与便携程序构建成功！" -ForegroundColor Green
    Write-Host "    桌面版: $DesktopOutDir\PrismStudio.exe" -ForegroundColor White
    Write-Host "    便携版: $OutDir\PrismStudio.exe" -ForegroundColor White
} else {
    throw "Missing build output: $ReleaseExe"
}
