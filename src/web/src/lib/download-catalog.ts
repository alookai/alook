import { ALOOK_RELEASES_URL, compareVersions, fetchGitHubReleases, parseStableSemver, type GitHubAsset, type GitHubRelease } from "./github-releases"

import { DOWNLOAD_TARGETS, type DownloadInstaller } from "./download-platforms"

export type DownloadCatalog = { installers: DownloadInstaller[]; unavailable: boolean }

function releaseAssetUrl(asset: GitHubAsset, tag: string): string | null {
  try {
    const url = new URL(asset.browser_download_url)
    return url.origin === "https://github.com" && !url.username && !url.password && !url.search && !url.hash
      && url.pathname === `/alookai/alook/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`
      && typeof asset.size === "number" && Number.isSafeInteger(asset.size) && asset.size > 0
      && (asset.state === undefined || asset.state === "uploaded") ? url.href : null
  } catch { return null }
}

function isRelease(value: unknown): value is GitHubRelease {
  if (!value || typeof value !== "object") return false
  const release = value as Partial<GitHubRelease>
  return typeof release.tag_name === "string" && typeof release.draft === "boolean" && typeof release.prerelease === "boolean"
    && Array.isArray(release.assets) && release.assets.every(asset => asset && typeof asset.name === "string" && typeof asset.browser_download_url === "string")
}

export function selectDownloadInstallers(input: unknown): DownloadInstaller[] {
  if (!Array.isArray(input)) throw new Error("Invalid release catalog")
  if (!input.every(isRelease)) throw new Error("Invalid release metadata")
  const releases = input.filter(release => !release.draft && !release.prerelease).flatMap(release => {
    const text = release.tag_name.startsWith("v") ? release.tag_name.slice(1) : ""
    const version = parseStableSemver(text)
    return version ? [{ release, text, version }] : []
  }).sort((a, b) => compareVersions(b.version, a.version))
  return DOWNLOAD_TARGETS.flatMap(target => {
    for (const { release, text } of releases) {
      if (target.platform !== "android" && !release.assets.some(asset => asset.name === "latest.json" && releaseAssetUrl(asset, release.tag_name))) continue
      const asset = release.assets.find(asset => target.id === "linux-rpm"
        ? asset.name.startsWith(`Alook-${text}-`) && /^\d+\.x86_64\.rpm$/.test(asset.name.slice(`Alook-${text}-`.length))
        : asset.name === `Alook_${text}${target.suffix}`)
      const url = asset && releaseAssetUrl(asset, release.tag_name)
      if (url && asset && typeof asset.size === "number") return [{ id: target.id, version: text, url, bytes: asset.size }]
    }
    return []
  })
}

export async function readDownloadCatalog(): Promise<DownloadCatalog> {
  try {
    const response = await fetchGitHubReleases()
    if (!response.ok) return { installers: [], unavailable: true }
    return { installers: selectDownloadInstallers(await response.json()), unavailable: false }
  } catch { return { installers: [], unavailable: true } }
}


export { ALOOK_RELEASES_URL }
