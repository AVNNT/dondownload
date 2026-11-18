#Requires -Version 5.1
<#
.SYNOPSIS
Builds the DonDownload tray stub with the Windows .NET Framework C# compiler
that ships with Windows.

.DESCRIPTION
No .NET SDK, Visual Studio or NuGet package is required. The stub is a windowed
executable (no console) built from native\TrayStub.cs against WinForms and
System.Drawing. It is the tiny tray owner Electron starts before it quits an idle
desktop app.

.PARAMETER OutputPath
Optional output executable path. Defaults to native\dondownload-tray.exe.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-tray-stub.ps1
#>
[CmdletBinding()]
param(
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'native\TrayStub.cs'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Tray stub source not found: $source"
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $root 'native\dondownload-tray.exe'
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

Write-Host "Using compiler: $csc"
Write-Host "Building:       $OutputPath"

$compilerArguments = @(
    '/nologo',
    '/target:winexe',
    '/platform:anycpu',
    '/optimize+',
    '/debug-',
    "/out:$OutputPath",
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    $source
)

& $csc $compilerArguments
if ($LASTEXITCODE -ne 0) {
    throw "The tray stub build failed with exit code $LASTEXITCODE."
}
if (-not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) {
    throw "The compiler did not produce $OutputPath"
}

$item = Get-Item -LiteralPath $OutputPath
Write-Host ("Built tray stub: {0} ({1} bytes)" -f $item.FullName, $item.Length)
