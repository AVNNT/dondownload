#Requires -Version 5.1
<#
.SYNOPSIS
Stages verified third-party Windows executables for the DonDownload installer.

.DESCRIPTION
Copies only the expected executables from an explicit DONDOWNLOAD_*_PATH
override or a verified local installation path into the ignored build\vendor
staging directory. It never downloads, installs, upgrades or modifies a tool,
the registry, the firewall or an existing DonDownload installation.

Every tool is executed with a read-only version flag and its version must match
the pinned version below. A missing tool, a mismatched version, a missing
license/notice file, or an unexpected staging directory fails the script before
an installer can be produced. The script writes a deterministic JSON manifest
with the SHA-256, version, source and license metadata for each staged file.

.PARAMETER OutputDirectory
Optional staging directory. It must be a child of the repository's build\
directory. Defaults to build\vendor.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stage-vendor.ps1

.EXAMPLE
$env:DONDOWNLOAD_YTDLP_PATH = 'D:\tools\yt-dlp.exe'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stage-vendor.ps1
#>
[CmdletBinding()]
param(
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $root 'build\vendor'
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$buildRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'build'))
$buildPrefix = $buildRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $OutputDirectory.StartsWith($buildPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to stage outside the ignored build directory. Expected a child of '$buildRoot', got '$OutputDirectory'."
}

# Pinned versions are the versions verified on the development machine and
# documented in docs/media-tools.md. Change them only together with the
# third-party notice review in third-party/NOTICE.md.
$tools = @(
    [pscustomobject]@{
        Name                 = 'aria2'
        Executable           = 'aria2c.exe'
        EnvOverride          = 'DONDOWNLOAD_ARIA2_PATH'
        ExpectedVersion      = '1.37.0'
        VersionArguments     = @('--version')
        VersionPattern       = '(?m)^aria2 version\s+([0-9]+\.[0-9]+\.[0-9]+)'
        TargetRelativePath   = 'aria2\aria2c.exe'
        PathCommand          = 'aria2c'
        KnownPaths           = @(
            'C:\Users\PC\AppData\Local\Microsoft\WinGet\Packages\aria2.aria2_Microsoft.Winget.Source_8wekyb3d8bbwe\aria2-1.37.0-win-64bit-build1\aria2c.exe'
        )
        License              = 'GPL-2.0-or-later'
        LicenseFiles         = @(
            'third-party\licenses\aria2-COPYING.txt',
            'third-party\licenses\aria2-LICENSE.OpenSSL.txt'
        )
        Upstream             = 'https://aria2.github.io/'
        SourceVersion        = '1.37.0'
        SourceArchive        = 'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0.tar.bz2'
        Notice               = 'aria2 is GPL-2.0-or-later. See third-party/NOTICE.md for source-offer obligations.'
    }
    [pscustomobject]@{
        Name                 = 'yt-dlp'
        Executable           = 'yt-dlp.exe'
        EnvOverride          = 'DONDOWNLOAD_YTDLP_PATH'
        ExpectedVersion      = '2026.10.26'
        VersionArguments     = @('--version')
        VersionPattern       = '(?m)^\s*([0-9]{4}\.[0-9]{2}\.[0-9]{2})\s*$'
        TargetRelativePath   = 'yt-dlp\yt-dlp.exe'
        PathCommand          = 'yt-dlp'
        KnownPaths           = @(
            'C:\Users\PC\AppData\Local\Microsoft\WinGet\Packages\yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe\yt-dlp.exe'
        )
        License              = 'Unlicense (with bundled third-party notices)'
        LicenseFiles         = @(
            'third-party\licenses\yt-dlp-UNLICENSE.txt',
            'third-party\licenses\yt-dlp-THIRD_PARTY_LICENSES.txt'
        )
        Upstream             = 'https://github.com/yt-dlp/yt-dlp'
        SourceVersion        = '2026.10.26'
        SourceArchive        = 'https://github.com/yt-dlp/yt-dlp/archive/refs/tags/2026.10.26.tar.gz'
        Notice               = 'yt-dlp is Unlicense; the standalone Windows executable also carries third-party licenses. See third-party/NOTICE.md.'
    }
    [pscustomobject]@{
        Name                 = 'ffmpeg'
        Executable           = 'ffmpeg.exe'
        EnvOverride          = 'DONDOWNLOAD_FFMPEG_PATH'
        ExpectedVersion      = '9.0.2'
        VersionArguments     = @('-version')
        VersionPattern       = '(?m)^ffmpeg version\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)'
        TargetRelativePath   = 'ffmpeg\ffmpeg.exe'
        PathCommand          = 'ffmpeg'
        KnownPaths           = @(
            'C:\Users\PC\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin\ffmpeg.exe'
        )
        License              = 'GPL-3.0-or-later (Gyan full build)'
        LicenseFiles         = @(
            'third-party\licenses\ffmpeg-GPLv3.txt',
            'third-party\licenses\ffmpeg-GYAN-BUILD-README.txt'
        )
        Upstream             = 'https://ffmpeg.org/'
        SourceVersion        = '9.0.2 / FFmpeg commit 946fcce07b'
        SourceArchive        = 'https://github.com/FFmpeg/FFmpeg/archive/946fcce07b.tar.gz'
        Notice               = 'FFmpeg Gyan full build is GPLv3. See third-party/NOTICE.md for source-offer obligations.'
    }
    [pscustomobject]@{
        Name                 = 'ffprobe'
        Executable           = 'ffprobe.exe'
        EnvOverride          = 'DONDOWNLOAD_FFPROBE_PATH'
        ExpectedVersion      = '9.0.2'
        VersionArguments     = @('-version')
        VersionPattern       = '(?m)^ffprobe version\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)'
        TargetRelativePath   = 'ffmpeg\ffprobe.exe'
        PathCommand          = 'ffprobe'
        KnownPaths           = @(
            'C:\Users\PC\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin\ffprobe.exe'
        )
        License              = 'GPL-3.0-or-later (Gyan full build)'
        LicenseFiles         = @(
            'third-party\licenses\ffmpeg-GPLv3.txt',
            'third-party\licenses\ffmpeg-GYAN-BUILD-README.txt'
        )
        Upstream             = 'https://ffmpeg.org/'
        SourceVersion        = '9.0.2 / FFmpeg commit 946fcce07b'
        SourceArchive        = 'https://github.com/FFmpeg/FFmpeg/archive/946fcce07b.tar.gz'
        Notice               = 'ffprobe from the FFmpeg Gyan full build is GPLv3. See third-party/NOTICE.md.'
    }
    [pscustomobject]@{
        Name                 = 'deno'
        Executable           = 'deno.exe'
        EnvOverride          = 'DONDOWNLOAD_DENO_PATH'
        ExpectedVersion      = '2.9.8'
        VersionArguments     = @('--version')
        VersionPattern       = '(?m)^deno\s+([0-9]+\.[0-9]+\.[0-9]+)'
        TargetRelativePath   = 'deno\deno.exe'
        PathCommand          = 'deno'
        KnownPaths           = @(
            'C:\Users\PC\AppData\Local\Microsoft\WinGet\Packages\DenoLand.Deno_Microsoft.Winget.Source_8wekyb3d8bbwe\deno.exe'
        )
        License              = 'MIT'
        LicenseFiles         = @(
            'third-party\licenses\deno-LICENSE.txt'
        )
        Upstream             = 'https://github.com/denoland/deno'
        SourceVersion        = '2.9.8'
        SourceArchive        = 'https://github.com/denoland/deno/archive/refs/tags/v2.9.8.tar.gz'
        Notice               = 'Deno is MIT. Bundled because current yt-dlp YouTube extraction requires a JavaScript runtime.'
    }
)

function Resolve-ToolSource {
    param([pscustomobject]$Tool)

    $override = [Environment]::GetEnvironmentVariable($Tool.EnvOverride)
    if (-not [string]::IsNullOrWhiteSpace($override)) {
        $raw = $override.Trim().Trim('"')
        $candidate = if ([System.IO.Path]::IsPathRooted($raw)) {
            $raw
        } else {
            Join-Path $root $raw
        }
        $candidate = [System.IO.Path]::GetFullPath($candidate)
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "$($Tool.Name): $($Tool.EnvOverride) points to a missing file: $candidate"
        }
        return [pscustomobject]@{
            Path   = $candidate
            Kind   = 'environment-override'
            Origin = $Tool.EnvOverride
        }
    }

    foreach ($candidate in $Tool.KnownPaths) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return [pscustomobject]@{
                Path   = [System.IO.Path]::GetFullPath($candidate)
                Kind   = 'verified-local-path'
                Origin = 'documented local installation path'
            }
        }
    }

    $command = Get-Command $Tool.PathCommand -ErrorAction SilentlyContinue
    if ($null -ne $command -and -not [string]::IsNullOrWhiteSpace($command.Source)) {
        $candidate = [System.IO.Path]::GetFullPath($command.Source)
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return [pscustomobject]@{
                Path   = $candidate
                Kind   = 'path-lookup'
                Origin = $Tool.PathCommand
            }
        }
    }

    throw "$($Tool.Name): no executable found. Set $($Tool.EnvOverride), install the verified version locally, or add it to PATH. Nothing is downloaded by this script."
}

function Get-ToolVersion {
    param(
        [pscustomobject]$Tool,
        [string]$Path
    )

    $output = & $Path @($Tool.VersionArguments) 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "$($Tool.Name): '$Path $($Tool.VersionArguments -join ' ')' failed with exit code $exitCode."
    }

    $text = ($output | Out-String)
    $match = [regex]::Match($text, $Tool.VersionPattern)
    if (-not $match.Success) {
        throw "$($Tool.Name): could not parse a version from '$Path'. Output: $($text.Trim())"
    }

    $version = $match.Groups[1].Value
    if ($version -ne $Tool.ExpectedVersion) {
        throw "$($Tool.Name): version mismatch. Expected $($Tool.ExpectedVersion), found $version at $Path. Update the pinned version and notices only after review."
    }
    return $version
}

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

if (Test-Path -LiteralPath $OutputDirectory) {
    Remove-Item -LiteralPath $OutputDirectory -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$stagedTools = New-Object System.Collections.Generic.List[object]

foreach ($tool in $tools) {
    $source = Resolve-ToolSource -Tool $tool
    $version = Get-ToolVersion -Tool $tool -Path $source.Path

    $licenseFiles = New-Object System.Collections.Generic.List[object]
    foreach ($relativeLicense in $tool.LicenseFiles) {
        $licensePath = Join-Path $root $relativeLicense
        if (-not (Test-Path -LiteralPath $licensePath -PathType Leaf)) {
            throw "$($tool.Name): required license/notice file is missing: $relativeLicense. Refusing to stage a binary without its notices."
        }
        $licenseFiles.Add([ordered]@{
            path   = $relativeLicense.Replace('\', '/')
            sha256 = Get-Sha256 -Path $licensePath
            sizeBytes = (Get-Item -LiteralPath $licensePath).Length
        })
    }

    $target = Join-Path $OutputDirectory $tool.TargetRelativePath
    $targetDirectory = Split-Path -Parent $target
    New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null
    Copy-Item -LiteralPath $source.Path -Destination $target -Force

    $sourceHash = Get-Sha256 -Path $source.Path
    $stagedHash = Get-Sha256 -Path $target
    if ($sourceHash -ne $stagedHash) {
        throw "$($tool.Name): staged copy hash does not match the source hash."
    }

    $item = Get-Item -LiteralPath $target
    $stagedTools.Add([ordered]@{
        name            = $tool.Name
        executable      = $tool.Executable
        stagedPath      = $tool.TargetRelativePath.Replace('\', '/')
        version         = $version
        expectedVersion = $tool.ExpectedVersion
        sha256          = $stagedHash
        sizeBytes       = $item.Length
        source          = [ordered]@{
            kind   = $source.Kind
            path   = $source.Path
            origin = $source.Origin
        }
        license         = $tool.License
        licenseFiles    = @($licenseFiles.ToArray())
        upstream        = $tool.Upstream
        sourceVersion   = $tool.SourceVersion
        sourceArchive   = $tool.SourceArchive
        notice          = $tool.Notice
    })

    Write-Host ("Staged {0} {1} ({2:N0} bytes, sha256 {3})" -f $tool.Name, $version, $item.Length, $stagedHash)
}

$manifest = [ordered]@{
    schemaVersion = 1
    generatedBy   = 'scripts/stage-vendor.ps1'
    platform      = 'win32-x64'
    tools         = @($stagedTools.ToArray())
    notices       = [ordered]@{
        noticeFile     = 'third-party/NOTICE.md'
        licenseRoot    = 'third-party/licenses'
        sourceOffer    = 'See docs/installer-packaging.md and third-party/NOTICE.md. This manifest is an inventory, not a legal conclusion.'
    }
}

$manifestPath = Join-Path $OutputDirectory 'manifest.json'
$json = $manifest | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText(
    $manifestPath,
    $json + [Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($false))
)

Write-Host ''
Write-Host "Vendor staging complete: $OutputDirectory"
Write-Host "Manifest: $manifestPath"
Write-Host ("Tools: {0}" -f (($tools | ForEach-Object { "$($_.Name) $($_.ExpectedVersion)" }) -join ', '))
