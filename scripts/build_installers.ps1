# Build native Windows x64 / ARM64 applications and NSIS setup executables for PrismStudio.
param(
    [ValidateSet('x64', 'arm64')]
    [string[]]$Architecture = @('x64', 'arm64'),
    [string]$Arm64ToolchainRoot = '',
    [string]$NpmCliPath = '',
    [switch]$SkipFrontendBuild
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Encoding UTF8 -Raw | ConvertFrom-Json).version
$outputDir = Join-Path $projectRoot "releases\installers\$version"
$targetRoot = if ($env:CARGO_TARGET_DIR) { [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR) } else { Join-Path $projectRoot 'src-tauri\target' }
$cli = Join-Path $projectRoot 'node_modules\@tauri-apps\cli\tauri.js'

function Invoke-Npm([string[]]$Arguments) {
    if ($NpmCliPath) { & node $NpmCliPath @Arguments }
    else { & npm.cmd @Arguments }
    if ($LASTEXITCODE -ne 0) { throw "npm failed: $($Arguments -join ' ')" }
}

function Get-PeMachine([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5a4d) { throw "Not an executable: $Path" }
        $stream.Position = 0x3c
        $peOffset = $reader.ReadInt32()
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x4550) { throw "Missing PE header: $Path" }
        return $reader.ReadUInt16()
    } finally { $reader.Dispose(); $stream.Dispose() }
}

function Get-IsolatedArm64Environment([string]$Root) {
    $compilers = @(Get-ChildItem -LiteralPath $Root -Filter 'cl.exe' -Recurse |
        Where-Object { $_.DirectoryName -match 'Hostx64[\\/]arm64$' })
    $libraries = @(Get-ChildItem -LiteralPath $Root -Filter 'libcmt.lib' -Recurse |
        Where-Object { $_.DirectoryName -match 'lib[\\/]arm64$' })
    if ($compilers.Count -ne 1 -or $libraries.Count -ne 1) {
        throw 'Expected one ARM64 compiler and CRT library directory in Arm64ToolchainRoot.'
    }
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    $vsRoot = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vsRoot) { throw 'Visual Studio C++ x64 Build Tools are required.' }
    $vcVersion = (Get-Content -LiteralPath (Join-Path $vsRoot 'VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt') -Raw).Trim()
    $vcRoot = Join-Path $vsRoot "VC\Tools\MSVC\$vcVersion"
    $hostBin = Join-Path $vcRoot 'bin\Hostx64\x64'
    $sdkRoot = "${env:ProgramFiles(x86)}\Windows Kits\10"
    $sdk = Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'Lib') -Directory |
        Where-Object { (Test-Path -LiteralPath (Join-Path $_.FullName 'um\arm64\kernel32.lib')) -and
            (Test-Path -LiteralPath (Join-Path $_.FullName 'ucrt\arm64\ucrt.lib')) } |
        Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    if (-not $sdk) { throw 'The Windows SDK ARM64 libraries are required.' }
    $includes = @((Join-Path $vcRoot 'include'))
    foreach ($part in @('ucrt', 'shared', 'um', 'winrt')) {
        $includes += Join-Path $sdkRoot "Include\$($sdk.Name)\$part"
    }
    $flags = @('-C', 'target-feature=+crt-static')
    foreach ($library in @($libraries[0].DirectoryName, (Join-Path $sdk.FullName 'um\arm64'), (Join-Path $sdk.FullName 'ucrt\arm64'))) {
        $flags += @('-L', "native=$library")
    }
    return @{
        'PATH' = "$($compilers[0].DirectoryName);$hostBin;$env:PATH"
        'INCLUDE' = $includes -join ';'
        'CC_aarch64_pc_windows_msvc' = $compilers[0].FullName
        'AR_aarch64_pc_windows_msvc' = Join-Path $hostBin 'lib.exe'
        'CARGO_TARGET_AARCH64_PC_WINDOWS_MSVC_LINKER' = Join-Path $hostBin 'link.exe'
        'CARGO_ENCODED_RUSTFLAGS' = $flags -join [char]31
    }
}

Push-Location $projectRoot
try {
    if (-not (Test-Path -LiteralPath $cli)) { Invoke-Npm @('ci') }
    $cmapsSrc = Join-Path $projectRoot 'node_modules\pdfjs-dist\cmaps'
    $cmapsDst = Join-Path $projectRoot 'public\pdfjs\cmaps'
    $fontsSrc = Join-Path $projectRoot 'node_modules\pdfjs-dist\standard_fonts'
    $fontsDst = Join-Path $projectRoot 'public\pdfjs\standard_fonts'
    if ((Test-Path -LiteralPath $cmapsSrc) -and -not (Test-Path -LiteralPath $cmapsDst)) {
        New-Item -ItemType Directory -Force -Path $cmapsDst, $fontsDst | Out-Null
        Copy-Item (Join-Path $cmapsSrc '*') $cmapsDst -Force
        Copy-Item (Join-Path $fontsSrc '*') $fontsDst -Force
    }
    if (-not $SkipFrontendBuild) { Invoke-Npm @('run', 'build') }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\index.html'))) { throw 'Frontend assets are missing.' }
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

    $overridePath = Join-Path $projectRoot 'releases\build-config\installer-skip-frontend.json'
    New-Item -ItemType Directory -Path (Split-Path -Parent $overridePath) -Force | Out-Null
    [IO.File]::WriteAllText($overridePath, '{"build":{"beforeBuildCommand":""}}', [Text.UTF8Encoding]::new($false))

    foreach ($arch in ($Architecture | Select-Object -Unique)) {
        $target = if ($arch -eq 'x64') { 'x86_64-pc-windows-msvc' } else { 'aarch64-pc-windows-msvc' }
        & rustup target add $target
        if ($LASTEXITCODE -ne 0) { throw "Cannot install Rust target $target" }
        $environment = if ($arch -eq 'arm64' -and $Arm64ToolchainRoot) { Get-IsolatedArm64Environment $Arm64ToolchainRoot } else { @{} }
        $original = @{}
        try {
            foreach ($key in $environment.Keys) {
                $original[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
                [Environment]::SetEnvironmentVariable($key, $environment[$key], 'Process')
            }
            & node $cli build --ci --target $target --bundles nsis --config src-tauri/tauri.installer.conf.json --config $overridePath -- --locked
            if ($LASTEXITCODE -ne 0) { throw "Installer build failed for $arch" }
        } finally {
            foreach ($key in $original.Keys) { [Environment]::SetEnvironmentVariable($key, $original[$key], 'Process') }
        }
        $buildRoot = Join-Path $targetRoot "$target\release"
        $binary = Join-Path $buildRoot 'md-pdf-reader.exe'
        $expectedMachine = if ($arch -eq 'x64') { 0x8664 } else { 0xaa64 }
        if ((Get-PeMachine $binary) -ne $expectedMachine) { throw "Wrong application architecture for $arch" }
        $binaryVersion = (Get-Item -LiteralPath $binary).VersionInfo.ProductVersion
        if ($binaryVersion -notlike "$version*") { throw "Binary version $binaryVersion does not match $version" }
        $installers = @(Get-ChildItem -LiteralPath (Join-Path $buildRoot 'bundle\nsis') -Filter "*_$($version)_$($arch)-setup.exe")
        if ($installers.Count -ne 1) { throw "Expected one $arch installer, found $($installers.Count)" }
        $destination = Join-Path $outputDir "PrismStudio-$version-Windows-$arch-setup.exe"
        Copy-Item -LiteralPath $installers[0].FullName -Destination $destination -Force
        Write-Output "Built and verified $destination"
    }
    $checksums = Get-ChildItem -LiteralPath $outputDir -Filter "PrismStudio-$version-Windows-*-setup.exe" |
        Sort-Object Name | ForEach-Object { '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name }
    [IO.File]::WriteAllLines((Join-Path $outputDir "SHA256SUMS-$version.txt"), [string[]]$checksums, [Text.UTF8Encoding]::new($false))
} finally { Pop-Location }
