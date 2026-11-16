# Build and package a clean portable release plus an allowlisted source archive for PrismStudio.
param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Encoding UTF8 -Raw | ConvertFrom-Json).version
$packageDir = Join-Path $projectRoot 'releases\packages'
$portableName = "PrismStudio-$version-Windows-x64"
$sourceName = "PrismStudio-$version-source"
$portableStage = Join-Path $packageDir $portableName
$portableZip = Join-Path $packageDir "$portableName.zip"
$sourceZip = Join-Path $packageDir "$sourceName.zip"
$sumsPath = Join-Path $packageDir "SHA256SUMS-$version.txt"
foreach ($destination in @($portableStage, $portableZip, $sourceZip, $sumsPath)) {
    if (Test-Path -LiteralPath $destination) { throw "Already exists: $destination" }
}

if (-not $SkipBuild) { & (Join-Path $PSScriptRoot 'build.ps1') }
$releaseRoot = Join-Path $projectRoot 'releases\portable'
$releaseExe = Join-Path $releaseRoot 'PrismStudio.exe'
if (-not (Test-Path -LiteralPath $releaseExe)) { throw "Missing build: $releaseExe" }
$binaryVersion = (Get-Item -LiteralPath $releaseExe).VersionInfo.ProductVersion
if ($binaryVersion -notlike "$version*") { throw "Binary version $binaryVersion does not match $version" }

New-Item -ItemType Directory -Path (Join-Path $portableStage 'data') -Force | Out-Null
Copy-Item -LiteralPath $releaseExe -Destination (Join-Path $portableStage 'PrismStudio.exe')
$instructions = @"
棱镜工坊 PrismStudio $version - Windows x64 便携版

使用方法
1. 将整个压缩包解压到可写目录，双击 PrismStudio.exe。
2. 同级 data 目录用于启用便携模式并保存本地设置、工作区历史与 WebView2 缓存，移动应用时请整体移动文件夹。
3. 需要 Windows 10/11 与 Microsoft Edge WebView2 运行时。

从旧版本更新
先退出旧程序，再将本包内的 PrismStudio.exe 复制到原目录替换即可；请保留自己的 data 文件夹。
"@
[IO.File]::WriteAllText((Join-Path $portableStage '使用说明.txt'), $instructions, [Text.UTF8Encoding]::new($false))

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Write-Archive([string]$Destination, [string]$RootName, [string]$BasePath, [string[]]$Files, [string[]]$EmptyDirs = @()) {
    $zip = [IO.Compression.ZipFile]::Open($Destination, [IO.Compression.ZipArchiveMode]::Create)
    try {
        $null = $zip.CreateEntry("$RootName/")
        foreach ($directory in $EmptyDirs) { $null = $zip.CreateEntry("$RootName/$directory/") }
        foreach ($relative in ($Files | Sort-Object -Unique)) {
            $entry = "$RootName/" + $relative.Replace('\', '/')
            $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip, (Join-Path $BasePath $relative), $entry, [IO.Compression.CompressionLevel]::Optimal)
        }
    } finally { $zip.Dispose() }
}

$portableFiles = @(Get-ChildItem -LiteralPath $portableStage -File | ForEach-Object Name)
Write-Archive $portableZip $portableName $portableStage $portableFiles @('data')

$sourceFolders = @('assets', 'src', 'scripts', 'src-tauri/src', 'src-tauri/icons', 'src-tauri/capabilities', 'src-tauri/.cargo')
$sourceFiles = @('.gitignore', 'README.md', '启动应用.bat', 'index.html',
    'package.json', 'package-lock.json', 'postcss.config.js', 'tailwind.config.js',
    'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts', 'vitest.config.ts',
    'src-tauri/build.rs', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock',
    'src-tauri/tauri.conf.json', 'src-tauri/tauri.installer.conf.json')
foreach ($folder in $sourceFolders) {
    $folderPath = Join-Path $projectRoot $folder
    if (-not (Test-Path -LiteralPath $folderPath)) { continue }
    foreach ($file in (Get-ChildItem -LiteralPath $folderPath -File -Recurse -Force)) {
        if ($file.Name -match '^(\.env($|\.)|.*\.(db|sqlite|sqlite3)(-wal|-shm)?$|.*\.log$)') {
            throw "Unexpected local data in source folder: $($file.FullName)"
        }
        $sourceFiles += $file.FullName.Substring($projectRoot.Length + 1)
    }
}
Write-Archive $sourceZip $sourceName $projectRoot $sourceFiles
$sums = foreach ($archive in @($portableZip, $sourceZip)) {
    "{0}  {1}" -f (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant(), (Split-Path -Leaf $archive)
}
[IO.File]::WriteAllLines($sumsPath, $sums, [Text.UTF8Encoding]::new($false))
Get-Item -LiteralPath $portableZip, $sourceZip, $sumsPath | Select-Object FullName, Length
