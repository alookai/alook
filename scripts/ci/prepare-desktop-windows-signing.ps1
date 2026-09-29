[CmdletBinding()]
param(
    [Parameter()]
    [string]$ManifestPath = (Join-Path $PSScriptRoot "desktop-signing-dependencies.json"),

    [Parameter(Mandatory)]
    [string]$DestinationRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$expectedPackages = @{
    "ArtifactSigning" = "0.1.8"
    "Microsoft.Windows.SDK.BuildTools" = "10.0.26100.4188"
    "Microsoft.ArtifactSigning.Client" = "1.0.128"
    "sign" = "0.9.1-beta.26227.3"
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1) {
    throw "Unsupported signing dependency manifest schema: $($manifest.schemaVersion)"
}
if ($manifest.packages.Count -ne $expectedPackages.Count) {
    throw "Signing dependency manifest must contain exactly $($expectedPackages.Count) packages"
}

$seen = @{}
foreach ($package in $manifest.packages) {
    if (-not $expectedPackages.ContainsKey($package.name)) {
        throw "Unexpected signing dependency: $($package.name)"
    }
    if ($seen.ContainsKey($package.name)) {
        throw "Duplicate signing dependency: $($package.name)"
    }
    $seen[$package.name] = $true
    if ($package.version -ne $expectedPackages[$package.name]) {
        throw "Unexpected version for $($package.name): $($package.version)"
    }
    if ($package.source -notmatch '^https://(www\.powershellgallery\.com|api\.nuget\.org)/') {
        throw "Unapproved package source for $($package.name)"
    }
    if ($package.sha256 -notmatch '^[0-9a-f]{64}$') {
        throw "Invalid SHA-256 for $($package.name)"
    }
}

$destination = [IO.Path]::GetFullPath($DestinationRoot)
if (Test-Path -LiteralPath $destination) {
    throw "Signing dependency destination must be fresh: $destination"
}

$packagesRoot = Join-Path $destination "packages"
$moduleRoot = Join-Path $destination "modules\ArtifactSigning\0.1.8"
$localAppData = Join-Path $destination "localappdata"
New-Item -Path $packagesRoot -ItemType Directory | Out-Null
New-Item -Path $moduleRoot -ItemType Directory | Out-Null
New-Item -Path $localAppData -ItemType Directory | Out-Null

Add-Type -AssemblyName System.IO.Compression.FileSystem

foreach ($package in $manifest.packages) {
    $archive = Join-Path $packagesRoot "$($package.name).$($package.version).nupkg"
    & curl.exe --fail --location --silent --show-error `
        --proto '=https' --tlsv1.2 `
        --connect-timeout 15 --max-time 600 `
        --retry 3 --retry-delay 2 --retry-all-errors `
        --output $archive $package.source
    if ($LASTEXITCODE -ne 0) {
        throw "Official package download failed for $($package.name) after bounded retries"
    }

    $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $package.sha256) {
        throw "SHA-256 mismatch for $($package.name): expected $($package.sha256), got $actualHash"
    }

    if ($package.kind -eq "module") {
        $extractPath = $moduleRoot
    } else {
        $packageVersionsPath = Join-Path $localAppData "ArtifactSigning\$($package.name)"
        $extractPath = Join-Path $packageVersionsPath "$($package.name).$($package.version)"
        New-Item -Path $packageVersionsPath -ItemType Directory -Force | Out-Null
    }

    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $extractPath)
}

$modulePath = Join-Path $moduleRoot "ArtifactSigning.psd1"
if (-not (Test-Path -LiteralPath $modulePath -PathType Leaf)) {
    throw "ArtifactSigning module was not extracted to the expected path"
}

$requiredContent = @(
    (Join-Path $localAppData "ArtifactSigning\Microsoft.Windows.SDK.BuildTools\Microsoft.Windows.SDK.BuildTools.10.0.26100.4188\bin\10.0.26100.0\x64\signtool.exe"),
    (Join-Path $localAppData "ArtifactSigning\Microsoft.ArtifactSigning.Client\Microsoft.ArtifactSigning.Client.1.0.128\bin\x64\Azure.CodeSigning.Dlib.dll"),
    (Join-Path $localAppData "ArtifactSigning\sign\sign.0.9.1-beta.26227.3\tools\net8.0\any\sign.dll")
)
foreach ($requiredPath in $requiredContent) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Signing dependency is missing expected content: $requiredPath"
    }
}

if (-not $env:GITHUB_ENV) {
    throw "GITHUB_ENV is required so Tauri's child signing commands inherit the verified paths"
}

"LOCALAPPDATA=$localAppData" | Out-File -LiteralPath $env:GITHUB_ENV -Append -Encoding utf8
"ALOOK_ARTIFACT_SIGNING_MODULE_PATH=$modulePath" | Out-File -LiteralPath $env:GITHUB_ENV -Append -Encoding utf8
"PSModulePath=$(Split-Path $moduleRoot -Parent);$env:PSModulePath" | Out-File -LiteralPath $env:GITHUB_ENV -Append -Encoding utf8

Write-Host "Prepared four digest-verified signing packages in a fresh runner-temporary directory."
