export const ALOOK_RELEASES_URL = "https://github.com/alookai/alook/releases"
export const RELEASE_CACHE_SECONDS = 300

export interface GitHubAsset {
  name: string
  browser_download_url: string
  size?: number
  state?: string
}

export interface GitHubRelease {
  tag_name: string
  draft: boolean
  prerelease: boolean
  assets: GitHubAsset[]
  body: string | null
  published_at: string | null
}

export function fetchGitHubReleases() {
  return fetch("https://api.github.com/repos/alookai/alook/releases?per_page=100", {
    headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "alook-updater" },
    next: { revalidate: RELEASE_CACHE_SECONDS },
  })
}

export function parseStableSemver(version: string): [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}
