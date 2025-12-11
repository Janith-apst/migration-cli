[CmdletBinding()]
param(
    [string]$Version = "latest",
    [switch]$System,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$AppName = "migration-cli"
$Repo = "Janith-apst/migration-cli"
$AssetExt = "zip"

function Get-Platform {
    $os = "windows"
    $arch = if ($env:PROCESSOR_ARCHITECTURE -match "ARM64") { "arm64" } else { "x64" }
    return @{ Os = $os; Arch = $arch }
}

function Require-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw "Node.js >=18 is required but was not found." }
    $ver = (& node -v).TrimStart('v')
    $major = [int]($ver.Split('.')[0])
    if ($major -lt 18) { throw "Node.js >=18 required, found $ver" }
}

function Ensure-Dir($path) {
    if (-not (Test-Path $path)) { [void](New-Item -ItemType Directory -Force -Path $path) }
}

function Get-PathList([System.EnvironmentVariableTarget]$Scope) {
    ($envVal = [Environment]::GetEnvironmentVariable("Path", $Scope)) | Out-Null
    if (-not $envVal) { return @() }
    return $envVal.Split(';') | Where-Object { $_ -and ($_ -ne '') }
}

function Add-ToPath([string]$Target, [System.EnvironmentVariableTarget]$Scope) {
    $paths = Get-PathList $Scope
    if ($paths -contains $Target) { return $false }
    $newPath = ($paths + $Target) -join ';'
    [Environment]::SetEnvironmentVariable("Path", $newPath, $Scope)
    return $true
}

function Remove-FromPath([string]$Target, [System.EnvironmentVariableTarget]$Scope) {
    $paths = Get-PathList $Scope
    if (-not ($paths -contains $Target)) { return $false }
    $newPath = ($paths | Where-Object { $_ -ne $Target }) -join ';'
    [Environment]::SetEnvironmentVariable("Path", $newPath, $Scope)
    return $true
}

function Move-InnerIfWrapped($destination) {
    $entries = Get-ChildItem -Path $destination -Force
    if ($entries.Count -eq 1 -and $entries[0].PSIsContainer) {
        $inner = $entries[0]
        Get-ChildItem -Path $inner.FullName -Force | ForEach-Object {
            Move-Item -Path $_.FullName -Destination $destination -Force
        }
        Remove-Item -Recurse -Force $inner.FullName
    }
}

$installRoot = if ($System) { Join-Path $env:ProgramFiles $AppName } else { Join-Path $env:LOCALAPPDATA $AppName }
$binDir = Join-Path $installRoot "bin"
$shimPath = Join-Path $binDir ("{0}.cmd" -f $AppName)

if ($Uninstall) {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $installRoot
    Remove-Item -Force -ErrorAction SilentlyContinue $shimPath
    $removedUser = Remove-FromPath $binDir ([System.EnvironmentVariableTarget]::User)
    $removedMachine = $false
    try { $removedMachine = Remove-FromPath $binDir ([System.EnvironmentVariableTarget]::Machine) } catch { }
    Write-Host "Uninstalled $AppName" -ForegroundColor Green
    if ($removedUser -or $removedMachine) { Write-Host "PATH entry removed." }
    return
}

Require-Node

$platform = Get-Platform
$asset = "{0}-{1}-{2}.{3}" -f $AppName, $platform.Os, $platform.Arch, $AssetExt
$baseUrl = if ($Version -eq "latest") {
    "https://github.com/$Repo/releases/latest/download"
} else {
    "https://github.com/$Repo/releases/download/$Version"
}

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
Ensure-Dir $tempDir
$archivePath = Join-Path $tempDir $asset

Write-Host "Downloading $asset ..."
Invoke-WebRequest -Uri ("{0}/{1}" -f $baseUrl, $asset) -OutFile $archivePath

# Optional checksum verification
try {
    $checksumPath = Join-Path $tempDir ("{0}.sha256" -f $asset)
    Invoke-WebRequest -Uri ("{0}/{1}.sha256" -f $baseUrl, $asset) -OutFile $checksumPath -ErrorAction Stop
    $expected = (Get-Content $checksumPath).Split(' ')[0].ToLower()
    $actual = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLower()
    if ($expected -ne $actual) { throw "Checksum mismatch" }
    Write-Host "Checksum verified." -ForegroundColor Green
} catch {
    Write-Host "Checksum not verified (missing file or hash mismatch)." -ForegroundColor Yellow
}

if (Test-Path $installRoot) { Remove-Item -Recurse -Force $installRoot }
Ensure-Dir $installRoot
Expand-Archive -Path $archivePath -DestinationPath $installRoot -Force
Move-InnerIfWrapped $installRoot

Ensure-Dir $binDir
$shim = "@echo off`r`nsetlocal`r`nset SCRIPT_DIR=%~dp0`r`nset APP_HOME=%SCRIPT_DIR%..`r`nset NODE_PATH=%APP_HOME%\\node_modules`r`nnode \"%APP_HOME%\\dist\\index.js\" %*`r`n"
Set-Content -Path $shimPath -Value $shim -Encoding ASCII

$addedUser = Add-ToPath $binDir ([System.EnvironmentVariableTarget]::User)
$addedMachine = $false
if ($System) {
    try { $addedMachine = Add-ToPath $binDir ([System.EnvironmentVariableTarget]::Machine) } catch { Write-Host "Run in an elevated shell to add machine PATH, or add $binDir manually." -ForegroundColor Yellow }
}

Write-Host "Installed to $installRoot" -ForegroundColor Green
Write-Host "Shim: $shimPath" -ForegroundColor Green
if (-not $addedUser -and -not $addedMachine) {
    Write-Host "Ensure $binDir is on your PATH." -ForegroundColor Yellow
} elseif ($addedUser) {
    Write-Host "Added $binDir to user PATH. Restart your shell to pick it up." -ForegroundColor Green
} elseif ($addedMachine) {
    Write-Host "Added $binDir to machine PATH. Restart shells to pick it up." -ForegroundColor Green
}
Write-Host "Run '$AppName --help' to get started." -ForegroundColor Green
