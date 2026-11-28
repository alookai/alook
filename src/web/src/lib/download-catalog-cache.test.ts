import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DOWNLOAD_TARGETS } from "./download-platforms"
import { RELEASE_MANIFEST_KV_KEY, type ReleaseManifest } from "./release-manifest"

const mocks = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
  kvGet: vi.fn(),
  fetch: vi.fn(),
}))

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}))

import { readCachedDownloadCatalog } from "./download-catalog-cache"

function makeManifest(desktopVersion = "1.2.0", androidVersion = "1.3.0"): ReleaseManifest {
  return {
    schemaVersion: 1,
    syncedAt: "2026-11-28T04:00:00.000Z",
    installers: DOWNLOAD_TARGETS.map((target) => {
      const version = target.id === "android-apk" ? androidVersion : desktopVersion
      const filename =
        target.id === "linux-rpm"
          ? `Alook-${version}-1.x86_64.rpm`
          : `Alook_${version}${target.suffix}`
      return {
        id: target.id,
        version,
        url: `https://github.com/alookai/alook/releases/download/v${version}/${encodeURIComponent(filename)}`,
        bytes: 12_345_678,
      }
    }),
    desktopUpdater: null,
  }
}

describe("readCachedDownloadCatalog", () => {
  const warnings: unknown[][] = []

  beforeEach(() => {
    warnings.length = 0
    mocks.getCloudflareContext.mockReset()
    mocks.kvGet.mockReset()
    mocks.fetch.mockReset()

    vi.stubGlobal("fetch", mocks.fetch)
    vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args)
    })
    mocks.getCloudflareContext.mockResolvedValue({
      env: { CACHE_KV: { get: mocks.kvGet } },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("reads installers exclusively from CACHE_KV with zero network fetch calls", async () => {
    const manifest = makeManifest()
    mocks.kvGet.mockResolvedValueOnce(JSON.stringify(manifest))

    const result = await readCachedDownloadCatalog()

    expect(mocks.kvGet).toHaveBeenCalledWith(RELEASE_MANIFEST_KV_KEY, "text")
    expect(result).toEqual({ installers: manifest.installers, unavailable: false })
    expect(result.installers).toHaveLength(8)
    expect(warnings).toEqual([])
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it("returns unavailable cleanly when CACHE_KV has not been seeded yet", async () => {
    mocks.kvGet.mockResolvedValueOnce(null)

    const result = await readCachedDownloadCatalog()

    expect(result).toEqual({ installers: [], unavailable: true })
    expect(warnings).toEqual([])
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it("returns unavailable and logs a concise warning when stored manifest is corrupt", async () => {
    mocks.kvGet.mockResolvedValueOnce("{corrupt-json")

    const result = await readCachedDownloadCatalog()

    expect(result).toEqual({ installers: [], unavailable: true })
    expect(warnings).toEqual([["download_catalog_unavailable", { stage: "manifest", reason: "invalid_json" }]])
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it("returns unavailable and logs safe error_kind when KV read throws", async () => {
    mocks.kvGet.mockRejectedValueOnce(new TypeError("private kv failure message"))

    const result = await readCachedDownloadCatalog()

    expect(result).toEqual({ installers: [], unavailable: true })
    expect(warnings).toEqual([["download_catalog_unavailable", { stage: "kv", error_kind: "TypeError" }]])
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it("returns unavailable without falling back to GitHub when Cloudflare context fails", async () => {
    mocks.getCloudflareContext.mockRejectedValueOnce(new Error("missing worker context"))

    const result = await readCachedDownloadCatalog()

    expect(result).toEqual({ installers: [], unavailable: true })
    expect(warnings).toEqual([["download_catalog_unavailable", { stage: "context" }]])
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})
