#Requires -Version 5.1
<#
.SYNOPSIS
Builds the DonDownload native messaging executable with the Windows .NET
Framework C# compiler that ships with Windows.

.DESCRIPTION
No .NET SDK, Visual Studio or NuGet package is required. The output is a real
Windows executable, which is what Chrome/Edge native messaging manifests must
point at. The compiler produces C# 5 code targeting .NET Framework 4.x.

.PARAMETER OutputPath
Optional output executable path. Defaults to native\dondownload-native-host.exe.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-native-host.ps1
#>
[CmdletBinding()]
param(
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'native\NativeHost.cs'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Native host source not found: $source"
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $root 'native\dondownload-native-host.exe'
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$cscCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $csc) {
    throw 'The .NET Framework C# compiler (csc.exe) was not found. Install .NET Framework 4.x or build on Windows 10/11.'
}

# JavaScriptSerializer lives in System.Web.Extensions. Locate the exact
# framework assembly path instead of guessing a GAC folder.
Add-Type -AssemblyName System.Web.Extensions
$webExtensions = [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location
if ([string]::IsNullOrWhiteSpace($webExtensions) -or -not (Test-Path -LiteralPath $webExtensions -PathType Leaf)) {
    throw 'System.Web.Extensions.dll could not be located.'
}

Write-Host "Using compiler: $csc"
Write-Host "Building:       $OutputPath"

$compilerArguments = @(
    '/nologo',
    '/target:exe',
    '/platform:anycpu',
    '/optimize+',
    '/debug-',
    "/out:$OutputPath",
    $source
)

& $csc $compilerArguments
if ($LASTEXITCODE -ne 0) {
    throw "The native host build failed with exit code $LASTEXITCODE."
}
if (-not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) {
    throw "The compiler did not produce $OutputPath"
}

$item = Get-Item -LiteralPath $OutputPath
Write-Host ("Built native host: {0} ({1} bytes)" -f $item.FullName, $item.Length)
