import { beforeEach, describe, expect, it, vi } from "vitest"
import { DOWNLOAD_TARGETS } from "@/lib/download-platforms"
import {
  RELEASE_MANIFEST_KV_KEY,
  RELEASE_MANIFEST_MAX_BYTES,
  type ReleaseManifest,
} from "@/lib/release-manifest"

const mocks = vi.hoisted(() => ({
  verifyGitHubOidcToken: vi.fn(),
  getCloudflareContext: vi.fn(),
  kvPut: vi.fn(),
}))

vi.mock("@/lib/github-oidc", () => ({
  verifyGitHubOidcToken: mocks.verifyGitHubOidcToken,
}))

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}))

import { POST } from "./route"

function makeValidManifest(): ReleaseManifest {
  const version = "1.2.0"
  return {
    schemaVersion: 1,
    syncedAt: "2026-11-28T04:00:00.000Z",
    installers: DOWNLOAD_TARGETS.map((target) => {
      const filename =
        target.id === "linux-rpm"
          ? `Alook-${version}-1.x86_64.rpm`
          : `Alook_${version}${target.suffix}`
      return {
        id: target.id,
        version,
        url: `https://github.com/alookai/alook/releases/download/v${version}/${encodeURIComponent(filename)}`,
        bytes: 25_000_000,
      }
    }),
    desktopUpdater: {
      version,
      notes: "Release notes",
      pub_date: "2026-11-28T03:00:00Z",
      platforms: {
        "darwin-aarch64-app": {
          url: `https://github.com/alookai/alook/releases/download/v${version}/Alook_${version}_aarch64.app.tar.gz`,
          signature: "valid-sig",
        },
      },
    },
  }
}

function makeRequest(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request("https://alook.ai/api/releases/sync", {
    method: "POST",
    headers,
    body,
  })
}

describe("POST /api/releases/sync", () => {
  beforeEach(() => {
    mocks.verifyGitHubOidcToken.mockReset()
    mocks.getCloudflareContext.mockReset()
    mocks.kvPut.mockReset()

    mocks.verifyGitHubOidcToken.mockResolvedValue({
      ok: true,
      claims: {
        iss: "https://token.actions.githubusercontent.com",
        aud: "https://alook.ai",
        repository: "alookai/alook",
        repository_owner: "alookai",
        ref: "refs/heads/main",
        event_name: "push",
        job_workflow_ref: "alookai/alook/.github/workflows/sync-releases.yml@refs/heads/main",
        workflow_ref: "alookai/alook/.github/workflows/desktop-release.yml@refs/heads/main",
        exp: 9999999999,
      },
    })
    mocks.kvPut.mockResolvedValue(undefined)
    mocks.getCloudflareContext.mockResolvedValue({
      env: { CACHE_KV: { put: mocks.kvPut } },
    })
  })

  it("returns 401 when Authorization header is missing or malformed", async () => {
    const missing = await POST(makeRequest(JSON.stringify(makeValidManifest())))
    expect(missing.status).toBe(401)
    expect(missing.headers.get("Cache-Control")).toBe("no-store")
    expect(mocks.verifyGitHubOidcToken).not.toHaveBeenCalled()

    const malformed = await POST(
      makeRequest(JSON.stringify(makeValidManifest()), { Authorization: "Basic abc" }),
    )
    expect(malformed.status).toBe(401)
    expect(mocks.verifyGitHubOidcToken).not.toHaveBeenCalled()
  })

  it("propagates OIDC auth failure statuses", async () => {
    mocks.verifyGitHubOidcToken.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: "Unauthorized OIDC token claims",
    })

    const res = await POST(
      makeRequest(JSON.stringify(makeValidManifest()), { Authorization: "Bearer test-jwt" }),
    )
    expect(res.status).toBe(403)
    expect(mocks.verifyGitHubOidcToken).toHaveBeenCalledWith("test-jwt")
    expect(mocks.kvPut).not.toHaveBeenCalled()
  })

  it("returns 413 for oversized Content-Length or streamed payload", async () => {
    const oversizedHeader = await POST(
      makeRequest("{}", {
        Authorization: "Bearer test-jwt",
        "Content-Length": String(RELEASE_MANIFEST_MAX_BYTES + 1),
      }),
    )
    expect(oversizedHeader.status).toBe(413)
    expect(mocks.kvPut).not.toHaveBeenCalled()

    const oversizedBody = await POST(
      makeRequest("x".repeat(RELEASE_MANIFEST_MAX_BYTES + 10), {
        Authorization: "Bearer test-jwt",
      }),
    )
    expect(oversizedBody.status).toBe(413)
    expect(mocks.kvPut).not.toHaveBeenCalled()
  })

  it("returns 400 for invalid JSON or invalid manifest schema", async () => {
    const badJson = await POST(
      makeRequest("{not-json", { Authorization: "Bearer test-jwt" }),
    )
    expect(badJson.status).toBe(400)

    const badSchema = await POST(
      makeRequest(JSON.stringify({ schemaVersion: 1, syncedAt: "bad", installers: [], desktopUpdater: null }), {
        Authorization: "Bearer test-jwt",
      }),
    )
    expect(badSchema.status).toBe(400)
    expect(mocks.kvPut).not.toHaveBeenCalled()
  })

  it("persists validated canonical manifest to CACHE_KV and returns summary", async () => {
    const manifest = makeValidManifest()
    const res = await POST(
      makeRequest(JSON.stringify({ ...manifest, unexpected: "dropped" }), {
        Authorization: "Bearer valid-oidc-jwt",
        "Content-Type": "application/json",
      }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(await res.json()).toEqual({
      ok: true,
      syncedAt: manifest.syncedAt,
      installerCount: 8,
      desktopVersion: "1.2.0",
      desktopPlatformCount: 1,
    })
    expect(mocks.kvPut).toHaveBeenCalledTimes(1)
    expect(mocks.kvPut).toHaveBeenCalledWith(RELEASE_MANIFEST_KV_KEY, JSON.stringify(manifest))
  })

  it("returns 503 when CACHE_KV put fails", async () => {
    mocks.kvPut.mockRejectedValueOnce(new Error("kv outage"))
    const res = await POST(
      makeRequest(JSON.stringify(makeValidManifest()), { Authorization: "Bearer valid-oidc-jwt" }),
    )
    expect(res.status).toBe(503)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })
})
