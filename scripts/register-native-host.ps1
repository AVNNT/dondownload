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

Firefox reads a separate app manifest that lists exact add-on IDs in
allowed_extensions instead of allowed_origins. Selecting the Firefox browser
writes that manifest and the current-user Mozilla native messaging key; the
add-on ID defaults to the one pinned in extension/manifest.json and can be
changed with -FirefoxAddonId.

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
One or more exact unpacked-extension IDs (32 characters, a-p). Defaults to
DonDownload's fixed extension ID (mikinloaillialkiannpcejdbmfbljhm), which is
pinned by extension/manifest.json. Pass other IDs only for an advanced or
legacy setup; every browser's ID must be included when they differ.

.PARAMETER Browser
Chrome, Edge, Helium, Firefox, Both, or All. Both means Chrome + Edge (the
historical default); Helium is explicit and uses the verified
Chromium-compatible Chrome current-user key; Firefox uses its own Mozilla key
and app manifest; All means Chrome + Edge + Firefox.

.PARAMETER HostPath
Optional native host executable. Defaults to
native\dondownload-native-host.exe.

.PARAMETER ManifestPath
Optional manifest destination. Defaults to
%APPDATA%\DonDownload\native-messaging\com.dondownload.bridge.json.

.PARAMETER FirefoxManifestPath
Optional Firefox app manifest destination. Defaults to
%APPDATA%\DonDownload\native-messaging\com.dondownload.bridge.firefox.json.

.PARAMETER FirefoxAddonId
The exact Firefox add-on ID written to allowed_extensions. Defaults to
DonDownload's fixed add-on ID (dondownload@dondownload.app), which is pinned by
extension/manifest.json.

.PARAMETER Unregister
Remove the current-user registrations and the generated manifest. With Helium,
this removes the shared Chrome-compatible key.

.PARAMETER PrintManifest
Print the Chromium app manifest JSON and exit without writing anything.

.PARAMETER PrintFirefoxManifest
Print the Firefox app manifest JSON and exit without writing anything.

.PARAMETER PrintRegistration
Print the resolved browser registry keys and manifest paths as JSON and exit
without writing anything. Useful for checking Helium's shared-key mapping.

.EXAMPLE
# Helium (verified local browser), using the fixed extension ID:
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1 -Browser Helium

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1 -Unregister -Browser Both
#>
[CmdletBinding()]
param(
    [string[]]$ExtensionId = @('mikinloaillialkiannpcejdbmfbljhm'),
    [ValidateSet('Chrome', 'Edge', 'Helium', 'Firefox', 'Both', 'All')]
    [string]$Browser = 'Both',
    [string]$HostPath,
    [string]$ManifestPath,
    [string]$FirefoxManifestPath,
    [string]$FirefoxAddonId = 'dondownload@dondownload.app',
    [switch]$Unregister,
    [switch]$PrintManifest,
    [switch]$PrintFirefoxManifest,
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

if ([string]::IsNullOrWhiteSpace($FirefoxManifestPath)) {
    if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
        throw 'APPDATA is not available; cannot choose a per-user manifest path.'
    }
    $FirefoxManifestPath = Join-Path $env:APPDATA "DonDownload\native-messaging\$HostName.firefox.json"
}
$FirefoxManifestPath = [System.IO.Path]::GetFullPath($FirefoxManifestPath)

$chromeKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$edgeKey = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
$firefoxKey = "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"

# Helium is Chromium-based and was verified locally to read the standard
# Chromium-compatible Chrome current-user key. Do not add a Helium-specific key
# unless a real Helium build is verified to require one.
$browserTargets = @(
    [pscustomobject]@{
        Browser       = 'Chrome'
        RegistryKey   = $chromeKey
        ManifestKind  = 'origins'
        SharesKeyWith = @()
        Note          = 'Standard Chrome current-user key.'
    }
    [pscustomobject]@{
        Browser       = 'Edge'
        RegistryKey   = $edgeKey
        ManifestKind  = 'origins'
        SharesKeyWith = @()
        Note          = 'Standard Edge current-user key.'
    }
    [pscustomobject]@{
        Browser       = 'Helium'
        RegistryKey   = $chromeKey
        ManifestKind  = 'origins'
        SharesKeyWith = @('Chrome')
        Note          = 'Helium uses the verified Chromium-compatible Chrome current-user key; no Helium-specific key is written.'
    }
    [pscustomobject]@{
        Browser       = 'Firefox'
        RegistryKey   = $firefoxKey
        ManifestKind  = 'extensions'
        SharesKeyWith = @()
        Note          = 'Firefox reads allowed_extensions from its own app manifest; Chrome ignores that key.'
    }
)

function Get-SelectedBrowsers {
    if ($Browser -eq 'Both') {
        # Preserve the historical meaning of Both: Chrome + Edge. Helium is an
        # explicit option because it shares Chrome's key.
        return @($browserTargets | Where-Object { $_.Browser -eq 'Chrome' -or $_.Browser -eq 'Edge' })
    }
    if ($Browser -eq 'All') {
        return @($browserTargets | Where-Object { $_.Browser -ne 'Helium' })
    }
    return @($browserTargets | Where-Object { $_.Browser -eq $Browser })
}

function Write-RegistrationPlan {
    $browsers = @()
    foreach ($target in Get-SelectedBrowsers) {
        $browsers += [ordered]@{
            browser       = $target.Browser
            registryKey   = $target.RegistryKey
            manifestKind  = $target.ManifestKind
            sharesKeyWith = @($target.SharesKeyWith)
            note          = $target.Note
        }
    }

    [ordered]@{
        mode                = $(if ($Unregister) { 'unregister' } else { 'register' })
        hostPath            = $HostPath
        manifestPath        = $ManifestPath
        firefoxManifestPath = $FirefoxManifestPath
        firefoxAddonId      = $FirefoxAddonId
        browsers            = @($browsers)
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

function Assert-ValidFirefoxAddonId([string]$id) {
    if ([string]::IsNullOrWhiteSpace($id)) {
        throw 'A Firefox add-on ID is required.'
    }
    if ($id -notmatch '^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$' -or $id.Length -gt 255) {
        throw "Invalid Firefox add-on ID '$id'. Use the exact id from browser_specific_settings.gecko.id (for example dondownload@dondownload.app)."
    }
}

function Assert-ValidHostPath {
    if (-not (Test-Path -LiteralPath $HostPath -PathType Leaf)) {
        throw "Native host executable not found: $HostPath. Run scripts\build-native-host.ps1 first."
    }
    if ([System.IO.Path]::GetExtension($HostPath) -ine '.exe') {
        throw "The browser manifest path must be a real .exe, not '$HostPath'."
    }
}

function New-NativeManifest {
    $validatedIds = Get-ValidatedExtensionIds
    $origins = New-Object System.Collections.Generic.List[string]
    foreach ($id in $validatedIds) {
        $origins.Add("chrome-extension://$id/")
    }

    Assert-ValidHostPath

    $manifest = [ordered]@{
        name            = $HostName
        description     = 'DonDownload native messaging bridge (manual HTTP(S) capture only)'
        path            = $HostPath
        type            = 'stdio'
        allowed_origins = @($origins.ToArray())
    }
    return $manifest
}

function New-FirefoxNativeManifest {
    $addonId = ([string]$FirefoxAddonId).Trim()
    Assert-ValidFirefoxAddonId $addonId
    Assert-ValidHostPath

    $manifest = [ordered]@{
        name               = $HostName
        description        = 'DonDownload native messaging bridge (manual HTTP(S) capture only)'
        path               = $HostPath
        type               = 'stdio'
        allowed_extensions = @($addonId)
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

    foreach ($file in @($ManifestPath, $FirefoxManifestPath)) {
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            Remove-Item -LiteralPath $file -Force
            Write-Host "Removed manifest: $file"
        }
    }
    return
}

if ($PrintManifest) {
    Write-Output ((New-NativeManifest) | ConvertTo-Json -Depth 5)
    return
}

if ($PrintFirefoxManifest) {
    Write-Output ((New-FirefoxNativeManifest) | ConvertTo-Json -Depth 5)
    return
}

if (-not $ExtensionId -or $ExtensionId.Count -eq 0) {
    throw 'Pass -ExtensionId with the exact unpacked extension ID, or use -Unregister.'
}

$selected = @(Get-SelectedBrowsers)
$writesOriginsManifest = @($selected | Where-Object { $_.ManifestKind -eq 'origins' }).Count -gt 0
$writesExtensionsManifest = @($selected | Where-Object { $_.ManifestKind -eq 'extensions' }).Count -gt 0

if ($writesOriginsManifest) {
    $manifest = New-NativeManifest
    $json = $manifest | ConvertTo-Json -Depth 5

    $manifestDirectory = Split-Path -Parent $ManifestPath
    New-Item -ItemType Directory -Force -Path $manifestDirectory | Out-Null
    [System.IO.File]::WriteAllText(
        $ManifestPath,
        $json,
        (New-Object System.Text.UTF8Encoding($false))
    )
    Write-Host "Wrote native messaging manifest: $ManifestPath"
}

if ($writesExtensionsManifest) {
    $firefoxJson = (New-FirefoxNativeManifest) | ConvertTo-Json -Depth 5

    $firefoxManifestDirectory = Split-Path -Parent $FirefoxManifestPath
    New-Item -ItemType Directory -Force -Path $firefoxManifestDirectory | Out-Null
    [System.IO.File]::WriteAllText(
        $FirefoxManifestPath,
        $firefoxJson,
        (New-Object System.Text.UTF8Encoding($false))
    )
    Write-Host "Wrote Firefox native messaging manifest: $FirefoxManifestPath"
}

foreach ($target in $selected) {
    $key = $target.RegistryKey
    $targetManifest = if ($target.ManifestKind -eq 'extensions') {
        $FirefoxManifestPath
    } else {
        $ManifestPath
    }
    New-Item -Path $key -Force | Out-Null
    Set-Item -Path $key -Value $targetManifest
    Write-Host "Registered $($target.Browser) native messaging host: $key"
    if ($target.Note) {
        Write-Host "  $($target.Note)"
    }
}

if ($writesOriginsManifest) {
    Write-Host ''
    Write-Host 'Allowed origins:'
    foreach ($id in (Get-ValidatedExtensionIds)) {
        Write-Host "  chrome-extension://$id/"
    }
}
if ($writesExtensionsManifest) {
    Write-Host ''
    Write-Host 'Allowed Firefox add-on IDs:'
    Write-Host "  $(([string]$FirefoxAddonId).Trim())"
}
Write-Host ''
Write-Host 'Restart the browser (or reload the extension) and try the popup or link context menu.'
