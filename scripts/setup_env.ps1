# Environment diagnostic script for DocPrism Reader (TS + Rust)
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host " 阅界 DocPrism (TS + Rust) 环境检查" -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan

$env:Path = "D:\huangjunjie\.env\web_node;$env:USERPROFILE\.cargo\bin;$env:Path"

$nodeVer = & node -v 2>$null
if ($nodeVer) {
    Write-Host "[√] Node.js 就绪: $nodeVer" -ForegroundColor Green
} else {
    Write-Host "[!] 未检测到 Node.js" -ForegroundColor Yellow
}

$rustVer = & rustc -V 2>$null
if ($rustVer) {
    Write-Host "[√] Rust 就绪: $rustVer" -ForegroundColor Green
} else {
    Write-Host "[!] 未检测到 Rust" -ForegroundColor Yellow
}
