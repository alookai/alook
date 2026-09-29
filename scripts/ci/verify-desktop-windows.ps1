[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$StageDirectory,

    [Parameter(Mandatory)]
    [string]$ExpectedVersion,

    [Parameter(Mandatory)]
    [string]$ExpectedPublisher,

    [Parameter(Mandatory)]
    [string]$TauriConfigPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$stage = (Resolve-Path -LiteralPath $StageDirectory).Path

& node (Join-Path $repositoryRoot "scripts\ci\desktop-release-artifacts.mjs") validate `
    --target "windows-x86_64" --version $ExpectedVersion --stage $stage
if ($LASTEXITCODE -ne 0) { throw "Windows staged artifact manifest validation failed" }

$msi = Join-Path $stage "files\Alook_${ExpectedVersion}_x64_en-US.msi"
$nsis = Join-Path $stage "files\Alook_${ExpectedVersion}_x64-setup.exe"

function Assert-Authenticode {
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [Parameter(Mandatory)]
        [string]$Label
    )

    $output = & signtool.exe verify /pa /all /v $Path 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "signtool rejected $Label`n$output" }
    if ($output -notmatch '(?im)^Hash of file \(sha256\): [0-9a-f]+$') { throw "$Label does not use a SHA-256 Authenticode file digest" }
    if ($output -notmatch '(?im)^The signature is timestamped:') { throw "$Label is missing a verified timestamp" }
    if ($output -notmatch '(?im)^Timestamp Verified by:') { throw "$Label is missing a timestamp certificate chain" }
    if (($output | Select-String -Pattern '(?im)^Signing Certificate Chain:' -AllMatches).Matches.Count -ne 1) {
        throw "$Label must contain exactly one Authenticode signature"
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "$Label Authenticode status is $($signature.Status)"
    }
    if ($signature.SignerCertificate.Subject -ne $ExpectedPublisher) {
        throw "$Label publisher mismatch: $($signature.SignerCertificate.Subject)"
    }
    if ($null -eq $signature.TimeStamperCertificate) { throw "$Label has no timestamp certificate" }
}

function Assert-EmbeddedMainExecutable {
    param(
        [Parameter(Mandatory)]
        [string]$Installer,

        [Parameter(Mandatory)]
        [string]$Label
    )

    $extractRoot = Join-Path $env:RUNNER_TEMP "alook-$Label-$([Guid]::NewGuid().ToString('N'))"
    New-Item -Path $extractRoot -ItemType Directory | Out-Null
    try {
        & 7z.exe x -y "-o$extractRoot" $Installer | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "7-Zip could not extract $Label" }
        $executables = @(Get-ChildItem -LiteralPath $extractRoot -Recurse -File -Filter "alook-desktop.exe")
        if ($executables.Count -ne 1) { throw "$Label must contain exactly one alook-desktop.exe" }
        Assert-Authenticode -Path $executables[0].FullName -Label "$Label embedded main executable"
    } finally {
        Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

foreach ($installer in @($msi, $nsis)) {
    $signaturePath = "$installer.sig"
    & node (Join-Path $repositoryRoot "scripts\ci\verify-minisign.mjs") `
        --file $installer --signature $signaturePath --config $TauriConfigPath `
        --version $ExpectedVersion --trusted-file ([IO.Path]::GetFileName($installer))
    if ($LASTEXITCODE -ne 0) { throw "Minisign verification failed for $installer" }
    Assert-Authenticode -Path $installer -Label ([IO.Path]::GetFileName($installer))
}

Assert-EmbeddedMainExecutable -Installer $msi -Label "msi"
Assert-EmbeddedMainExecutable -Installer $nsis -Label "nsis"

Write-Host "Verified staged Windows installers, embedded main executables, and exact-byte updater signatures."
