import { describe, expect, it, vi } from "vitest"
import { validateReleaseManifest } from "../../src/web/src/lib/release-manifest"
import {
  buildReleaseManifest,
  DOWNLOAD_TARGETS,
  parseCliArgs,
  pushReleaseManifest,
  requestOidcToken,
} from "./sync-release-manifest.mjs"

function makeAsset(name: string, version: string, patch: Record<string, unknown> = {}) {
  return {
    name,
    size: 12_000_000,
    state: "uploaded",
    browser_download_url: `https://github.com/alookai/alook/releases/download/v${version}/${encodeURIComponent(name)}`,
    ...patch,
  }
}

function makeDesktopAssets(version: string) {
  const installerAssets = DOWNLOAD_TARGETS.filter((target) => target.platform !== "android").map((target) =>
    makeAsset(
      target.id === "linux-rpm" ? `Alook-${version}-1.x86_64.rpm` : `Alook_${version}${target.suffix}`,
      version,
    ),
  )
  const updaterNames = [
    `Alook_${version}_aarch64.app.tar.gz`,
    `Alook_${version}_x64.app.tar.gz`,
    `Alook_${version}_amd64.AppImage`,
    `Alook_${version}_amd64.deb`,
    `Alook-${version}-1.x86_64.rpm`,
    `Alook_${version}_x64_en-US.msi`,
    `Alook_${version}_x64-setup.exe`,
  ]
  const updaterAssets = updaterNames.flatMap((name) => [
    makeAsset(name, version),
    makeAsset(`${name}.sig`, version, { size: 320 }),
  ])
  const seen = new Set<string>()
  return [makeAsset("latest.json", version, { size: 1500 }), ...installerAssets, ...updaterAssets].filter((asset) => {
    if (seen.has(asset.name)) return false
    seen.add(asset.name)
    return true
  })
}

function makeRelease(
  version: string,
  assets: Array<Record<string, unknown>>,
  patch: Record<string, unknown> = {},
) {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    body: `Notes for ${version}`,
    published_at: "2026-11-28T01:00:00Z",
    assets,
    ...patch,
  }
}

describe("sync-release-manifest builder", () => {
  it("aggregates a full release and produces a manifest accepted by the web validator", async () => {
    const releases = [
      makeRelease("0.1.74", [...makeDesktopAssets("0.1.74"), makeAsset("Alook_0.1.74_android.apk", "0.1.74")]),
      makeRelease("0.1.75-rc.1", makeDesktopAssets("0.1.75-rc.1"), { prerelease: true }),
      makeRelease("0.1.76", makeDesktopAssets("0.1.76"), { draft: true }),
    ]
    const fetchSignature = vi.fn(async (url: string) => `sig-for:${url.split("/").pop()}\n`)

    const manifest = await buildReleaseManifest(releases, {
      syncedAt: "2026-11-28T04:00:00.000Z",
      fetchSignature,
    })

    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.installers).toHaveLength(8)
    expect(manifest.installers.every((item) => item.version === "0.1.74")).toBe(true)
    expect(manifest.desktopUpdater?.version).toBe("0.1.74")
    expect(Object.keys(manifest.desktopUpdater?.platforms ?? {})).toHaveLength(7)
    expect(fetchSignature).toHaveBeenCalledTimes(7)

    // Cross-validate against the exact web runtime schema validator!
    const validated = validateReleaseManifest(manifest)
    expect(validated.ok).toBe(true)
  })

  it("preserves desktop binaries when a newer mobile-only release publishes only Android APK", async () => {
    const releases = [
      makeRelease("0.1.75", [makeAsset("Alook_0.1.75_android.apk", "0.1.75")]),
      makeRelease("0.1.74", [...makeDesktopAssets("0.1.74"), makeAsset("Alook_0.1.74_android.apk", "0.1.74")]),
    ]
    const fetchSignature = vi.fn(async () => "trimmed-signature")

    const manifest = await buildReleaseManifest(releases, {
      syncedAt: "2026-11-28T04:00:00.000Z",
      fetchSignature,
    })

    expect(manifest.installers.find((item) => item.id === "android-apk")?.version).toBe("0.1.75")
    expect(
      manifest.installers.filter((item) => item.id !== "android-apk").every((item) => item.version === "0.1.74"),
    ).toBe(true)
    expect(manifest.desktopUpdater?.version).toBe("0.1.74")
    expect(validateReleaseManifest(manifest).ok).toBe(true)
  })

  it("preserves Android APK when a newer desktop-only release has no APK", async () => {
    const releases = [
      makeRelease("0.1.76", makeDesktopAssets("0.1.76")),
      makeRelease("0.1.75", [makeAsset("Alook_0.1.75_android.apk", "0.1.75")]),
    ]
    const fetchSignature = vi.fn(async () => "desktop-sig")

    const manifest = await buildReleaseManifest(releases, {
      syncedAt: "2026-11-28T04:00:00.000Z",
      fetchSignature,
    })

    expect(manifest.installers.find((item) => item.id === "android-apk")?.version).toBe("0.1.75")
    expect(
      manifest.installers.filter((item) => item.id !== "android-apk").every((item) => item.version === "0.1.76"),
    ).toBe(true)
    expect(manifest.desktopUpdater?.version).toBe("0.1.76")
    expect(validateReleaseManifest(manifest).ok).toBe(true)
  })

  it("throws if any desktop platform signature is empty", async () => {
    const releases = [makeRelease("0.1.74", makeDesktopAssets("0.1.74"))]
    await expect(
      buildReleaseManifest(releases, {
        syncedAt: "2026-11-28T04:00:00.000Z",
        fetchSignature: async () => "   \n",
      }),
    ).rejects.toThrow("Empty signature")
  })
})

describe("OIDC token request and manifest push", () => {
  it("requests an OIDC JWT with the configured audience and retries transient 5xx", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("temporary error", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: "header.payload.sig" }), { status: 200 }))
    const sleepFn = vi.fn(async () => {})

    const token = await requestOidcToken({
      requestUrl: "https://vstoken.actions.githubusercontent.com/_apis/distributedtask/hubs/Actions?api-version=2.0",
      requestToken: "runner-request-token",
      audience: "https://alook.ai",
      fetchFn,
      retryDelaysMs: [10],
      sleepFn,
    })

    expect(token).toBe("header.payload.sig")
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("audience=https%3A%2F%2Falook.ai")
    expect(sleepFn).toHaveBeenCalledWith(10)
  })

  it("retries transient 5xx on POST /api/releases/sync but does not retry 403", async () => {
    const sleepFn = vi.fn(async () => {})
    const retryingFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, installerCount: 8 }), { status: 200 }))

    const result = await pushReleaseManifest({
      endpoint: "https://alook.ai/api/releases/sync",
      token: "oidc-jwt",
      manifest: { schemaVersion: 1, syncedAt: "2026-11-28T04:00:00.000Z", installers: [], desktopUpdater: null },
      fetchFn: retryingFetch,
      retryDelaysMs: [10],
      sleepFn,
    })
    expect(result).toEqual({ ok: true, installerCount: 8 })
    expect(retryingFetch).toHaveBeenCalledTimes(2)

    const authFailFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("forbidden", { status: 403 }))
    await expect(
      pushReleaseManifest({
        endpoint: "https://alook.ai/api/releases/sync",
        token: "bad-jwt",
        manifest: { schemaVersion: 1, syncedAt: "2026-11-28T04:00:00.000Z", installers: [], desktopUpdater: null },
        fetchFn: authFailFetch,
        retryDelaysMs: [10, 20],
        sleepFn,
      }),
    ).rejects.toThrow("HTTP 403")
    expect(authFailFetch).toHaveBeenCalledTimes(1)
  })

  it("parses --dry-run, --out, --endpoint, and --repo flags", () => {
    expect(
      parseCliArgs([
        "--dry-run",
        "--out",
        "tmp/manifest.json",
        "--endpoint",
        "https://preview.alook.ai/api/releases/sync",
        "--repo",
        "alookai/alook",
      ]),
    ).toEqual({
      dryRun: true,
      out: "tmp/manifest.json",
      endpoint: "https://preview.alook.ai/api/releases/sync",
      audience: "https://alook.ai",
      repo: "alookai/alook",
    })
  })
})
