export const IOS_TESTFLIGHT_URL = "https://testflight.apple.com/join/4fHgVBVF"

export const DOWNLOAD_TARGETS = [
  { id: "mac-arm", platform: "macos", label: "Apple Silicon", format: "DMG", suffix: "_aarch64.dmg" },
  { id: "mac-intel", platform: "macos", label: "Intel", format: "DMG", suffix: "_x64.dmg" },
  { id: "windows-exe", platform: "windows", label: "Windows x64", format: "EXE", suffix: "_x64-setup.exe" },
  { id: "windows-msi", platform: "windows", label: "Windows x64", format: "MSI", suffix: "_x64_en-US.msi" },
  { id: "linux-deb", platform: "linux", label: "Debian / Ubuntu · x64", format: "DEB", suffix: "_amd64.deb" },
  { id: "linux-rpm", platform: "linux", label: "Fedora / RHEL · x64", format: "RPM", suffix: ".x86_64.rpm" },
  { id: "linux-appimage", platform: "linux", label: "Linux x64", format: "AppImage", suffix: "_amd64.AppImage" },
  { id: "android-apk", platform: "android", label: "Android", format: "APK", suffix: "_android.apk" },
] as const

export type DownloadPlatform = (typeof DOWNLOAD_TARGETS)[number]["platform"] | "ios" | "unknown"
export type DownloadTargetId = (typeof DOWNLOAD_TARGETS)[number]["id"]
export type DownloadInstaller = { id: DownloadTargetId; version: string; url: string; bytes: number }

export type DownloadArchitecture = "arm64" | "x64" | "unsupported" | "unknown"
export type DownloadEnvironment = { platform: DownloadPlatform; architecture: DownloadArchitecture }
export const UNKNOWN_DOWNLOAD_ENVIRONMENT: DownloadEnvironment = { platform: "unknown", architecture: "unknown" }

export function downloadPlatformFromOS(name = ""): DownloadPlatform {
  const os = name.toLowerCase()
  if (os === "android") return "android"
  if (os === "ios") return "ios"
  if (["macos", "mac os"].includes(os)) return "macos"
  if (os === "windows") return "windows"
  if (["linux", "ubuntu", "debian", "fedora", "arch", "centos", "red hat", "linux mint", "suse"].includes(os)) return "linux"
  return "unknown"
}

export function downloadArchitecture(architecture = "", bitness?: string): DownloadArchitecture {
  const arch = architecture.toLowerCase()
  if (!arch) return "unknown"
  if (arch === "arm64" || arch === "aarch64" || (arch === "arm" && bitness === "64")) return "arm64"
  if (["amd64", "x86_64", "x64"].includes(arch) || (arch === "x86" && bitness === "64")) return "x64"
  return "unsupported"
}

export function currentDownloadTargets(environment: DownloadEnvironment): DownloadTargetId[] {
  const { platform, architecture } = environment
  if (platform === "android") return ["android-apk"]
  if (platform === "macos") {
    if (architecture === "arm64") return ["mac-arm"]
    if (architecture === "x64") return ["mac-intel"]
    return architecture === "unknown" ? ["mac-arm", "mac-intel"] : []
  }
  if (architecture === "arm64" || architecture === "unsupported") return []
  if (platform === "windows") return ["windows-exe", "windows-msi"]
  if (platform === "linux") return ["linux-appimage", "linux-deb", "linux-rpm"]
  return []
}
