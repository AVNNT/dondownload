#Requires -Version 5.1
<#
.SYNOPSIS
Registers or unregisters the DonDownload native messaging host for the current
Windows user in Helium, Chrome and/or Edge.

.DESCRIPTION
This script writes an explicit native messaging manifest whose allowed_origins
contains only the exact chrome-extension://<32-character-id>/ origins you pass
in. It never writes a wildcard. Registry writes are under HKCU, so administrator
rights are not required.

The browser manifest's "path" must be a real executable. A .cmd, .ps1 or JS
path is rejected.

Helium shares the Chromium-compatible Chrome current-user registration key.
That exact key was verified locally with Helium 0.20.3.1 / Chromium 156.0.8078.79
and extension id efakbfgkcnfjpomeejapmhpaihompngo. No Helium-specific registry
key is written because none was verified as required.

Because Helium and Chrome share one manifest, include every extension id that
should work (comma-separated) in a single registration. Unregistering Helium
removes the shared key, so re-register Chrome afterwards if you still need it.

.PARAMETER ExtensionId
One or more exact unpacked-extension IDs (32 characters, a-p). Pass every
browser's ID when they differ.

.PARAMETER Browser
Chrome, Edge, Helium, or Both. Both means Chrome + Edge (the historical
default); Helium is explicit. Helium uses the verified Chromium-compatible
Chrome current-user key.

.PARAMETER HostPath
Optional native host executable. Defaults to
native\dondownload-native-host.exe.

.PARAMETER ManifestPath
Optional manifest destination. Defaults to
%APPDATA%\DonDownload\native-messaging\com.dondownload.bridge.json.

.PARAMETER Unregister
Remove the current-user registrations and the generated manifest. With Helium,
this removes the shared Chrome-compatible key.

.PARAMETER PrintManifest
Print the manifest JSON and exit without writing anything.

.PARAMETER PrintRegistration
Print the resolved browser registry keys and manifest path as JSON and exit
without writing anything. Useful for checking Helium's shared-key mapping.

.EXAMPLE
# Helium (verified local browser):
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1 -Browser Helium -ExtensionId efakbfgkcnfjpomeejapmhpaihompngo

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1 -Unregister -Browser Both
#>
[CmdletBinding()]
param(
    [string[]]$ExtensionId,
    [ValidateSet('Chrome', 'Edge', 'Helium', 'Both')]
    [string]$Browser = 'Both',
    [string]$HostPath,
    [string]$ManifestPath,
    [switch]$Unregister,
    [switch]$PrintManifest,
    [switch]$PrintRegistration
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

$chromeKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$edgeKey = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"

# Helium is Chromium-based and was verified locally to read the standard
# Chromium-compatible Chrome current-user key. Do not add a Helium-specific key
# unless a real Helium build is verified to require one.
$browserTargets = @(
    [pscustomobject]@{
        Browser       = 'Chrome'
        RegistryKey   = $chromeKey
        SharesKeyWith = @()
        Note          = 'Standard Chrome current-user key.'
    }
    [pscustomobject]@{
        Browser       = 'Edge'
        RegistryKey   = $edgeKey
        SharesKeyWith = @()
        Note          = 'Standard Edge current-user key.'
    }
    [pscustomobject]@{
        Browser       = 'Helium'
        RegistryKey   = $chromeKey
        SharesKeyWith = @('Chrome')
        Note          = 'Helium uses the verified Chromium-compatible Chrome current-user key; no Helium-specific key is written.'
    }
)

function Get-SelectedBrowsers {
    if ($Browser -eq 'Both') {
        # Preserve the historical meaning of Both: Chrome + Edge. Helium is an
        # explicit option because it shares Chrome's key.
        return @($browserTargets | Where-Object { $_.Browser -eq 'Chrome' -or $_.Browser -eq 'Edge' })
    }
    return @($browserTargets | Where-Object { $_.Browser -eq $Browser })
}

function Write-RegistrationPlan {
    $browsers = @()
    foreach ($target in Get-SelectedBrowsers) {
        $browsers += [ordered]@{
            browser       = $target.Browser
            registryKey   = $target.RegistryKey
            sharesKeyWith = @($target.SharesKeyWith)
            note          = $target.Note
        }
    }

    [ordered]@{
        mode         = $(if ($Unregister) { 'unregister' } else { 'register' })
        hostPath     = $HostPath
        manifestPath = $ManifestPath
        browsers     = @($browsers)
    } | ConvertTo-Json -Depth 5
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

if ($PrintRegistration) {
    Write-RegistrationPlan
    return
}

if ($Unregister) {
    foreach ($target in Get-SelectedBrowsers) {
        $key = $target.RegistryKey
        if (Test-Path -LiteralPath $key) {
            Remove-Item -LiteralPath $key -Recurse -Force
            Write-Host "Removed $($target.Browser) native messaging host registration: $key"
        } else {
            Write-Host "No $($target.Browser) native messaging host registration to remove."
        }
        if ($target.SharesKeyWith.Count -gt 0) {
            Write-Host "  Note: $($target.Browser) uses the same key as $($target.SharesKeyWith -join ', ')."
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

foreach ($target in Get-SelectedBrowsers) {
    $key = $target.RegistryKey
    New-Item -Path $key -Force | Out-Null
    Set-Item -Path $key -Value $ManifestPath
    Write-Host "Registered $($target.Browser) native messaging host: $key"
    if ($target.Note) {
        Write-Host "  $($target.Note)"
    }
}

Write-Host ''
Write-Host 'Allowed origins:'
foreach ($id in (Get-ValidatedExtensionIds)) {
    Write-Host "  chrome-extension://$id/"
}
Write-Host ''
Write-Host 'Restart the browser (or reload the extension) and try the popup or link context menu.'
