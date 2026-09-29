[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [string]$FilePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$requiredEnvironment = @(
    "ALOOK_WINDOWS_SIGNING_ROOT",
    "ALOOK_ARTIFACT_SIGNING_MODULE_PATH",
    "ALOOK_ARTIFACT_SIGNING_ENDPOINT",
    "ALOOK_ARTIFACT_SIGNING_ACCOUNT_NAME",
    "ALOOK_ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME"
)
foreach ($name in $requiredEnvironment) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "Required signing environment variable is missing: $name"
    }
}

[Uri]$endpoint = $null
if (-not [Uri]::TryCreate($env:ALOOK_ARTIFACT_SIGNING_ENDPOINT, [UriKind]::Absolute, [ref]$endpoint) -or
    $endpoint.Scheme -ne [Uri]::UriSchemeHttps -or
    $endpoint.DnsSafeHost -notmatch '^[a-z0-9-]+\.codesigning\.azure\.net$' -or
    -not $endpoint.IsDefaultPort -or
    $endpoint.AbsolutePath -ne '/' -or
    $endpoint.UserInfo -ne '' -or
    $endpoint.Query -ne '' -or
    $endpoint.Fragment -ne '') {
    throw "Artifact Signing endpoint must be an HTTPS regional codesigning.azure.net root URL"
}

$root = (Resolve-Path -LiteralPath $env:ALOOK_WINDOWS_SIGNING_ROOT).Path.TrimEnd('\', '/')
$resolved = (Resolve-Path -LiteralPath $FilePath).Path
$item = Get-Item -LiteralPath $resolved
if (-not $item.PSIsContainer -and $item.LinkType -eq $null) {
    $relative = [IO.Path]::GetRelativePath($root, $resolved)
} else {
    throw "Tauri signCommand accepts exactly one regular file"
}

if ([IO.Path]::IsPathRooted($relative) -or $relative -eq ".." -or $relative.StartsWith("..$([IO.Path]::DirectorySeparatorChar)")) {
    throw "Refusing to sign a path outside the expected Tauri release root: $resolved"
}

$normalized = $relative.Replace('/', '\')
# NSIS !uninstfinalize writes the generated uninstaller beneath %TEMP%\~nsu.tmp.
$allowed = @(
    '^alook-desktop\.exe$',
    '^bundle\\msi\\Alook_[0-9]+\.[0-9]+\.[0-9]+_x64_en-US\.msi$',
    '^bundle\\nsis\\Alook_[0-9]+\.[0-9]+\.[0-9]+_x64-setup\.exe$',
    '^wix\\x64\\wix\\Wix(?:UI|Util)Extension\.dll$',
    '^nsis\\x64\\Plugins\\x86-unicode\\(?:NSISdl|StartMenu|System|nsDialogs)\.dll$',
    '^nsis\\x64\\Plugins\\x86-unicode\\additional\\nsis_tauri_utils\.dll$',
    '^tauri-sign-temp\\~nsu\.tmp\\Un_[A-Za-z0-9]+\.exe$'
)
if (-not ($allowed | Where-Object { $normalized -match $_ })) {
    throw "Refusing unexpected Tauri signing path: $relative"
}

$modulePath = (Resolve-Path -LiteralPath $env:ALOOK_ARTIFACT_SIGNING_MODULE_PATH).Path
Import-Module $modulePath -Force

$signingParameters = @{
    Endpoint = $env:ALOOK_ARTIFACT_SIGNING_ENDPOINT
    CodeSigningAccountName = $env:ALOOK_ARTIFACT_SIGNING_ACCOUNT_NAME
    CertificateProfileName = $env:ALOOK_ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME
    Files = $resolved
    FileDigest = "SHA256"
    TimestampRfc3161 = "http://timestamp.acs.microsoft.com"
    TimestampDigest = "SHA256"
    ExcludeEnvironmentCredential = $true
    ExcludeWorkloadIdentityCredential = $true
    ExcludeManagedIdentityCredential = $true
    ExcludeSharedTokenCacheCredential = $true
    ExcludeVisualStudioCredential = $true
    ExcludeVisualStudioCodeCredential = $true
    ExcludeAzureCliCredential = $false
    ExcludeAzurePowerShellCredential = $true
    ExcludeAzureDeveloperCliCredential = $true
    ExcludeInteractiveBrowserCredential = $true
}

Invoke-ArtifactSigning @signingParameters

$signature = Get-AuthenticodeSignature -LiteralPath $resolved
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Artifact Signing returned without a valid Authenticode signature: $relative ($($signature.Status))"
}
