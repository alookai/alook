import { afterEach, describe, expect, it, vi } from "vitest"
import { readDownloadCatalog, selectDownloadInstallers } from "./download-catalog"
import { DOWNLOAD_TARGETS } from "./download-platforms"
import { compareVersions, parseStableSemver } from "./github-releases"

function asset(name: string, version: string, patch: Record<string, unknown> = {}) {
  return { name, size: 1000, state: "uploaded", browser_download_url: `https://github.com/alookai/alook/releases/download/v${version}/${encodeURIComponent(name)}`, ...patch }
}
function release(version: string, complete = true, patch: Record<string, unknown> = {}) {
  return { tag_name: `v${version}`, draft: false, prerelease: false, assets: [
    ...(complete ? [asset("latest.json", version)] : []),
    ...DOWNLOAD_TARGETS.map(target => asset(target.id === "linux-rpm" ? `Alook-${version}-1.x86_64.rpm` : `Alook_${version}${target.suffix}`, version)),
    asset(`Alook_${version}_aarch64.app.tar.gz`, version),
    asset(`Alook_${version}_aarch64.app.tar.gz.sig`, version),
  ], ...patch }
}
afterEach(() => vi.unstubAllGlobals())

describe("public installer selection", () => {
  it("selects all eight actual installers in semantic order, separately from updater bundles", () => {
    const result = selectDownloadInstallers([release("2.9.1"), release("2.10.0"), release("3.0.0-beta", true, { prerelease: true }), release("9.0.0", true, { draft: true }), release("10.0.0", true, { tag_name: "web-v10.0.0" })])
    expect(result.map(item => item.id)).toEqual(DOWNLOAD_TARGETS.map(item => item.id))
    expect(result.every(item => item.version === "2.10.0")).toBe(true)
    expect(result.find(item => item.id === "mac-arm")?.url).toMatch(/aarch64\.dmg$/)
    expect(result.some(item => /\.sig$|\.tar\.gz$/.test(item.url))).toBe(false)
  })

  it("uses the last completed desktop release while allowing the independent newer APK", () => {
    const result = selectDownloadInstallers([release("1.0.0"), release("1.0.1", false)])
    expect(result.filter(item => item.id !== "android-apk").every(item => item.version === "1.0.0")).toBe(true)
    expect(result.find(item => item.id === "android-apk")?.version).toBe("1.0.1")
  })

  it("falls back per actual missing format rather than guessing an asset URL", () => {
    const newest = release("1.1.0")
    newest.assets = newest.assets.filter(item => !item.name.endsWith(".msi") && !item.name.endsWith(".apk"))
    const result = selectDownloadInstallers([newest, release("1.0.0")])
    expect(result.find(item => item.id === "windows-exe")?.version).toBe("1.1.0")
    expect(result.find(item => item.id === "windows-msi")?.version).toBe("1.0.0")
    expect(result.find(item => item.id === "android-apk")?.version).toBe("1.0.0")
    expect(selectDownloadInstallers([{ ...newest, assets: [] }])).toEqual([])
  })

  it.each([
    { browser_download_url: "not a URL" },
    { browser_download_url: "https://example.com/Alook_1.0.0_aarch64.dmg" },
    { browser_download_url: "https://github.com/other/repo/releases/download/v1.0.0/Alook_1.0.0_aarch64.dmg" },
    { browser_download_url: "https://user:password@github.com/alookai/alook/releases/download/v1.0.0/Alook_1.0.0_aarch64.dmg" },
    { browser_download_url: "https://github.com/alookai/alook/releases/download/v1.0.0/Alook_1.0.0_aarch64.dmg?token=opaque" },
    { browser_download_url: "https://github.com/alookai/alook/releases/download/v1.0.0/Alook_1.0.0_aarch64.dmg#fragment" },
    { size: 0 }, { size: -1 }, { size: "1000" }, { state: "new" },
  ])("rejects an unqualified installer without publishing it: %j", patch => {
    const candidate = release("1.0.0")
    candidate.assets = candidate.assets.map(item => item.name.endsWith("_aarch64.dmg") ? { ...item, ...patch } : item)
    expect(selectDownloadInstallers([candidate]).some(item => item.id === "mac-arm")).toBe(false)
  })

  it("rejects an invalid desktop completion marker and keeps a real APK", () => {
    const candidate = release("1.0.0")
    candidate.assets[0] = { ...candidate.assets[0], state: "new" }
    expect(selectDownloadInstallers([candidate]).map(item => item.id)).toEqual(["android-apk"])
  })

  it.each([null, {}, [null], [{ tag_name: "v1.0.0" }], [{ ...release("1.0.0"), assets: [null] }]])("rejects malformed response metadata: %j", input => {
    expect(() => selectDownloadInstallers(input)).toThrow()
  })

  it("retains the shared stable-version grammar and numeric comparison", () => {
    expect(parseStableSemver("1.2.3+build.4")).toEqual([1, 2, 3])
    for (const value of ["1.2", "01.2.3", "1.2.3-beta", "garbage"]) expect(parseStableSemver(value)).toBeNull()
    expect(compareVersions([1, 2, 3], [1, 2, 3])).toBe(0)
    expect(compareVersions([1, 2, 4], [1, 2, 3])).toBeGreaterThan(0)
  })
})

describe("public catalog read", () => {
  it("uses the existing public release fetch/cache and produces a serializable catalog", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([release("1.0.0")])))
    vi.stubGlobal("fetch", fetch)
    const result = await readDownloadCatalog()
    expect(result.unavailable).toBe(false)
    expect(result.installers).toHaveLength(8)
    expect(fetch).toHaveBeenCalledWith("https://api.github.com/repos/alookai/alook/releases?per_page=100", { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "alook-updater" }, next: { revalidate: 300 } })
  })
  it.each(["http", "network", "json", "shape"])("returns an honest fallback on %s failure", async failure => {
    const fetch = vi.fn().mockImplementation(() => failure === "network" ? Promise.reject(new Error("offline"))
      : Promise.resolve(new Response(failure === "json" ? "not json" : "{}", { status: failure === "http" ? 503 : 200 })))
    vi.stubGlobal("fetch", fetch)
    expect(await readDownloadCatalog()).toEqual({ installers: [], unavailable: true })
  })
})
