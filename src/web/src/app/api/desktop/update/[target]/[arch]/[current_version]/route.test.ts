import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  RELEASE_MANIFEST_KV_KEY,
  type DesktopUpdaterPlatformKey,
  type ReleaseManifest,
} from "@/lib/release-manifest"

const mocks = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
  kvGet: vi.fn(),
  fetch: vi.fn(),
}))

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}))

import { GET } from "./route"

function makeRequest(
  target: string,
  arch: string,
  currentVersion: string,
  bundleType = "app",
) {
  const url = new URL(
    `http://localhost/api/desktop/update/${target}/${arch}/${currentVersion}`,
  )
  url.searchParams.set("bundle_type", bundleType)
  return new Request(url)
}

function makeParams(target: string, arch: string, currentVersion: string) {
  return { params: Promise.resolve({ target, arch, current_version: currentVersion }) }
}

async function requestUpdate(
  target: string,
  arch: string,
  currentVersion: string,
  bundleType = "app",
) {
  return GET(
    makeRequest(target, arch, currentVersion, bundleType),
    makeParams(target, arch, currentVersion),
  )
}

function releaseUrl(version: string, filename: string) {
  return `https://github.com/alookai/alook/releases/download/v${version}/${encodeURIComponent(filename)}`
}

function makeManifest(
  version: string,
  platforms: Partial<Record<DesktopUpdaterPlatformKey, { url: string; signature: string }>>,
): ReleaseManifest {
  return {
    schemaVersion: 1,
    syncedAt: "2026-11-28T04:00:00.000Z",
    installers: [],
    desktopUpdater: {
      version,
      notes: "Release notes",
      pub_date: "2026-06-01T00:00:00Z",
      platforms,
    },
  }
}

describe("GET /api/desktop/update/[target]/[arch]/[current_version]", () => {
  beforeEach(() => {
    mocks.getCloudflareContext.mockReset()
    mocks.kvGet.mockReset()
    mocks.fetch.mockReset()

    vi.stubGlobal("fetch", mocks.fetch)
    vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.getCloudflareContext.mockResolvedValue({
      env: { CACHE_KV: { get: mocks.kvGet } },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("returns 204 for unsupported updater targets before touching KV or network", async () => {
    const res = await requestUpdate("freebsd", "x86_64", "1.0.0", "app")
    expect(res.status).toBe(204)
    expect(mocks.kvGet).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it("returns 204 for an invalid current version before touching KV or network", async () => {
    const res = await requestUpdate("darwin", "aarch64", "1.0.0.1")
    expect(res.status).toBe(204)
    expect(mocks.kvGet).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it("returns 503 no-store when CACHE_KV manifest is missing, null desktopUpdater, corrupt, or throws", async () => {
    mocks.kvGet.mockResolvedValueOnce(null)
    const missing = await requestUpdate("darwin", "aarch64", "1.0.0")
    expect(missing.status).toBe(503)
    expect(missing.headers.get("Cache-Control")).toBe("no-store")

    mocks.kvGet.mockResolvedValueOnce(
      JSON.stringify({
        schemaVersion: 1,
        syncedAt: "2026-11-28T04:00:00.000Z",
        installers: [],
        desktopUpdater: null,
      }),
    )
    const noDesktop = await requestUpdate("darwin", "aarch64", "1.0.0")
    expect(noDesktop.status).toBe(503)
    expect(noDesktop.headers.get("Cache-Control")).toBe("no-store")

    mocks.kvGet.mockResolvedValueOnce("{corrupt")
    const corrupt = await requestUpdate("darwin", "aarch64", "1.0.0")
    expect(corrupt.status).toBe(503)

    mocks.kvGet.mockRejectedValueOnce(new Error("kv failure"))
    const kvError = await requestUpdate("darwin", "aarch64", "1.0.0")
    expect(kvError.status).toBe(503)

    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it("returns 204 when current_version is already latest or newer", async () => {
    const manifest = makeManifest("1.0.0", {
      "darwin-aarch64-app": {
        url: releaseUrl("1.0.0", "Alook_1.0.0_aarch64.app.tar.gz"),
        signature: "sig-1",
      },
    })
    mocks.kvGet.mockResolvedValue(JSON.stringify(manifest))

    expect((await requestUpdate("darwin", "aarch64", "1.0.0")).status).toBe(204)
    expect((await requestUpdate("darwin", "aarch64", "2.0.0")).status).toBe(204)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it("returns 204 when the requested platform is absent from desktopUpdater.platforms", async () => {
    const manifest = makeManifest("2.0.0", {
      "darwin-aarch64-app": {
        url: releaseUrl("2.0.0", "Alook_2.0.0_aarch64.app.tar.gz"),
        signature: "sig-arm",
      },
    })
    mocks.kvGet.mockResolvedValueOnce(JSON.stringify(manifest))

    const res = await requestUpdate("windows", "x86_64", "1.0.0", "nsis")
    expect(res.status).toBe(204)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it.each([
    ["darwin", "aarch64", "app", "Alook_2.0.0_aarch64.app.tar.gz"],
    ["darwin", "x86_64", "app", "Alook_2.0.0_x64.app.tar.gz"],
    ["linux", "x86_64", "appimage", "Alook_2.0.0_amd64.AppImage"],
    ["linux", "x86_64", "deb", "Alook_2.0.0_amd64.deb"],
    ["linux", "x86_64", "rpm", "Alook-2.0.0-1.x86_64.rpm"],
    ["linux", "aarch64", "appimage", "Alook_2.0.0_aarch64.AppImage"],
    ["linux", "aarch64", "deb", "Alook_2.0.0_arm64.deb"],
    ["linux", "aarch64", "rpm", "Alook-2.0.0-1.aarch64.rpm"],
    ["windows", "x86_64", "msi", "Alook_2.0.0_x64_en-US.msi"],
    ["windows", "x86_64", "nsis", "Alook_2.0.0_x64-setup.exe"],
    ["windows", "aarch64", "msi", "Alook_2.0.0_arm64_en-US.msi"],
    ["windows", "aarch64", "nsis", "Alook_2.0.0_arm64-setup.exe"],
  ] as const)(
    "returns the exact Tauri v2 %s-%s-%s artifact and signature from CACHE_KV with zero network calls",
    async (target, arch, bundleType, assetName) => {
      const platformKey = `${target}-${arch}-${bundleType}` as DesktopUpdaterPlatformKey
      const url = releaseUrl("2.0.0", assetName)
      const manifest = makeManifest("2.0.0", {
        [platformKey]: { url, signature: `${platformKey}-sig` },
      })
      mocks.kvGet.mockResolvedValueOnce(JSON.stringify(manifest))

      const res = await requestUpdate(target, arch, "1.0.0", bundleType)

      expect(res.status).toBe(200)
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=300")
      expect(mocks.kvGet).toHaveBeenCalledWith(RELEASE_MANIFEST_KV_KEY, "text")
      expect(await res.json()).toEqual({
        version: "2.0.0",
        notes: "Release notes",
        pub_date: "2026-06-01T00:00:00Z",
        platforms: {
          [platformKey]: {
            url,
            signature: `${platformKey}-sig`,
          },
        },
      })
      expect(mocks.fetch).not.toHaveBeenCalled()
    },
  )
})
