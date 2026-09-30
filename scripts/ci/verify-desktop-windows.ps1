[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$StageDirectory,

    [Parameter(Mandatory)]
    [string]$ExpectedVersion,

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

foreach ($installer in @($msi, $nsis)) {
    $signaturePath = "$installer.sig"
    & node (Join-Path $repositoryRoot "scripts\ci\verify-minisign.mjs") `
        --file $installer --signature $signaturePath --config $TauriConfigPath `
        --version $ExpectedVersion --trusted-file ([IO.Path]::GetFileName($installer))
    if ($LASTEXITCODE -ne 0) { throw "Minisign verification failed for $installer" }
}

Write-Host "Verified staged Windows installer manifests and exact-byte updater signatures; installers are not Authenticode code-signed."
