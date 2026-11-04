#Requires -Version 5.1
<#
.SYNOPSIS
Registers or unregisters the DonDownload native messaging host for the current
Windows user in Chrome and/or Edge.

.DESCRIPTION
This script writes an explicit native messaging manifest whose allowed_origins
contains only the exact chrome-extension://<32-character-id>/ origins you pass
in. It never writes a wildcard. Registry writes are under HKCU, so administrator
rights are not required.

The browser manifest's "path" must be a real executable. A .cmd, .ps1 or JS
path is rejected.

.PARAMETER ExtensionId
One or more exact unpacked-extension IDs (32 characters, a-p). Pass both a
Chrome and an Edge ID when they differ.

.PARAMETER Browser
Chrome, Edge, or Both (default).

.PARAMETER HostPath
Optional native host executable. Defaults to
native\dondownload-native-host.exe.

.PARAMETER ManifestPath
Optional manifest destination. Defaults to
%APPDATA%\DonDownload\native-messaging\com.dondownload.bridge.json.

.PARAMETER Unregister
Remove the current-user registrations and the generated manifest.

.PARAMETER PrintManifest
Print the manifest JSON and exit without writing anything.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1 -Unregister -Browser Both
#>
[CmdletBinding()]
param(
    [string[]]$ExtensionId,
    [ValidateSet('Chrome', 'Edge', 'Both')]
    [string]$Browser = 'Both',
    [string]$HostPath,
    [string]$ManifestPath,
    [switch]$Unregister,
    [switch]$PrintManifest
)

$ErrorActionPreference = 'Stop'

$HostName = 'com.dondownload.bridge'
$root = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($HostPath)) {
    $HostPath = Join-Path $root 'native\dondownload-native-host.exe'
}
$HostPath = [System.IO.Path]::GetFullPath($HostPath)

if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
        throw 'APPDATA is not available; cannot choose a per-user manifest path.'
    }
    $ManifestPath = Join-Path $env:APPDATA "DonDownload\native-messaging\$HostName.json"
}
$ManifestPath = [System.IO.Path]::GetFullPath($ManifestPath)

$registryKeys = @{
    Chrome = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
    Edge   = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
}

function Get-SelectedBrowsers {
    if ($Browser -eq 'Both') {
        return @('Chrome', 'Edge')
    }
    return @($Browser)
}

function Assert-ValidExtensionId([string]$id) {
    if ([string]::IsNullOrWhiteSpace($id)) {
        throw 'An extension ID is required.'
    }
    if ($id -notmatch '^[a-p]{32}$') {
        throw "Invalid extension ID '$id'. Use the exact 32-character id shown by chrome://extensions or edge://extensions (lowercase a-p only)."
    }
}

function Get-ValidatedExtensionIds {
    $ids = New-Object System.Collections.Generic.List[string]
    foreach ($entry in $ExtensionId) {
        foreach ($part in ([string]$entry -split ',')) {
            $id = $part.Trim()
            Assert-ValidExtensionId $id
            if (-not $ids.Contains($id)) {
                $ids.Add($id)
            }
        }
    }
    if ($ids.Count -eq 0) {
        throw 'At least one extension ID is required.'
    }
    return $ids.ToArray()
}

function New-NativeManifest {
    $validatedIds = Get-ValidatedExtensionIds
    $origins = New-Object System.Collections.Generic.List[string]
    foreach ($id in $validatedIds) {
        $origins.Add("chrome-extension://$id/")
    }

    if (-not (Test-Path -LiteralPath $HostPath -PathType Leaf)) {
        throw "Native host executable not found: $HostPath. Run scripts\build-native-host.ps1 first."
    }
    if ([System.IO.Path]::GetExtension($HostPath) -ine '.exe') {
        throw "The browser manifest path must be a real .exe, not '$HostPath'."
    }

    $manifest = [ordered]@{
        name            = $HostName
        description     = 'DonDownload native messaging bridge (manual HTTP(S) capture only)'
        path            = $HostPath
        type            = 'stdio'
        allowed_origins = @($origins.ToArray())
    }
    return $manifest
}

if ($Unregister) {
    foreach ($browser in Get-SelectedBrowsers) {
        $key = $registryKeys[$browser]
        if (Test-Path -LiteralPath $key) {
            Remove-Item -LiteralPath $key -Recurse -Force
            Write-Host "Removed $browser native messaging host registration: $key"
        } else {
            Write-Host "No $browser native messaging host registration to remove."
        }
    }

    if (Test-Path -LiteralPath $ManifestPath -PathType Leaf) {
        Remove-Item -LiteralPath $ManifestPath -Force
        Write-Host "Removed manifest: $ManifestPath"
    }
    return
}

if (-not $ExtensionId -or $ExtensionId.Count -eq 0) {
    throw 'Pass -ExtensionId with the exact unpacked extension ID, or use -Unregister.'
}

$manifest = New-NativeManifest
$json = $manifest | ConvertTo-Json -Depth 5

if ($PrintManifest) {
    Write-Output $json
    return
}

$manifestDirectory = Split-Path -Parent $ManifestPath
New-Item -ItemType Directory -Force -Path $manifestDirectory | Out-Null
[System.IO.File]::WriteAllText(
    $ManifestPath,
    $json,
    (New-Object System.Text.UTF8Encoding($false))
)
Write-Host "Wrote native messaging manifest: $ManifestPath"

foreach ($browser in Get-SelectedBrowsers) {
    $key = $registryKeys[$browser]
    New-Item -Path $key -Force | Out-Null
    Set-Item -Path $key -Value $ManifestPath
    Write-Host "Registered $browser native messaging host: $key"
}

Write-Host ''
Write-Host 'Allowed origins:'
foreach ($id in (Get-ValidatedExtensionIds)) {
    Write-Host "  chrome-extension://$id/"
}
Write-Host ''
Write-Host 'Restart the browser (or reload the extension) and try the popup or link context menu.'
