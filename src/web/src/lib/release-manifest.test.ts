import { describe, expect, it, vi } from "vitest"
import { DOWNLOAD_TARGETS } from "./download-platforms"
import {
  readReleaseManifestFromKv,
  RELEASE_MANIFEST_KV_KEY,
  RELEASE_MANIFEST_MAX_BYTES,
  RELEASE_NOTES_MAX_CHARS,
  validateReleaseManifest,
  type ReleaseManifest,
} from "./release-manifest"

function makeInstallerUrl(version: string, filename: string) {
  return `https://github.com/alookai/alook/releases/download/v${version}/${encodeURIComponent(filename)}`
}

function makeValidManifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  const desktopVersion = "1.2.0"
  const androidVersion = "1.3.0"
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
        url: makeInstallerUrl(version, filename),
        bytes: 42_000_000,
      }
    }),
    desktopUpdater: {
      version: desktopVersion,
      notes: "Bug fixes and improvements",
      pub_date: "2026-11-27T18:00:00Z",
      platforms: {
        "darwin-aarch64-app": {
          url: makeInstallerUrl(desktopVersion, `Alook_${desktopVersion}_aarch64.app.tar.gz`),
          signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQ==",
        },
        "windows-x86_64-nsis": {
          url: makeInstallerUrl(desktopVersion, `Alook_${desktopVersion}_x64-setup.exe`),
          signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHdpbmRvd3M=",
        },
        "linux-x86_64-rpm": {
          url: makeInstallerUrl(desktopVersion, `Alook-${desktopVersion}-1.x86_64.rpm`),
          signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHJwbQ==",
        },
      },
    },
    ...overrides,
  }
}

describe("validateReleaseManifest", () => {
  it("accepts a valid manifest with partial-release desktop and android versions", () => {
    const manifest = makeValidManifest()
    const result = validateReleaseManifest(manifest)
    expect(result).toEqual({ ok: true, manifest })
  })

  it("accepts null desktopUpdater and null pub_date", () => {
    expect(validateReleaseManifest(makeValidManifest({ desktopUpdater: null })).ok).toBe(true)

    const withNullPubDate = makeValidManifest()
    withNullPubDate.desktopUpdater!.pub_date = null
    expect(validateReleaseManifest(withNullPubDate).ok).toBe(true)
  })

  it("trims desktopUpdater signatures and strips extra top-level fields", () => {
    const raw = {
      ...makeValidManifest(),
      extraField: "ignored",
      desktopUpdater: {
        ...makeValidManifest().desktopUpdater!,
        platforms: {
          "darwin-aarch64-app": {
            url: makeInstallerUrl("1.2.0", "Alook_1.2.0_aarch64.app.tar.gz"),
            signature: "  valid-signature\n",
          },
        },
      },
    }
    const result = validateReleaseManifest(raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect("extraField" in result.manifest).toBe(false)
      expect(result.manifest.desktopUpdater?.platforms["darwin-aarch64-app"]?.signature).toBe("valid-signature")
    }
  })

  it.each([
    ["non-object", null],
    ["unsupported schemaVersion", { ...makeValidManifest(), schemaVersion: 2 }],
    ["invalid syncedAt", { ...makeValidManifest(), syncedAt: "not-a-timestamp" }],
    ["non-array installers", { ...makeValidManifest(), installers: "bad" }],
    [
      "duplicate installer ids",
      {
        ...makeValidManifest(),
        installers: [makeValidManifest().installers[0], makeValidManifest().installers[0]],
      },
    ],
    [
      "unsupported installer id",
      {
        ...makeValidManifest(),
        installers: [{ ...makeValidManifest().installers[0], id: "freebsd-tar" }],
      },
    ],
    [
      "non-semver installer version",
      {
        ...makeValidManifest(),
        installers: [{ ...makeValidManifest().installers[0], version: "1.2.0-beta.1" }],
      },
    ],
    [
      "zero byte size",
      {
        ...makeValidManifest(),
        installers: [{ ...makeValidManifest().installers[0], bytes: 0 }],
      },
    ],
    [
      "non-integer byte size",
      {
        ...makeValidManifest(),
        installers: [{ ...makeValidManifest().installers[0], bytes: 10.5 }],
      },
    ],
    [
      "non-GitHub installer URL",
      {
        ...makeValidManifest(),
        installers: [
          {
            ...makeValidManifest().installers[0],
            url: "https://evil.example.com/Alook_1.2.0_aarch64.dmg",
          },
        ],
      },
    ],
    [
      "wrong repository installer URL",
      {
        ...makeValidManifest(),
        installers: [
          {
            ...makeValidManifest().installers[0],
            url: "https://github.com/other/alook/releases/download/v1.2.0/Alook_1.2.0_aarch64.dmg",
          },
        ],
      },
    ],
    [
      "installer URL with query string",
      {
        ...makeValidManifest(),
        installers: [
          {
            ...makeValidManifest().installers[0],
            url: "https://github.com/alookai/alook/releases/download/v1.2.0/Alook_1.2.0_aarch64.dmg?token=1",
          },
        ],
      },
    ],
    [
      "installer URL mismatched with version",
      {
        ...makeValidManifest(),
        installers: [
          {
            ...makeValidManifest().installers[0],
            url: "https://github.com/alookai/alook/releases/download/v1.1.0/Alook_1.1.0_aarch64.dmg",
          },
        ],
      },
    ],
    [
      "empty desktopUpdater platforms",
      {
        ...makeValidManifest(),
        desktopUpdater: {
          version: "1.2.0",
          notes: "",
          pub_date: null,
          platforms: {},
        },
      },
    ],
    [
      "unsupported desktopUpdater platform key",
      {
        ...makeValidManifest(),
        desktopUpdater: {
          version: "1.2.0",
          notes: "",
          pub_date: null,
          platforms: {
            "freebsd-x86_64-app": {
              url: makeInstallerUrl("1.2.0", "Alook_1.2.0_x64.app.tar.gz"),
              signature: "sig",
            },
          },
        },
      },
    ],
    [
      "desktopUpdater signature file used as binary URL",
      {
        ...makeValidManifest(),
        desktopUpdater: {
          version: "1.2.0",
          notes: "",
          pub_date: null,
          platforms: {
            "darwin-aarch64-app": {
              url: makeInstallerUrl("1.2.0", "Alook_1.2.0_aarch64.app.tar.gz.sig"),
              signature: "sig",
            },
          },
        },
      },
    ],
    [
      "desktopUpdater wrong architecture binary URL",
      {
        ...makeValidManifest(),
        desktopUpdater: {
          version: "1.2.0",
          notes: "",
          pub_date: null,
          platforms: {
            "darwin-aarch64-app": {
              url: makeInstallerUrl("1.2.0", "Alook_1.2.0_x64.app.tar.gz"),
              signature: "sig",
            },
          },
        },
      },
    ],
    [
      "desktopUpdater empty signature",
      {
        ...makeValidManifest(),
        desktopUpdater: {
          version: "1.2.0",
          notes: "",
          pub_date: null,
          platforms: {
            "darwin-aarch64-app": {
              url: makeInstallerUrl("1.2.0", "Alook_1.2.0_aarch64.app.tar.gz"),
              signature: "   \n ",
            },
          },
        },
      },
    ],
    [
      "desktopUpdater oversized notes",
      {
        ...makeValidManifest(),
        desktopUpdater: {
          ...makeValidManifest().desktopUpdater!,
          notes: "a".repeat(RELEASE_NOTES_MAX_CHARS + 1),
        },
      },
    ],
    [
      "desktopUpdater invalid pub_date",
      {
        ...makeValidManifest(),
        desktopUpdater: {
          ...makeValidManifest().desktopUpdater!,
          pub_date: "yesterday",
        },
      },
    ],
  ])("rejects %s", (_label, candidate) => {
    expect(validateReleaseManifest(candidate).ok).toBe(false)
  })
})

describe("readReleaseManifestFromKv", () => {
  it("reads and validates a manifest from CACHE_KV", async () => {
    const manifest = makeValidManifest()
    const get = vi.fn().mockResolvedValue(JSON.stringify(manifest))
    const kv = { get } as unknown as KVNamespace

    const result = await readReleaseManifestFromKv(kv)
    expect(get).toHaveBeenCalledWith(RELEASE_MANIFEST_KV_KEY, "text")
    expect(result).toEqual({ status: "ok", manifest })
  })

  it("returns missing when KV has no entry", async () => {
    const kv = { get: vi.fn().mockResolvedValue(null) } as unknown as KVNamespace
    await expect(readReleaseManifestFromKv(kv)).resolves.toEqual({ status: "missing" })
  })

  it("returns corrupt for invalid JSON, invalid schema, or oversized payload", async () => {
    const badJsonKv = { get: vi.fn().mockResolvedValue("{bad") } as unknown as KVNamespace
    await expect(readReleaseManifestFromKv(badJsonKv)).resolves.toEqual({
      status: "corrupt",
      reason: "invalid_json",
    })

    const badSchemaKv = { get: vi.fn().mockResolvedValue(JSON.stringify({ schemaVersion: 9 })) } as unknown as KVNamespace
    await expect(readReleaseManifestFromKv(badSchemaKv)).resolves.toEqual({
      status: "corrupt",
      reason: "invalid_schema",
    })

    const oversizedKv = {
      get: vi.fn().mockResolvedValue("x".repeat(RELEASE_MANIFEST_MAX_BYTES + 1)),
    } as unknown as KVNamespace
    await expect(readReleaseManifestFromKv(oversizedKv)).resolves.toEqual({
      status: "corrupt",
      reason: "payload_too_large",
    })
  })

  it("returns safe error kind on KV read failure", async () => {
    const kv = {
      get: vi.fn().mockRejectedValue(new TypeError("private internal KV details")),
    } as unknown as KVNamespace
    await expect(readReleaseManifestFromKv(kv)).resolves.toEqual({
      status: "error",
      errorKind: "TypeError",
    })
  })
})
