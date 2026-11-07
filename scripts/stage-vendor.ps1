#Requires -Version 5.1
<#
.SYNOPSIS
Stages verified third-party Windows executables for the DonDownload installer.

.DESCRIPTION
Copies only the expected executables from an explicit DONDOWNLOAD_*_PATH
override or a verified local installation path into the ignored build\vendor
staging directory. It never installs, upgrades or modifies a tool, the registry,
the firewall or an existing DonDownload installation.

Only aria2, yt-dlp and FFmpeg are staged. FFprobe and Deno are not: the app
reads stream headers with FFmpeg itself and downloads Deno on demand for YouTube
JS challenges.

yt-dlp is staged as the official Windows one-folder build (`yt-dlp.exe` plus
`_internal\`) because it starts much faster than the PyInstaller one-file
executable. A verified local `yt-dlp_win.zip` may be supplied with
DONDOWNLOAD_YTDLP_ZIP_PATH (or a cached copy may exist below
%LOCALAPPDATA%\DonDownload\vendor). When neither is present, the script downloads
only the pinned yt-dlp archive URL below and requires its SHA-256 to match the
pinned value; no other download is performed.

Every tool is executed with a read-only version flag and its version must match
the pinned version below. A missing tool, a mismatched version, a missing
license/notice file, an unsafe archive entry, or an unexpected staging directory
fails the script before an installer can be produced. The script writes a
deterministic JSON manifest with the SHA-256, version, source and license
metadata for each staged file.

.PARAMETER OutputDirectory
Optional staging directory. It must be a child of the repository's build\
directory. Defaults to build\vendor.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stage-vendor.ps1

.EXAMPLE
$env:DONDOWNLOAD_YTDLP_ZIP_PATH = 'D:\downloads\yt-dlp_win.zip'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stage-vendor.ps1

.EXAMPLE
$env:DONDOWNLOAD_YTDLP_PATH = 'D:\tools\yt-dlp\yt-dlp.exe'
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
#
# Only these executables are staged. Two tools that earlier releases shipped are
# deliberately absent:
# - ffprobe: the application no longer calls it. The bounded header read that
#   labels an unlabeled stream now runs `ffmpeg -i <url>` and parses the stream
#   table FFmpeg prints on stderr, so the 100 MB probe executable is not needed.
# - deno: yt-dlp only needs a JavaScript runtime for YouTube JS challenges. The
#   app downloads the pinned, SHA-256 verified build into
#   <userData>/tools/deno/<version>/deno.exe the first time a YouTube job needs
#   it (src/main/media/jsRuntime.ts). Shipping it in every installer cost about
#   94 MB for a feature most downloads never use.
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
        # The official Windows one-folder build starts much faster than the
        # PyInstaller one-file executable because nothing self-extracts on
        # every launch. It is staged as `yt-dlp\yt-dlp.exe` plus `_internal\`.
        Layout               = 'onedir'
        ArchiveEnvOverride   = 'DONDOWNLOAD_YTDLP_ZIP_PATH'
        ArchiveFileName      = 'yt-dlp_win.zip'
        ArchiveUrl           = 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_win.zip'
        ArchiveSha256        = 'fd51b212cf8380c7a52ee08c0d6be7f3c59b2f2c832eaf7b45acfae6eab57419'
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
        Notice               = 'yt-dlp is Unlicense; the official Windows one-folder build also carries the bundled third-party licenses. See third-party/NOTICE.md.'
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
            # Gyan "essentials" build: about half the size of the full build and
            # covers every muxer/codec DonDownload uses (mp4/mkv/webm merges,
            # mp3/m4a/opus extraction, HLS over https). Extracted from
            # https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip
            # (SHA-256 60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba).
            #
            # This stays the smallest build that can be verified here. The
            # "essentials" variant is already Gyan's reduced build: the shared
            # and full variants are larger once their DLLs are counted, and no
            # other reputable publisher offers a pinned Windows build with a
            # published SHA-256 that still carries the mp3/m4a/opus encoders,
            # the mp4/mkv/webm muxers and HTTPS HLS input. A smaller build would
            # have to drop codecs the download pipeline actually invokes, so the
            # 100 MB static executable is kept.
            (Join-Path $env:LOCALAPPDATA 'DonDownload\vendor\ffmpeg-9.0.2-essentials_build\bin\ffmpeg.exe'),
            'C:\Users\PC\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin\ffmpeg.exe'
        )
        License              = 'GPL-3.0-or-later (Gyan essentials build)'
        LicenseFiles         = @(
            'third-party\licenses\ffmpeg-GPLv3.txt',
            'third-party\licenses\ffmpeg-GYAN-ESSENTIALS-BUILD-README.txt'
        )
        Upstream             = 'https://ffmpeg.org/'
        SourceVersion        = '9.0.2 / FFmpeg commit 946fcce07b'
        SourceArchive        = 'https://github.com/FFmpeg/FFmpeg/archive/946fcce07b.tar.gz'
        Notice               = 'FFmpeg Gyan essentials build is GPLv3. See third-party/NOTICE.md for source-offer obligations.'
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

function Assert-Sha256 {
    param(
        [string]$Path,
        [string]$Expected,
        [string]$Description
    )
    $actual = Get-Sha256 -Path $Path
    if ($actual -ne $Expected.ToLowerInvariant()) {
        throw "$Description checksum mismatch. Expected $Expected, got $actual for $Path."
    }
    return $actual
}

function Expand-VerifiedZip {
    param(
        [string]$ZipPath,
        [string]$Destination,
        [pscustomobject]$Tool
    )

    # Caps mirror the runtime updater: reject oversized archives before any
    # byte is written, and validate every entry name for zip-slip safety.
    $maxEntries = 20000
    $maxTotalBytes = [long](300 * 1024 * 1024)
    $maxEntryBytes = [long](300 * 1024 * 1024)

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $destinationFull = [System.IO.Path]::GetFullPath($Destination)
    $prefix = $destinationFull.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

    $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        if ($zip.Entries.Count -gt $maxEntries) {
            throw "$($Tool.Name): archive contains too many entries ($($zip.Entries.Count))."
        }
        [long]$totalBytes = 0
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName
            if ([string]::IsNullOrEmpty($name) -or $name.Length -gt 4096) {
                throw "$($Tool.Name): archive contains an invalid entry name."
            }
            if ($name -match '[\x00-\x1f\x7f]') {
                throw "$($Tool.Name): archive contains a control character in an entry name."
            }
            if ($name.Contains('\')) {
                throw "$($Tool.Name): archive entry uses a backslash separator: $name"
            }
            if ($name.StartsWith('/') -or $name -match '^[A-Za-z]:') {
                throw "$($Tool.Name): archive contains an absolute entry path: $name"
            }
            foreach ($segment in $name.Split('/')) {
                if ($segment -eq '..' -or $segment -eq '.') {
                    throw "$($Tool.Name): archive entry escapes the extraction directory: $name"
                }
            }
            if ($name.EndsWith('/')) { continue }

            if ($entry.Length -gt $maxEntryBytes) {
                throw "$($Tool.Name): archive entry exceeds the extraction size limit: $name"
            }
            $totalBytes += $entry.Length
            if ($totalBytes -gt $maxTotalBytes) {
                throw "$($Tool.Name): archive expands beyond the extraction size limit."
            }

            $relative = $name.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
            $target = [System.IO.Path]::GetFullPath((Join-Path $destinationFull $relative))
            if (-not $target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "$($Tool.Name): archive entry escapes the extraction directory: $name"
            }
            $parent = Split-Path -Parent $target
            New-Item -ItemType Directory -Force -Path $parent | Out-Null
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
        }
    } finally {
        $zip.Dispose()
    }
}

function Resolve-YtdlpOnedir {
    param([pscustomobject]$Tool)

    $cacheDir = if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        Join-Path ([System.IO.Path]::GetTempPath()) 'DonDownload\vendor'
    } else {
        Join-Path $env:LOCALAPPDATA 'DonDownload\vendor'
    }
    $cachePath = Join-Path $cacheDir ("yt-dlp_win-{0}.zip" -f $Tool.ExpectedVersion)

    $override = [Environment]::GetEnvironmentVariable($Tool.ArchiveEnvOverride)
    if (-not [string]::IsNullOrWhiteSpace($override)) {
        $raw = $override.Trim().Trim('"')
        $candidate = if ([System.IO.Path]::IsPathRooted($raw)) { $raw } else { Join-Path $root $raw }
        $candidate = [System.IO.Path]::GetFullPath($candidate)
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "$($Tool.Name): $($Tool.ArchiveEnvOverride) points to a missing file: $candidate"
        }
        Assert-Sha256 -Path $candidate -Expected $Tool.ArchiveSha256 -Description "$($Tool.Name) archive" | Out-Null
        return [pscustomobject]@{
            ZipPath   = $candidate
            Directory = $null
            Kind      = 'environment-override'
            Origin    = $Tool.ArchiveEnvOverride
        }
    }

    # A staged one-folder installation can be pointed at directly.
    $exeCandidates = New-Object System.Collections.Generic.List[string]
    $exeOverride = [Environment]::GetEnvironmentVariable($Tool.EnvOverride)
    if (-not [string]::IsNullOrWhiteSpace($exeOverride)) {
        $raw = $exeOverride.Trim().Trim('"')
        $exeCandidates.Add($(if ([System.IO.Path]::IsPathRooted($raw)) { $raw } else { Join-Path $root $raw }))
    }
    foreach ($known in $Tool.KnownPaths) { $exeCandidates.Add($known) }
    foreach ($candidate in $exeCandidates) {
        $exePath = [System.IO.Path]::GetFullPath($candidate)
        if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) { continue }
        $directory = Split-Path -Parent $exePath
        if (Test-Path -LiteralPath (Join-Path $directory '_internal') -PathType Container) {
            return [pscustomobject]@{
                ZipPath   = $null
                Directory = $directory
                Kind      = 'verified-local-onedir'
                Origin    = 'documented one-folder installation'
            }
        }
    }

    if (Test-Path -LiteralPath $cachePath -PathType Leaf) {
        Assert-Sha256 -Path $cachePath -Expected $Tool.ArchiveSha256 -Description "$($Tool.Name) cached archive" | Out-Null
        return [pscustomobject]@{
            ZipPath   = $cachePath
            Directory = $null
            Kind      = 'verified-local-cache'
            Origin    = $cachePath
        }
    }

    # No verified local copy: fetch only the pinned official archive URL.
    New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
    $tempDownload = Join-Path $cacheDir ('.yt-dlp-download-{0}.zip' -f [guid]::NewGuid().ToString('N'))
    try {
        Write-Host "Downloading pinned $($Tool.ArchiveFileName) from $($Tool.ArchiveUrl)"
        Invoke-WebRequest -Uri $Tool.ArchiveUrl -OutFile $tempDownload -UseBasicParsing
        Assert-Sha256 -Path $tempDownload -Expected $Tool.ArchiveSha256 -Description "$($Tool.Name) downloaded archive" | Out-Null
        Move-Item -LiteralPath $tempDownload -Destination $cachePath -Force
    } catch {
        if (Test-Path -LiteralPath $tempDownload) {
            Remove-Item -LiteralPath $tempDownload -Force -ErrorAction SilentlyContinue
        }
        throw
    }

    return [pscustomobject]@{
        ZipPath   = $cachePath
        Directory = $null
        Kind      = 'verified-github-archive'
        Origin    = $Tool.ArchiveUrl
    }
}

if (Test-Path -LiteralPath $OutputDirectory) {
    Remove-Item -LiteralPath $OutputDirectory -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$stagedTools = New-Object System.Collections.Generic.List[object]

foreach ($tool in $tools) {
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

    $isOnedir = ($tool.PSObject.Properties.Name -contains 'Layout') -and $tool.Layout -eq 'onedir'
    $extra = [ordered]@{}
    $stagingWork = $null

    if ($isOnedir) {
        # Stage the official one-folder build: `yt-dlp.exe` plus `_internal\`.
        $archive = Resolve-YtdlpOnedir -Tool $tool
        $sourceDirectory = $archive.Directory
        if ($null -eq $sourceDirectory) {
            $stagingWork = Join-Path ([System.IO.Path]::GetTempPath()) ('dondownload-stage-{0}-{1}' -f $tool.Name, [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Force -Path $stagingWork | Out-Null
            try {
                Expand-VerifiedZip -ZipPath $archive.ZipPath -Destination $stagingWork -Tool $tool
            } catch {
                Remove-Item -LiteralPath $stagingWork -Recurse -Force -ErrorAction SilentlyContinue
                throw
            }
            $sourceDirectory = $stagingWork
        }

        try {
            $sourceExe = Join-Path $sourceDirectory $tool.Executable
            if (-not (Test-Path -LiteralPath $sourceExe -PathType Leaf)) {
                throw "$($tool.Name): the verified archive did not contain $($tool.Executable)."
            }
            if (-not (Test-Path -LiteralPath (Join-Path $sourceDirectory '_internal') -PathType Container)) {
                throw "$($tool.Name): the verified archive is not the expected one-folder build (missing _internal)."
            }
            $version = Get-ToolVersion -Tool $tool -Path $sourceExe

            $target = Join-Path $OutputDirectory $tool.TargetRelativePath
            $targetDirectory = Split-Path -Parent $target
            New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null
            Copy-Item -Path (Join-Path $sourceDirectory '*') -Destination $targetDirectory -Recurse -Force

            $sourceHash = Get-Sha256 -Path $sourceExe
            $stagedHash = Get-Sha256 -Path $target
            if ($sourceHash -ne $stagedHash) {
                throw "$($tool.Name): staged copy hash does not match the source hash."
            }

            $item = Get-Item -LiteralPath $target
            $stagedFiles = @(Get-ChildItem -LiteralPath $targetDirectory -Recurse -File)
            [long]$extractedSizeBytes = ($stagedFiles | Measure-Object -Property Length -Sum).Sum
            if ($null -eq $extractedSizeBytes) { $extractedSizeBytes = 0 }

            $extra = [ordered]@{
                layout             = 'onedir'
                fileCount          = $stagedFiles.Count
                extractedSizeBytes = $extractedSizeBytes
                archive            = [ordered]@{
                    name      = $tool.ArchiveFileName
                    url       = $tool.ArchiveUrl
                    sha256    = $tool.ArchiveSha256
                    sizeBytes = if ($null -ne $archive.ZipPath) { (Get-Item -LiteralPath $archive.ZipPath).Length } else { $null }
                }
            }
            $sourceKind = $archive.Kind
            $sourcePath = if ($null -ne $archive.ZipPath) { $archive.ZipPath } else { $sourceExe }
            $sourceOrigin = $archive.Origin
        } finally {
            if ($null -ne $stagingWork -and (Test-Path -LiteralPath $stagingWork)) {
                Remove-Item -LiteralPath $stagingWork -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    } else {
        $source = Resolve-ToolSource -Tool $tool
        $version = Get-ToolVersion -Tool $tool -Path $source.Path

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
        $sourceKind = $source.Kind
        $sourcePath = $source.Path
        $sourceOrigin = $source.Origin
    }

    $manifestItem = [ordered]@{
        name            = $tool.Name
        executable      = $tool.Executable
        stagedPath      = $tool.TargetRelativePath.Replace('\', '/')
        version         = $version
        expectedVersion = $tool.ExpectedVersion
        sha256          = $stagedHash
        sizeBytes       = $item.Length
        source          = [ordered]@{
            kind   = $sourceKind
            path   = $sourcePath
            origin = $sourceOrigin
        }
        license         = $tool.License
        licenseFiles    = @($licenseFiles.ToArray())
        upstream        = $tool.Upstream
        sourceVersion   = $tool.SourceVersion
        sourceArchive   = $tool.SourceArchive
        notice          = $tool.Notice
    }
    foreach ($key in $extra.Keys) { $manifestItem[$key] = $extra[$key] }
    $stagedTools.Add($manifestItem)

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
